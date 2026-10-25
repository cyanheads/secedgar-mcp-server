/**
 * @fileoverview Optional 13F amendment reads — cover pages and the information tables
 * composition reads — through the real SEC retry ladder, rate-limit gate and
 * cancellation path; the original's holdings survive every optional failure.
 * @module tests/mcp-server/tools/amendment-disclosure
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    userAgent: 'test test@example.com',
    rateLimitRps: 10,
    rateLimitCooldownSeconds: 600,
    tickerCacheTtl: 3600,
    mirrorFallbackLive: true,
  }),
}));
vi.mock('@/services/edgar/mirror/index.js', () => ({ getEdgarMirror: () => undefined }));

import { getInstitutionalHoldingsTool } from '@/mcp-server/tools/definitions/get-institutional-holdings.tool.js';
import { disposeEdgarApiService, initEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { blockText } from '../../support/assertions.js';
import { readCommonMark } from '../../support/commonmark.js';

const ORIGINAL = '0000000001-25-000001';
/** NEW HOLDINGS, filed last. */
const AMENDMENT = '0000000001-25-000002';
/** RESTATEMENT, filed between the original and AMENDMENT. */
const LATER = '0000000001-25-000003';

const table = (name: string, cusip: string, value: number) =>
  `<informationTable><infoTable><nameOfIssuer>${name}</nameOfIssuer><cusip>${cusip}</cusip><value>${value}</value></infoTable></informationTable>`;
const cover = (type?: string) =>
  `<edgarSubmission><filingManager><name>Manager</name></filingManager><periodOfReport>12-31-2024</periodOfReport>${type ? `<amendmentInfo><amendmentType>${type}</amendmentType></amendmentInfo>` : ''}</edgarSubmission>`;

type Route = (init?: RequestInit) => Promise<Response>;
const text =
  (body: string): Route =>
  async () =>
    new Response(body);

/** Default responses per `<accession>/<document>`; a test overrides any of them. */
const DEFAULTS: Record<string, Route> = {
  [`${ORIGINAL}/primary_doc.xml`]: text(cover()),
  [`${ORIGINAL}/infotable.xml`]: text(table('APPLE INC', '037833100', 10)),
  [`${LATER}/primary_doc.xml`]: text(cover('RESTATEMENT')),
  [`${LATER}/infotable.xml`]: text(table('MICROSOFT CORP', '594918104', 30)),
  [`${AMENDMENT}/primary_doc.xml`]: text(cover('NEW HOLDINGS')),
  [`${AMENDMENT}/infotable.xml`]: text(table('NVIDIA CORP', '67066G104', 20)),
};

/** Every request is recorded, including an unexpected URL. */
function requests(overrides: Record<string, Route> = {}) {
  const routes = { ...DEFAULTS, ...overrides };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/company_tickers.json')) return Response.json({});
    if (url.endsWith('/company_tickers_mf.json')) return Response.json({ data: [] });
    if (url.endsWith('/CIK0000000001.json'))
      return Response.json({
        name: 'Manager',
        tickers: [],
        exchanges: [],
        filings: {
          recent: {
            form: ['13F-HR/A', '13F-HR/A', '13F-HR'],
            accessionNumber: [AMENDMENT, LATER, ORIGINAL],
            filingDate: ['2025-08-14', '2025-08-13', '2025-02-15'],
            reportDate: ['2024-12-31', '2024-12-31', '2024-12-31'],
            primaryDocument: ['primary_doc.xml', 'primary_doc.xml', 'primary_doc.xml'],
            primaryDocDescription: ['', '', ''],
          },
          files: [],
        },
      });
    if (url.endsWith('/index.json'))
      return Response.json({
        directory: { item: [{ name: 'primary_doc.xml' }, { name: 'infotable.xml' }] },
      });
    for (const accession of [ORIGINAL, LATER, AMENDMENT]) {
      if (!url.includes(`/${accession.replaceAll('-', '')}/`)) continue;
      const route = routes[`${accession}/${url.slice(url.lastIndexOf('/') + 1)}`];
      if (route) return route(init);
    }
    throw new Error(`Unexpected fixture URL: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Requests for one accession's document (`index.json`, `primary_doc.xml`, `infotable.xml`). */
const sent = (fetchMock: ReturnType<typeof requests>, accession: string, doc: string) =>
  fetchMock.mock.calls.filter(([url]) =>
    String(url).includes(`/${accession.replaceAll('-', '')}/${doc}`),
  ).length;

const contentText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  readCommonMark(result.content.map((_, i) => blockText(result.content, i)).join('\n'));

const failing =
  (status: number): Route =>
  async () =>
    new Response('unavailable', { status });

describe('13F optional amendment reads', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    initEdgarApiService();
  });
  afterEach(() => {
    disposeEdgarApiService();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([404, 403, 429, 503])(
    'composes without an amendment whose cover read fails with HTTP %s',
    async (status) => {
      const fetchMock = requests({ [`${AMENDMENT}/primary_doc.xml`]: failing(status) });
      const pending = runToolContract(getInstitutionalHoldingsTool, { company: '0000000001' });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        accession_number: ORIGINAL,
        total_holdings_in_filing: 1,
        total_positions: 1,
        // A 429 stops every later read, so the restatement goes unread and the original stands.
        composed_accessions: [status === 429 ? ORIGINAL : LATER],
        holdings: [status === 429 ? { cusip: '037833100' } : { cusip: '594918104' }],
        amendments: [
          {
            accession_number: AMENDMENT,
            amendment_type: 'UNAVAILABLE',
            unavailable_reason: status === 404 ? 'missing_header' : 'lookup_failed',
            applied_as: 'not_applied',
          },
          {
            accession_number: LATER,
            amendment_type: status === 429 ? 'UNAVAILABLE' : 'RESTATEMENT',
            applied_as: status === 429 ? 'not_applied' : 'restatement',
          },
        ],
      });
      expect(sent(fetchMock, AMENDMENT, 'primary_doc.xml')).toBe(status === 503 ? 3 : 1);
      expect(sent(fetchMock, AMENDMENT, 'infotable.xml')).toBe(0);
      expect(sent(fetchMock, LATER, 'primary_doc.xml')).toBe(status === 429 ? 0 : 1);
      expect(sent(fetchMock, LATER, 'infotable.xml')).toBe(status === 429 ? 0 : 1);
      const content = contentText(result);
      const reason = status === 404 ? 'missing_header' : 'lookup_failed';
      expect(content).toContain(
        `${AMENDMENT} (filed 2025-08-14, UNAVAILABLE: ${reason}, not_applied)`,
      );
      expect(content).toContain(
        `Not applied, since the type or information table could not be read: ${status === 429 ? `${AMENDMENT}, ${LATER}` : AMENDMENT} — inspect with secedgar_get_filing.`,
      );
    },
  );

  it.each([404, 403, 429, 503])(
    'composes without a restatement whose table read fails with HTTP %s',
    async (status) => {
      const fetchMock = requests({ [`${LATER}/infotable.xml`]: failing(status) });
      const pending = runToolContract(getInstitutionalHoldingsTool, {
        company: '0000000001',
        consolidate: false,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(result.isError).toBeFalsy();
      // The base falls back to the original; the later NEW HOLDINGS still appends unless
      // the 429 stopped further reads.
      expect(result.structuredContent).toMatchObject({
        composed_accessions: status === 429 ? [ORIGINAL] : [ORIGINAL, AMENDMENT],
        holdings:
          status === 429
            ? [{ cusip: '037833100', source_accession_numbers: [ORIGINAL] }]
            : [
                { cusip: '037833100', source_accession_numbers: [ORIGINAL] },
                { cusip: '67066G104', source_accession_numbers: [AMENDMENT] },
              ],
        amendments: [
          {
            accession_number: AMENDMENT,
            amendment_type: 'NEW HOLDINGS',
            applied_as: status === 429 ? 'not_applied' : 'new_holdings',
          },
          { accession_number: LATER, amendment_type: 'RESTATEMENT', applied_as: 'not_applied' },
        ],
      });
      expect(sent(fetchMock, LATER, 'infotable.xml')).toBe(status === 503 ? 3 : 1);
      expect(sent(fetchMock, AMENDMENT, 'infotable.xml')).toBe(status === 429 ? 0 : 1);
      expect(contentText(result)).toContain(
        `Not applied, since the type or information table could not be read: ${status === 429 ? `${AMENDMENT}, ${LATER}` : LATER}`,
      );
    },
  );

  it('propagates caller cancellation during an amendment cover read, with its reason', async () => {
    const controller = new AbortController();
    const fetchMock = requests({
      [`${AMENDMENT}/primary_doc.xml`]: async () => {
        controller.abort(new Error('cancel amendment disclosure'));
        throw controller.signal.reason;
      },
    });
    const pending = runToolContract(
      getInstitutionalHoldingsTool,
      { company: '0000000001' },
      { context: { signal: controller.signal } },
    );
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(blockText(result.content)).toContain('cancel amendment disclosure');
    expect(sent(fetchMock, LATER, 'primary_doc.xml')).toBe(0);
  });

  it('propagates caller cancellation during an amendment table read, with its reason', async () => {
    const controller = new AbortController();
    const fetchMock = requests({
      [`${LATER}/infotable.xml`]: async () => {
        controller.abort(new Error('cancel amendment composition'));
        throw controller.signal.reason;
      },
    });
    const pending = runToolContract(
      getInstitutionalHoldingsTool,
      { company: '0000000001' },
      { context: { signal: controller.signal } },
    );
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(blockText(result.content)).toContain('cancel amendment composition');
    expect(sent(fetchMock, LATER, 'infotable.xml')).toBe(1);
    expect(sent(fetchMock, AMENDMENT, 'infotable.xml')).toBe(0);
  });

  /** A request that never answers until its signal aborts. */
  const hanging: Route = async (init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });

  it('spends one shared failure budget on a cover read and stops subsequent amendment reads', async () => {
    const fetchMock = requests({ [`${AMENDMENT}/primary_doc.xml`]: hanging });
    const pending = runToolContract(getInstitutionalHoldingsTool, { company: '0000000001' });
    await vi.advanceTimersByTimeAsync(50_000);
    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      total_positions: 1,
      composed_accessions: [ORIGINAL],
      amendments: [
        {
          accession_number: AMENDMENT,
          amendment_type: 'UNAVAILABLE',
          unavailable_reason: 'lookup_failed',
          applied_as: 'not_applied',
        },
        {
          accession_number: LATER,
          amendment_type: 'UNAVAILABLE',
          unavailable_reason: 'lookup_stopped',
          applied_as: 'not_applied',
        },
      ],
    });
    expect(sent(fetchMock, AMENDMENT, 'primary_doc.xml')).toBe(3);
    expect(sent(fetchMock, LATER, 'primary_doc.xml')).toBe(0);
    expect(sent(fetchMock, LATER, 'infotable.xml')).toBe(0);
  });

  it('spends the same budget on a table read and stops the reads after it', async () => {
    const fetchMock = requests({ [`${LATER}/infotable.xml`]: hanging });
    const pending = runToolContract(getInstitutionalHoldingsTool, { company: '0000000001' });
    await vi.advanceTimersByTimeAsync(50_000);
    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      composed_accessions: [ORIGINAL],
      holdings: [{ cusip: '037833100' }],
      amendments: [
        { accession_number: AMENDMENT, applied_as: 'not_applied' },
        { accession_number: LATER, applied_as: 'not_applied' },
      ],
    });
    expect(sent(fetchMock, LATER, 'infotable.xml')).toBe(3);
    expect(sent(fetchMock, AMENDMENT, 'infotable.xml')).toBe(0);
  });
});
