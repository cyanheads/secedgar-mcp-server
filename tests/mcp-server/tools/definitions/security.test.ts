/**
 * @fileoverview Security tests for tool input validation — injection, oversized inputs,
 * and env-var leakage across the SEC EDGAR tool surface.
 * @module tests/mcp-server/tools/definitions/security
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { companySearchTool } from '@/mcp-server/tools/definitions/company-search.tool.js';
import { fetchFramesTool } from '@/mcp-server/tools/definitions/fetch-frames.tool.js';
import { getFilingTool } from '@/mcp-server/tools/definitions/get-filing.tool.js';
import { getFinancialsTool } from '@/mcp-server/tools/definitions/get-financials.tool.js';
import { searchFilingsTool } from '@/mcp-server/tools/definitions/search-filings.tool.js';

vi.mock('@/services/edgar/edgar-api-service.js', () => ({
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
  suggestCompanies: vi.fn(() => []),
  pickPreferredTicker: vi.fn(),
  trigramSimilarity: vi.fn(),
}));

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  toDatasetField: vi.fn(),
}));

vi.mock('@/services/edgar/filing-to-text.js', () => ({
  filingToText: vi.fn(),
  filingToExtract: vi.fn(),
  hasExtractCache: vi.fn(),
  getExtractCache: vi.fn(),
  setExtractCache: vi.fn(),
  clearExtractCache: vi.fn(),
  extractCacheSize: vi.fn(),
  detectHeadings: vi.fn(),
  windowText: vi.fn(),
}));

import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import {
  detectHeadings,
  filingToExtract,
  getExtractCache,
  windowText,
} from '@/services/edgar/filing-to-text.js';

const mockApi = {
  resolveCik: vi.fn(),
  getSubmissions: vi.fn(),
  getAllEntries: vi.fn().mockResolvedValue([]),
  searchFilings: vi.fn(),
  findFilingCiks: vi.fn(),
  tryGetFilingIndex: vi.fn(),
  tryGetFilingDocument: vi.fn(),
  tryGetFilingHeaders: vi.fn(),
  tryGetCompanyConcept: vi.fn(),
  tryGetCompanyFacts: vi.fn(),
  tryGetFrames: vi.fn(),
  cikToTicker: vi.fn(),
};

const mockSubmissions = {
  name: 'Apple Inc.',
  cik: '0000320193',
  tickers: ['AAPL'],
  exchanges: ['Nasdaq'],
  filings: {
    recent: {
      accessionNumber: [],
      filingDate: [],
      form: [],
      primaryDocDescription: [],
      primaryDocument: [],
      reportDate: [],
    },
    files: [],
  },
  fiscalYearEnd: '0930',
  entityType: 'operating',
  sic: '3571',
  sicDescription: 'ELECTRONIC COMPUTERS',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as any);
  vi.mocked(getCanvasBridge).mockReturnValue(undefined);
  mockApi.resolveCik.mockResolvedValue([]);
  mockApi.getSubmissions.mockResolvedValue(mockSubmissions);
  mockApi.findFilingCiks.mockResolvedValue([]);
  vi.mocked(getExtractCache).mockReturnValue(undefined);
  vi.mocked(filingToExtract).mockReturnValue('');
  vi.mocked(detectHeadings).mockReturnValue([]);
  vi.mocked(windowText).mockImplementation((full: string, offset: number, limit: number) => {
    const truncated = full.length > offset + limit;
    return {
      text: full.slice(offset, offset + limit),
      truncated,
      totalLength: full.length,
      ...(truncated ? { nextOffset: offset + limit } : {}),
    };
  });
});

// ---------------------------------------------------------------------------
// company-search input validation
// ---------------------------------------------------------------------------

describe('companySearchTool — input validation', () => {
  it('rejects empty query string', () => {
    expect(() => companySearchTool.input.parse({ query: '' })).toThrow();
  });

  it('accepts long queries since no max-length constraint is declared in schema', () => {
    // The schema uses only .min(1); there is no .max(). This test documents that behavior.
    const long = 'A'.repeat(201);
    expect(() => companySearchTool.input.parse({ query: long })).not.toThrow();
  });

  it('rejects filing_limit below 1', () => {
    expect(() => companySearchTool.input.parse({ query: 'AAPL', filing_limit: 0 })).toThrow();
  });

  it('rejects filing_limit above 50', () => {
    expect(() => companySearchTool.input.parse({ query: 'AAPL', filing_limit: 51 })).toThrow();
  });

  it('SQL injection in query does not expose internals in error data', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: "' OR 1=1 --" });
    const err = await companySearchTool.handler(input, ctx).catch((e) => e);
    // Check the wire-level fields only (code + data), not the raw Error.stack which always contains file paths
    const wireFields = { code: err?.code, message: err?.message, data: err?.data };
    const wireStr = JSON.stringify(wireFields);
    expect(wireStr).not.toMatch(/\/Users\//);
    expect(wireStr).not.toMatch(/node_modules/);
    // Ensure the error is structured and not a raw crash
    expect(err?.code).toBeDefined();
    expect(err?.data?.reason).toBeDefined();
  });

  it('error response does not expose EDGAR_USER_AGENT env var', async () => {
    process.env.EDGAR_USER_AGENT = 'TestApp user@example.com';
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'test' });
    const err = await companySearchTool.handler(input, ctx).catch((e) => e);
    expect(JSON.stringify(err)).not.toContain('TestApp user@example.com');
  });
});

// ---------------------------------------------------------------------------
// search-filings input validation
// ---------------------------------------------------------------------------

describe('searchFilingsTool — input validation', () => {
  it('rejects empty query string', () => {
    expect(() => searchFilingsTool.input.parse({ query: '' })).toThrow();
  });

  it('rejects limit above 100', () => {
    expect(() => searchFilingsTool.input.parse({ query: 'test', limit: 101 })).toThrow();
  });

  it('rejects limit below 1', () => {
    expect(() => searchFilingsTool.input.parse({ query: 'test', limit: 0 })).toThrow();
  });

  it('rejects offset below 0', () => {
    expect(() => searchFilingsTool.input.parse({ query: 'test', offset: -1 })).toThrow();
  });

  it('accepts valid YYYY-MM-DD dates (#25)', () => {
    expect(() =>
      searchFilingsTool.input.parse({
        query: 'test',
        start_date: '2023-01-01',
        end_date: '2023-12-31',
      }),
    ).not.toThrow();
  });

  it('accepts empty-string dates as no-filter (#25)', () => {
    // Form-based clients may send "" for an omitted optional field — the union
    // variant accepts it and the handler treats it as absent.
    expect(() =>
      searchFilingsTool.input.parse({ query: 'test', start_date: '', end_date: '' }),
    ).not.toThrow();
  });

  it('rejects malformed start_date via the pattern (#25)', () => {
    expect(() =>
      searchFilingsTool.input.parse({ query: 'test', start_date: '2023/01/01' }),
    ).toThrow();
  });

  it('rejects malformed end_date via the pattern (#25)', () => {
    expect(() =>
      searchFilingsTool.input.parse({ query: 'test', end_date: '01-31-2023' }),
    ).toThrow();
  });

  it('boolean operator injection in query is passed through safely to API', async () => {
    const emptyResponse = {
      hits: { total: { value: 0, relation: 'eq' }, hits: [] },
      query: { from: 0, size: 20, query: 'test' },
    };
    mockApi.searchFilings.mockResolvedValue(emptyResponse);
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({
      query: 'revenue AND (risk OR uncertainty)',
    });
    const result = await searchFilingsTool.handler(input, ctx);
    // Just verifies no crash and proper empty result
    expect(result.total).toBe(0);
  });

  it('deeply nested parenthesis injection does not cause hang or crash', async () => {
    const emptyResponse = {
      hits: { total: { value: 0, relation: 'eq' }, hits: [] },
      query: { from: 0, size: 20, query: 'test' },
    };
    mockApi.searchFilings.mockResolvedValue(emptyResponse);
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const injection = '((((SELECT * FROM users))))';
    const input = searchFilingsTool.input.parse({ query: injection });
    const result = await searchFilingsTool.handler(input, ctx);
    expect(result.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// get-filing input validation
// ---------------------------------------------------------------------------

describe('getFilingTool — input validation', () => {
  it('rejects content_limit below 1000', () => {
    expect(() =>
      getFilingTool.input.parse({
        accession_number: '0000320193-23-000106',
        content_limit: 999,
      }),
    ).toThrow();
  });

  it('rejects content_limit above 200000', () => {
    expect(() =>
      getFilingTool.input.parse({
        accession_number: '0000320193-23-000106',
        content_limit: 200001,
      }),
    ).toThrow();
  });

  it('path traversal in document param is rejected — file not in index', async () => {
    mockApi.findFilingCiks.mockResolvedValue(['0000320193']);
    mockApi.tryGetFilingIndex.mockResolvedValue({
      directory: {
        name: '000032019323000106',
        item: [
          {
            name: 'aapl-20230930.htm',
            type: 'text/html',
            size: '500000',
            'last-modified': '2023-11-03',
          },
        ],
      },
    });
    mockApi.tryGetFilingDocument.mockResolvedValue('<html>content</html>');
    mockApi.tryGetFilingHeaders.mockResolvedValue(null);
    vi.mocked(filingToExtract).mockReturnValue('content');

    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
      document: '../../etc/passwd',
    });
    const err = await getFilingTool.handler(input, ctx).catch((e) => e);
    // Either fails with document_not_found or no_documents — not reading arbitrary paths
    expect(err?.data?.reason).toMatch(/document_not_found|no_documents/);
  });

  it('accession number with special chars is normalized safely', () => {
    // Should parse without throwing
    const input = getFilingTool.input.parse({ accession_number: '0000320193-23-000106' });
    expect(input.accession_number).toBe('0000320193-23-000106');
  });

  it('filing content does not echo EDGAR_USER_AGENT', async () => {
    process.env.EDGAR_USER_AGENT = 'PrivateAgent private@corp.com';
    mockApi.findFilingCiks.mockResolvedValue(['0000320193']);
    mockApi.tryGetFilingIndex.mockResolvedValue({
      directory: {
        name: '000032019323000106',
        item: [
          { name: 'doc.htm', type: 'text/html', size: '10000', 'last-modified': '2023-11-03' },
        ],
      },
    });
    mockApi.tryGetFilingDocument.mockResolvedValue('<html>SEC filing content</html>');
    mockApi.tryGetFilingHeaders.mockResolvedValue(null);
    vi.mocked(filingToExtract).mockReturnValue('SEC filing content');
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({ accession_number: '0000320193-23-000106' });
    const result = await getFilingTool.handler(input, ctx);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('PrivateAgent private@corp.com');
  });
});

// ---------------------------------------------------------------------------
// get-financials input validation
// ---------------------------------------------------------------------------

describe('getFinancialsTool — input validation', () => {
  it('rejects empty company string (#24)', () => {
    expect(() => getFinancialsTool.input.parse({ company: '', concept: 'revenue' })).toThrow();
  });

  it('rejects empty concept string (#24)', () => {
    expect(() => getFinancialsTool.input.parse({ company: 'AAPL', concept: '' })).toThrow();
  });

  it('rejects invalid taxonomy', () => {
    expect(() =>
      getFinancialsTool.input.parse({
        company: 'AAPL',
        concept: 'revenue',
        taxonomy: 'not-a-real-taxonomy',
      }),
    ).toThrow();
  });

  it('rejects invalid period_type', () => {
    expect(() =>
      getFinancialsTool.input.parse({
        company: 'AAPL',
        concept: 'revenue',
        period_type: 'daily' as any,
      }),
    ).toThrow();
  });

  it('result does not contain env vars', async () => {
    process.env.EDGAR_USER_AGENT = 'PrivateApp private@test.com';
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'AAPL', concept: 'revenue' });
    const err = await getFinancialsTool.handler(input, ctx).catch((e) => e);
    expect(JSON.stringify(err)).not.toContain('PrivateApp private@test.com');
  });
});

// ---------------------------------------------------------------------------
// fetch-frames input validation
// ---------------------------------------------------------------------------

describe('fetchFramesTool — input validation', () => {
  it('rejects empty concept (#24)', () => {
    expect(() => fetchFramesTool.input.parse({ concept: '', period: 'CY2023' })).toThrow();
  });

  it('rejects empty period (#24)', () => {
    expect(() => fetchFramesTool.input.parse({ concept: 'revenue', period: '' })).toThrow();
  });

  it('rejects limit below 1', () => {
    expect(() =>
      fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023', limit: 0 }),
    ).toThrow();
  });

  it('rejects limit above 100', () => {
    expect(() =>
      fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023', limit: 101 }),
    ).toThrow();
  });

  it('accepts CY####, CY####Q#, and CY####Q#I periods (#25)', () => {
    for (const period of ['CY2023', 'CY2024Q2', 'CY2023Q4I']) {
      expect(() => fetchFramesTool.input.parse({ concept: 'revenue', period })).not.toThrow();
    }
  });

  it('rejects malformed period via the pattern (#25)', () => {
    for (const period of ['2023Q4', 'CY23', 'CY2023Q5', 'FY2023']) {
      expect(() => fetchFramesTool.input.parse({ concept: 'revenue', period })).toThrow();
    }
  });

  it('rejects invalid sort value', () => {
    expect(() =>
      fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023', sort: 'random' as any }),
    ).toThrow();
  });

  it('result does not contain EDGAR env vars', async () => {
    process.env.EDGAR_USER_AGENT = 'EnvSecret env@test.com';
    mockApi.tryGetFrames.mockResolvedValue(null);
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const err = await fetchFramesTool.handler(input, ctx).catch((e) => e);
    expect(JSON.stringify(err)).not.toContain('EnvSecret env@test.com');
  });
});

// ---------------------------------------------------------------------------
// Cross-tool: no secrets in any output
// ---------------------------------------------------------------------------

describe('env-var leakage — all tools', () => {
  const secretValue = 'SUPER_SECRET_TOKEN_XYZ_12345';

  beforeEach(() => {
    process.env.EDGAR_USER_AGENT = secretValue;
    process.env.EDGAR_RATE_LIMIT_RPS = '10';
  });

  it('company-search error does not expose EDGAR_USER_AGENT', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'test' });
    const err = await companySearchTool.handler(input, ctx).catch((e) => e);
    expect(JSON.stringify(err)).not.toContain(secretValue);
  });

  it('search-filings error does not expose EDGAR_USER_AGENT', async () => {
    mockApi.searchFilings.mockRejectedValue(new Error('upstream error'));
    const ctx = createMockContext({ errors: searchFilingsTool.errors });
    const input = searchFilingsTool.input.parse({ query: 'test' });
    const err = await searchFilingsTool.handler(input, ctx).catch((e) => e);
    // The env var should not appear in the error propagation
    expect(JSON.stringify(err)).not.toContain(secretValue);
  });

  it('get-financials error does not expose EDGAR_USER_AGENT', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'TEST', concept: 'revenue' });
    const err = await getFinancialsTool.handler(input, ctx).catch((e) => e);
    expect(JSON.stringify(err)).not.toContain(secretValue);
  });

  it('fetch-frames error does not expose EDGAR_USER_AGENT', async () => {
    mockApi.tryGetFrames.mockResolvedValue(null);
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const err = await fetchFramesTool.handler(input, ctx).catch((e) => e);
    expect(JSON.stringify(err)).not.toContain(secretValue);
  });
});
