/**
 * @fileoverview Tests for company-search tool — entity lookup with optional filings.
 * @module tests/mcp-server/tools/definitions/company-search.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { companySearchTool } from '@/mcp-server/tools/definitions/company-search.tool.js';
import type { SubmissionsResponse } from '@/services/edgar/types.js';

vi.mock('@/services/edgar/edgar-api-service.js', () => ({
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
}));

import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';

const mockSubmissions: SubmissionsResponse = {
  cik: '0000320193',
  entityType: 'operating',
  exchanges: ['Nasdaq'],
  filings: {
    recent: {
      accessionNumber: ['0000320193-23-000106', '0000320193-23-000077'],
      filingDate: ['2023-11-03', '2023-08-04'],
      form: ['10-K', '10-Q'],
      primaryDocDescription: ['10-K', '10-Q'],
      primaryDocument: ['aapl-20230930.htm', 'aapl-20230701.htm'],
      reportDate: ['2023-09-30', '2023-07-01'],
    },
    files: [],
  },
  fiscalYearEnd: '0930',
  name: 'Apple Inc.',
  sic: '3571',
  sicDescription: 'ELECTRONIC COMPUTERS',
  stateOfIncorporation: 'CA',
  tickers: ['AAPL'],
};

const mockApi = {
  resolveCik: vi.fn(),
  getSubmissions: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as any);
  mockApi.getSubmissions.mockResolvedValue(mockSubmissions);
});

describe('companySearchTool', () => {
  it('returns company info for a single match', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL' });
    const result = await companySearchTool.handler(input, ctx);

    expect(result.cik).toBe('0000320193');
    expect(result.name).toBe('Apple Inc.');
    expect(result.tickers).toEqual(['AAPL']);
    expect(result.sic).toBe('3571');
    expect(result.fiscal_year_end).toBe('0930');
  });

  it('includes filings by default', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL' });
    const result = await companySearchTool.handler(input, ctx);

    expect(result.filings).toBeDefined();
    expect(result.filings!.length).toBe(2);
    expect(result.filings![0].form).toBe('10-K');
    expect(result.total_filings).toBe(2);
  });

  it('excludes filings when include_filings is false', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL', include_filings: false });
    const result = await companySearchTool.handler(input, ctx);

    expect(result.filings).toBeUndefined();
    expect(result.total_filings).toBeUndefined();
  });

  it('filters filings by form_types', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL', form_types: ['10-K'] });
    const result = await companySearchTool.handler(input, ctx);

    expect(result.filings).toHaveLength(1);
    expect(result.filings![0].form).toBe('10-K');
    expect(result.total_filings).toBe(1);
  });

  it('applies filing_limit', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL', filing_limit: 1 });
    const result = await companySearchTool.handler(input, ctx);

    expect(result.filings).toHaveLength(1);
    expect(result.total_filings).toBe(2);
  });

  it('throws notFound when no matches', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'XYZNOTREAL' });

    await expect(companySearchTool.handler(input, ctx)).rejects.toThrow(/No company found/);
  });

  it('throws notFound when multiple matches', async () => {
    mockApi.resolveCik.mockResolvedValue([
      { cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' },
      { cik: '0000001234', name: 'Apple Corp.', ticker: 'APCO' },
    ]);
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'Apple' });

    await expect(companySearchTool.handler(input, ctx)).rejects.toThrow(/Multiple matches/);
  });

  it('handles array with single match', async () => {
    mockApi.resolveCik.mockResolvedValue([
      { cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' },
    ]);
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL' });
    const result = await companySearchTool.handler(input, ctx);

    expect(result.cik).toBe('0000320193');
  });

  it('formats output correctly', () => {
    const output = {
      cik: '0000320193',
      name: 'Apple Inc.',
      tickers: ['AAPL'],
      exchanges: ['Nasdaq'],
      sic: '3571',
      sic_description: 'ELECTRONIC COMPUTERS',
      fiscal_year_end: '0930',
      filings: [
        {
          accession_number: '0000320193-23-000106',
          form: '10-K',
          filing_date: '2023-11-03',
          primary_document: 'aapl-20230930.htm',
        },
      ],
      total_filings: 1,
    };
    const blocks = companySearchTool.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('Apple Inc.');
    expect(blocks[0].text).toContain('AAPL');
    expect(blocks[0].text).toContain('10-K');
  });

  it('formats output without filings', () => {
    const output = {
      cik: '0000320193',
      name: 'Apple Inc.',
      tickers: [],
      exchanges: [],
      sic: '3571',
      sic_description: 'ELECTRONIC COMPUTERS',
      fiscal_year_end: '0930',
    };
    const blocks = companySearchTool.format!(output);
    expect(blocks[0].text).toContain('no ticker');
    expect(blocks[0].text).not.toContain('Recent filings');
  });
});
