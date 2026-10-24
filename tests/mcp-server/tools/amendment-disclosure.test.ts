/**
 * @fileoverview Optional 13F amendment reads through the real SEC retry ladder,
 * rate-limit gate and cancellation path; successful original holdings survive.
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

const ORIGINAL = '0000000001-25-000001';
const AMENDMENT = '0000000001-25-000002';
const LATER = '0000000001-25-000003';
const TABLE =
  '<informationTable><infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><cusip>037833100</cusip><value>10</value></infoTable></informationTable>';
const COVER =
  '<edgarSubmission><filingManager><name>Manager</name></filingManager><periodOfReport>12-31-2024</periodOfReport></edgarSubmission>';

/** Every request is recorded, including an unexpected URL. */
function requests(amendment: (init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/company_tickers.json')) return Response.json({});
    if (url.endsWith('/company_tickers_mf.json')) return Response.json({ data: [] });
    if (url.endsWith('/CIK0000000001.json'))
      return Response.json({
        name: 'Manager',
        tickers: [],
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
    if (url.endsWith('/infotable.xml')) return new Response(TABLE);
    if (url.includes(ORIGINAL.replaceAll('-', ''))) return new Response(COVER);
    if (url.includes(AMENDMENT.replaceAll('-', ''))) return amendment(init);
    if (url.includes(LATER.replaceAll('-', '')))
      return new Response(
        '<edgarSubmission><amendmentInfo><amendmentType>RESTATEMENT</amendmentType></amendmentInfo></edgarSubmission>',
      );
    throw new Error(`Unexpected fixture URL: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

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
    'retains original holdings after amendment HTTP %s',
    async (status) => {
      const fetchMock = requests(async () => new Response('unavailable', { status }));
      const pending = runToolContract(getInstitutionalHoldingsTool, { company: '0000000001' });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        accession_number: ORIGINAL,
        total_positions: 1,
        holdings: [{ cusip: '037833100', market_value_usd: 10 }],
        amendments: [
          {
            accession_number: AMENDMENT,
            amendment_type: 'UNAVAILABLE',
            unavailable_reason: status === 404 ? 'missing_header' : 'lookup_failed',
          },
          {
            accession_number: LATER,
            amendment_type: status === 429 ? 'UNAVAILABLE' : 'RESTATEMENT',
          },
        ],
      });
      const attempts = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes(AMENDMENT.replaceAll('-', '')),
      );
      expect(attempts).toHaveLength(status === 503 ? 3 : 1);
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes(LATER.replaceAll('-', ''))),
      ).toHaveLength(status === 429 ? 0 : 1);
      const text = result.content.map((_, i) => blockText(result.content, i)).join('\n');
      expect(text).toContain(AMENDMENT);
      expect(text).toContain('UNAVAILABLE');
      expect(text).toContain('secedgar_get_filing');
    },
  );

  it('propagates caller cancellation during an amendment read, with its reason', async () => {
    const controller = new AbortController();
    const fetchMock = requests(async () => {
      controller.abort(new Error('cancel amendment disclosure'));
      throw controller.signal.reason;
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
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes(LATER.replaceAll('-', ''))),
    ).toHaveLength(0);
  });

  it('spends one shared failure budget and stops subsequent amendment reads', async () => {
    const fetchMock = requests(
      async (init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const pending = runToolContract(getInstitutionalHoldingsTool, { company: '0000000001' });
    await vi.advanceTimersByTimeAsync(50_000);
    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      total_positions: 1,
      amendments: [
        {
          accession_number: AMENDMENT,
          amendment_type: 'UNAVAILABLE',
          unavailable_reason: 'lookup_failed',
        },
        {
          accession_number: LATER,
          amendment_type: 'UNAVAILABLE',
          unavailable_reason: 'lookup_stopped',
        },
      ],
    });
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes(AMENDMENT.replaceAll('-', ''))),
    ).toHaveLength(3);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes(LATER.replaceAll('-', ''))),
    ).toHaveLength(0);
  });
});
