/**
 * @fileoverview Tests for search-filings tool — full-text EDGAR filing search.
 * @module tests/mcp-server/tools/definitions/search-filings.tool
 */

import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchFilingsTool } from '@/mcp-server/tools/definitions/search-filings.tool.js';
import type { EftsResponse } from '@/services/edgar/types.js';

// Preserve the real pure helpers the tool imports (quartersInRange); only the
// service singleton getter is mocked. The archive-page walk lives in its own
// module and runs for real against the mocked `fetchArchivePage`.
vi.mock('@/services/edgar/edgar-api-service.js', async (importActual) => {
  const actual = await importActual<typeof import('@/services/edgar/edgar-api-service.js')>();
  return {
    ...actual,
    getEdgarApiService: vi.fn(),
    initEdgarApiService: vi.fn(),
  };
});

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
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { at, bag, blockAt, blockText, caught, recoveryHint } from '../../../support/assertions.js';

// EFTS also sends form_filter aggregation buckets, which EftsResponse omits and the tool ignores.
const mockEftsResponse: EftsResponse & { aggregations: unknown } = {
  hits: {
    total: { value: 2, relation: 'eq' },
    hits: [
      {
        _id: '0000320193-23-000106:aapl-20230930.htm',
        _source: {
          adsh: '0000320193-23-000106',
          form: '10-K',
          file_date: '2023-11-03',
          period_ending: '2023-09-30',
          display_names: ['Apple Inc.'],
          ciks: ['0000320193'],
          file_description: 'Annual report',
          sics: ['3571'],
          biz_locations: ['CA'],
        },
      },
      {
        _id: '0000320193-23-000077:aapl-20230701.htm',
        _source: {
          adsh: '0000320193-23-000077',
          form: '10-Q',
          file_date: '2023-08-04',
          period_ending: '2023-07-01',
          display_names: ['Apple Inc.'],
          ciks: ['0000320193'],
          sics: ['3571'],
          biz_locations: ['CA'],
        },
      },
    ],
  },
  query: { from: 0, size: 20, query: 'test' },
  aggregations: {
    form_filter: {
      buckets: [
        { key: '10-K', doc_count: 20 },
        { key: '10-Q', doc_count: 22 },
      ],
    },
  },
};

const mockApi = {
  searchFilings: vi.fn(),
  resolveCik: vi.fn(),
  getSubmissions: vi.fn(),
  fetchArchivePage: vi.fn(),
  fetchFullIndexQuarter: vi.fn(),
  tryGetFilingDocument: vi.fn(),
};

/**
 * Build a submissions feed whose `recent` window holds one filing per supplied
 * (accession, date) pair — the pre-2001 arms' input.
 */
function submissionsWith(
  filings: Array<{ accession: string; date: string; form?: string }>,
  name = 'APPLE COMPUTER INC',
) {
  return {
    cik: '0000320193',
    name,
    filings: {
      recent: {
        accessionNumber: filings.map((f) => f.accession),
        form: filings.map((f) => f.form ?? '10-K'),
        filingDate: filings.map((f) => f.date),
        reportDate: filings.map(() => ''),
        primaryDocument: filings.map(() => ''),
        primaryDocDescription: filings.map(() => ''),
      },
      files: [],
    },
  };
}

/** Serve each accession a body of its own, defaulting to text that matches nothing. */
function documentBodies(bodies: Record<string, string>) {
  return vi.fn(async (_cik: string, accession: string) =>
    bodies[accession] === undefined
      ? '<html><body>nothing of interest here</body></html>'
      : `<html><body>${bodies[accession]}</body></html>`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as any);
  vi.mocked(getCanvasBridge).mockReturnValue(undefined);
  mockApi.searchFilings.mockResolvedValue(mockEftsResponse);
});

describe('searchFilingsTool', () => {
  it('returns search results with correct structure', async () => {
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'material weakness' });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(result.total).toBe(2);
    expect(result.total_is_exact).toBe(true);
    expect(result.total_documents).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(at(result.results, 0).accession_number).toBe('0000320193-23-000106');
    expect(at(result.results, 0).form).toBe('10-K');
    expect(at(result.results, 0).company_name).toBe('Apple Inc.');
  });

  it('passes through caller offset/limit when sort=relevance', async () => {
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'revenue growth',
      forms: ['10-K', '10-Q'],
      filed_after: '2023-01-01',
      filed_before: '2023-12-31',
      limit: 10,
      offset: 20,
      sort: 'relevance',
    });
    await searchFilingsTool.handler(input, ctx);

    expect(mockApi.searchFilings).toHaveBeenCalledWith({
      query: 'revenue growth',
      forms: ['10-K', '10-Q'],
      startDate: '2023-01-01',
      endDate: '2023-12-31',
      from: 20,
      size: 10,
    });
  });

  it('over-fetches and applies offset client-side under date sort', async () => {
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'revenue growth',
      forms: ['10-K'],
      limit: 10,
      offset: 20,
    });
    await searchFilingsTool.handler(input, ctx);

    // Default sort is filing_date_desc → fetch the EFTS window (size=100, from=0)
    // so we have enough hits to sort and paginate over.
    expect(mockApi.searchFilings).toHaveBeenCalledWith({
      query: 'revenue growth',
      forms: ['10-K'],
      startDate: undefined,
      endDate: undefined,
      from: 0,
      size: 100,
    });
  });

  it('applies client-side limit slicing', async () => {
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'test', limit: 1 });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
  });

  it('sorts results by filing_date desc by default', async () => {
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 3, relation: 'eq' },
        hits: [
          // Deliberately out of date order — mimics EFTS relevance scoring
          {
            _id: 'a',
            _source: {
              adsh: 'A',
              form: '10-K',
              file_date: '2012-03-01',
              display_names: ['NVIDIA Corp'],
              ciks: ['0001045810'],
            },
          },
          {
            _id: 'b',
            _source: {
              adsh: 'B',
              form: '10-K',
              file_date: '2025-02-26',
              display_names: ['NVIDIA Corp'],
              ciks: ['0001045810'],
            },
          },
          {
            _id: 'c',
            _source: {
              adsh: 'C',
              form: '10-K',
              file_date: '2018-05-15',
              display_names: ['NVIDIA Corp'],
              ciks: ['0001045810'],
            },
          },
        ],
      },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'export controls', limit: 3 });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(result.results.map((r) => r.filing_date)).toEqual([
      '2025-02-26',
      '2018-05-15',
      '2012-03-01',
    ]);
  });

  it('sorts results by filing_date asc when sort=filing_date_asc', async () => {
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 2, relation: 'eq' },
        hits: [
          {
            _id: 'a',
            _source: {
              adsh: 'A',
              file_date: '2025-01-01',
              display_names: ['X'],
              ciks: ['1'],
            },
          },
          {
            _id: 'b',
            _source: {
              adsh: 'B',
              file_date: '2010-01-01',
              display_names: ['X'],
              ciks: ['1'],
            },
          },
        ],
      },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'foo', sort: 'filing_date_asc' });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(result.results.map((r) => r.filing_date)).toEqual(['2010-01-01', '2025-01-01']);
  });

  it('preserves EFTS order when sort=relevance', async () => {
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 2, relation: 'eq' },
        hits: [
          {
            _id: 'a',
            _source: {
              adsh: 'A',
              file_date: '2010-01-01',
              display_names: ['X'],
              ciks: ['1'],
            },
          },
          {
            _id: 'b',
            _source: {
              adsh: 'B',
              file_date: '2025-01-01',
              display_names: ['X'],
              ciks: ['1'],
            },
          },
        ],
      },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'foo', sort: 'relevance' });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(result.results.map((r) => r.filing_date)).toEqual(['2010-01-01', '2025-01-01']);
  });

  it('counts form_distribution from the rows, ignoring the aggregation buckets (#124)', async () => {
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'test' });
    const result = await searchFilingsTool.handler(input, ctx);

    // The fixture's buckets claim 20 + 22 documents; the window holds one filing of each.
    expect(result.form_distribution).toEqual({ '10-K': 1, '10-Q': 1 });
  });

  it('omits form_distribution when no row carries a form', async () => {
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 1, relation: 'eq' },
        hits: [
          {
            _id: '0000320193-23-000106:doc.htm',
            _source: {
              adsh: '0000320193-23-000106',
              file_date: '2023-11-03',
              display_names: ['Test Corp'],
              ciks: ['0000320193'],
            },
          },
        ],
      },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'test' });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.form_distribution).toBeUndefined();
  });

  it('rebuilds form_distribution from hits under entity targeting (server-side ciks scope)', async () => {
    (mockApi as any).resolveCik = vi
      .fn()
      .mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.' });
    // EFTS scopes by the `ciks` param server-side, so the response carries only
    // the entity's filings — no client-side post-filter is involved.
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 2, relation: 'eq' },
        hits: [
          {
            _id: 'a',
            _source: {
              adsh: 'A',
              form: '10-K',
              file_date: '2024-01-01',
              display_names: ['Apple Inc.'],
              ciks: ['0000320193'],
            },
          },
          {
            _id: 'b',
            _source: {
              adsh: 'B',
              form: '10-Q',
              file_date: '2024-04-01',
              display_names: ['Apple Inc.'],
              ciks: ['0000320193'],
            },
          },
        ],
      },
      aggregations: {
        form_filter: {
          buckets: [
            { key: '10-K', doc_count: 1 },
            { key: '10-Q', doc_count: 1 },
          ],
        },
      },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'foo ticker:AAPL' });
    const result = await searchFilingsTool.handler(input, ctx);

    // CIK is sent to EFTS's server-side `ciks` param; the company name is NOT
    // injected into the free-text query.
    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'foo', ciks: ['0000320193'] }),
    );
    expect(result.total).toBe(2);
    expect(result.form_distribution).toEqual({ '10-K': 1, '10-Q': 1 });
  });

  it('reports non-exact totals', async () => {
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: { ...mockEftsResponse.hits, total: { value: 10000, relation: 'gte' } },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'test' });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(result.total_is_exact).toBe(false);
  });

  it('handles empty results', async () => {
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: { total: { value: 0, relation: 'eq' }, hits: [] },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'nonexistent' });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(result.total).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it('populates enrichment effectiveQuery on success', async () => {
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'material weakness' });
    await searchFilingsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('material weakness');
    // notice may be set when total > results.length (truncation); effectiveQuery is the concern here.
  });

  it('populates enrichment notice when results are empty', async () => {
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: { total: { value: 0, relation: 'eq' }, hits: [] },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'zzznomatch' });
    await searchFilingsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('zzznomatch');
  });

  it('handles hits without adsh (falls back to _id)', async () => {
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 1, relation: 'eq' },
        hits: [
          {
            _id: '0000320193-23-000106:doc.htm',
            _source: {
              adsh: '',
              form: '10-K',
              file_date: '2023-11-03',
              display_names: ['Test Corp'],
              ciks: ['0000320193'],
            },
          },
        ],
      },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'test' });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(at(result.results, 0).accession_number).toBe('0000320193-23-000106');
  });

  it('extracts ticker from display_names parenthetical', async () => {
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 2, relation: 'eq' },
        hits: [
          {
            _id: 'a',
            _source: {
              adsh: 'A',
              form: '10-K',
              file_date: '2024-01-01',
              display_names: ['Apple Inc.  (AAPL)  (CIK 0000320193)'],
              ciks: ['0000320193'],
            },
          },
          {
            _id: 'b',
            _source: {
              adsh: 'B',
              form: '10-K',
              file_date: '2024-01-02',
              display_names: ['BERKSHIRE HATHAWAY INC  (BRK-A, BRK-B)  (CIK 0001067983)'],
              ciks: ['0001067983'],
            },
          },
        ],
      },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'test', sort: 'relevance' });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(at(result.results, 0).ticker).toBe('AAPL');
    expect(at(result.results, 0).company_name).toBe('Apple Inc.');
    expect(at(result.results, 1).ticker).toBe('BRK-A');
    expect(at(result.results, 1).company_name).toBe('BERKSHIRE HATHAWAY INC');
  });

  it('omits ticker when display_names has no ticker parenthetical', async () => {
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 1, relation: 'eq' },
        hits: [
          {
            _id: 'a',
            _source: {
              adsh: 'A',
              form: '10-K',
              file_date: '2024-01-01',
              display_names: ['Some Private Co.  (CIK 0001234567)'],
              ciks: ['0001234567'],
            },
          },
        ],
      },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'test' });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(at(result.results, 0).ticker).toBeUndefined();
    expect(at(result.results, 0).company_name).toBe('Some Private Co.');
  });

  it('materializes the entity-scoped EFTS window to a dataframe — single call (#35)', async () => {
    (mockApi as any).resolveCik = vi
      .fn()
      .mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.' });
    const registerDataframe = vi.fn().mockResolvedValue({
      tableName: 'df_TEST1_TEST2',
      rowCount: 30,
      expiresAt: '2026-05-18T00:00:00.000Z',
      columnSchema: [],
    });
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);

    // With server-side `ciks` scoping, every hit in the window is the entity's.
    const aaplHit = (n: number) => ({
      _id: `aapl-${n}`,
      _source: {
        adsh: `A${n}`,
        form: '10-K',
        file_date: `2024-01-${String(n).padStart(2, '0')}`,
        display_names: ['Apple Inc.  (AAPL)  (CIK 0000320193)'],
        ciks: ['0000320193'],
      },
    });
    // limit=5 → 5 inline, 30 in df. EFTS total 200 > window 30 → truncated=true.
    const windowHits = Array.from({ length: 30 }, (_, i) => aaplHit(i + 1));
    mockApi.searchFilings.mockResolvedValueOnce({
      ...mockEftsResponse,
      hits: { total: { value: 200, relation: 'eq' }, hits: windowHits },
    });

    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'ticker:AAPL revenue', limit: 5 });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(mockApi.searchFilings).toHaveBeenCalledOnce();
    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'revenue', ciks: ['0000320193'] }),
    );
    expect(registerDataframe).toHaveBeenCalledOnce();
    const call = registerDataframe.mock.calls[0]![1];
    expect(call.rows).toHaveLength(30);
    expect(call.rows.every((r: any) => r.cik === '0000320193')).toBe(true);
    expect(call.queryParams.entity_cik).toBe('0000320193');
    expect(call.truncated).toBe(true);
    expect(result.dataset?.name).toBe('df_TEST1_TEST2');
    // The 25 rows past the inline window are only reachable through the
    // dataframe, so the truncation guidance names both dataframe tools (#104).
    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('df_TEST1_TEST2');
    expect(notice).toContain('secedgar_dataframe_describe');
    expect(notice).toContain('secedgar_dataframe_query');
    expect(notice.match(/secedgar_dataframe_describe/g)).toHaveLength(1);
  });

  it('skips dataset registration when the entity-scoped hits fit inline', async () => {
    (mockApi as any).resolveCik = vi
      .fn()
      .mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.' });
    const registerDataframe = vi.fn();
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);

    const aaplHit = (n: number) => ({
      _id: `aapl-${n}`,
      _source: {
        adsh: `A${n}`,
        form: '10-K',
        file_date: `2024-01-0${n}`,
        display_names: ['Apple Inc.  (AAPL)  (CIK 0000320193)'],
        ciks: ['0000320193'],
      },
    });
    mockApi.searchFilings.mockResolvedValueOnce({
      ...mockEftsResponse,
      hits: { total: { value: 3, relation: 'eq' }, hits: [aaplHit(1), aaplHit(2), aaplHit(3)] },
    });

    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'ticker:AAPL', limit: 5 });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(registerDataframe).not.toHaveBeenCalled();
    expect(result.dataset).toBeUndefined();
    expect(result.total).toBe(3);
    // Bare ticker: → no free-text query; entity scope is entirely the CIK.
    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({ query: '', ciks: ['0000320193'] }),
    );
  });

  // #61 — bad entity-targeting tokens must fail typed instead of stripping the
  // token and proceeding unscoped (which can leave EFTS a blank query it rejects
  // with a 2xx error body, previously surfacing as a raw TypeError).
  it('unresolved ticker: targeting fails with typed unresolved_ticker, no EFTS call (#61)', async () => {
    (mockApi as any).resolveCik = vi.fn().mockResolvedValue([]);
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'ticker:NOTAREALTICKER', limit: 3 });

    await expect(searchFilingsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'unresolved_ticker',
        recovery: { hint: expect.stringContaining('secedgar_company_search') },
      },
    });
    expect(mockApi.searchFilings).not.toHaveBeenCalled();
  });

  // #110 — the ticker: token reaches resolveCik verbatim, dot included, and whatever
  // it resolves becomes the EFTS entity scope. That resolveCik maps the dotted form
  // onto SEC's hyphenated key is pinned against the real registry shape in
  // tests/services/edgar/edgar-api-service.resolve-cik.test.ts.
  it('scopes ticker:BRK.B to the resolved issuer CIK (#110)', async () => {
    const resolveCik = vi.fn().mockResolvedValue({
      cik: '0001067983',
      name: 'BERKSHIRE HATHAWAY INC',
      ticker: 'BRK-B',
    });
    (mockApi as any).resolveCik = resolveCik;
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: { total: { value: 0, relation: 'eq' }, hits: [] },
    });

    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'ticker:BRK.B insurance', limit: 5 });
    await searchFilingsTool.handler(input, ctx);

    // The dot survives tokenization — resolveCik sees the caller's literal symbol.
    expect(resolveCik).toHaveBeenCalledWith('BRK.B');
    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'insurance', ciks: ['0001067983'] }),
    );
  });

  it('malformed cik: targeting fails with typed invalid_cik, no EFTS call (#61)', async () => {
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'cik:ABC123 revenue' });

    await expect(searchFilingsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_cik',
        recovery: { hint: expect.stringContaining('cik:320193') },
      },
    });
    expect(mockApi.searchFilings).not.toHaveBeenCalled();
  });

  it('declares unresolved_ticker and invalid_cik in the errors contract (#61)', () => {
    const unresolved = searchFilingsTool.errors?.find((e) => e.reason === 'unresolved_ticker');
    const invalidCik = searchFilingsTool.errors?.find((e) => e.reason === 'invalid_cik');
    expect(unresolved?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(invalidCik?.code).toBe(JsonRpcErrorCode.ValidationError);
  });

  it('scopes cik: targeting via the server-side ciks param without injecting the company name (#35)', async () => {
    // CIK 1326801 is Meta (formerly Facebook). The fix must NOT inject the
    // entity's current name as a phrase — that dropped Facebook-era filings on
    // the same CIK. The cik: branch resolves to the padded CIK directly.
    const metaHit = (id: string, date: string) => ({
      _id: id,
      _source: {
        adsh: id.split(':')[0],
        form: '10-K',
        file_date: date,
        display_names: ['Meta Platforms, Inc.  (META)  (CIK 0001326801)'],
        ciks: ['0001326801'],
      },
    });
    // Three matching documents of two filings: the count is the entity's filings (#124).
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 3, relation: 'eq' },
        hits: [
          metaHit('0001326801-13-000003:fb-12312012x10k.htm', '2013-02-01'),
          metaHit('0001326801-13-000003:fb-12312012xex211.htm', '2013-02-01'),
          metaHit('0001326801-24-000012:meta-20231231.htm', '2024-02-02'),
        ],
      },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'cik:1326801 "risk factors"',
      forms: ['10-K'],
      sort: 'filing_date_asc',
    });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({
        query: '"risk factors"',
        ciks: ['0001326801'],
        forms: ['10-K'],
      }),
    );
    // The free-text query carries no injected entity name.
    const sentQuery = mockApi.searchFilings.mock.calls[0]![0].query;
    expect(sentQuery).not.toMatch(/Meta|Facebook/);
    expect(result.total).toBe(2);
    expect(result.total_is_exact).toBe(true);
    expect(result.total_documents).toBe(3);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toContain('0001326801');
    expect(enrichment.effectiveQuery).not.toMatch(/Meta|Facebook/);
  });

  it('uses default limit, offset, and sort', () => {
    const input = searchFilingsTool.input.parse({ query: 'test' });
    expect(input.limit).toBe(20);
    expect(input.offset).toBe(0);
    expect(input.sort).toBe('filing_date_desc');
  });

  // --- Whitespace-only query validation (#57) ---

  it('rejects a whitespace-only query at parse time', () => {
    expect(() => searchFilingsTool.input.parse({ query: '   ' })).toThrow();
  });

  // --- Browse mode: empty query with forms/entity (#79) ---

  it('allows an explicitly-empty or omitted query at parse time (browse sentinel #79)', () => {
    // Empty string is now the browse sentinel — parse accepts it (the handler guard,
    // not the schema, enforces that forms or entity targeting accompanies it).
    expect(() => searchFilingsTool.input.parse({ query: '', forms: ['S-1'] })).not.toThrow();
    expect(() => searchFilingsTool.input.parse({ forms: ['S-1'] })).not.toThrow();
  });

  it('declares missing_criteria in the errors contract (#79)', () => {
    const entry = searchFilingsTool.errors?.find((e) => e.reason === 'missing_criteria');
    expect(entry).toBeDefined();
    expect(entry!.code).toBe(JsonRpcErrorCode.ValidationError);
  });

  it('browses forms-only with no query — sends forms, omits the q term (#79)', async () => {
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 80, relation: 'eq' },
        hits: [
          {
            _id: 's1a',
            _source: {
              adsh: 'S1A',
              form: 'S-1',
              file_date: '2026-07-03',
              display_names: ['Some Issuer Inc.  (CIK 0001234567)'],
              ciks: ['0001234567'],
            },
          },
        ],
      },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      forms: ['S-1'],
      filed_after: '2026-06-25',
      filed_before: '2026-07-04',
    });
    const result = await searchFilingsTool.handler(input, ctx);

    // Empty query string reaches the service, which omits `q` from the EFTS request.
    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({ query: '', forms: ['S-1'] }),
    );
    // A browse matches one document per filing, so EDGAR's count of 80 is the filing
    // count even though the window holds one of them (#124).
    expect(result.total).toBe(80);
    expect(result.total_is_exact).toBe(true);
    expect(result.total_documents).toBe(80);
    expect(at(result.results, 0).form).toBe('S-1');
  });

  it('rejects a date-range-only browse with no query or forms — missing_criteria (#79)', async () => {
    // Matches live EFTS: a bare date range with no forms/query/entity is "Blank search
    // not valid". The guard fires before any EFTS call.
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      filed_after: '2026-06-25',
      filed_before: '2026-07-04',
    });

    await expect(searchFilingsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'missing_criteria' },
    });
    expect(mockApi.searchFilings).not.toHaveBeenCalled();
  });

  it('allows entity-scope-only browse via cik: with no forms/query — regression guard (#79)', async () => {
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    // cik: carries raw content, so the both-absent guard does not fire even with no forms.
    const input = searchFilingsTool.input.parse({ query: 'cik:320193' });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({ query: '', ciks: ['0000320193'] }),
    );
    expect(result.total).toBe(2);
  });

  it('zero-hit forms-only browse notice names the forms, not an empty query (#79)', async () => {
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: { total: { value: 0, relation: 'eq' }, hits: [] },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      forms: ['S-1'],
      filed_after: '2026-06-25',
      filed_before: '2026-07-04',
    });
    await searchFilingsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('forms [S-1]');
    // No empty-quoted-query artifact from the browse path.
    expect(enrichment.notice).not.toContain('""');
  });

  // --- Zero-total notice echoes all criteria including date range (#58) ---

  it('populates enrichment notice with date range when total is zero', async () => {
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: { total: { value: 0, relation: 'eq' }, hits: [] },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'xyzabc123',
      forms: ['S-1'],
      filed_after: '2022-01-01',
      filed_before: '2022-06-30',
    });
    await searchFilingsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('xyzabc123');
    expect(enrichment.notice).toContain('S-1');
    expect(enrichment.notice).toContain('2022-01-01');
    expect(enrichment.notice).toContain('2022-06-30');
  });

  // --- Offset-exceeds-window notice (wideFetch path) vs genuine no-match (#56) ---

  it('fires window-exceeded notice (not no-match) when total > 0 but offset >= fetched window', async () => {
    // EFTS returns total=10000 but only 2 hits in the window (simulates a narrow wideFetch)
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 10000, relation: 'eq' },
        hits: [
          {
            _id: 'a',
            _source: {
              adsh: 'A',
              form: '10-K',
              file_date: '2024-01-01',
              display_names: ['Test Corp'],
              ciks: ['0001234567'],
            },
          },
          {
            _id: 'b',
            _source: {
              adsh: 'B',
              form: '10-K',
              file_date: '2024-01-02',
              display_names: ['Test Corp'],
              ciks: ['0001234567'],
            },
          },
        ],
      },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    // offset=5 exceeds the 2-hit window → sliced to empty, but total > 0
    const input = searchFilingsTool.input.parse({
      query: 'annual report',
      limit: 3,
      offset: 5,
    });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(result.total).toBe(2);
    expect(result.total_documents).toBe(10000);
    expect(result.results).toHaveLength(0);

    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    // Must mention the offset value and a route to sort=relevance or dataframe
    expect(enrichment.notice).toContain('5');
    // Must NOT use the no-match phrasing
    expect(enrichment.notice).not.toContain('No filings matched');
  });

  it('fires no-match notice (not window notice) when total is zero', async () => {
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: { total: { value: 0, relation: 'eq' }, hits: [] },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'zzznomatch2' });
    await searchFilingsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('No filings matched');
    expect(enrichment.notice).toContain('zzznomatch2');
  });

  it('formats output correctly', () => {
    const output = {
      total: 42,
      total_is_exact: true,
      results: [
        {
          accession_number: '0000320193-23-000106',
          form: '10-K',
          filing_date: '2023-11-03',
          company_name: 'Apple Inc.',
          cik: '0000320193',
        },
      ],
      form_distribution: { '10-K': 20, '10-Q': 22 },
    };
    const blocks = searchFilingsTool.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blockAt(blocks).type).toBe('text');
    expect(blockText(blocks)).toContain('42 filings');
    expect(blockText(blocks)).toContain('10-K');
    expect(blockText(blocks)).toContain('Form distribution');
  });

  it('formats a full-text lower bound with its document count, flagging the 10,000 cap', () => {
    const output = {
      total: 94,
      total_is_exact: false,
      total_documents: 10000,
      results: [],
    };
    const text = blockText(searchFilingsTool.format!(output));
    expect(text).toContain('Found 94 filings (lower bound');
    expect(text).toContain('10000+ matching documents');
  });

  it('renders the source marker per row (format-parity)', () => {
    const output = {
      total: 2,
      total_is_exact: true,
      results: [
        {
          accession_number: '0000320193-97-000010',
          form: '10-K',
          filing_date: '1997-12-05',
          company_name: 'APPLE COMPUTER INC',
          cik: '0000320193',
          source: 'submissions' as const,
        },
        {
          accession_number: '0000320193-23-000106',
          form: '10-K',
          filing_date: '2023-11-03',
          company_name: 'Apple Inc.',
          cik: '0000320193',
          source: 'efts' as const,
        },
      ],
    };
    const text = blockText(searchFilingsTool.format!(output));
    expect(text).toContain('source: submissions');
    expect(text).toContain('source: efts');
  });

  // --- Pre-2001 date routing to the archives (#77) ---

  it('declares pre2001_full_text_unscoped and drops the reasons #87 replaced with service', () => {
    const reasons = searchFilingsTool.errors?.map((e) => e.reason) ?? [];
    const byReason = new Map(searchFilingsTool.errors?.map((e) => [e.reason, e]));
    expect(byReason.get('pre2001_full_text_unscoped')?.code).toBe(JsonRpcErrorCode.ValidationError);
    // Both arms now serve these shapes, so a declared-but-unreachable reason would lie.
    expect(reasons).not.toContain('straddling_date_range');
    expect(reasons).not.toContain('pre2001_full_text_scoped');
  });

  it('routes a pre-2001 entity-scoped range to the submissions archive (source: submissions) (#77)', async () => {
    mockApi.getSubmissions.mockResolvedValue({
      cik: '0000320193',
      name: 'APPLE COMPUTER INC',
      filings: {
        recent: {
          accessionNumber: ['0000320193-99-000001', '0000320193-97-000010'],
          form: ['10-K', '10-K'],
          filingDate: ['1999-12-01', '1997-12-05'],
          reportDate: ['1999-09-25', '1997-09-26'],
          primaryDocument: ['', ''],
          primaryDocDescription: ['', ''],
        },
        files: [],
      },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'cik:320193',
      forms: ['10-K'],
      filed_after: '1996-01-01',
      filed_before: '1999-12-31',
    });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(mockApi.searchFilings).not.toHaveBeenCalled();
    expect(mockApi.getSubmissions).toHaveBeenCalledWith('0000320193');
    expect(result.total).toBe(2);
    expect(result.results.every((r) => r.source === 'submissions')).toBe(true);
    // Newest-first by default; both recent 10-Ks fall inside the window.
    expect(at(result.results, 0).filing_date).toBe('1999-12-01');
    expect(result.results.map((r) => r.accession_number)).toContain('0000320193-97-000010');
  });

  it('scans submissions archive pages for older pre-2001 filings (#77, reuses #78 paging)', async () => {
    mockApi.getSubmissions.mockResolvedValue({
      cik: '0000320193',
      name: 'APPLE COMPUTER INC',
      filings: {
        recent: {
          accessionNumber: [],
          form: [],
          filingDate: [],
          reportDate: [],
          primaryDocument: [],
          primaryDocDescription: [],
        },
        files: [
          {
            name: 'CIK0000320193-submissions-001.json',
            filingCount: 1,
            filingFrom: '1994-01-26',
            filingTo: '1996-12-31',
          },
        ],
      },
    });
    mockApi.fetchArchivePage.mockResolvedValue({
      accessionNumber: ['0000320193-94-000005'],
      form: ['10-K'],
      filingDate: ['1994-12-13'],
      reportDate: ['1994-09-30'],
      primaryDocument: [''],
      primaryDocDescription: [''],
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'cik:320193',
      forms: ['10-K'],
      filed_after: '1993-01-01',
      filed_before: '1996-12-31',
    });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(mockApi.fetchArchivePage).toHaveBeenCalledWith('CIK0000320193-submissions-001.json');
    expect(result.total).toBe(1);
    expect(at(result.results, 0).accession_number).toBe('0000320193-94-000005');
    expect(at(result.results, 0).source).toBe('submissions');
  });

  it('routes a pre-2001 unscoped forms/date browse to the full-index (source: full-index) (#77)', async () => {
    mockApi.fetchFullIndexQuarter.mockResolvedValue([
      {
        cik: '0000320193',
        companyName: 'APPLE COMPUTER INC',
        form: '10-K',
        filingDate: '1998-03-05',
        accessionNumber: '0000320193-98-000007',
      },
      {
        cik: '0000320193',
        companyName: 'APPLE COMPUTER INC',
        form: '10-K/A',
        filingDate: '1998-03-20',
        accessionNumber: '0000320193-98-000008',
      },
      {
        cik: '0001000045',
        companyName: 'NICHOLAS FINANCIAL INC',
        form: '10-Q',
        filingDate: '1998-02-13',
        accessionNumber: '0000914317-98-000107',
      },
    ]);
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: '',
      forms: ['10-K'],
      filed_after: '1998-01-01',
      filed_before: '1998-03-31',
    });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(mockApi.searchFilings).not.toHaveBeenCalled();
    expect(mockApi.fetchFullIndexQuarter).toHaveBeenCalledWith(1998, 1);
    // 10-K + 10-K/A match forms:['10-K'] (amendment-aware); 10-Q excluded.
    expect(result.total).toBe(2);
    expect(result.results.every((r) => r.source === 'full-index')).toBe(true);
    expect(result.results.map((r) => r.form).sort()).toEqual(['10-K', '10-K/A']);
  });

  it('caps the full-index quarter scan and discloses truncation with a source-tagged dataframe (#77)', async () => {
    mockApi.fetchFullIndexQuarter.mockImplementation(async (year: number, quarter: number) =>
      Array.from({ length: 5 }, (_, i) => ({
        cik: '0000320193',
        companyName: 'APPLE COMPUTER INC',
        form: '10-K',
        filingDate: `${year}-0${quarter}-1${i}`,
        accessionNumber: `${year}Q${quarter}-000${i}`,
      })),
    );
    const registerDataframe = vi.fn().mockResolvedValue({
      tableName: 'df_FULL1_IDX22',
      rowCount: 40,
      expiresAt: '2026-05-18T00:00:00.000Z',
      columnSchema: [],
    });
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);

    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: '',
      forms: ['10-K'],
      filed_after: '1993-01-01',
      filed_before: '2000-12-31',
      limit: 10,
    });
    const result = await searchFilingsTool.handler(input, ctx);

    // 1993 QTR1..2000 QTR4 = 32 quarters, capped at 8.
    expect(mockApi.fetchFullIndexQuarter).toHaveBeenCalledTimes(8);
    expect(result.total_is_exact).toBe(false);
    expect(result.dataset?.truncated).toBe(true);
    const rows = registerDataframe.mock.calls[0]![1].rows;
    expect(rows.every((r: any) => r.source === 'full-index')).toBe(true);
  });

  it('rejects pre-2001 free-text without entity scope (pre2001_full_text_unscoped) (#77)', async () => {
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'revenue',
      filed_after: '1998-01-01',
      filed_before: '1998-12-31',
    });
    await expect(searchFilingsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'pre2001_full_text_unscoped' },
    });
    expect(mockApi.searchFilings).not.toHaveBeenCalled();
  });

  it('treats filed_before 2000-12-31 as pre-2001 → archive full-index, not EFTS (#77)', async () => {
    mockApi.fetchFullIndexQuarter.mockResolvedValue([]);
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: '',
      forms: ['10-K'],
      filed_after: '2000-10-01',
      filed_before: '2000-12-31',
    });
    await searchFilingsTool.handler(input, ctx);

    expect(mockApi.fetchFullIndexQuarter).toHaveBeenCalled();
    expect(mockApi.searchFilings).not.toHaveBeenCalled();
  });

  it('treats filed_after 2001-01-01 as EFTS, not archive — post-2001 unchanged, source: efts (#77)', async () => {
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'revenue',
      filed_after: '2001-01-01',
      filed_before: '2001-12-31',
    });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(mockApi.searchFilings).toHaveBeenCalled();
    expect(mockApi.fetchFullIndexQuarter).not.toHaveBeenCalled();
    expect(result.results.every((r) => r.source === 'efts')).toBe(true);
  });

  it('tags post-2001 EFTS canvas rows with source: efts (#77)', async () => {
    const registerDataframe = vi.fn().mockResolvedValue({
      tableName: 'df_EFTS1_SRC22',
      rowCount: 30,
      expiresAt: '2026-05-18T00:00:00.000Z',
      columnSchema: [],
    });
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);
    const hit = (n: number) => ({
      _id: `h${n}`,
      _source: {
        adsh: `A${n}`,
        form: '10-K',
        file_date: `2020-01-${String(n).padStart(2, '0')}`,
        display_names: ['X'],
        ciks: ['1'],
      },
    });
    mockApi.searchFilings.mockResolvedValueOnce({
      ...mockEftsResponse,
      hits: {
        total: { value: 60, relation: 'eq' },
        hits: Array.from({ length: 30 }, (_, i) => hit(i + 1)),
      },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'revenue', limit: 5 });
    const result = await searchFilingsTool.handler(input, ctx);

    const rows = registerDataframe.mock.calls[0]![1].rows;
    expect(rows.every((r: any) => r.source === 'efts')).toBe(true);
    expect(result.results.every((r) => r.source === 'efts')).toBe(true);
  });

  it('emits a coverage-boundary notice on a zero-hit pre-2001 browse (#77)', async () => {
    mockApi.fetchFullIndexQuarter.mockResolvedValue([]);
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: '',
      forms: ['SC 13D'],
      filed_after: '1998-01-01',
      filed_before: '1998-03-31',
    });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(result.total).toBe(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('full-index');
  });

  // --- Bare-CIK 404 recovery on the pre-2001 submissions arm (#93) ---

  it('declares entity_not_found in the errors contract (#93)', () => {
    const entry = searchFilingsTool.errors?.find((e) => e.reason === 'entity_not_found');
    expect(entry?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(entry?.recovery).toContain('secedgar_company_search');
  });

  it('converts a bare-CIK 404 on the pre-2001 arm to entity_not_found, URL stripped (#93)', async () => {
    // cik: tokens are only shape-validated, so a filing-agent CIK reaches the
    // submissions feed and 404s. Convert it to the declared contract error.
    mockApi.resolveCik.mockResolvedValue({ cik: '0001193125' });
    mockApi.getSubmissions.mockRejectedValue(
      notFound(
        'SEC EDGAR API returned 404 for https://data.sec.gov/submissions/CIK0001193125.json',
        { url: 'https://data.sec.gov/submissions/CIK0001193125.json', status: 404 },
      ),
    );
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'cik:0001193125',
      filed_after: '1997-01-01',
      filed_before: '1999-12-31',
    });

    const err = await caught(searchFilingsTool.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data.reason).toBe('entity_not_found');
    expect(err.message).toMatch(/accession-number prefix/i);
    expect(recoveryHint(err)).toContain('secedgar_company_search');
    expect(err.message).not.toContain('data.sec.gov');
    expect(err.message).not.toContain('https://');
    expect(JSON.stringify(err.data)).not.toContain('data.sec.gov');
  });

  it('propagates a pre-2001 404 unchanged for a ticker-cache registrant (#93)', async () => {
    // A CIK the ticker cache knows is a real registrant — a 404 there is an
    // EDGAR-side anomaly, not a bad query.
    mockApi.resolveCik.mockResolvedValue({
      cik: '0000320193',
      name: 'Apple Inc.',
      ticker: 'AAPL',
    });
    mockApi.getSubmissions.mockRejectedValue(
      notFound(
        'SEC EDGAR API returned 404 for https://data.sec.gov/submissions/CIK0000320193.json',
        { url: 'https://data.sec.gov/submissions/CIK0000320193.json', status: 404 },
      ),
    );
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'cik:320193',
      filed_after: '1997-01-01',
      filed_before: '1999-12-31',
    });

    const err = await caught(searchFilingsTool.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data?.reason).toBeUndefined();
    expect(err.message).toContain('data.sec.gov');
  });

  // --- Arm 1: bounded pre-2001 local text scan (#87) ---

  it('matches pre-2001 entity-scoped free text by reading documents, and reports the scan (#87)', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith([
        { accession: '0000320193-98-000001', date: '1998-12-01' },
        { accession: '0000320193-97-000010', date: '1997-12-05' },
        { accession: '0000320193-96-000023', date: '1996-12-19' },
      ]),
    );
    mockApi.tryGetFilingDocument = documentBodies({
      '0000320193-97-000010': 'Power Macintosh unit sales rose',
    });

    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'cik:320193 Macintosh',
      forms: ['10-K'],
      filed_after: '1996-01-01',
      filed_before: '1999-12-31',
    });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(mockApi.searchFilings).not.toHaveBeenCalled();
    // The whole accession .txt is the fetched unit — pre-1997 filings expose no
    // per-document name, so there is nothing else to ask for.
    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledTimes(3);
    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledWith(
      '0000320193',
      '0000320193-97-000010',
      '0000320193-97-000010.txt',
    );
    expect(result.results.map((r) => r.accession_number)).toEqual(['0000320193-97-000010']);
    expect(at(result.results, 0).source).toBe('submissions');
    expect(result.total).toBe(1);
    expect(result.total_is_exact).toBe(true);
    expect(result.scan).toEqual({ candidates: 3, scanned: 3, matched: 1, capped: false });
  });

  it('caps the document scan at 50 and reports total as a lower bound (#87)', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith(
        Array.from({ length: 60 }, (_, i) => ({
          accession: `0000320193-99-${String(i).padStart(6, '0')}`,
          date: `1999-${String((i % 12) + 1).padStart(2, '0')}-01`,
        })),
      ),
    );
    mockApi.tryGetFilingDocument = vi.fn(
      async () => '<html><body>Macintosh everywhere</body></html>',
    );

    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'cik:320193 Macintosh',
      filed_after: '1996-01-01',
      filed_before: '1999-12-31',
      limit: 5,
    });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledTimes(50);
    expect(result.scan).toEqual({ candidates: 60, scanned: 50, matched: 50, capped: true });
    expect(result.total).toBe(50);
    expect(result.total_is_exact).toBe(false);
  });

  it('scans the end of the candidate list the sort asks for (#87)', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith([
        { accession: 'NEW', date: '1999-01-01' },
        { accession: 'OLD', date: '1994-01-01' },
      ]),
    );
    mockApi.tryGetFilingDocument = vi.fn(async () => '<html><body>Macintosh</body></html>');

    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    // A cap of 1 is what `limit` cannot express, so drive it through the sort:
    // ascending must reach for the oldest candidate first.
    const input = searchFilingsTool.input.parse({
      query: 'cik:320193 Macintosh',
      filed_after: '1993-01-01',
      filed_before: '1999-12-31',
      sort: 'filing_date_asc',
    });
    await searchFilingsTool.handler(input, ctx);

    expect(mockApi.tryGetFilingDocument.mock.calls.map((c) => c[1])).toEqual(['OLD', 'NEW']);
  });

  it('honors phrase, exclusion, OR, and wildcard syntax in the local scan (#87)', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith([
        { accession: 'PHRASE', date: '1998-01-01' },
        { accession: 'SPLIT', date: '1998-02-01' },
        { accession: 'EXCLUDED', date: '1998-03-01' },
        { accession: 'ALT', date: '1998-04-01' },
        { accession: 'WILD', date: '1998-05-01' },
      ]),
    );
    const bodies = {
      PHRASE: 'a material weakness in internal control',
      SPLIT: 'material improvement and structural weakness',
      EXCLUDED: 'a material weakness, preliminary and unaudited',
      ALT: 'restatement of prior periods',
      WILD: 'accounting policies were revised',
    };

    const run = async (query: string) => {
      mockApi.tryGetFilingDocument = documentBodies(bodies);
      const ctx = createMockContext({ errors: searchFilingsTool.errors });
      const result = await searchFilingsTool.handler(
        searchFilingsTool.input.parse({
          query: `cik:320193 ${query}`,
          filed_after: '1998-01-01',
          filed_before: '1998-12-31',
        }),
        ctx,
      );
      return result.results.map((r) => r.accession_number).sort();
    };

    // Quoted phrase matches adjacency, not the two words anywhere.
    expect(await run('"material weakness"')).toEqual(['EXCLUDED', 'PHRASE']);
    // Exclusion drops a document that otherwise matches.
    expect(await run('"material weakness" -preliminary')).toEqual(['PHRASE']);
    // OR is an alternative between AND-groups.
    expect(await run('restatement OR accounting')).toEqual(['ALT', 'WILD']);
    // Wildcard suffix is prefix matching; the bare term is word-bounded.
    expect(await run('account*')).toEqual(['WILD']);
    expect(await run('account')).toEqual([]);
  });

  it('discloses the whole-submission caveat in the zero-hit notice (#87)', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith([{ accession: 'A', date: '1998-01-01' }]),
    );
    mockApi.tryGetFilingDocument = documentBodies({});

    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'cik:320193 Macintosh',
      filed_after: '1998-01-01',
      filed_before: '1998-12-31',
    });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(result.total).toBe(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('Read 1 of 1 candidate filings');
    expect(enrichment.notice).toContain('attached exhibit');
  });

  it('skips a candidate whose accession .txt is absent rather than failing the scan (#87)', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith([
        { accession: 'GONE', date: '1998-01-01' },
        { accession: 'HERE', date: '1998-02-01' },
      ]),
    );
    mockApi.tryGetFilingDocument = vi.fn(async (_cik: string, accession: string) =>
      accession === 'GONE' ? null : '<html><body>Macintosh</body></html>',
    );

    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'cik:320193 Macintosh',
      filed_after: '1998-01-01',
      filed_before: '1998-12-31',
    });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(result.results.map((r) => r.accession_number)).toEqual(['HERE']);
    expect(result.scan).toEqual({ candidates: 2, scanned: 2, matched: 1, capped: false });
  });

  it('completes the scan when one candidate nests 30,000 levels deep (#118)', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith([
        { accession: 'DEEP', date: '1998-01-01' },
        { accession: 'HERE', date: '1998-02-01' },
      ]),
    );
    mockApi.tryGetFilingDocument = vi.fn(async (_cik: string, accession: string) =>
      accession === 'DEEP'
        ? `<html><body>Macintosh ${'<span>'.repeat(30_000)}x${'</span>'.repeat(30_000)}</body></html>`
        : '<html><body>no match here</body></html>',
    );

    const result = await runToolContract(searchFilingsTool, {
      query: 'cik:320193 Macintosh',
      filed_after: '1998-01-01',
      filed_before: '1998-12-31',
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      results: Array<{ accession_number: string }>;
      scan: unknown;
    };
    expect(structured.results.map((r) => r.accession_number)).toEqual(['DEEP']);
    expect(structured.scan).toEqual({ candidates: 2, scanned: 2, matched: 1, capped: false });
    expect(blockText(result.content)).toContain('DEEP');
  });

  it('matches a phrase found only in a plain exhibit of a submission holding an HTML document (#159)', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith([
        { accession: 'EXHIBIT', date: '2000-11-14', form: '10-Q' },
        { accession: 'BODY', date: '2000-08-14', form: '10-Q' },
      ]),
    );
    // An HTML-era submission: an HTML 10-Q, then a plain-text exhibit.
    const htmlEraSubmission = (exhibit: string) =>
      '<SEC-DOCUMENT>\n<DOCUMENT>\n<TYPE>10-Q\n<FILENAME>d81726e10-q.htm\n<TEXT>\n<HTML><BODY><P>Item 1. Financial Statements</P></BODY></HTML>\n</TEXT>\n</DOCUMENT>\n' +
      `<DOCUMENT>\n<TYPE>EX-10.1\n<FILENAME>d81726ex10-1.txt\n<TEXT>\n${exhibit}\n</TEXT>\n</DOCUMENT>\n</SEC-DOCUMENT>\n`;
    mockApi.tryGetFilingDocument = vi.fn(async (_cik: string, accession: string) =>
      htmlEraSubmission(
        accession === 'EXHIBIT'
          ? '                    FOURTEENTH AMENDMENT TO THE\n         THIRD AMENDED AND RESTATED AGREEMENT'
          : 'SECOND AMENDMENT TO THE CREDIT AGREEMENT',
      ),
    );

    const result = await runToolContract(searchFilingsTool, {
      query: 'cik:320193 "fourteenth amendment"',
      filed_after: '2000-01-01',
      filed_before: '2000-12-31',
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      results: Array<{ accession_number: string }>;
      scan: unknown;
    };
    expect(structured.results.map((r) => r.accession_number)).toEqual(['EXHIBIT']);
    expect(structured.scan).toEqual({ candidates: 2, scanned: 2, matched: 1, capped: false });
    expect(blockText(result.content)).toContain('EXHIBIT');
    expect(blockText(result.content)).toContain('2 candidate filings, 1 matched');
  });

  it('renders the scan disclosure in format() (format-parity) (#87)', () => {
    const text = blockText(
      searchFilingsTool.format!({
        total: 23,
        total_is_exact: false,
        results: [],
        scan: { candidates: 112, scanned: 50, matched: 23, capped: true },
      }),
    );

    expect(text).toContain('read 50 of 112 candidate filings, 23 matched');
    expect(text).toContain('Capped — the remaining 62 went unread');
    expect(text).toContain('attached exhibit');

    // The uncapped case says so rather than going silent — a reader must be able
    // to tell a complete read from a partial one without inspecting counts.
    const uncapped = blockText(
      searchFilingsTool.format!({
        total: 1,
        total_is_exact: true,
        results: [],
        scan: { candidates: 3, scanned: 3, matched: 1, capped: false },
      }),
    );
    expect(uncapped).toContain('Not capped — every candidate was read.');
  });

  // --- Arm 2: straddling-range auto-split and merge (#87) ---

  it('splits a straddling entity-scoped range at 2001-01-01 and merges both sources (#87)', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith([
        { accession: '0000320193-00-000001', date: '2000-12-14' },
        { accession: '0000320193-99-000001', date: '1999-12-22' },
      ]),
    );
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 1, relation: 'eq' },
        hits: [
          {
            _id: 'e1',
            _source: {
              adsh: '0001047469-02-007674',
              form: '10-K',
              file_date: '2002-12-19',
              period_ending: '2002-09-28',
              display_names: ['Apple Computer Inc  (AAPL)  (CIK 0000320193)'],
              ciks: ['0000320193'],
              sics: ['3571'],
              biz_locations: ['CA'],
            },
          },
        ],
      },
    });

    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'cik:320193',
      forms: ['10-K'],
      filed_after: '1999-01-01',
      filed_before: '2003-12-31',
      limit: 20,
    });
    const result = await searchFilingsTool.handler(input, ctx);

    // EFTS is asked only for the era it indexes; the archives cover the rest.
    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({
        ciks: ['0000320193'],
        startDate: '2001-01-01',
        endDate: '2003-12-31',
        from: 0,
        size: 100,
      }),
    );
    expect(mockApi.getSubmissions).toHaveBeenCalledWith('0000320193');

    expect(result.results.map((r) => r.source)).toEqual(['efts', 'submissions', 'submissions']);
    expect(result.results.map((r) => r.filing_date)).toEqual([
      '2002-12-19',
      '2000-12-14',
      '1999-12-22',
    ]);
    // total counts both eras' filings: 2 archive rows + the full-text side's 1.
    expect(result.total).toBe(3);
    expect(result.total_is_exact).toBe(true);
  });

  it('leaves the EFTS-only fields null on the archive half of a merge (#87)', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith([{ accession: 'ARCHIVE', date: '2000-06-01' }]),
    );
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 1, relation: 'eq' },
        hits: [
          {
            _id: 'e1',
            _source: {
              adsh: 'EFTS',
              form: '10-K',
              file_date: '2002-12-19',
              period_ending: '2002-09-28',
              display_names: ['Apple Computer Inc  (AAPL)  (CIK 0000320193)'],
              ciks: ['0000320193'],
              file_description: 'Annual report',
              sics: ['3571'],
              biz_locations: ['CA'],
            },
          },
        ],
      },
    });

    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'cik:320193',
      forms: ['10-K'],
      filed_after: '2000-01-01',
      filed_before: '2003-12-31',
    });
    const result = await searchFilingsTool.handler(input, ctx);

    const efts = result.results.find((r) => r.source === 'efts')!;
    const archive = result.results.find((r) => r.source === 'submissions')!;
    expect(efts.period_ending).toBe('2002-09-28');
    expect(efts.ticker).toBe('AAPL');
    expect(efts.sic).toBe('3571');
    for (const field of [
      'period_ending',
      'ticker',
      'file_description',
      'matched_documents',
      'sic',
      'location',
    ] as const) {
      expect(archive[field]).toBeUndefined();
    }
  });

  it('splits a straddling unscoped forms browse across full-index and EFTS (#87)', async () => {
    mockApi.fetchFullIndexQuarter.mockResolvedValue([
      {
        cik: '0000320193',
        companyName: 'APPLE COMPUTER INC',
        form: '10-K',
        filingDate: '2000-12-14',
        accessionNumber: 'IDX1',
      },
    ]);
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 4067, relation: 'eq' },
        hits: [
          {
            _id: 'e1',
            _source: {
              adsh: 'EFTS1',
              form: '10-K',
              file_date: '2001-03-30',
              display_names: ['Some Issuer'],
              ciks: ['0001234567'],
            },
          },
        ],
      },
    });

    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: '',
      forms: ['10-K'],
      filed_after: '2000-10-01',
      filed_before: '2001-03-31',
      limit: 20,
    });
    const result = await searchFilingsTool.handler(input, ctx);

    // The full-index side stops at 2000-12-31, so only Q4 2000 is scanned.
    expect(mockApi.fetchFullIndexQuarter).toHaveBeenCalledTimes(1);
    expect(mockApi.fetchFullIndexQuarter).toHaveBeenCalledWith(2000, 4);
    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: '2001-01-01', endDate: '2001-03-31' }),
    );
    expect(result.results.map((r) => r.source)).toEqual(['efts', 'full-index']);
    // The full-text side's one-filing window of 4,067 documents makes the sum a lower bound.
    expect(result.total).toBe(2);
    expect(result.total_is_exact).toBe(false);
    expect(result.total_documents).toBe(4067);
  });

  it('runs the local scan on the archive half of a straddling free-text search (#87)', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith([
        { accession: 'HIT', date: '2000-12-14' },
        { accession: 'MISS', date: '1999-12-22' },
      ]),
    );
    mockApi.tryGetFilingDocument = documentBodies({ HIT: 'Power Macintosh' });
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 1, relation: 'eq' },
        hits: [
          {
            _id: 'e1',
            _source: {
              adsh: 'EFTS1',
              form: '10-K',
              file_date: '2002-12-19',
              display_names: ['Apple Computer Inc'],
              ciks: ['0000320193'],
            },
          },
        ],
      },
    });

    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'cik:320193 Macintosh',
      forms: ['10-K'],
      filed_after: '1999-01-01',
      filed_before: '2003-12-31',
    });
    const result = await searchFilingsTool.handler(input, ctx);

    // EFTS gets the text terms server-side; the archive half is matched locally.
    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Macintosh', startDate: '2001-01-01' }),
    );
    expect(result.scan).toEqual({ candidates: 2, scanned: 2, matched: 1, capped: false });
    expect(result.results.map((r) => r.accession_number)).toEqual(['EFTS1', 'HIT']);
    expect(result.total).toBe(2);
  });

  it('rejects a straddling free-text search with no entity scope, before any fetch (#87)', async () => {
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'material weakness',
      filed_after: '1998-01-01',
      filed_before: '2004-12-31',
    });

    const err = await caught(searchFilingsTool.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('pre2001_full_text_unscoped');
    // Names the unservable half, not the whole range.
    expect(err.message).toContain('1998-01-01..2000-12-31');
    expect(mockApi.searchFilings).not.toHaveBeenCalled();
    expect(mockApi.getSubmissions).not.toHaveBeenCalled();
  });

  it('offsets into the merged row list, not either source window (#87)', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith([
        { accession: 'ARCH1', date: '2000-12-01' },
        { accession: 'ARCH2', date: '2000-11-01' },
      ]),
    );
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 2, relation: 'eq' },
        hits: [
          {
            _id: 'e1',
            _source: {
              adsh: 'EFTS1',
              form: '10-K',
              file_date: '2002-01-01',
              display_names: ['X'],
              ciks: ['0000320193'],
            },
          },
          {
            _id: 'e2',
            _source: {
              adsh: 'EFTS2',
              form: '10-K',
              file_date: '2001-01-02',
              display_names: ['X'],
              ciks: ['0000320193'],
            },
          },
        ],
      },
    });

    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'cik:320193',
      forms: ['10-K'],
      filed_after: '2000-01-01',
      filed_before: '2003-12-31',
      limit: 2,
      offset: 1,
    });
    const result = await searchFilingsTool.handler(input, ctx);

    // Merged, date-descending: EFTS1, EFTS2, ARCH1, ARCH2 → offset 1 crosses the
    // source boundary, which an offset scoped to one source could never do.
    expect(result.results.map((r) => r.accession_number)).toEqual(['EFTS2', 'ARCH1']);
  });

  it('registers the merged rows as one source-tagged dataframe (#87)', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith([
        { accession: 'ARCH1', date: '2000-12-01' },
        { accession: 'ARCH2', date: '2000-11-01' },
      ]),
    );
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 500, relation: 'eq' },
        hits: [
          {
            _id: 'e1',
            _source: {
              adsh: 'EFTS1',
              form: '10-K',
              file_date: '2002-01-01',
              display_names: ['X'],
              ciks: ['0000320193'],
            },
          },
        ],
      },
    });
    const registerDataframe = vi.fn().mockResolvedValue({
      tableName: 'df_MERGE_ROWS11',
      rowCount: 3,
      expiresAt: '2026-05-18T00:00:00.000Z',
      columnSchema: [],
    });
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);

    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'cik:320193',
      forms: ['10-K'],
      filed_after: '2000-01-01',
      filed_before: '2003-12-31',
      limit: 1,
    });
    const result = await searchFilingsTool.handler(input, ctx);

    const call = registerDataframe.mock.calls[0]![1];
    expect(call.rows.map((r: any) => r.source)).toEqual(['efts', 'submissions', 'submissions']);
    expect(call.queryParams.source).toBe('efts+archive');
    // EFTS reported 500 matching documents behind a 1-row window — more exists than was materialized.
    expect(call.truncated).toBe(true);
    expect(result.dataset?.truncated).toBe(true);
    // Second success path that registers a dataframe — it carries the same
    // describe-then-query pointer as the 2001-onward path (#104).
    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('df_MERGE_ROWS11');
    expect(notice).toContain('secedgar_dataframe_describe');
    expect(notice).toContain('secedgar_dataframe_query');
    expect(notice.match(/secedgar_dataframe_describe/g)).toHaveLength(1);
  });

  it('promises no pointer on the merged path when the canvas is unavailable (#104)', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith([
        { accession: 'ARCH1', date: '2000-12-01' },
        { accession: 'ARCH2', date: '2000-11-01' },
      ]),
    );
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 500, relation: 'eq' },
        hits: [
          {
            _id: 'e1',
            _source: {
              adsh: 'EFTS1',
              form: '10-K',
              file_date: '2002-01-01',
              display_names: ['X'],
              ciks: ['0000320193'],
            },
          },
        ],
      },
    });
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);

    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'cik:320193',
      forms: ['10-K'],
      filed_after: '2000-01-01',
      filed_before: '2003-12-31',
      limit: 1,
    });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(result.dataset).toBeUndefined();
    expect(String(getEnrichment(ctx).notice)).not.toContain('secedgar_dataframe_describe');
  });

  // --- Offset past the assembled rows ---

  /** A forms-only browse across 2001-01-01: one archive row plus a one-filing window of 4,067 documents. */
  const crossingBrowse = (offset: number) => {
    mockApi.fetchFullIndexQuarter.mockResolvedValue([
      {
        cik: '0000320193',
        companyName: 'APPLE COMPUTER INC',
        form: '10-K',
        filingDate: '2000-12-14',
        accessionNumber: 'IDX1',
      },
    ]);
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 4067, relation: 'eq' },
        hits: [
          {
            _id: 'e1',
            _source: {
              adsh: 'EFTS1',
              form: '10-K',
              file_date: '2001-03-30',
              display_names: ['Some Issuer'],
              ciks: ['0001234567'],
            },
          },
        ],
      },
    });
    return runToolContract(searchFilingsTool, {
      query: '',
      forms: ['10-K'],
      filed_after: '2000-10-01',
      filed_before: '2001-03-31',
      offset,
    });
  };

  it('names the way to the rest when an offset passes assembled rows that are a lower bound', async () => {
    const result = await crossingBrowse(5);

    const notice = String(bag(result.structuredContent).notice);
    expect(notice).toMatch(
      /^Offset \(5\) exceeds the 2 filings this search assembled — lower the offset\. /,
    );
    expect(notice).toContain(
      'search 2001-01-01 to 2001-03-31 on its own to page through the rest.',
    );
    expect(notice).toContain('More matches exist beyond the rows fetched — narrow the range.');
    // The enrichment trailer carries the notice to content[] as well.
    expect(result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')).toContain(
      notice,
    );
    expect(bag(result.structuredContent).total_is_exact).toBe(false);
  });

  it('names the capped archive scan when an offset passes a pre-2001 browse it truncated', async () => {
    mockApi.fetchFullIndexQuarter.mockResolvedValue([
      {
        cik: '0000320193',
        companyName: 'APPLE COMPUTER INC',
        form: '10-K',
        filingDate: '1999-12-14',
        accessionNumber: 'IDX1',
      },
    ]);

    const result = await runToolContract(searchFilingsTool, {
      query: '',
      forms: ['10-K'],
      filed_after: '1993-01-01',
      filed_before: '2000-12-31',
      offset: 3,
    });

    expect(bag(result.structuredContent).notice).toBe(
      'Offset (3) exceeds the 1 filings this search assembled — lower the offset. Served from the quarterly EDGAR full-index — full-text search covers 2001-present only. More matches exist beyond the rows fetched — narrow the range.',
    );
  });

  it('keeps the bare lower-the-offset notice when the assembled rows are every match', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith([{ accession: 'ARCH1', date: '2000-12-01' }]),
    );
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: {
        total: { value: 1, relation: 'eq' },
        hits: [
          {
            _id: 'e1',
            _source: {
              adsh: 'EFTS1',
              form: '10-K',
              file_date: '2002-01-01',
              display_names: ['X'],
              ciks: ['0000320193'],
            },
          },
        ],
      },
    });

    const result = await runToolContract(searchFilingsTool, {
      query: 'cik:320193',
      forms: ['10-K'],
      filed_after: '2000-01-01',
      filed_before: '2003-12-31',
      offset: 4,
    });

    expect(bag(result.structuredContent).notice).toBe(
      'Offset (4) exceeds the 2 filings this search assembled — lower the offset.',
    );
  });

  it("describes a crossing range's total as its archive rows plus one window, never EDGAR's count (#124)", () => {
    const { shape } = searchFilingsTool.output;
    const total = String(shape.total.description);
    expect(total).toContain("A forms- or entity-only browse from 2001 on gives EDGAR's own count");
    expect(total).not.toContain("A forms- or entity-only browse gives EDGAR's own count");
    expect(String(shape.results.element.shape.source.description)).toContain(
      'total sums its archive rows and the filings of one 100-document full-text window',
    );
  });
});

/**
 * The live `"going concern" ticker:TSLA` response: EFTS answers one hit per matching
 * document, `_id` is `<accession>:<filename>`, and 18 documents span 14 filings.
 * Columns: `_id`, form, file_type, file_description, file_date — in rank order.
 */
const TSLA_GOING_CONCERN = [
  ['0001193125-16-665620:d200129dex101.htm', '8-K', 'EX-10.1', 'EX-10.1', '2016-08-01'],
  ['0001193125-16-665621:d200129dex101.htm', '425', 'EX-10.1', 'EX-10.1', '2016-08-01'],
  ['0001564590-17-015705:tsla-ex103_121.htm', '10-Q', 'EX-10.3', 'EX-10.3', '2017-08-04'],
  [
    '0001193125-10-017054:dex1027.htm',
    'S-1',
    'EX-10.27',
    'SUPPLY AGREEMENT - SANYO ELECTRIC CO. LTD',
    '2010-01-29',
  ],
  ['0001564590-17-015705:tsla-ex101_122.htm', '10-Q', 'EX-10.1', 'EX-10.1', '2017-08-04'],
  ['0001564590-16-026820:tsla-10q_20160930.htm', '10-Q', '10-Q', '10-Q', '2016-11-02'],
  ['0001564590-17-003118:tsla-ex991_2714.htm', '10-K', 'EX-99.1', 'EX-99.1', '2017-03-01'],
  ['0001564590-17-003118:tsla-10k_20161231.htm', '10-K', '10-K', '10-K', '2017-03-01'],
  ['0000950170-23-001409:tsla-ex10_59.htm', '10-K', 'EX-10.59', 'EX-10.59', '2023-01-31'],
  ['0001104659-24-053372:tm2412112d4_ars.pdf', 'ARS', 'ARS', 'ARS', '2024-04-29'],
  ['0001104659-24-053333:tm2326076d14_def14a.pdf', 'DEF 14A', 'DEF 14A', 'PDF', '2024-04-29'],
  ['0001564590-16-026820:tsla-ex102_708.htm', '10-Q', 'EX-10.2', 'EX-10.2', '2016-11-02'],
  [
    '0001193125-10-129878:dex1037.htm',
    'S-1/A',
    'EX-10.37',
    'LOAN ARRANGEMENT AND REIMBURSEMENT AGREEMENT',
    '2010-05-27',
  ],
  ['0001193125-19-095913:d625340dex1068.htm', 'S-4/A', 'EX-10.68', 'EX-10.68', '2019-04-03'],
  [
    '0001104659-24-053333:tm2326076d15_def14a.htm',
    'DEF 14A',
    'DEF 14A',
    'FORM DEF14A',
    '2024-04-29',
  ],
  ['0001104659-24-048040:tm2326076d13_pre14a.htm', 'PRE 14A', 'PRE 14A', 'PRE 14A', '2024-04-17'],
  ['0001564590-21-004599:tsla-ex1044_13.htm', '10-K', 'EX-10.44', 'EX-10.44', '2021-02-08'],
  ['0001193125-15-222013:d942001dex101.htm', '8-K', 'EX-10.1', 'EX-10.1', '2015-06-12'],
] as const;

/** The form_filter buckets EFTS sent with that response — document counts by root form. */
const TSLA_FORM_AGGREGATION = [
  { key: '10-K', doc_count: 4 },
  { key: '10-Q', doc_count: 4 },
  { key: '8-K', doc_count: 2 },
  { key: 'DEF 14A', doc_count: 2 },
  { key: 'S-1', doc_count: 2 },
  { key: '425', doc_count: 1 },
  { key: 'ARS', doc_count: 1 },
  { key: 'PRE 14A', doc_count: 1 },
  { key: 'S-4', doc_count: 1 },
];

/** The same response's filings by form — 14 accessions, amendments kept apart. */
const TSLA_FILINGS_BY_FORM = {
  '8-K': 2,
  '425': 1,
  '10-Q': 2,
  'S-1': 1,
  '10-K': 3,
  ARS: 1,
  'DEF 14A': 1,
  'S-1/A': 1,
  'S-4/A': 1,
  'PRE 14A': 1,
};

/** One matching document as an EFTS hit. */
function documentHit(
  id: string,
  form: string,
  fileType: string,
  fileDescription: string | null,
  fileDate: string,
) {
  return {
    _id: id,
    _source: {
      adsh: id.split(':')[0] ?? '',
      form,
      file_type: fileType,
      file_description: fileDescription,
      file_date: fileDate,
      display_names: ['Tesla, Inc.  (TSLA)  (CIK 0001318605)'],
      ciks: ['0001318605'],
      sics: ['3711'],
      biz_locations: ['Palo Alto, CA'],
    },
  };
}

/** An EFTS response holding `hits`, reporting `value` matching documents. */
function eftsWindow(
  hits: ReturnType<typeof documentHit>[],
  value = hits.length,
  relation: 'eq' | 'gte' = 'eq',
) {
  return {
    hits: { total: { value, relation }, hits },
    query: { from: 0, size: 100, query: '' },
    aggregations: { form_filter: { buckets: TSLA_FORM_AGGREGATION } },
  };
}

const tslaHits = () =>
  TSLA_GOING_CONCERN.map(([id, form, type, description, date]) =>
    documentHit(id, form, type, description, date),
  );

/** A contract result's structuredContent: the domain output plus the enrichment fields. */
type SearchContent = ReturnType<typeof searchFilingsTool.output.parse> & {
  truncated?: boolean;
  notice?: string;
};

describe('searchFilingsTool — one row per filing (#124)', () => {
  const call = (args: Record<string, unknown>) => runToolContract(searchFilingsTool, args as never);
  const tsla = { cik: '0001318605', name: 'Tesla, Inc.', ticker: 'TSLA' };

  it('collapses the documents of one filing into one row that lists them', async () => {
    mockApi.resolveCik.mockResolvedValue(tsla);
    mockApi.searchFilings.mockResolvedValue(eftsWindow(tslaHits()));

    const result = await call({ query: '"going concern" ticker:TSLA', limit: 3 });
    const out = result.structuredContent as SearchContent;

    expect(out.total).toBe(14);
    expect(out.total_is_exact).toBe(true);
    expect(out.total_documents).toBe(18);
    // Newest first: the three 2024 filings, the two-document proxy counted once.
    expect(out.results.map((r) => r.accession_number)).toEqual([
      '0001104659-24-053372',
      '0001104659-24-053333',
      '0001104659-24-048040',
    ]);
    const proxy = at(out.results, 1);
    // The first-ranked document's fields, and every matching document in rank order.
    expect(proxy.file_description).toBe('PDF');
    expect(proxy.matched_documents).toEqual([
      { name: 'tm2326076d14_def14a.pdf', type: 'DEF 14A' },
      { name: 'tm2326076d15_def14a.htm', type: 'DEF 14A' },
    ]);
    expect(at(out.results, 0).matched_documents).toEqual([
      { name: 'tm2412112d4_ars.pdf', type: 'ARS' },
    ]);

    const text = blockText(result.content);
    expect(text).toContain('Found 14 filings (exact)');
    expect(text).toContain('18 matching documents');
    expect(text).toContain(
      'matched documents: tm2326076d14_def14a.pdf (DEF 14A), tm2326076d15_def14a.htm (DEF 14A)',
    );
    expect(text.split('[0001104659-24-053333]')).toHaveLength(2);
  });

  it('reads form_distribution from the filings in hand, not the document-count aggregation', async () => {
    mockApi.searchFilings.mockResolvedValue(eftsWindow(tslaHits()));

    const result = await searchFilingsTool.handler(
      searchFilingsTool.input.parse({ query: '"going concern"' }),
      createMockContext({ errors: searchFilingsTool.errors }),
    );

    expect(result.form_distribution).toEqual(TSLA_FILINGS_BY_FORM);
    const counted = Object.values(result.form_distribution ?? {}).reduce((a, b) => a + b, 0);
    expect(counted).toBe(result.total);
  });

  it('stages one dataframe row per accession with a comma-separated matched_documents column', async () => {
    mockApi.resolveCik.mockResolvedValue(tsla);
    mockApi.searchFilings.mockResolvedValue(eftsWindow(tslaHits()));
    const registerDataframe = vi.fn().mockResolvedValue({
      tableName: 'df_TSLA1_GOING2',
      rowCount: 14,
      expiresAt: '2026-10-05T00:00:00.000Z',
      columnSchema: [],
    });
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);

    const result = await searchFilingsTool.handler(
      searchFilingsTool.input.parse({ query: '"going concern" ticker:TSLA', limit: 3 }),
      createMockContext({ errors: searchFilingsTool.errors }),
    );

    const { rows, truncated } = registerDataframe.mock.calls[0]![1];
    expect(rows).toHaveLength(14);
    expect(new Set(rows.map((r: any) => r.accession_number)).size).toBe(14);
    const byAccession = new Map(rows.map((r: any) => [r.accession_number, r]));
    expect((byAccession.get('0001104659-24-053333') as any).matched_documents).toBe(
      'tm2326076d14_def14a.pdf,tm2326076d15_def14a.htm',
    );
    expect((byAccession.get('0000950170-23-001409') as any).matched_documents).toBe(
      'tsla-ex10_59.htm',
    );
    // The window held every matching document, so nothing lies beyond the dataframe.
    expect(truncated).toBe(false);
    expect(result.dataset?.truncated).toBe(false);
  });

  it('counts the window as a lower bound, keeps the document total, and says why', async () => {
    // Four documents of three filings, out of 1,034 matching documents.
    mockApi.searchFilings.mockResolvedValue(
      eftsWindow(
        [
          documentHit('0000000001-25-000001:a.htm', '8-K', '8-K', '8-K', '2025-04-09'),
          documentHit('0000000001-25-000001:ex99.htm', '8-K', 'EX-99.1', 'EX-99.1', '2025-04-09'),
          documentHit('0000000002-25-000001:b.htm', '8-K', '8-K', null, '2025-04-08'),
          documentHit('0000000003-25-000001:c.htm', '8-K', '8-K', '8-K', '2025-04-07'),
        ],
        1034,
      ),
    );

    const result = await call({ query: 'tariff', forms: ['8-K'] });
    const out = result.structuredContent as SearchContent;

    expect(out.total).toBe(3);
    expect(out.total_is_exact).toBe(false);
    expect(out.total_documents).toBe(1034);
    expect(out.results).toHaveLength(3);
    // Every filing in hand is shown, yet more exist — the truncation notice still fires.
    expect(out.truncated).toBe(true);
    expect(out.notice).toContain('1034 matching documents');
    // A null file_description stays absent rather than becoming a string.
    expect(at(out.results, 1).file_description).toBeUndefined();
    expect(at(out.results, 1).matched_documents).toEqual([{ name: 'b.htm', type: '8-K' }]);
    const text = blockText(result.content);
    expect(text).toContain('Found 3 filings (lower bound');
    expect(text).toContain('1034 matching documents');
  });

  it.each([
    ['EFTS reports a lower bound (gte)', 'gte' as const, {}],
    [
      'the window starts past 0 (sort=relevance)',
      'eq' as const,
      { sort: 'relevance', offset: 100 },
    ],
  ])(
    'is not exact when %s, even with every document of the window in hand',
    async (_label, relation, args) => {
      const hits = [
        documentHit('0000000001-25-000001:a.htm', '10-K', '10-K', '10-K', '2025-02-01'),
        documentHit('0000000002-25-000001:b.htm', '10-K', '10-K', '10-K', '2025-02-02'),
      ];
      mockApi.searchFilings.mockResolvedValue(eftsWindow(hits, hits.length, relation));

      const result = await searchFilingsTool.handler(
        searchFilingsTool.input.parse({ query: 'impairment', ...args }),
        createMockContext({ errors: searchFilingsTool.errors }),
      );

      expect(result.total).toBe(2);
      expect(result.total_is_exact).toBe(false);
      expect(result.total_documents).toBe(2);
    },
  );

  it('names the documents past a relevance page that ran off the end, not a zero match', async () => {
    mockApi.searchFilings.mockResolvedValue(eftsWindow([], 150));
    const ctx = createMockContext({ errors: searchFilingsTool.errors });

    const result = await searchFilingsTool.handler(
      searchFilingsTool.input.parse({ query: 'impairment', sort: 'relevance', offset: 200 }),
      ctx,
    );

    expect(result.results).toHaveLength(0);
    expect(result.total_documents).toBe(150);
    const notice = String(getEnrichment(ctx).notice);
    expect(notice).not.toContain('No filings matched');
    expect(notice).toContain('Offset (200)');
    expect(notice).toContain('150 matching documents');
  });

  it('says how many documents a relevance page past offset 0 actually fetched', async () => {
    mockApi.searchFilings.mockResolvedValue(
      eftsWindow(
        [
          documentHit('0000000001-25-000001:a.htm', '10-K', '10-K', '10-K', '2025-02-01'),
          documentHit('0000000002-25-000001:b.htm', '10-K', '10-K', '10-K', '2025-02-02'),
        ],
        102,
      ),
    );

    const result = await call({ query: 'impairment', sort: 'relevance', offset: 100 });
    const out = result.structuredContent as SearchContent;

    expect(out.total).toBe(2);
    expect(out.total_is_exact).toBe(false);
    // The last page held two documents, not a 100-document page.
    expect(out.notice).toContain(
      'total counts the filings among the 2 documents fetched from offset 100 of 102 matching documents',
    );
    expect(out.notice).not.toContain('100-document page');
  });

  it('tells an offset past a window that held every match to lower it, without a 100-document window', async () => {
    mockApi.resolveCik.mockResolvedValue(tsla);
    mockApi.searchFilings.mockResolvedValue(eftsWindow(tslaHits()));

    const result = await call({ query: '"going concern" ticker:TSLA', offset: 50 });
    const out = result.structuredContent as SearchContent;

    expect(out.results).toHaveLength(0);
    expect(out.notice).toBe('Offset (50) exceeds the 14 matching filings — lower the offset.');
  });

  describe('a forms- or entity-only browse matches one document per filing', () => {
    /** One primary document per filing — what EDGAR answers when no search terms are sent. */
    const s1Filings = (n: number, form = 'S-1') =>
      Array.from({ length: n }, (_, i) =>
        documentHit(
          `0000000${String(i + 1).padStart(3, '0')}-25-000001:primary.htm`,
          form,
          form,
          form,
          `2025-01-${String(31 - i).padStart(2, '0')}`,
        ),
      );

    it("reports EDGAR's count as the exact filing total, flagging the window the rows came from", async () => {
      mockApi.searchFilings.mockResolvedValue(eftsWindow(s1Filings(3), 264));
      const registerDataframe = vi.fn().mockResolvedValue({
        tableName: 'df_S1BRW_JAN25',
        rowCount: 3,
        expiresAt: '2026-10-05T00:00:00.000Z',
        columnSchema: [],
      });
      vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);

      const result = await call({
        forms: ['S-1'],
        filed_after: '2025-01-01',
        filed_before: '2025-01-31',
        limit: 2,
      });
      const out = result.structuredContent as SearchContent;

      expect(out.total).toBe(264);
      expect(out.total_is_exact).toBe(true);
      expect(out.total_documents).toBe(264);
      // The rows in hand are one window of the 264, so the dataframe is a sample.
      expect(out.dataset).toMatchObject({ row_count: 3, truncated: true });
      expect(out.form_distribution).toEqual({ 'S-1': 3 });
      expect(out.truncated).toBe(true);
      expect(out.notice).toContain('The rows fetched are the first 3 of 264 matching filings');
      expect(blockText(result.content)).toContain('Found 264 filings (exact)');
    });

    it('points at a truncated dataframe as the rows fetched, never the full set (#162)', async () => {
      mockApi.searchFilings.mockResolvedValue(eftsWindow(s1Filings(100), 264));
      const registerDataframe = vi.fn().mockResolvedValue({
        tableName: 'df_S1BRW_JAN25',
        rowCount: 100,
        expiresAt: '2026-10-05T00:00:00.000Z',
        columnSchema: [],
      });
      vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);

      const result = await call({
        forms: ['S-1'],
        filed_after: '2025-01-01',
        filed_before: '2025-01-31',
      });

      expect(result.structuredContent as SearchContent).toMatchObject({
        total: 264,
        dataset: { row_count: 100, truncated: true },
      });
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain(
        'The rows fetched are staged as df_S1BRW_JAN25 (100 rows), not the full set — use secedgar_dataframe_describe',
      );
      expect(text).not.toContain('Full set staged');
    });

    it('counts a browse page past offset 0 under sort=relevance exactly too', async () => {
      mockApi.searchFilings.mockResolvedValue(eftsWindow(s1Filings(2, '8-K'), 150));

      const result = await call({ forms: ['8-K'], sort: 'relevance', offset: 100 });
      const out = result.structuredContent as SearchContent;

      expect(out.total).toBe(150);
      expect(out.total_is_exact).toBe(true);
      expect(out.notice).toContain('page on with offset');
    });

    it('falls back to the window lower bound when the window shows two documents of one filing', async () => {
      mockApi.searchFilings.mockResolvedValue(
        eftsWindow(
          [
            documentHit('0000000001-25-000001:a.htm', 'S-1', 'S-1', 'S-1', '2025-01-31'),
            documentHit('0000000001-25-000001:ex.htm', 'S-1', 'EX-10.1', 'EX-10.1', '2025-01-31'),
            documentHit('0000000002-25-000001:b.htm', 'S-1', 'S-1', 'S-1', '2025-01-30'),
          ],
          50,
        ),
      );

      const result = await call({ forms: ['S-1'] });
      const out = result.structuredContent as SearchContent;

      expect(out.total).toBe(2);
      expect(out.total_is_exact).toBe(false);
      expect(out.total_documents).toBe(50);
    });

    it('keeps counting the window for a search with terms, whose documents outnumber its filings', async () => {
      mockApi.searchFilings.mockResolvedValue(eftsWindow(s1Filings(3), 264));

      const result = await call({ query: 'tariff', forms: ['S-1'] });
      const out = result.structuredContent as SearchContent;

      expect(out.total).toBe(3);
      expect(out.total_is_exact).toBe(false);
    });
  });

  it('collapses master.idx lines that list one accession under several CIKs', async () => {
    // A Schedule 13G is indexed once under the filer and once under the subject company.
    mockApi.fetchFullIndexQuarter.mockResolvedValue([
      {
        cik: '0000102909',
        companyName: 'VANGUARD GROUP INC',
        form: 'SC 13G',
        filingDate: '1999-02-03',
        accessionNumber: '0000102909-99-000101',
      },
      {
        cik: '0000320193',
        companyName: 'APPLE COMPUTER INC',
        form: 'SC 13G',
        filingDate: '1999-02-03',
        accessionNumber: '0000102909-99-000101',
      },
      {
        cik: '0000789019',
        companyName: 'MICROSOFT CORP',
        form: 'SC 13G',
        filingDate: '1999-02-04',
        accessionNumber: '0000950123-99-000777',
      },
    ]);

    const result = await searchFilingsTool.handler(
      searchFilingsTool.input.parse({
        forms: ['SC 13G'],
        filed_after: '1999-02-01',
        filed_before: '1999-02-05',
      }),
      createMockContext({ errors: searchFilingsTool.errors }),
    );

    expect(result.total).toBe(2);
    expect(result.results.map((r) => r.accession_number).sort()).toEqual([
      '0000102909-99-000101',
      '0000950123-99-000777',
    ]);
    // The first index line names the row.
    const collapsed = result.results.find((r) => r.accession_number === '0000102909-99-000101');
    expect(collapsed).toMatchObject({ cik: '0000102909', company_name: 'VANGUARD GROUP INC' });
    expect(result.form_distribution).toEqual({ 'SC 13G': 2 });
    // No full-text side ran, so there is no document count to report.
    expect(result.total_documents).toBeUndefined();
    expect(result.results.every((r) => r.matched_documents === undefined)).toBe(true);
  });

  it('counts filings and reports the document total on a range crossing 2001-01-01', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith([{ accession: '0001318605-00-000001', date: '2000-11-01' }], 'TESLA'),
    );
    mockApi.searchFilings.mockResolvedValue(
      eftsWindow([
        documentHit(
          '0001564590-17-003118:tsla-ex991_2714.htm',
          '10-K',
          'EX-99.1',
          'EX-99.1',
          '2017-03-01',
        ),
        documentHit(
          '0001564590-17-003118:tsla-10k_20161231.htm',
          '10-K',
          '10-K',
          '10-K',
          '2017-03-01',
        ),
        documentHit(
          '0000950170-23-001409:tsla-ex10_59.htm',
          '10-K',
          'EX-10.59',
          'EX-10.59',
          '2023-01-31',
        ),
      ]),
    );
    const registerDataframe = vi.fn().mockResolvedValue({
      tableName: 'df_CROSS_TSLA1',
      rowCount: 3,
      expiresAt: '2026-10-05T00:00:00.000Z',
      columnSchema: [],
    });
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);

    const result = await searchFilingsTool.handler(
      searchFilingsTool.input.parse({
        query: 'cik:1318605',
        forms: ['10-K'],
        filed_after: '2000-01-01',
        filed_before: '2024-12-31',
        limit: 1,
      }),
      createMockContext({ errors: searchFilingsTool.errors }),
    );

    // One archive filing plus two full-text filings across three documents.
    expect(result.total).toBe(3);
    expect(result.total_is_exact).toBe(true);
    expect(result.total_documents).toBe(3);
    expect(result.form_distribution).toEqual({ '10-K': 3 });
    const rows = registerDataframe.mock.calls[0]![1].rows;
    expect(rows.map((r: any) => [r.source, r.matched_documents])).toEqual([
      ['efts', 'tsla-ex10_59.htm'],
      ['efts', 'tsla-ex991_2714.htm,tsla-10k_20161231.htm'],
      ['submissions', null],
    ]);
  });

  it('says offset counts documents under sort=relevance, so a filing can recur', () => {
    const description = searchFilingsTool.input.shape.offset.description ?? '';
    expect(description).toMatch(/sort=relevance[^.]*counts (matching )?documents/);
    expect(description).toContain('recur');
  });
});

// Through the real argument-parsing path, where `inputAliases` is applied (#115).
describe('searchFilingsTool parameter names (#115)', () => {
  const call = (args: Record<string, unknown>) => runToolContract(searchFilingsTool, args as never);

  it.each([
    ['filed_after', 'filed_before'],
    ['start_date', 'end_date'],
    ['date_from', 'date_to'],
  ])('bounds the filing date with %s / %s', async (after, before) => {
    const result = await call({
      query: 'material weakness',
      [after]: '2023-01-01',
      [before]: '2023-12-31',
    });

    expect(result.isError).toBeFalsy();
    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: '2023-01-01', endDate: '2023-12-31' }),
    );
    expect(result.structuredContent).toMatchObject({ total: 2 });
    expect(blockText(result.content)).toContain('0000320193-23-000106');
  });

  it.each(['forms', 'form_types'])('filters by form with %s', async (key) => {
    const result = await call({ [key]: ['10-K'] });

    expect(result.isError).toBeFalsy();
    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({ forms: ['10-K'] }),
    );
    expect(blockText(result.content)).toContain('Found 2 filings');
  });

  it('names the canonical bounds when a retired spelling arrives with only one of them', async () => {
    const result = await call({ query: 'material weakness', start_date: '2023-01-01' });

    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: { data?: { reason?: string } } }).error;
    expect(error.data?.reason).toBe('invalid_date_range');
    const text = blockText(result.content);
    expect(text).toContain('filed_after');
    expect(text).toContain('filed_before');
    expect(mockApi.searchFilings).not.toHaveBeenCalled();
  });

  it('leaves a singular form_type out — one string cannot fill the forms array', async () => {
    const result = await call({ form_type: '10-K' });

    expect(result.isError).toBe(true);
    expect(blockText(result.content)).toContain('form_type');
    expect(mockApi.searchFilings).not.toHaveBeenCalled();
  });

  it('still rejects an unrelated unknown key by name', async () => {
    const result = await call({ query: 'material weakness', bogus: true });

    expect(result.isError).toBe(true);
    expect(blockText(result.content)).toContain('bogus');
    expect(mockApi.searchFilings).not.toHaveBeenCalled();
  });
});
