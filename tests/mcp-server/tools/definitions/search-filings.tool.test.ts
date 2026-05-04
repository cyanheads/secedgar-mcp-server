/**
 * @fileoverview Tests for search-filings tool — full-text EDGAR filing search.
 * @module tests/mcp-server/tools/definitions/search-filings.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchFilingsTool } from '@/mcp-server/tools/definitions/search-filings.tool.js';
import type { EftsResponse } from '@/services/edgar/types.js';

vi.mock('@/services/edgar/edgar-api-service.js', () => ({
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
}));

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
