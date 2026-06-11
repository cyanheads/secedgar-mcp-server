/**
 * @fileoverview Tests for company-search tool — entity lookup with optional filings,
 * fund ticker resolution (series_id/class_id), no-match trigram suggestions,
 * and former-name resolution.
 * @module tests/mcp-server/tools/definitions/company-search.tool
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { companySearchTool } from '@/mcp-server/tools/definitions/company-search.tool.js';
import type { CikMatch, SubmissionsResponse } from '@/services/edgar/types.js';

vi.mock('@/services/edgar/edgar-api-service.js', () => ({
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
  suggestCompanies: vi.fn(),
  pickPreferredTicker: vi.fn(),
  trigramSimilarity: vi.fn(),
}));

import { getEdgarApiService, suggestCompanies } from '@/services/edgar/edgar-api-service.js';

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

const mockVanguardSubmissions: SubmissionsResponse = {
  cik: '0000036405',
  entityType: 'investment-company',
  exchanges: [],
  filings: {
    recent: {
      accessionNumber: ['0000036405-24-000001'],
      filingDate: ['2024-01-15'],
      form: ['N-PORT'],
      primaryDocDescription: ['N-PORT'],
      primaryDocument: ['voo-nport.htm'],
      reportDate: ['2023-12-31'],
    },
    files: [],
  },
  fiscalYearEnd: '1031',
  name: 'Vanguard Index Funds',
  sic: '6726',
  sicDescription: 'INVESTMENT OFFICES, NEC',
  tickers: ['VOO'],
};

const mockMetaSubmissions: SubmissionsResponse = {
  cik: '0001326801',
  entityType: 'operating',
  exchanges: ['Nasdaq'],
  filings: {
    recent: {
      accessionNumber: ['0001326801-24-000001'],
      filingDate: ['2024-02-01'],
      form: ['10-K'],
      primaryDocDescription: ['10-K'],
      primaryDocument: ['meta-20231231.htm'],
      reportDate: ['2023-12-31'],
    },
    files: [],
  },
  fiscalYearEnd: '1231',
  name: 'Meta Platforms, Inc.',
  sic: '7370',
  sicDescription: 'SERVICES-COMPUTER PROGRAMMING, DATA PROCESSING',
  tickers: ['META'],
};

const mockApi = {
  resolveCik: vi.fn(),
  getSubmissions: vi.fn(),
  getAllEntries: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as any);
  vi.mocked(suggestCompanies).mockReturnValue([]);
  mockApi.getSubmissions.mockResolvedValue(mockSubmissions);
  mockApi.getAllEntries.mockResolvedValue([]);
});

describe('companySearchTool', () => {
  // --- Existing behaviour (regression) ---

  it('returns company info for a single match', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL' });
    const result = await companySearchTool.handler(input, ctx);

    expect(result.cik).toBe('0000320193');
    expect(result.name).toBe('Apple Inc.');
    expect(result.tickers).toEqual(['AAPL']);
    expect(result.sic).toBe('3571');
    expect(result.fiscal_year_end).toBe('09-30');
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

  it('throws no_match when zero results, with no suggestions', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    vi.mocked(suggestCompanies).mockReturnValue([]);
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'XYZNOTREAL' });

    await expect(companySearchTool.handler(input, ctx)).rejects.toThrow(/No company found/);
  });

  it('throws multiple_matches when array > 1', async () => {
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

  it('populates enrichment notice when form_types filter returns no filings', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL', form_types: ['S-1'] });
    await companySearchTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('S-1');
  });

  it('does not populate enrichment notice when filings are returned', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL', form_types: ['10-K'] });
    await companySearchTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeUndefined();
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

  // --- ETF/MF fund ticker resolution (#40) ---

  it('resolves a fund ticker and returns series_id and class_id', async () => {
    const vooMatch: CikMatch = {
      cik: '0000036405',
      ticker: 'VOO',
      seriesId: 'S000002839',
      classId: 'C000092055',
    };
    mockApi.resolveCik.mockResolvedValue(vooMatch);
    mockApi.getSubmissions.mockResolvedValue(mockVanguardSubmissions);

    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'VOO' });
    const result = await companySearchTool.handler(input, ctx);

    expect(result.cik).toBe('0000036405');
    expect(result.name).toBe('Vanguard Index Funds');
    expect(result.series_id).toBe('S000002839');
    expect(result.class_id).toBe('C000092055');
  });

  it('does not set series_id/class_id for an equity match', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL' });
    const result = await companySearchTool.handler(input, ctx);

    expect(result.series_id).toBeUndefined();
    expect(result.class_id).toBeUndefined();
  });

  it('formats series_id and class_id in the text output when present', () => {
    const output = {
      cik: '0000036405',
      name: 'Vanguard Index Funds',
      tickers: ['VOO'],
      exchanges: [],
      sic: '6726',
      sic_description: 'INVESTMENT OFFICES, NEC',
      fiscal_year_end: '10-31',
      series_id: 'S000002839',
      class_id: 'C000092055',
    };
    const blocks = companySearchTool.format!(output);
    expect(blocks[0].text).toContain('S000002839');
    expect(blocks[0].text).toContain('C000092055');
  });

  // --- Trigram suggestions on no-match (#41) ---

  it('throws no_match with suggestions when near-matches exist', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    vi.mocked(suggestCompanies).mockReturnValue([
      { cik: '0000789019', name: 'MICROSOFT CORP', ticker: 'MSFT' },
    ]);

    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'Microsfot' });

    let caught: unknown;
    try {
      await companySearchTool.handler(input, ctx);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    const err = caught as { data?: { suggestions?: unknown[] }; message?: string };
    expect(err.data?.suggestions).toBeDefined();
    expect(Array.isArray(err.data?.suggestions)).toBe(true);
    expect((err.data!.suggestions as Array<{ cik: string }>)[0]).toMatchObject({
      cik: '0000789019',
    });
    expect(err.message).toContain('MICROSOFT CORP');
  });

  it('throws a clean no_match (no suggestions key) when trigram finds nothing', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    vi.mocked(suggestCompanies).mockReturnValue([]);

    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'XYZNOTREAL' });

    let caught: unknown;
    try {
      await companySearchTool.handler(input, ctx);
    } catch (e) {
      caught = e;
    }

    const err = caught as { data?: { suggestions?: unknown } };
    expect(err.data?.suggestions).toBeUndefined();
  });

  // --- Former-name resolution (#42) ---

  it('resolves a former name to the current entity', async () => {
    // resolveCik returns Meta's CIK because "Facebook" matched a former-name entry
    const metaMatch: CikMatch = { cik: '0001326801', name: 'facebook inc' };
    mockApi.resolveCik.mockResolvedValue(metaMatch);
    mockApi.getSubmissions.mockResolvedValue(mockMetaSubmissions);

    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'Facebook' });
    const result = await companySearchTool.handler(input, ctx);

    // The handler fetches the current entity name from submissions, not from the CikMatch.
    expect(result.cik).toBe('0001326801');
    expect(result.name).toBe('Meta Platforms, Inc.');
  });

  // --- Whitespace-only query validation (#57) ---

  it('rejects a whitespace-only query at parse time', () => {
    expect(() => companySearchTool.input.parse({ query: '   ' })).toThrow();
  });

  it('rejects an empty query at parse time', () => {
    expect(() => companySearchTool.input.parse({ query: '' })).toThrow();
  });

  // --- Bare-CIK 404 surfaced as no_match (#55) ---

  it('converts a bare-CIK 404 to no_match with recovery hint and no URL in message', async () => {
    // resolveCik returns { cik } with no name/ticker — the bare-CIK fallback path
    mockApi.resolveCik.mockResolvedValue({ cik: '0000099999' });
    mockApi.getSubmissions.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.NotFound,
        'SEC EDGAR API returned 404 for https://data.sec.gov/submissions/CIK0000099999.json',
        { url: 'https://data.sec.gov/submissions/CIK0000099999.json', status: 404 },
      ),
    );

    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: '99999', include_filings: false });

    let caught: unknown;
    try {
      await companySearchTool.handler(input, ctx);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    const err = caught as {
      message?: string;
      data?: { reason?: string; recovery?: { hint?: string } };
    };
    // Must surface as no_match, not a raw 404
    expect(err.data?.reason).toBe('no_match');
    // Recovery hint must be present
    expect(typeof err.data?.recovery?.hint).toBe('string');
    expect(err.data!.recovery!.hint!.length).toBeGreaterThan(0);
    // Internal SEC URL must NOT appear in the error message
    expect(err.message).not.toContain('data.sec.gov');
    expect(err.message).not.toContain('CIK0000099999');
    // Message must reference the query
    expect(err.message).toContain('99999');
  });

  it('propagates a 404 unchanged when the match came from the ticker cache (has name/ticker)', async () => {
    // Cache-hit match carries name and ticker — a 404 from getSubmissions is an EDGAR-side error
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    const edgarError = new McpError(
      JsonRpcErrorCode.NotFound,
      'SEC EDGAR API returned 404 for https://data.sec.gov/submissions/CIK0000320193.json',
      { url: 'https://data.sec.gov/submissions/CIK0000320193.json', status: 404 },
    );
    mockApi.getSubmissions.mockRejectedValue(edgarError);

    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL', include_filings: false });

    let caught: unknown;
    try {
      await companySearchTool.handler(input, ctx);
    } catch (e) {
      caught = e;
    }

    // Must propagate the original error — not converted to no_match
    expect(caught).toBe(edgarError);
  });

  // --- Null upstream fields (private / pre-IPO filers, e.g. SpaceX) ---

  it('sanitizes null exchanges and null fiscal year end so output stays schema-valid', async () => {
    mockApi.resolveCik.mockResolvedValue({
      cik: '0001181412',
      name: 'SPACE EXPLORATION TECHNOLOGIES CORP',
      ticker: 'SPCX',
    });
    mockApi.getSubmissions.mockResolvedValue({
      ...mockSubmissions,
      cik: '0001181412',
      name: 'SPACE EXPLORATION TECHNOLOGIES CORP',
      tickers: ['SPCX'],
      exchanges: [null],
      fiscalYearEnd: null,
    });

    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'SPCX', include_filings: false });
    const result = await companySearchTool.handler(input, ctx);

    expect(result.exchanges).toEqual([]);
    expect(result.fiscal_year_end).toBeUndefined();
    // The framework validates handler output against the declared schema at runtime —
    // a null element here previously threw -32007. Parsing must now succeed.
    expect(() => companySearchTool.output.parse(result)).not.toThrow();
  });
});
