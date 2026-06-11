/**
 * @fileoverview Tests for search-filings tool — full-text EDGAR filing search.
 * @module tests/mcp-server/tools/definitions/search-filings.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchFilingsTool } from '@/mcp-server/tools/definitions/search-filings.tool.js';
import type { EftsResponse } from '@/services/edgar/types.js';

vi.mock('@/services/edgar/edgar-api-service.js', () => ({
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
}));

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

const mockApi = { searchFilings: vi.fn() };

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
});
