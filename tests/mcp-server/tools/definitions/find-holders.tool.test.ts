/**
 * @fileoverview Tests for find-holders — the 13F reverse lookup. Covers quarter
 * defaulting and the filing window, the reporting-period filter, CUSIP vs name
 * search modes, the paging budget, both zero-hit causes, the company-identifier
 * aliases on `issuer` (#152), the name phrase's dropped trailing qualifier (#205),
 * the notice naming another registrant that shares the phrase (#224), and the
 * format() values read back under CommonMark (#221).
 * @module tests/mcp-server/tools/definitions/find-holders.tool
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFindHoldersTool,
  findHoldersTool,
} from '@/mcp-server/tools/definitions/find-holders.tool.js';
import { CallScope } from '@/services/edgar/call-scope.js';
import type { EftsHit, EftsResponse } from '@/services/edgar/types.js';
import { allText, bag, blockText, wireError } from '../../../support/assertions.js';
import { codeSpansIn, readCommonMark } from '../../../support/commonmark.js';

vi.mock('@/services/edgar/edgar-api-service.js', async (importActual) => {
  const actual = await importActual<typeof import('@/services/edgar/edgar-api-service.js')>();
  return {
    ...actual,
    getEdgarApiService: vi.fn(),
    initEdgarApiService: vi.fn(),
  };
});

import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';

// Partial mock: the canvas accessors are stubbed, but `dataframeGuidance` stays
// real so the staged-dataframe pointer is asserted against the shipped wording.
vi.mock('@/services/canvas-bridge/canvas-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/canvas-bridge/canvas-bridge.js')>()),
  getCanvasBridge: vi.fn(),
  toDatasetField: (r: { tableName: string; rowCount: number; expiresAt: string }) => ({
    name: r.tableName,
    row_count: r.rowCount,
    expires_at: r.expiresAt,
  }),
}));

import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

/** Fixed clock: 2026-07-26 sits 117 days past the 2026-03-31 quarter end. */
const NOW = '2026-07-26T12:00:00.000Z';

function stubBridge() {
  return {
    registerDataframe: vi.fn(
      async (
        _ctx: unknown,
        opts: { rows: Array<Record<string, unknown>>; truncated?: boolean },
      ) => ({
        tableName: 'df_TEST0_TEST1',
        rowCount: opts.rows.length,
        expiresAt: '2026-12-31T00:00:00.000Z',
        columnSchema: [],
      }),
    ),
  };
}

/**
 * One EFTS hit for a 13F-HR information table. The filer CIK defaults to one
 * derived from the accession, so a batch of generated hits reads as a batch of
 * distinct managers — the tool keys its holder set on the CIK.
 */
function hit(opts: {
  accession: string;
  cik?: string;
  name?: string;
  fileDate?: string;
  periodEnding?: string | null;
  form?: string;
}): EftsHit {
  return {
    _id: `${opts.accession}:infotable.xml`,
    _source: {
      adsh: opts.accession,
      ciks: [opts.cik ?? opts.accession.replaceAll('-', '').slice(-10)],
      display_names: [opts.name ?? 'BERKSHIRE HATHAWAY INC  (BRK-A, BRK-B)  (CIK 0001067983)'],
      file_date: opts.fileDate ?? '2026-05-15',
      form: opts.form ?? '13F-HR',
      period_ending: opts.periodEnding === undefined ? '2026-03-31' : opts.periodEnding,
    },
  };
}

function eftsPage(hits: EftsHit[], total: number): EftsResponse {
  return {
    hits: { hits, total: { value: total, relation: 'eq' } },
    query: { from: 0, size: 100, query: '' },
  };
}

const mockApi = {
  getAllEntries: vi.fn(),
  resolveCik: vi.fn(),
  searchFilings: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.mocked(getCanvasBridge).mockReturnValue(undefined as never);
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as never);
  mockApi.getAllEntries.mockResolvedValue([]);
  mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
  mockApi.searchFilings.mockResolvedValue(
    eftsPage([hit({ accession: '0001193125-26-226661' })], 1),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('findHoldersTool', () => {
  it('characterizes a complete single-document sample without a continuation', async () => {
    const result = await runToolContract(findHoldersTool, { issuer: 'Apple', cusip: '037833100' });
    expect(result.structuredContent).toMatchObject({ fetched: 1, holders_in_quarter: 1 });
    expect(result.content.map((_, i) => blockText(result.content, i)).join('\n')).not.toContain(
      'Continue with secedgar_search_filings',
    );
  });

  it.each([
    ['eq', 12000],
    ['gte', 10000],
  ] as const)('states the document ceiling for %s totals', async (relation, total) => {
    const response = eftsPage(
      Array.from({ length: 100 }, (_, i) => hit({ accession: `a-${i}` })),
      total,
    );
    response.hits.total.relation = relation;
    mockApi.searchFilings.mockResolvedValue(response);
    const result = await runToolContract(findHoldersTool, { issuer: 'Apple', cusip: '037833100' });
    expect(result.structuredContent).toMatchObject({
      fetched: 500,
      total_filings: total,
      total_is_exact: relation === 'eq',
    });
    const text = result.content.map((_, i) => blockText(result.content, i)).join('\n');
    expect(text).toContain('10000-document paging ceiling');
    expect(text).toContain('10000 reported documents');
    expect(text).toContain('unreachable by paging');
    // The deepest offset search_filings sends to EDGAR, not offset + limit (#214).
    expect(text).toContain(
      'Advance offset by 100 documents per full page, up to offset 9900, the deepest page EDGAR full-text search serves.',
    );
    expect(text).not.toContain('offset + limit exceeds');
    if (relation === 'gte') expect(text).toContain('lower bound');
  });

  it('keeps phrase quoting and the all-other-period notice in continuation guidance', async () => {
    mockApi.searchFilings.mockResolvedValue(
      eftsPage(
        Array.from({ length: 100 }, (_, i) =>
          hit({ accession: `other-${i}`, periodEnding: '2024-12-31' }),
        ),
        700,
      ),
    );
    const result = await runToolContract(findHoldersTool, { issuer: 'Apple', quarter: '2025-Q4' });
    expect(result.structuredContent).toMatchObject({ holders: [], holders_in_quarter: 0 });
    const text = result.content.map((_, i) => blockText(result.content, i)).join('\n');
    expect(text).toContain('amendments restating other quarters');
    expect(text).toContain(
      JSON.stringify({
        query: '"Apple Inc."',
        forms: ['13F-HR'],
        filed_after: '2026-01-01',
        filed_before: '2026-03-31',
        sort: 'relevance',
        offset: 500,
        limit: 100,
      }),
    );
    expect(text).toContain('latest filing_date');
  });

  it('does not advertise another window when exactly 500 matching documents were fetched', async () => {
    mockApi.searchFilings.mockResolvedValue(
      eftsPage(
        Array.from({ length: 100 }, (_, i) => hit({ accession: `complete-${i}` })),
        500,
      ),
    );
    const result = await runToolContract(findHoldersTool, { issuer: 'Apple', cusip: '037833100' });
    expect(result.structuredContent).toMatchObject({ fetched: 500, total_filings: 500 });
    expect(result.content.map((_, i) => blockText(result.content, i)).join('\n')).not.toContain(
      'Continue with secedgar_search_filings',
    );
  });

  it.each([false, true])('continues a bounded document sample with canvas=%s', async (canvas) => {
    let page = 0;
    mockApi.searchFilings.mockImplementation(async () =>
      eftsPage(
        Array.from({ length: 100 }, (_, i) =>
          hit({ accession: `p${page++}-${i}`, periodEnding: '2025-12-31' }),
        ),
        6462,
      ),
    );
    if (canvas) vi.mocked(getCanvasBridge).mockReturnValue(stubBridge() as never);
    const result = await runToolContract(findHoldersTool, {
      issuer: 'AAPL',
      cusip: '037833100',
      quarter: '2025-Q4',
      limit: 1,
    });
    const text = result.content.map((_, i) => blockText(result.content, i)).join('\n');
    expect(text).toContain('Continue with secedgar_search_filings');
    expect(text).toContain(
      JSON.stringify({
        query: '037833100',
        forms: ['13F-HR'],
        filed_after: '2026-01-01',
        filed_before: '2026-03-31',
        sort: 'relevance',
        offset: 500,
        limit: 100,
      }),
    );
    expect(text).toContain('sample.filer_cik');
    expect(text).toContain('results.cik');
    expect(text).toContain('2025-12-31');
    if (canvas) expect(text).toContain('df_TEST0_TEST1');
    expect(result.structuredContent).toMatchObject({ fetched: 500, holders_in_quarter: 500 });
  });
  it('defaults to the newest quarter whose 45-day deadline has passed', async () => {
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({ issuer: 'AAPL', cusip: '037833100' });
    const result = await findHoldersTool.handler(input, ctx);

    // 2026-07-26 minus 45 days is 2026-06-11, so Q2 (ending 06-30) is still
    // in-flight and Q1 is the newest quarter with a closed filing deadline.
    expect(result.quarter).toBe('2026-Q1');
  });

  it('opens the filing window from the day after the quarter end to the next quarter end', async () => {
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({ issuer: 'AAPL', cusip: '037833100' });
    const result = await findHoldersTool.handler(input, ctx);

    // Stopping at the next quarter end keeps the following quarter's originals,
    // which start arriving in July for Q2, out of a Q1 holder list.
    expect(result.filed_from).toBe('2026-04-01');
    expect(result.filed_to).toBe('2026-06-30');
    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: '2026-04-01', endDate: '2026-06-30' }),
      expect.any(CallScope),
    );
    // The scope carries the caller's own signal, so a cancel reaches SEC (#179).
    expect(mockApi.searchFilings.mock.calls[0]?.[1].signal).toBe(ctx.signal);
  });

  it('rolls the window into the next year for a Q4 quarter', async () => {
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({
      issuer: 'AAPL',
      cusip: '037833100',
      quarter: '2025-Q4',
    });
    const result = await findHoldersTool.handler(input, ctx);

    expect(result.filed_from).toBe('2026-01-01');
    expect(result.filed_to).toBe('2026-03-31');
  });

  it('searches the CUSIP verbatim and skips company resolution', async () => {
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({ issuer: 'Apple', cusip: '037833100' });
    const result = await findHoldersTool.handler(input, ctx);

    expect(result.search_mode).toBe('cusip');
    expect(result.search_key).toBe('037833100');
    expect(result.resolved_issuer_name).toBeUndefined();
    expect(mockApi.resolveCik).not.toHaveBeenCalled();
    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({ query: '037833100', forms: ['13F-HR'] }),
      expect.any(CallScope),
    );
  });

  it('uppercases a lowercase CUSIP before searching', async () => {
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({ issuer: 'Chubb', cusip: 'h1467j104' });
    const result = await findHoldersTool.handler(input, ctx);

    expect(result.search_key).toBe('H1467J104');
  });

  it('phrase-quotes the resolved company name when no CUSIP is given', async () => {
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({ issuer: 'AAPL' });
    const result = await findHoldersTool.handler(input, ctx);

    expect(result.search_mode).toBe('name');
    expect(result.search_key).toBe('"Apple Inc."');
    expect(result.resolved_issuer_name).toBe('Apple Inc.');
    expect(result.resolved_issuer_cik).toBe('0000320193');
  });

  it('drops filings that report a different quarter', async () => {
    mockApi.searchFilings.mockResolvedValue(
      eftsPage(
        [
          hit({ accession: '0000000001-26-000001' }),
          // An amendment restating Q4 2025, filed inside the Q1 2026 window.
          hit({ accession: '0000000002-26-000002', periodEnding: '2025-12-31', form: '13F-HR/A' }),
          hit({ accession: '0000000003-26-000003', periodEnding: null }),
        ],
        3,
      ),
    );
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({ issuer: 'AAPL', cusip: '037833100' });
    const result = await findHoldersTool.handler(input, ctx);

    expect(result.fetched).toBe(3);
    expect(result.holders_in_quarter).toBe(1);
    expect(result.holders.map((h) => h.accession_number)).toEqual(['0000000001-26-000001']);
  });

  it('lists a filer once when several documents of one filing match', async () => {
    const duplicate = hit({ accession: '0001193125-26-226661' });
    mockApi.searchFilings.mockResolvedValue(
      eftsPage([duplicate, { ...duplicate, _id: '0001193125-26-226661:other.xml' }], 2),
    );
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({ issuer: 'AAPL', cusip: '037833100' });
    const result = await findHoldersTool.handler(input, ctx);

    expect(result.holders_in_quarter).toBe(1);
  });

  it('lists a manager once when it amended its own report for this quarter', async () => {
    mockApi.searchFilings.mockResolvedValue(
      eftsPage(
        [
          hit({ accession: '0000000001-26-000001', cik: '0001274173', fileDate: '2026-05-12' }),
          hit({
            accession: '0000000002-26-000002',
            cik: '0001274173',
            fileDate: '2026-06-04',
            form: '13F-HR/A',
          }),
          hit({ accession: '0000000003-26-000003', cik: '0001760263' }),
        ],
        3,
      ),
    );
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({ issuer: 'AAPL', cusip: '037833100' });
    const result = await findHoldersTool.handler(input, ctx);

    expect(result.fetched).toBe(3);
    expect(result.holders_in_quarter).toBe(2);
    // The amendment supersedes the original, so it is the accession carried.
    expect(result.holders.map((h) => h.accession_number)).toEqual([
      '0000000002-26-000002',
      '0000000003-26-000003',
    ]);
  });

  it('stops at the five-page fetch budget and reports the shortfall', async () => {
    let page = 0;
    mockApi.searchFilings.mockImplementation(async () => {
      const hits = Array.from({ length: 100 }, (_, i) =>
        hit({ accession: `000000000${page}-26-${String(i).padStart(6, '0')}` }),
      );
      page += 1;
      return eftsPage(hits, 6652);
    });
    vi.mocked(getCanvasBridge).mockReturnValue(stubBridge() as never);

    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({ issuer: 'AAPL', cusip: '037833100' });
    const result = await findHoldersTool.handler(input, ctx);

    expect(mockApi.searchFilings).toHaveBeenCalledTimes(5);
    expect(mockApi.searchFilings).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: 400 }),
      expect.any(CallScope),
    );
    expect(result.fetched).toBe(500);
    expect(result.total_filings).toBe(6652);
    expect(result.dataset?.truncated).toBe(true);
  });

  it('stops early when the window is exhausted before the budget', async () => {
    mockApi.searchFilings.mockResolvedValue(
      eftsPage(
        Array.from({ length: 40 }, (_, i) =>
          hit({ accession: `0000000000-26-${String(i).padStart(6, '0')}` }),
        ),
        40,
      ),
    );
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({ issuer: 'AAPL', cusip: '037833100' });
    const result = await findHoldersTool.handler(input, ctx);

    expect(mockApi.searchFilings).toHaveBeenCalledTimes(1);
    expect(result.holders_in_quarter).toBe(40);
  });

  it('always states that the ordering carries no position-size signal', async () => {
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({ issuer: 'AAPL', cusip: '037833100' });
    await findHoldersTool.handler(input, ctx);

    expect(getEnrichment(ctx).ordering).toMatch(/not a ranking by shares held or market value/);
  });

  it('explains a zero-hit quarter whose filing deadline has not arrived', async () => {
    mockApi.searchFilings.mockResolvedValue(eftsPage([], 0));
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({
      issuer: 'AAPL',
      cusip: '037833100',
      quarter: '2026-Q3',
    });
    const result = await findHoldersTool.handler(input, ctx);

    expect(result.total_filings).toBe(0);
    expect(getEnrichment(ctx).notice).toContain('not due until 2026-11-14');
  });

  it('routes a zero-hit name search to the CUSIP path', async () => {
    mockApi.searchFilings.mockResolvedValue(eftsPage([], 0));
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({ issuer: 'AAPL', quarter: '2026-Q1' });
    await findHoldersTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain('pass cusip for an exact match');
  });

  it('distinguishes matches that all report other quarters from no matches at all', async () => {
    mockApi.searchFilings.mockResolvedValue(
      eftsPage([hit({ accession: '0000000002-26-000002', periodEnding: '2025-12-31' })], 1),
    );
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({ issuer: 'AAPL', cusip: '037833100' });
    const result = await findHoldersTool.handler(input, ctx);

    expect(result.total_filings).toBe(1);
    expect(result.holders_in_quarter).toBe(0);
    expect(getEnrichment(ctx).notice).toContain('amendments restating other quarters');
  });

  it('registers the in-quarter rows as a dataframe carrying the issuer key', async () => {
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);
    mockApi.searchFilings.mockResolvedValue(
      eftsPage(
        Array.from({ length: 5 }, (_, i) =>
          hit({ accession: `0000000000-26-${String(i).padStart(6, '0')}` }),
        ),
        5,
      ),
    );
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({
      issuer: 'AAPL',
      cusip: '037833100',
      limit: 2,
    });
    const result = await findHoldersTool.handler(input, ctx);

    expect(result.holders).toHaveLength(2);
    expect(result.dataset?.row_count).toBe(5);
    const rows = bridge.registerDataframe.mock.calls[0]?.[1].rows;
    expect(rows?.[0]).toMatchObject({
      issuer_cusip: '037833100',
      quarter: '2026-Q1',
      reporting_period: '2026-03-31',
    });
    // The managers past the inline cap are only reachable through the dataframe (#104).
    const notice = String(getEnrichment(ctx).notice);
    expect(getEnrichment(ctx).truncated).toBe(true);
    expect(notice).toContain('df_TEST0_TEST1');
    expect(notice).toContain('secedgar_dataframe_describe');
    expect(notice).toContain('secedgar_dataframe_query');
    expect(notice.match(/secedgar_dataframe_describe/g)).toHaveLength(1);
  });

  it('promises no dataframe pointer when the canvas is unavailable (#104)', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);
    mockApi.searchFilings.mockResolvedValue(
      eftsPage(
        Array.from({ length: 5 }, (_, i) =>
          hit({ accession: `0000000000-26-${String(i).padStart(6, '0')}` }),
        ),
        5,
      ),
    );
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({
      issuer: 'AAPL',
      cusip: '037833100',
      limit: 2,
    });
    const result = await findHoldersTool.handler(input, ctx);

    expect(result.dataset).toBeUndefined();
    const notice = String(getEnrichment(ctx).notice);
    expect(getEnrichment(ctx).truncated).toBe(true);
    expect(notice).not.toContain('secedgar_dataframe_describe');
    expect(notice).toContain('Raise limit');
  });

  describe('without a canvas at the 100-row limit cap', () => {
    beforeEach(() => {
      vi.mocked(getCanvasBridge).mockReturnValue(undefined);
      mockApi.searchFilings.mockResolvedValue(
        eftsPage(
          Array.from({ length: 101 }, (_, i) =>
            hit({ accession: `0000000000-26-${String(i).padStart(6, '0')}` }),
          ),
          101,
        ),
      );
    });

    async function noticeFor(args: Record<string, unknown>) {
      const ctx = createMockContext({ errors: findHoldersTool.errors });
      await findHoldersTool.handler(findHoldersTool.input.parse({ limit: 100, ...args }), ctx);
      expect(getEnrichment(ctx).truncated).toBe(true);
      return String(getEnrichment(ctx).notice);
    }

    it('drops the raise-limit advice and points a name search at cusip', async () => {
      const notice = await noticeFor({ issuer: 'AAPL' });
      expect(notice).not.toContain('Raise limit');
      expect(notice).toContain('Narrow to a single share class with cusip.');
    });

    it('points a cusip search at secedgar_search_filings for the rest', async () => {
      const notice = await noticeFor({ issuer: 'AAPL', cusip: '037833100' });
      expect(notice).not.toContain('Raise limit');
      expect(notice).not.toContain('with cusip');
      expect(notice).toContain(
        'Page the remaining managers with secedgar_search_filings `{"query":"037833100","forms":["13F-HR"],"filed_after":"2026-04-01","filed_before":"2026-06-30","sort":"relevance","offset":0,"limit":100}`,',
      );
      expect(notice).toContain('period_ending="2026-03-31"');
    });
  });

  it('fails when the issuer resolves to a bare CIK with no name to phrase-match', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '9999999999' });
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({ issuer: '9999999999' });

    await expect(findHoldersTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'issuer_not_found' },
    });
  });

  it('fails on an ambiguous issuer name rather than picking one', async () => {
    mockApi.resolveCik.mockResolvedValue([
      { cik: '0001560385', name: 'Liberty Media Corp', ticker: 'FWONA' },
      { cik: '0001611983', name: 'Liberty Broadband Corp', ticker: 'LBRDA' },
    ]);
    const ctx = createMockContext({ errors: findHoldersTool.errors });
    const input = findHoldersTool.input.parse({ issuer: 'Liberty' });

    await expect(findHoldersTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'ambiguous_issuer' },
    });
    expect(mockApi.searchFilings).not.toHaveBeenCalled();
  });

  it('rejects a malformed CUSIP and quarter at the schema', () => {
    expect(() => findHoldersTool.input.parse({ issuer: 'AAPL', cusip: '03783310' })).toThrow();
    expect(() => findHoldersTool.input.parse({ issuer: 'AAPL', cusip: '037833100X' })).toThrow();
    expect(() => findHoldersTool.input.parse({ issuer: 'AAPL', quarter: 'Q1-2026' })).toThrow();
    expect(() => findHoldersTool.input.parse({ issuer: 'AAPL', quarter: '2026-Q5' })).toThrow();
    expect(() => findHoldersTool.input.parse({ issuer: '  ' })).toThrow();
    expect(() => findHoldersTool.input.parse({ issuer: 'AAPL', limit: 1001 })).toThrow();
  });

  it('renders the ordering-bearing counts and every holder into format()', () => {
    const text = findHoldersTool.format?.({
      issuer: 'AAPL',
      resolved_issuer_name: undefined,
      resolved_issuer_cik: undefined,
      search_mode: 'cusip',
      search_key: '037833100',
      quarter: '2026-Q1',
      filed_from: '2026-04-01',
      filed_to: '2026-06-30',
      total_filings: 6652,
      total_is_exact: true,
      fetched: 500,
      holders_in_quarter: 477,
      holders: [
        {
          filer_name: 'BERKSHIRE HATHAWAY INC',
          filer_cik: '0001067983',
          accession_number: '0001193125-26-226661',
          filing_date: '2026-05-15',
          form: '13F-HR',
        },
      ],
      dataset: undefined,
    })?.[0];

    expect(text?.type).toBe('text');
    const rendered = text?.type === 'text' ? text.text : '';
    expect(rendered).toContain('6652 filings in the window');
    expect(rendered).toContain('477 managers reporting 2026-Q1');
    expect(rendered).toContain('BERKSHIRE HATHAWAY INC (CIK 0001067983)');
  });
});

// Through the real argument-parsing path, where `inputAliases` is applied (#152).
describe('findHoldersTool parameter names (#152)', () => {
  const call = (args: Record<string, unknown>) => runToolContract(findHoldersTool, args as never);

  it.each(['issuer', 'company', 'ticker', 'cik', 'ticker_or_cik'])(
    'resolves the issuer from %s',
    async (key) => {
      const result = await call({ [key]: 'AAPL' });

      expect(result.isError).toBeFalsy();
      expect(mockApi.resolveCik).toHaveBeenCalledWith('AAPL', expect.any(CallScope));
      expect(result.structuredContent).toMatchObject({
        issuer: 'AAPL',
        resolved_issuer_name: 'Apple Inc.',
        resolved_issuer_cik: '0000320193',
      });
      expect(blockText(result.content)).toContain('Resolved issuer: Apple Inc. (CIK 0000320193)');
    },
  );

  it('rejects an alias sent beside issuer by name rather than picking one', async () => {
    const result = await call({ issuer: 'AAPL', company: 'MSFT' });

    expect(wireError(result).data.reason).toBe('invalid_arguments');
    expect(blockText(result.content)).toContain('"company"');
    expect(mockApi.resolveCik).not.toHaveBeenCalled();
  });
});

// The name phrase leaves out one trailing qualifier on the conformed name — `\DE\`,
// `/OH/`, `\new` — which 13F information tables do not print (#205).
describe('findHoldersTool — a trailing qualifier on the conformed name (#205)', () => {
  it.each([
    ['US BANCORP \\DE\\', '0000036104', 'USB', '"US BANCORP"'],
    ['PROGRESSIVE CORP/OH/', '0000080661', 'PGR', '"PROGRESSIVE CORP"'],
    ['KVH INDUSTRIES INC \\DE\\', '0001007587', 'KVHI', '"KVH INDUSTRIES INC"'],
    ['Viridian Therapeutics, Inc.\\DE', '0001590750', 'VRDN', '"Viridian Therapeutics, Inc."'],
    ['Protagenic Therapeutics, Inc.\\new', '0001022899', 'PTIX', '"Protagenic Therapeutics, Inc."'],
    // Six letters, the longest qualifier dropped.
    ['Blue Acquisition Corp/Cayman', '0002059654', 'BACC', '"Blue Acquisition Corp"'],
    // One qualifier only: the `/S` of the company form before it stays.
    ['Zealand Pharma A/S/ADR', '0002068427', 'ZLDPF', '"Zealand Pharma A/S"'],
  ])(
    'searches %s without the qualifier and keeps the registry name',
    async (name, cik, ticker, phrase) => {
      mockApi.resolveCik.mockResolvedValue({ cik, name, ticker });

      const result = await runToolContract(findHoldersTool, { issuer: ticker });

      expect(result.isError).toBeFalsy();
      expect(mockApi.searchFilings).toHaveBeenCalledWith(
        expect.objectContaining({ query: phrase, forms: ['13F-HR'] }),
        expect.any(CallScope),
      );
      expect(result.structuredContent).toMatchObject({
        resolved_issuer_name: name,
        resolved_issuer_cik: cik,
        search_mode: 'name',
        search_key: phrase,
      });
      // The registry name reads back whole, its trailing backslash included (#221).
      const text = readCommonMark(blockText(result.content));
      expect(text).toContain(`Resolved issuer: ${name} (CIK ${cik})`);
      expect(text).toContain(`Matched by name: ${phrase}`);
    },
  );

  it.each([
    ['Apple Inc.', '0000320193'],
    ['UNIVERSAL DISPLAY CORP PA', '0001005284'],
    ['CULLEN/FROST BANKERS, INC.', '0000039263'],
    ['M/I HOMES, INC.', '0000799292'],
  ])('quotes %s unchanged, having no delimited trailing qualifier', async (name, cik) => {
    mockApi.resolveCik.mockResolvedValue({ cik, name });

    const result = await runToolContract(findHoldersTool, { issuer: name });

    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({ query: `"${name}"` }),
      expect.any(CallScope),
    );
    expect(result.structuredContent).toMatchObject({
      resolved_issuer_name: name,
      search_key: `"${name}"`,
    });
    expect(blockText(result.content)).toContain(`Matched by name: "${name}"`);
  });
});

// A limit above the 100-filer inline cap is served at 100 while EDGAR_CLAMP_OVERSIZED_LIMITS
// is on; the mechanism itself is tabled in tests/mcp-server/tools/limit-clamp.test.ts (#197).
describe('findHoldersTool — limit above the 100 cap (#197)', () => {
  beforeEach(() => {
    // 101 distinct in-quarter managers across two EFTS pages: more than the applied 100,
    // not more than a requested 101, so each `rows > limit` read decides the outcome.
    const hits = Array.from({ length: 101 }, (_, i) =>
      hit({ accession: `0000000000-26-${String(i).padStart(6, '0')}` }),
    );
    mockApi.searchFilings.mockImplementation(async (params: { from: number }) =>
      eftsPage(hits.slice(params.from, params.from + 100), 101),
    );
  });

  const args = { issuer: 'AAPL', cusip: '037833100' };

  it('answers limit 101 exactly as limit 100, the applied cap included', async () => {
    const at100 = await runToolContract(findHoldersTool, { ...args, limit: 100 });
    const at101 = await runToolContract(findHoldersTool, { ...args, limit: 101 });

    expect(at101).toEqual(at100);
    expect(at101.structuredContent).toMatchObject({
      holders_in_quarter: 101,
      cap: 100,
      shown: 100,
      truncated: true,
    });
    expect(readCommonMark(blockText(at101.content))).toContain(
      '101 managers reporting 2026-Q1, 100 shown',
    );
  });

  it('answers limit 101 exactly as limit 100 when the filers are staged as a dataframe', async () => {
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);

    const at100 = await runToolContract(findHoldersTool, { ...args, limit: 100 });
    const at101 = await runToolContract(findHoldersTool, { ...args, limit: 101 });

    expect(bridge.registerDataframe).toHaveBeenCalledTimes(2);
    expect(bridge.registerDataframe.mock.calls[1]?.[1]).toEqual(
      bridge.registerDataframe.mock.calls[0]?.[1],
    );
    expect(at101).toEqual(at100);
  });

  it('accepts up to 1000 with the switch on; off, advertises 100 and rejects 101', async () => {
    const maximum = (clampOversizedLimits: boolean) =>
      (
        z.toJSONSchema(createFindHoldersTool({ clampOversizedLimits }).input, {
          io: 'input',
        }) as any
      ).properties.limit.maximum;
    expect(maximum(true)).toBe(1000);
    expect(maximum(false)).toBe(100);
    expect(findHoldersTool.input.safeParse({ ...args, limit: 1000 }).success).toBe(true);

    const off = createFindHoldersTool({ clampOversizedLimits: false });
    const rejected = await runToolContract(off, { ...args, limit: 101 });
    expect(rejected.isError).toBe(true);
    expect(wireError(rejected).code).toBe(JsonRpcErrorCode.InvalidParams);
  });
});

/**
 * The notice names each secedgar_search_filings call as JSON. A client renders
 * content[] as Markdown, so each call sits in a code span a CommonMark parse reads
 * back as the exact JSON structuredContent carries — the quoted name phrase's
 * backslashes included (#220).
 */
describe('findHoldersTool — the JSON calls in content[] read back under CommonMark (#220)', () => {
  /** Five full pages of distinct in-quarter managers out of `total` matching documents. */
  function fullBudget(total: number) {
    mockApi.searchFilings.mockImplementation(async (params: { from: number }) =>
      eftsPage(
        Array.from({ length: 100 }, (_, i) =>
          hit({ accession: `0000000000-26-${String(params.from + i).padStart(6, '0')}` }),
        ),
        total,
      ),
    );
  }

  /** The call the notice names, built from the result's own fields. */
  const searchCall = (sc: Record<string, unknown>, offset: number) =>
    JSON.stringify({
      query: sc.search_key,
      forms: ['13F-HR'],
      filed_after: sc.filed_from,
      filed_before: sc.filed_to,
      sort: 'relevance',
      offset,
      limit: 100,
    });

  /** The JSON objects content[] shows as code — the trailer also spans `ordering`, which is prose. */
  const jsonSpans = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    codeSpansIn(allText(result)).filter((span) => span.startsWith('{'));

  it.each([
    ['a quoted phrase', 'US BANCORP \\DE\\', '"US BANCORP"'],
    [
      'backticks and Markdown punctuation',
      'A``B `C` *D* _E_ [F](G) \\H I CORP',
      '"A``B `C` *D* _E_ [F](G) \\H I CORP"',
    ],
  ])(
    'reads the continuation call back exactly for a name holding %s',
    async (_label, name, phrase) => {
      mockApi.resolveCik.mockResolvedValue({ cik: '0000036104', name });
      fullBudget(2315);

      const result = await runToolContract(findHoldersTool, { issuer: 'USB' });

      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.search_key).toBe(phrase);
      const call = searchCall(sc, 500);
      expect(String(sc.notice)).toContain(call);
      expect(jsonSpans(result)).toEqual([call]);
      expect(JSON.parse(call).query).toBe(phrase);
    },
  );

  it('reads the first-page and continuation calls of one notice back exactly, in order', async () => {
    fullBudget(6462);

    const result = await runToolContract(findHoldersTool, {
      issuer: 'AAPL',
      cusip: '037833100',
      limit: 100,
    });

    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({ fetched: 500, holders_in_quarter: 500, truncated: true });
    expect(jsonSpans(result)).toEqual([searchCall(sc, 0), searchCall(sc, 500)]);
  });
});

/**
 * Two registrants whose names match once the trailing qualifier is gone search the
 * same phrase and get the same holders, so a name search says which other current
 * registrant the phrase also names and points to cusip (#224). Rows as SEC's
 * company_tickers.json lists them; a former name carries no ticker.
 */
describe('findHoldersTool — another registrant named by the searched phrase (#224)', () => {
  const REGISTRY = [
    { cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' },
    { cik: '0000036104', name: 'US BANCORP \\DE\\', ticker: 'USB' },
    { cik: '0000036104', name: 'US BANCORP \\DE\\', ticker: 'USB-PA' },
    { cik: '0000080661', name: 'PROGRESSIVE CORP/OH/', ticker: 'PGR' },
    { cik: '0001057706', name: 'FIRST BANCORP /PR/', ticker: 'FBP' },
    { cik: '0000776901', name: 'INDEPENDENT BANK CORP', ticker: 'INDB' },
    { cik: '0000811589', name: 'FIRST BANCORP /NC/', ticker: 'FBNC' },
    { cik: '0000039311', name: 'INDEPENDENT BANK CORP /MI/', ticker: 'IBCP' },
    // The phrase sits inside this title, which is the over-match the description states.
    { cik: '0000765207', name: 'First Bancorp, Inc /ME/', ticker: 'FNLC' },
    { cik: '0002107968', name: 'WISeQey Corp.', ticker: 'WQEY' },
    { cik: '0002102907', name: 'Resolution Minerals Ltd', ticker: 'RML' },
    { cik: '0001738699', name: 'WISeQey Corp.', ticker: 'WSKEF' },
    { cik: '0002086869', name: 'RESOLUTION MINERALS LTD/ADR', ticker: 'RLMLF' },
    // Former names: never current registrants, so never named.
    { cik: '0000000901', name: 'apple inc.' },
    { cik: '0000000902', name: 'progressive corp' },
  ];
  const row = (ticker: string) => {
    const entry = REGISTRY.find((e) => e.ticker === ticker);
    if (!entry) throw new Error(`No registry row for ${ticker}.`);
    return entry;
  };
  const sentence = (phrase: string, others: string, which: string) =>
    `${phrase} is also the name of ${others}, so these holders can include ${which}. Pass cusip to match one issuer.`;

  beforeEach(() => {
    mockApi.getAllEntries.mockResolvedValue(REGISTRY);
  });

  /** A name-mode call for `ticker`, its registry row as the resolution. */
  async function holdersOf(ticker: string, args: Record<string, unknown> = {}) {
    mockApi.resolveCik.mockResolvedValue(row(ticker));
    return runToolContract(findHoldersTool, { issuer: ticker, ...args });
  }

  it.each([
    ['FBP', '"FIRST BANCORP"', 'FBNC'],
    ['FBNC', '"FIRST BANCORP"', 'FBP'],
    ['IBCP', '"INDEPENDENT BANK CORP"', 'INDB'],
    ['INDB', '"INDEPENDENT BANK CORP"', 'IBCP'],
    ['RLMLF', '"RESOLUTION MINERALS LTD"', 'RML'],
    ['RML', '"Resolution Minerals Ltd"', 'RLMLF'],
    ['WQEY', '"WISeQey Corp."', 'WSKEF'],
    ['WSKEF', '"WISeQey Corp."', 'WQEY'],
  ])(
    'names the other registrant searched by %s’s phrase on both surfaces',
    async (ticker, phrase, other) => {
      const { cik, name } = row(other);
      const expected = sentence(phrase, `${name} (CIK ${cik}, ${other})`, "that company's");

      const result = await holdersOf(ticker);

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        resolved_issuer_name: row(ticker).name,
        resolved_issuer_cik: row(ticker).cik,
        search_mode: 'name',
        search_key: phrase,
        total_filings: 1,
        holders_in_quarter: 1,
        holders: [{ accession_number: '0001193125-26-226661' }],
        notice: expected,
      });
      expect(readCommonMark(allText(result))).toContain(expected);
      expect(mockApi.searchFilings).toHaveBeenCalledTimes(1);
      expect(mockApi.searchFilings).toHaveBeenCalledWith(
        expect.objectContaining({ query: phrase }),
        expect.any(CallScope),
      );
    },
  );

  it.each([
    ['USB', 'one CIK listed under several tickers'],
    ['PGR', 'a former name equal to the phrase'],
    ['AAPL', 'a former name equal to the title'],
  ])('adds nothing for %s — %s', async (ticker) => {
    const result = await holdersOf(ticker);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(allText(result)).not.toContain('is also the name of');
  });

  it('lists every other registrant the phrase names, in registry order', async () => {
    const third = { cik: '0000000003', name: 'First Bancorp /VA/', ticker: 'FBVA' };
    mockApi.getAllEntries.mockResolvedValue([...REGISTRY, third]);

    const result = await holdersOf('FBP');

    const expected = sentence(
      '"FIRST BANCORP"',
      'FIRST BANCORP /NC/ (CIK 0000811589, FBNC) and First Bancorp /VA/ (CIK 0000000003, FBVA)',
      "those companies'",
    );
    expect(bag(result.structuredContent).notice).toBe(expected);
    expect(readCommonMark(allText(result))).toContain(expected);
  });

  it('reads a registrant name holding Markdown punctuation back under CommonMark', async () => {
    const searched = { cik: '0000000011', name: 'A*B* `C` [D](E) CORP /DE/', ticker: 'ABDE' };
    const other = { cik: '0000000012', name: 'a*b* `c` [d](e) corp', ticker: 'ABCO' };
    mockApi.getAllEntries.mockResolvedValue([searched, other]);
    mockApi.resolveCik.mockResolvedValue(searched);

    const result = await runToolContract(findHoldersTool, { issuer: 'ABDE' });

    expect(readCommonMark(allText(result))).toContain(
      sentence(
        '"A*B* `C` [D](E) CORP"',
        'a*b* `c` [d](e) corp (CIK 0000000012, ABCO)',
        "that company's",
      ),
    );
  });

  it('composes the sentence with the cap guidance and the continuation recipe', async () => {
    mockApi.searchFilings.mockImplementation(async (params: { from: number }) =>
      eftsPage(
        Array.from({ length: 100 }, (_, i) =>
          hit({ accession: `0000000000-26-${String(params.from + i).padStart(6, '0')}` }),
        ),
        6462,
      ),
    );

    const result = await holdersOf('IBCP', { limit: 1 });

    const sc = bag(result.structuredContent);
    expect(sc).toMatchObject({ truncated: true, shown: 1, cap: 1, holders_in_quarter: 500 });
    const notice = String(sc.notice);
    expect(notice).toContain(
      sentence(
        '"INDEPENDENT BANK CORP"',
        'INDEPENDENT BANK CORP (CIK 0000776901, INDB)',
        "that company's",
      ),
    );
    expect(notice).toContain('Raise limit to see more inline');
    expect(notice).toContain('Continue with secedgar_search_filings');
  });

  it('composes the sentence with the other-quarters notice', async () => {
    mockApi.searchFilings.mockResolvedValue(
      eftsPage([hit({ accession: '0000000002-26-000002', periodEnding: '2025-12-31' })], 1),
    );

    const result = await holdersOf('INDB');

    const notice = String(bag(result.structuredContent).notice);
    expect(notice).toContain('amendments restating other quarters');
    expect(notice).toContain(
      'is also the name of INDEPENDENT BANK CORP /MI/ (CIK 0000039311, IBCP)',
    );
  });

  it('leaves a zero-hit result with only the zero-hit notice', async () => {
    mockApi.searchFilings.mockResolvedValue(eftsPage([], 0));

    const result = await holdersOf('FBP');

    const notice = String(bag(result.structuredContent).notice);
    expect(notice).toMatch(/^No 13F-HR filings matched the phrase "FIRST BANCORP" filed /);
    expect(notice).not.toContain('is also the name of');
  });

  it('never adds it in cusip mode, and reads no registry', async () => {
    mockApi.resolveCik.mockResolvedValue(row('FBP'));

    const result = await runToolContract(findHoldersTool, { issuer: 'FBP', cusip: '318672706' });

    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(mockApi.getAllEntries).not.toHaveBeenCalled();
  });
});

/**
 * Every format() value the tool did not author reads back under CommonMark as
 * structuredContent carries it: the issuer echo in bold, the resolved name, the
 * searched phrase, and filer names at the start of a list item (#221).
 */
describe('findHoldersTool — format() values read back under CommonMark (#221)', () => {
  it('reads each interpolated value back as structuredContent carries it', async () => {
    const name = 'A *B* _C_ `D` [E](F) &amp; \\DE\\';
    mockApi.resolveCik.mockResolvedValue({ cik: '0000000021', name, ticker: 'ABCD' });
    mockApi.searchFilings.mockResolvedValue(
      eftsPage(
        [
          hit({
            accession: '0000000001-26-000001',
            cik: '0000000031',
            name: '1. FUND *ONE* LLC  (CIK 0000000031)',
          }),
          hit({
            accession: '0000000002-26-000002',
            cik: '0000000032',
            name: '# HEDGE `CO` \\  (CIK 0000000032)',
          }),
        ],
        2,
      ),
    );

    const result = await runToolContract(findHoldersTool, { issuer: name });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      issuer: name,
      resolved_issuer_name: name,
      search_key: '"A *B* _C_ `D` [E](F) &amp;"',
      holders: [
        { filer_name: '1. FUND *ONE* LLC', filer_cik: '0000000031' },
        { filer_name: '# HEDGE `CO` \\', filer_cik: '0000000032' },
      ],
    });
    const text = readCommonMark(blockText(result.content));
    expect(text).toContain(`⟨strong⟩13F holders of ${name}⟨/strong⟩ — 2026-Q1`);
    expect(text).toContain(`Resolved issuer: ${name} (CIK 0000000021)`);
    expect(text).toContain('Matched by name: "A *B* _C_ `D` [E](F) &amp;"');
    expect(text).toContain(
      '⟨list_item_open⟩\n\n1. FUND *ONE* LLC (CIK 0000000031) — 13F-HR 2026-05-15 [0000000001-26-000001]',
    );
    expect(text).toContain(
      '⟨list_item_open⟩\n\n# HEDGE `CO` \\ (CIK 0000000032) — 13F-HR 2026-05-15 [0000000002-26-000002]',
    );
    expect(text).not.toMatch(/⟨(ordered_list_open|heading_open|em|code_inline|a )/);
  });
});
