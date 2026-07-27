/**
 * @fileoverview Tests for find-holders — the 13F reverse lookup. Covers quarter
 * defaulting and the filing window, the reporting-period filter, CUSIP vs name
 * search modes, the paging budget, and both zero-hit causes.
 * @module tests/mcp-server/tools/definitions/find-holders.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findHoldersTool } from '@/mcp-server/tools/definitions/find-holders.tool.js';
import type { EftsHit, EftsResponse } from '@/services/edgar/types.js';

vi.mock('@/services/edgar/edgar-api-service.js', async (importActual) => {
  const actual = await importActual<typeof import('@/services/edgar/edgar-api-service.js')>();
  return {
    ...actual,
    getEdgarApiService: vi.fn(),
    initEdgarApiService: vi.fn(),
  };
});

import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
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
  resolveCik: vi.fn(),
  searchFilings: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.mocked(getCanvasBridge).mockReturnValue(undefined as never);
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as never);
  mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
  mockApi.searchFilings.mockResolvedValue(
    eftsPage([hit({ accession: '0001193125-26-226661' })], 1),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('findHoldersTool', () => {
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
    );
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
    expect(mockApi.searchFilings).toHaveBeenLastCalledWith(expect.objectContaining({ from: 400 }));
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
    expect(() => findHoldersTool.input.parse({ issuer: 'AAPL', limit: 101 })).toThrow();
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
