/**
 * @fileoverview Tests for search-filings tool — full-text EDGAR filing search.
 * @module tests/mcp-server/tools/definitions/search-filings.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchFilingsTool } from '@/mcp-server/tools/definitions/search-filings.tool.js';
import type { EftsResponse } from '@/services/edgar/types.js';

// Preserve the real pure helpers the tool imports (quartersInRange,
// selectArchivePages); only the service singleton getter is mocked.
vi.mock('@/services/edgar/edgar-api-service.js', async (importActual) => {
  const actual = await importActual<typeof import('@/services/edgar/edgar-api-service.js')>();
  return {
    ...actual,
    getEdgarApiService: vi.fn(),
    initEdgarApiService: vi.fn(),
  };
});

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  toDatasetField: (r: { tableName: string; rowCount: number; expiresAt: string }) => ({
    name: r.tableName,
    row_count: r.rowCount,
    expires_at: r.expiresAt,
  }),
}));

import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';

const mockEftsResponse: EftsResponse = {
  hits: {
    total: { value: 42, relation: 'eq' },
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
};

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

    expect(result.total).toBe(42);
    expect(result.total_is_exact).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].accession_number).toBe('0000320193-23-000106');
    expect(result.results[0].form).toBe('10-K');
    expect(result.results[0].company_name).toBe('Apple Inc.');
  });

  it('passes through caller offset/limit when sort=relevance', async () => {
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'revenue growth',
      forms: ['10-K', '10-Q'],
      start_date: '2023-01-01',
      end_date: '2023-12-31',
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

  it('extracts form distribution from aggregations', async () => {
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'test' });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(result.form_distribution).toEqual({ '10-K': 20, '10-Q': 22 });
  });

  it('handles missing aggregations', async () => {
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      aggregations: undefined,
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'test' });
    const result = await searchFilingsTool.handler(input, ctx);

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

    expect(result.results[0].accession_number).toBe('0000320193-23-000106');
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

    expect(result.results[0].ticker).toBe('AAPL');
    expect(result.results[0].company_name).toBe('Apple Inc.');
    expect(result.results[1].ticker).toBe('BRK-A');
    expect(result.results[1].company_name).toBe('BERKSHIRE HATHAWAY INC');
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

    expect(result.results[0].ticker).toBeUndefined();
    expect(result.results[0].company_name).toBe('Some Private Co.');
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
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: { total: { value: 15, relation: 'eq' }, hits: [] },
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
    expect(result.total).toBe(15);
    expect(result.total_is_exact).toBe(true);

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
      start_date: '2026-06-25',
      end_date: '2026-07-04',
    });
    const result = await searchFilingsTool.handler(input, ctx);

    // Empty query string reaches the service, which omits `q` from the EFTS request.
    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({ query: '', forms: ['S-1'] }),
    );
    expect(result.total).toBe(80);
    expect(result.results[0].form).toBe('S-1');
  });

  it('rejects a date-range-only browse with no query or forms — missing_criteria (#79)', async () => {
    // Matches live EFTS: a bare date range with no forms/query/entity is "Blank search
    // not valid". The guard fires before any EFTS call.
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      start_date: '2026-06-25',
      end_date: '2026-07-04',
    });

    await expect(searchFilingsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'missing_criteria' },
    });
    expect(mockApi.searchFilings).not.toHaveBeenCalled();
  });

  it('allows entity-scope-only browse via cik: with no forms/query — regression guard (#79)', async () => {
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: { total: { value: 5, relation: 'eq' }, hits: [] },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    // cik: carries raw content, so the both-absent guard does not fire even with no forms.
    const input = searchFilingsTool.input.parse({ query: 'cik:320193' });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({ query: '', ciks: ['0000320193'] }),
    );
    expect(result.total).toBe(5);
  });

  it('zero-hit forms-only browse notice names the forms, not an empty query (#79)', async () => {
    mockApi.searchFilings.mockResolvedValue({
      ...mockEftsResponse,
      hits: { total: { value: 0, relation: 'eq' }, hits: [] },
    });
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      forms: ['S-1'],
      start_date: '2026-06-25',
      end_date: '2026-07-04',
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
      start_date: '2022-01-01',
      end_date: '2022-06-30',
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

    expect(result.total).toBe(10000);
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
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('42 filings');
    expect(blocks[0].text).toContain('10-K');
    expect(blocks[0].text).toContain('Form distribution');
  });

  it('formats non-exact total with capped note', () => {
    const output = {
      total: 10000,
      total_is_exact: false,
      results: [],
    };
    const blocks = searchFilingsTool.format!(output);
    expect(blocks[0].text).toContain('capped at 10,000');
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
    const text = searchFilingsTool.format!(output)[0].text;
    expect(text).toContain('source: submissions');
    expect(text).toContain('source: efts');
  });

  // --- Pre-2001 date routing to the archives (#77) ---

  it('declares the pre-2001 routing reasons in the errors contract (#77)', () => {
    const byReason = new Map(searchFilingsTool.errors?.map((e) => [e.reason, e]));
    for (const reason of [
      'straddling_date_range',
      'pre2001_full_text_unscoped',
      'pre2001_full_text_scoped',
    ]) {
      expect(byReason.get(reason)?.code).toBe(JsonRpcErrorCode.ValidationError);
    }
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
      start_date: '1996-01-01',
      end_date: '1999-12-31',
    });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(mockApi.searchFilings).not.toHaveBeenCalled();
    expect(mockApi.getSubmissions).toHaveBeenCalledWith('0000320193');
    expect(result.total).toBe(2);
    expect(result.results.every((r) => r.source === 'submissions')).toBe(true);
    // Newest-first by default; both recent 10-Ks fall inside the window.
    expect(result.results[0].filing_date).toBe('1999-12-01');
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
      start_date: '1993-01-01',
      end_date: '1996-12-31',
    });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(mockApi.fetchArchivePage).toHaveBeenCalledWith('CIK0000320193-submissions-001.json');
    expect(result.total).toBe(1);
    expect(result.results[0].accession_number).toBe('0000320193-94-000005');
    expect(result.results[0].source).toBe('submissions');
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
      start_date: '1998-01-01',
      end_date: '1998-03-31',
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
      start_date: '1993-01-01',
      end_date: '2000-12-31',
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

  it('rejects a straddling range with straddling_date_range and no fetch (#77)', async () => {
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: '',
      forms: ['10-K'],
      start_date: '1998-01-01',
      end_date: '2003-01-01',
    });
    await expect(searchFilingsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'straddling_date_range',
        recovery: { hint: expect.stringContaining('2001-01-01') },
      },
    });
    expect(mockApi.searchFilings).not.toHaveBeenCalled();
    expect(mockApi.getSubmissions).not.toHaveBeenCalled();
    expect(mockApi.fetchFullIndexQuarter).not.toHaveBeenCalled();
  });

  it('rejects pre-2001 free-text without entity scope (pre2001_full_text_unscoped) (#77)', async () => {
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'revenue',
      start_date: '1998-01-01',
      end_date: '1998-12-31',
    });
    await expect(searchFilingsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'pre2001_full_text_unscoped' },
    });
    expect(mockApi.searchFilings).not.toHaveBeenCalled();
  });

  it('rejects pre-2001 free-text with entity scope (pre2001_full_text_scoped) — no silent term drop (#77)', async () => {
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'cik:320193 revenue',
      start_date: '1998-01-01',
      end_date: '1998-12-31',
    });
    await expect(searchFilingsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'pre2001_full_text_scoped',
        recovery: { hint: expect.stringContaining('form and date') },
      },
    });
    expect(mockApi.searchFilings).not.toHaveBeenCalled();
    expect(mockApi.getSubmissions).not.toHaveBeenCalled();
  });

  it('treats end_date 2000-12-31 as pre-2001 → archive full-index, not EFTS (#77)', async () => {
    mockApi.fetchFullIndexQuarter.mockResolvedValue([]);
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: '',
      forms: ['10-K'],
      start_date: '2000-10-01',
      end_date: '2000-12-31',
    });
    await searchFilingsTool.handler(input, ctx);

    expect(mockApi.fetchFullIndexQuarter).toHaveBeenCalled();
    expect(mockApi.searchFilings).not.toHaveBeenCalled();
  });

  it('treats start_date 2001-01-01 as EFTS, not archive — post-2001 unchanged, source: efts (#77)', async () => {
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'revenue',
      start_date: '2001-01-01',
      end_date: '2001-12-31',
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
      start_date: '1998-01-01',
      end_date: '1998-03-31',
    });
    const result = await searchFilingsTool.handler(input, ctx);

    expect(result.total).toBe(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('full-index');
  });
});
