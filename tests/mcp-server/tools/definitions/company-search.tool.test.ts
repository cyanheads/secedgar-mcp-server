/**
 * @fileoverview Tests for company-search tool — entity lookup with optional filings,
 * fund ticker resolution (series_id/class_id), no-match trigram suggestions,
 * former-name resolution, and a name SEC's ticker file misses reaching EDGAR's entity
 * index and 10-K subsidiaries exhibits (#236).
 * @module tests/mcp-server/tools/definitions/company-search.tool
 */

import { readFileSync } from 'node:fs';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  companySearchTool,
  createCompanySearchTool,
} from '@/mcp-server/tools/definitions/company-search.tool.js';
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { CallScope } from '@/services/edgar/call-scope.js';
import type { CikMatch, FilingsRecent, SubmissionsResponse } from '@/services/edgar/types.js';

/**
 * The entity-index cases run the real service over a stubbed `fetch` (#236): the config
 * fields its constructor and requests read, and the mirror strict mode reads its tickers from.
 */
const { config, mirrorRef } = vi.hoisted(() => ({
  config: {
    userAgent: 'test test@example.com',
    rateLimitRps: 10,
    rateLimitCooldownSeconds: 600,
    tickerCacheTtl: 3600,
    mirrorFallbackLive: true,
  },
  mirrorRef: { current: undefined as object | undefined },
}));

vi.mock('@/config/server-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/server-config.js')>()),
  getServerConfig: () => config,
}));
vi.mock('@/services/edgar/mirror/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/edgar/mirror/index.js')>()),
  getEdgarMirror: () => mirrorRef.current,
}));

// Keep the real module and override only the service accessor + suggestions. The
// archive-page walk lives in its own module and runs for real against the mocked
// `fetchArchivePage`.
vi.mock('@/services/edgar/edgar-api-service.js', async (importActual) => {
  const actual = await importActual<typeof import('@/services/edgar/edgar-api-service.js')>();
  return {
    ...actual,
    getEdgarApiService: vi.fn(),
    initEdgarApiService: vi.fn(),
    suggestCompanies: vi.fn(),
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
import { getEdgarApiService, suggestCompanies } from '@/services/edgar/edgar-api-service.js';
import {
  allText,
  at,
  bag,
  blockAt,
  blockText,
  caught,
  records,
  recoveryHint,
  wireError,
} from '../../../support/assertions.js';
import { codeSpansIn, readCommonMark } from '../../../support/commonmark.js';

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

// Submissions with an older-filings archive page manifest (#78). The recent window
// holds 2023–2024 filings; the archive page covers 2005–2010.
const mockPagedSubmissions: SubmissionsResponse = {
  cik: '0000320193',
  entityType: 'operating',
  exchanges: ['Nasdaq'],
  filings: {
    recent: {
      accessionNumber: ['0000320193-24-000001', '0000320193-23-000106'],
      filingDate: ['2024-11-01', '2023-11-03'],
      form: ['10-K', '10-Q'],
      primaryDocDescription: ['10-K', '10-Q'],
      primaryDocument: ['aapl-2024.htm', 'aapl-2023.htm'],
      reportDate: ['2024-09-28', '2023-09-30'],
    },
    files: [
      {
        name: 'CIK0000320193-submissions-001.json',
        filingCount: 4,
        filingFrom: '2005-01-03',
        filingTo: '2010-12-20',
      },
    ],
  },
  fiscalYearEnd: '0930',
  name: 'Apple Inc.',
  sic: '3571',
  sicDescription: 'ELECTRONIC COMPUTERS',
  stateOfIncorporation: 'CA',
  tickers: ['AAPL'],
};

// One archive page's parallel-array content (2005–2010), newest-first.
const mockArchivePage: FilingsRecent = {
  accessionNumber: [
    '0000320193-10-000001',
    '0000320193-08-000002',
    '0000320193-06-000003',
    '0000320193-05-000004',
  ],
  filingDate: ['2010-10-27', '2008-11-05', '2006-12-29', '2005-12-01'],
  form: ['10-K', '10-Q', '10-K', '8-K'],
  primaryDocDescription: ['10-K', '10-Q', '10-K', '8-K'],
  primaryDocument: ['a10.htm', 'a08.htm', 'a06.htm', 'a05.htm'],
  reportDate: ['2010-09-25', '2008-09-27', '2006-09-30', '2005-11-30'],
};

const mockApi = {
  resolveCik: vi.fn(),
  getSubmissions: vi.fn(),
  getAllEntries: vi.fn(),
  fetchArchivePage: vi.fn(),
  resolveEntityByName: vi.fn(),
  findSubsidiaryParents: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as any);
  vi.mocked(suggestCompanies).mockReturnValue([]);
  vi.mocked(getCanvasBridge).mockReturnValue(undefined);
  mockApi.getSubmissions.mockResolvedValue(mockSubmissions);
  mockApi.getAllEntries.mockResolvedValue([]);
  mockApi.fetchArchivePage.mockResolvedValue(mockArchivePage);
  // A name every local pass missed finds nothing in EDGAR's entity index or its exhibits (#236).
  mockApi.resolveEntityByName.mockResolvedValue({
    matches: [],
    total: { value: 0, relation: 'eq' },
  });
  mockApi.findSubsidiaryParents.mockResolvedValue([]);
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
    expect(at(result.filings, 0).form).toBe('10-K');
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

  it('filters filings by forms', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL', forms: ['10-K'] });
    const result = await companySearchTool.handler(input, ctx);

    expect(result.filings).toHaveLength(1);
    expect(at(result.filings, 0).form).toBe('10-K');
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

  it('throws ambiguous_company when array > 1 (#228)', async () => {
    mockApi.resolveCik.mockResolvedValue([
      { cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' },
      { cik: '0000001234', name: 'Apple Corp.', ticker: 'APCO' },
    ]);
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'Apple' });

    await expect(companySearchTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'ambiguous_company' },
    });
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
    expect(blockAt(blocks).type).toBe('text');
    expect(blockText(blocks)).toContain('Apple Inc.');
    expect(blockText(blocks)).toContain('AAPL');
    expect(blockText(blocks)).toContain('10-K');
  });

  it('populates enrichment notice when forms filter returns no filings', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL', forms: ['S-1'] });
    await companySearchTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('S-1');
  });

  it('does not populate enrichment notice when filings are returned', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL', forms: ['10-K'] });
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
    expect(blockText(blocks)).toContain('no ticker');
    expect(blockText(blocks)).not.toContain('Recent filings');
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
    expect(blockText(blocks)).toContain('S000002839');
    expect(blockText(blocks)).toContain('C000092055');
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

  // --- Ticker-aware no_match recovery (#111) ---

  it('carries one recovery string covering both ticker- and name-shaped misses (#111)', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    vi.mocked(suggestCompanies).mockReturnValue([
      { cik: '0001624794', name: 'CSW INDUSTRIALS, INC.', ticker: 'CSW' },
    ]);

    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'CSWI' });

    const err = await caught(companySearchTool.handler(input, ctx));

    expect(err.data.reason).toBe('no_match');
    const hint = recoveryHint(err);
    // Only the throw that attaches suggestions points at them (#153).
    expect(hint.startsWith('Check `data.suggestions` for near matches. ')).toBe(true);
    // The ETF/mutual-fund ticker guidance survives the rewrite.
    expect(hint).toContain('VOO');
    expect(err.data.suggestions).toHaveLength(1);
    expect(err.message).toContain('CSW INDUSTRIALS, INC.');
  });

  it('throws a clean no_match (no suggestions key) when trigram finds nothing', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    vi.mocked(suggestCompanies).mockReturnValue([]);

    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'XYZNOTREAL' });

    const err = await caught(companySearchTool.handler(input, ctx));

    expect(err.data.reason).toBe('no_match');
    expect(err.data.suggestions).toBeUndefined();
    // The hint names no field the error does not carry (#153).
    const hint = recoveryHint(err);
    expect(hint).not.toContain('data.suggestions');
    expect(hint).toContain('VOO');
  });

  // --- Suffix-form resolution reaching both output surfaces (#107) ---

  it('surfaces a suffix-form resolution on structuredContent and in format() (#107)', async () => {
    // "Beacon Financial Corporation" resolves to the registry's "Beacon Financial Corp"
    // (CIK 0001108134). The tool renders the SEC-conformed name, not the query's spelling.
    mockApi.resolveCik.mockResolvedValue({
      cik: '0001108134',
      name: 'Beacon Financial Corp',
      ticker: 'BBT',
    });
    mockApi.getSubmissions.mockResolvedValue({
      ...mockSubmissions,
      cik: '0001108134',
      name: 'Beacon Financial Corp',
      tickers: ['BBT'],
    });

    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'Beacon Financial Corporation' });
    const result = await companySearchTool.handler(input, ctx);

    expect(result.cik).toBe('0001108134');
    expect(result.name).toBe('Beacon Financial Corp');
    const text = blockText(companySearchTool.format!(result));
    expect(text).toContain('Beacon Financial Corp');
    expect(text).toContain('BBT');
    expect(text).toContain('0001108134');
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
    // Recovery hint must be present, and must not point at suggestions it lacks (#153)
    expect(typeof err.data?.recovery?.hint).toBe('string');
    expect(err.data!.recovery!.hint!.length).toBeGreaterThan(0);
    expect(err.data!.recovery!.hint).not.toContain('data.suggestions');
    expect(err.data).not.toHaveProperty('suggestions');
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

  // --- Archive-page paging beyond the recent window (#78) ---

  it('routes a filed_before date filter into the older archive pages', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    mockApi.getSubmissions.mockResolvedValue(mockPagedSubmissions);

    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL', filed_before: '2010-12-31' });
    const result = await companySearchTool.handler(input, ctx);

    // Recent filings (2023–2024) all post-date the filter → excluded; the archive
    // page (2005–2010) is fetched and its rows fill the result.
    expect(mockApi.fetchArchivePage).toHaveBeenCalledWith(
      'CIK0000320193-submissions-001.json',
      expect.any(CallScope),
    );
    // The scope carries the caller's own signal, so a cancel reaches SEC (#179).
    expect(mockApi.fetchArchivePage.mock.calls[0]?.[1].signal).toBe(ctx.signal);
    expect(result.total_filings).toBe(4);
    expect(result.filings!.every((f) => f.filing_date <= '2010-12-31')).toBe(true);
    // Newest-first ordering across the archive page.
    expect(at(result.filings, 0).filing_date).toBe('2010-10-27');
  });

  it('discloses history_scanned_through as the oldest archive page reached', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    mockApi.getSubmissions.mockResolvedValue(mockPagedSubmissions);

    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL', filed_before: '2010-12-31' });
    const result = await companySearchTool.handler(input, ctx);

    // The fetched page's filingFrom is the deepest date scanned.
    expect(result.history_scanned_through).toBe('2005-01-03');
  });

  it('discloses history_scanned_through as the recent tail when no archive is scanned', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    mockApi.getSubmissions.mockResolvedValue(mockPagedSubmissions);

    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL' });
    const result = await companySearchTool.handler(input, ctx);

    expect(mockApi.fetchArchivePage).not.toHaveBeenCalled();
    expect(result.history_scanned_through).toBe('2023-11-03');
  });

  it('pages into the archive when a form filter under-fills the recent window', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    mockApi.getSubmissions.mockResolvedValue(mockPagedSubmissions);

    const ctx = createMockContext({ errors: companySearchTool.errors });
    // Recent holds 1 10-K; asking for 3 under-fills → walk the archive for older 10-Ks.
    const input = companySearchTool.input.parse({
      query: 'AAPL',
      forms: ['10-K'],
      filing_limit: 3,
    });
    const result = await companySearchTool.handler(input, ctx);

    expect(mockApi.fetchArchivePage).toHaveBeenCalledOnce();
    // recent 10-K (2024) + archive 10-Ks (2010, 2006) = 3.
    expect(result.total_filings).toBe(3);
    expect(result.filings!.every((f) => f.form === '10-K')).toBe(true);
    expect(result.filings!.map((f) => f.filing_date)).toEqual([
      '2024-11-01',
      '2010-10-27',
      '2006-12-29',
    ]);
  });

  it('does not page the archive when the recent window already fills the form filter', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    mockApi.getSubmissions.mockResolvedValue(mockPagedSubmissions);

    const ctx = createMockContext({ errors: companySearchTool.errors });
    // Recent holds 1 10-K and filing_limit is 1 → filled from recent, no archive walk.
    const input = companySearchTool.input.parse({
      query: 'AAPL',
      forms: ['10-K'],
      filing_limit: 1,
    });
    const result = await companySearchTool.handler(input, ctx);

    expect(mockApi.fetchArchivePage).not.toHaveBeenCalled();
    expect(result.total_filings).toBe(1);
  });

  it('registers the full filtered history to the canvas when the scan reaches beyond recent', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    mockApi.getSubmissions.mockResolvedValue(mockPagedSubmissions);
    const registerDataframe = vi.fn().mockResolvedValue({
      tableName: 'df_HIST1_HIST2',
      rowCount: 4,
      expiresAt: '2026-08-01T00:00:00.000Z',
      columnSchema: [],
    });
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);

    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({
      query: 'AAPL',
      filed_before: '2010-12-31',
      filing_limit: 2,
    });
    const result = await companySearchTool.handler(input, ctx);

    expect(registerDataframe).toHaveBeenCalledOnce();
    const call = registerDataframe.mock.calls[0]![1];
    expect(call.sourceTool).toBe('secedgar_company_search');
    expect(call.rows).toHaveLength(4); // full filtered archive history
    expect(call.rows[0].accession_number).toBe('0000320193-10-000001');
    expect(result.dataset?.name).toBe('df_HIST1_HIST2');
    expect(result.dataset?.truncated).toBe(false); // the single page was fully scanned
    expect(result.filings).toHaveLength(2); // inline stays capped at filing_limit
    expect(result.total_filings).toBe(4);
    // The cap is disclosed structurally, so a client reading only enrichment
    // still knows the inline list is partial.
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(2);
    expect(enrichment.cap).toBe(input.filing_limit);
    expect(enrichment.notice).toContain('2 of 4');
    // The rows past the inline cap live only on the dataframe, so the same
    // guidance names both dataframe tools, describe first (#104).
    const notice = String(enrichment.notice);
    expect(notice).toContain('df_HIST1_HIST2');
    expect(notice).toContain('secedgar_dataframe_describe');
    expect(notice).toContain('secedgar_dataframe_query');
    expect(notice.match(/secedgar_dataframe_describe/g)).toHaveLength(1);
  });

  it('promises no dataframe pointer when nothing was staged (#104)', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    mockApi.getSubmissions.mockResolvedValue(mockPagedSubmissions);
    // Canvas off: the history is still truncated inline, but there is no table
    // to point at, so the guidance must not name one.
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);

    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({
      query: 'AAPL',
      filed_before: '2010-12-31',
      filing_limit: 2,
    });
    const result = await companySearchTool.handler(input, ctx);

    expect(result.dataset).toBeUndefined();
    const notice = String(getEnrichment(ctx).notice);
    expect(getEnrichment(ctx).truncated).toBe(true);
    expect(notice).not.toContain('secedgar_dataframe_describe');
    expect(notice).toContain('Raise filing_limit');
  });

  it('skips canvas registration for a plain lookup that stays in the recent window', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    mockApi.getSubmissions.mockResolvedValue(mockPagedSubmissions);
    const registerDataframe = vi.fn();
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);

    const ctx = createMockContext({ errors: companySearchTool.errors });
    const input = companySearchTool.input.parse({ query: 'AAPL' });
    const result = await companySearchTool.handler(input, ctx);

    expect(mockApi.fetchArchivePage).not.toHaveBeenCalled();
    expect(registerDataframe).not.toHaveBeenCalled();
    expect(result.dataset).toBeUndefined();
    expect(result.total_filings).toBe(2);
  });
});

// The assembled error result, where the declared recovery fill lands (#153).
describe('companySearchTool no_match recovery on the wire (#153)', () => {
  const call = (args: Record<string, unknown>) => runToolContract(companySearchTool, args as never);

  it.each([
    ['a zero-hit name with no near match', [] as CikMatch[], 'Nonexistent Widget Makers of Ohio'],
    ['an unknown bare CIK', { cik: '9999999999' }, '9999999999'],
  ])('names no data.suggestions for %s', async (_case, resolved, query) => {
    mockApi.resolveCik.mockResolvedValue(resolved);
    mockApi.getSubmissions.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'SEC EDGAR API returned 404', { status: 404 }),
    );

    const result = await call({ query, include_filings: false });

    const error = wireError(result);
    expect(error.data.reason).toBe('no_match');
    expect(error.data).not.toHaveProperty('suggestions');
    expect(bag(error.data.recovery).hint).not.toContain('data.suggestions');
    const text = blockText(result.content);
    expect(text).toContain('Recovery:');
    expect(text).not.toContain('data.suggestions');
  });

  it('points at data.suggestions when the zero-hit throw attaches them', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    vi.mocked(suggestCompanies).mockReturnValue([
      { cik: '0000789019', name: 'MICROSOFT CORP', ticker: 'MSFT' },
    ]);

    const result = await call({ query: 'Microsfot', include_filings: false });

    const error = wireError(result);
    expect(error.data.reason).toBe('no_match');
    expect(error.data.suggestions).toEqual([
      { cik: '0000789019', name: 'MICROSOFT CORP', ticker: 'MSFT' },
    ]);
    const hint = String(bag(error.data.recovery).hint);
    expect(hint.startsWith('Check `data.suggestions` for near matches. ')).toBe(true);
    expect(hint).toContain('VOO');
    const text = readCommonMark(blockText(result.content));
    expect(text).toContain('MICROSOFT CORP (MSFT)');
    expect(text).toContain('Check `data.suggestions` for near matches.');
  });
});

/**
 * A name matching several companies fails as ambiguous_company, with get_financials' reason and
 * wording, before any submissions read (#228); the list is cut to 10 with the full count beside
 * it (#229). One company answers as before.
 */
describe('companySearchTool — a name matching several companies (#228)', () => {
  const BLUE_OWL = [
    { cik: '0001823945', name: 'BLUE OWL CAPITAL INC.', ticker: 'OWL' },
    { cik: '0001655888', name: 'Blue Owl Capital Corp', ticker: 'OBDC' },
  ];
  const call = (args: Record<string, unknown>) => runToolContract(companySearchTool, args as never);

  it('fails as ambiguous_company listing both CIKs, reading no submissions', async () => {
    mockApi.resolveCik.mockResolvedValue(BLUE_OWL);

    const result = await call({ query: 'Blue Owl Capital', include_filings: false });

    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe(
      "'Blue Owl Capital' matches multiple companies: 0001823945 BLUE OWL CAPITAL INC. (OWL), 0001655888 Blue Owl Capital Corp (OBDC). Retry with one of these tickers or 10-digit CIKs.",
    );
    expect(error.data).toMatchObject({
      reason: 'ambiguous_company',
      query: 'Blue Owl Capital',
      matches: BLUE_OWL,
      total_matches: 2,
      recovery: {
        hint: 'Use a ticker symbol or 10-digit CIK from the matches list for an exact match.',
      },
    });
    expect(readCommonMark(blockText(result.content))).toContain(
      '0001823945 BLUE OWL CAPITAL INC. (OWL), 0001655888 Blue Owl Capital Corp (OBDC).',
    );
    expect(mockApi.getSubmissions).not.toHaveBeenCalled();
  });

  it('lists 10 of 15 candidates, with the full count and the Showing sentence', async () => {
    const companies = Array.from({ length: 15 }, (_, i) => ({
      cik: String(i).padStart(10, '0'),
      name: `Blue ${i}`,
      ticker: `B${i}`,
    }));
    mockApi.resolveCik.mockResolvedValue(companies);

    const result = await call({ query: 'Blue', include_filings: false });

    const error = wireError(result);
    expect(error.data).toMatchObject({
      reason: 'ambiguous_company',
      query: 'Blue',
      matches: companies.slice(0, 10),
      total_matches: 15,
    });
    expect(error.message).toMatch(
      /, 0000000009 Blue 9 \(B9\)\. Retry with one of these tickers or 10-digit CIKs\. Showing 10 of 15 matches; for one not listed, retry with a fuller name, its ticker, or its CIK\.$/,
    );
    expect(error.message).not.toContain('Blue 10');
    expect(mockApi.getSubmissions).not.toHaveBeenCalled();
  });

  it.each([
    ['a ticker', 'OWL'],
    ['a CIK', '1823945'],
    ['a name naming one company', 'Blue Owl Capital Inc'],
  ])('answers %s as before', async (_label, query) => {
    mockApi.resolveCik.mockResolvedValue(BLUE_OWL[0]);
    mockApi.getSubmissions.mockResolvedValue({
      ...mockSubmissions,
      cik: '0001823945',
      name: 'BLUE OWL CAPITAL INC.',
      tickers: ['OWL'],
    });

    const result = await call({ query, include_filings: false });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      cik: '0001823945',
      name: 'BLUE OWL CAPITAL INC.',
      tickers: ['OWL'],
    });
    expect(mockApi.getSubmissions).toHaveBeenCalledWith('0001823945', expect.any(CallScope));
  });

  it('declares ambiguous_company as get_financials does, and no multiple_matches', () => {
    const defs = buildToolDefinitions({ dropEnabled: false, clampOversizedLimits: true });
    const errors = (name: string) => defs.find((d) => d.name === name)?.errors ?? [];
    const entry = (name: string) => errors(name).find((e) => e.reason === 'ambiguous_company');

    expect(entry('secedgar_company_search')).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
    });
    expect(entry('secedgar_company_search')).toEqual(entry('secedgar_get_financials'));
    expect(errors('secedgar_company_search').map((e) => e.reason)).not.toContain(
      'multiple_matches',
    );
  });
});

// Through the real argument-parsing path, where `inputAliases` is applied (#115).
describe('companySearchTool parameter names (#115)', () => {
  const call = (args: Record<string, unknown>) => runToolContract(companySearchTool, args as never);

  beforeEach(() => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
  });

  it.each(['forms', 'form_types'])('filters filings by form with %s', async (key) => {
    const result = await call({ query: 'AAPL', [key]: ['10-K'] });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      total_filings: 1,
      filings: [{ form: '10-K', accession_number: '0000320193-23-000106' }],
    });
    const text = blockText(result.content);
    expect(text).toContain('0000320193-23-000106');
    expect(text).not.toContain('0000320193-23-000077');
  });

  it.each([
    ['filed_after', 'filed_before'],
    ['start_date', 'end_date'],
    ['date_from', 'date_to'],
  ])('bounds the filing date with %s / %s, both ends inclusive', async (after, before) => {
    const result = await call({ query: 'AAPL', [after]: '2023-08-04', [before]: '2023-08-04' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      total_filings: 1,
      filings: [{ form: '10-Q', filing_date: '2023-08-04' }],
    });
    expect(blockText(result.content)).toContain('0000320193-23-000077');
  });

  it('still rejects an unrelated unknown key by name', async () => {
    const result = await call({ query: 'AAPL', bogus: true });

    expect(result.isError).toBe(true);
    expect(blockText(result.content)).toContain('bogus');
    expect(mockApi.resolveCik).not.toHaveBeenCalled();
  });

  // The company-identifier spellings other tools take, rewritten onto `query` (#152).
  it.each(['query', 'company', 'ticker', 'cik', 'ticker_or_cik', 'name', 'search'])(
    'resolves the company with %s',
    async (key) => {
      const result = await call({ [key]: 'AAPL', include_filings: false });

      expect(result.isError).toBeFalsy();
      expect(mockApi.resolveCik).toHaveBeenCalledWith('AAPL', expect.any(CallScope));
      expect(result.structuredContent).toMatchObject({ cik: '0000320193', name: 'Apple Inc.' });
      expect(blockText(result.content)).toContain('**Apple Inc.** (AAPL)');
    },
  );

  it('accepts a numeric cik, repaired to the string query expects (#152)', async () => {
    const result = await call({ cik: 320193, include_filings: false });

    expect(result.isError).toBeFalsy();
    expect(mockApi.resolveCik).toHaveBeenCalledWith('320193', expect.any(CallScope));
    expect(result.structuredContent).toMatchObject({ cik: '0000320193' });
  });

  it.each([
    [{ query: 'AAPL', company: 'MSFT' }, 'company'],
    [{ company: 'AAPL', ticker: 'MSFT' }, 'ticker'],
  ])('rejects %o by naming the leftover %s rather than picking one (#152)', async (args, key) => {
    const result = await call({ ...args, include_filings: false });

    const error = wireError(result);
    expect(error.data.reason).toBe('invalid_arguments');
    expect(blockText(result.content)).toContain(`"${key}"`);
    expect(mockApi.resolveCik).not.toHaveBeenCalled();
  });
});

// Manifest page bounds can sit a day off the page's own rows; page selection
// tolerates it and rows are still filtered by their own dates (#137).
describe('companySearchTool — one-day manifest drift (#137)', () => {
  const block = (rows: Array<[accession: string, date: string]>): FilingsRecent => ({
    accessionNumber: rows.map(([a]) => a),
    filingDate: rows.map(([, d]) => d),
    form: rows.map(() => '424B2'),
    primaryDocDescription: rows.map(() => ''),
    primaryDocument: rows.map(([a]) => `${a}.htm`),
    reportDate: rows.map(() => ''),
  });

  /** JPMorgan-shaped: page 041 is listed to 2021-02-17 but its newest rows are 2021-02-18. */
  const jpm: SubmissionsResponse = {
    ...mockPagedSubmissions,
    cik: '0000019617',
    name: 'JPMORGAN CHASE & CO',
    filings: {
      recent: block([
        ['recent-1', '2026-09-24'],
        ['recent-2', '2025-09-24'],
      ]),
      files: [
        { name: 'p040', filingCount: 2, filingFrom: '2021-02-19', filingTo: '2021-04-18' },
        { name: 'p041', filingCount: 3, filingFrom: '2020-12-15', filingTo: '2021-02-17' },
      ],
    },
  };
  const pages: Record<string, FilingsRecent> = {
    p040: block([
      ['apr', '2021-04-18'],
      ['feb19', '2021-02-19'],
    ]),
    p041: block([
      ['feb18-a', '2021-02-18'],
      ['feb18-b', '2021-02-18'],
      ['feb17', '2021-02-17'],
    ]),
  };

  beforeEach(() => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000019617', name: 'JPMORGAN CHASE & CO' });
    mockApi.getSubmissions.mockResolvedValue(jpm);
    mockApi.fetchArchivePage.mockImplementation(async (name: string) => {
      const page = pages[name];
      if (!page) throw new Error(`unexpected archive page ${name}`);
      return page;
    });
  });

  it('reads the page holding a one-day window its listed end trails, returning only that day', async () => {
    const result = await runToolContract(companySearchTool, {
      query: '0000019617',
      filed_after: '2021-02-18',
      filed_before: '2021-02-18',
    });

    expect(result.isError).toBeFalsy();
    expect(mockApi.fetchArchivePage).toHaveBeenCalledWith('p041', expect.any(CallScope));
    expect(result.structuredContent).toMatchObject({ total_filings: 2 });
    const text = blockText(result.content);
    expect(text).toContain('[feb18-a]');
    expect(text).toContain('[feb18-b]');
    expect(text).not.toContain('[feb17]');
    expect(text).not.toContain('[feb19]');
  });
});

// A filing_limit above the 50-filing inline list is served at 50, and the notice names a
// route to the rest that the caller can actually follow (#168).
describe('companySearchTool — filing_limit above the inline cap (#168)', () => {
  /** `n` filings of one form, one per day, newest first from `newest`. */
  const daily = (n: number, newest: string, form: string, prefix: string): FilingsRecent => {
    const dates = Array.from({ length: n }, (_, i) => {
      const d = new Date(`${newest}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - i);
      return d.toISOString().slice(0, 10);
    });
    return {
      accessionNumber: dates.map((_, i) => `${prefix}-${String(i).padStart(3, '0')}`),
      filingDate: dates,
      form: dates.map(() => form),
      primaryDocDescription: dates.map(() => form),
      primaryDocument: dates.map((_, i) => `${prefix}-${i}.htm`),
      reportDate: dates.map(() => ''),
    };
  };

  /** 100 Form 4 filings, 2026-09-30 back to 2026-06-23, all in the recent window. */
  const recentOnly: SubmissionsResponse = {
    ...mockSubmissions,
    cik: '0001045810',
    name: 'NVIDIA CORP',
    tickers: ['NVDA'],
    filings: { recent: daily(100, '2026-09-30', '4', 'r'), files: [] },
  };

  /**
   * Ten 10-Qs in the recent window and three archive pages of 30 each, so a 10-Q
   * filter under-fills the recent window and walks the archive.
   */
  const archivePages: Record<string, FilingsRecent> = {
    p1: daily(30, '2025-06-30', '10-Q', 'p1'),
    p2: daily(30, '2025-03-31', '10-Q', 'p2'),
    p3: daily(30, '2024-12-31', '10-Q', 'p3'),
  };
  const withArchive: SubmissionsResponse = {
    ...recentOnly,
    filings: {
      recent: daily(10, '2026-09-30', '10-Q', 'r'),
      files: [
        { name: 'p1', filingCount: 30, filingFrom: '2025-06-01', filingTo: '2025-06-30' },
        { name: 'p2', filingCount: 30, filingFrom: '2025-03-02', filingTo: '2025-03-31' },
        { name: 'p3', filingCount: 30, filingFrom: '2024-12-02', filingTo: '2024-12-31' },
      ],
    },
  };

  /** The `secedgar_search_filings` arguments the notice spells out in a code span, parsed back. */
  const recipe = (notice: unknown) => {
    const json = String(notice).match(/secedgar_search_filings with (`+)(\{.*?\})\1 —/)?.[2];
    expect(json).toBeDefined();
    return JSON.parse(json as string) as Record<string, unknown>;
  };

  /** The handler result and enrichment for one call, plus the archive pages it read. */
  const run = async (args: Record<string, unknown>) => {
    mockApi.fetchArchivePage.mockClear();
    const ctx = createMockContext({ errors: companySearchTool.errors });
    const result = await companySearchTool.handler(companySearchTool.input.parse(args), ctx);
    return {
      result,
      enrichment: getEnrichment(ctx),
      pagesRead: mockApi.fetchArchivePage.mock.calls.map(([name]) => name),
    };
  };

  beforeEach(() => {
    mockApi.resolveCik.mockResolvedValue({
      cik: '0001045810',
      name: 'NVIDIA CORP',
      ticker: 'NVDA',
    });
    mockApi.fetchArchivePage.mockImplementation(async (name: string) => {
      const page = archivePages[name];
      if (!page) throw new Error(`unexpected archive page ${name}`);
      return page;
    });
  });

  it('accepts filing_limit up to 1000 and rejects past it', () => {
    for (const filing_limit of [51, 100, 1000]) {
      expect(companySearchTool.input.parse({ query: 'NVDA', filing_limit }).filing_limit).toBe(
        filing_limit,
      );
    }
    expect(() => companySearchTool.input.parse({ query: 'NVDA', filing_limit: 1001 })).toThrow();
  });

  it('at 50, returns the newest 50 of a larger history with cap 50 and no dataset', async () => {
    mockApi.getSubmissions.mockResolvedValue(recentOnly);
    const { result, enrichment } = await run({
      query: 'NVDA',
      filed_after: '2026-07-01',
      filed_before: '2026-09-24',
      filing_limit: 50,
    });

    expect(result.total_filings).toBe(86);
    expect(result.filings).toHaveLength(50);
    expect(at(result.filings, 0).filing_date).toBe('2026-09-24');
    expect(result.filings?.at(-1)?.filing_date).toBe('2026-08-06');
    expect(result.dataset).toBeUndefined();
    expect(enrichment).toMatchObject({ truncated: true, shown: 50, cap: 50 });
  });

  it('answers a call at 100 exactly as the same call at 50, within the recent window', async () => {
    mockApi.getSubmissions.mockResolvedValue(recentOnly);
    const args = { query: 'NVDA', filed_after: '2026-07-01', filed_before: '2026-09-24' };

    const at50 = await run({ ...args, filing_limit: 50 });
    const at100 = await run({ ...args, filing_limit: 100 });

    expect(at100).toEqual(at50);
    expect(at100.result.filings).toHaveLength(50);
    expect(at100.enrichment.cap).toBe(50);
  });

  it('answers a call at 100 exactly as at 50 when the forms filter walks the archive without a canvas', async () => {
    mockApi.getSubmissions.mockResolvedValue(withArchive);
    const args = { query: 'NVDA', forms: ['10-Q'] };

    const at50 = await run({ ...args, filing_limit: 50 });
    const at100 = await run({ ...args, filing_limit: 100 });

    // The no-canvas archive stop fires at the applied 50: two pages fill it, the third is unread.
    expect(at50.pagesRead).toEqual(['p1', 'p2']);
    expect(at100).toEqual(at50);
    expect(at100.result.total_filings).toBe(70);
    expect(at100.result.filings).toHaveLength(50);
  });

  it('answers a call at 100 exactly as at 50 when the full history is staged as a dataframe', async () => {
    mockApi.getSubmissions.mockResolvedValue(withArchive);
    const registerDataframe = vi.fn().mockResolvedValue({
      tableName: 'df_FULL1_FULL2',
      rowCount: 100,
      expiresAt: '2026-11-01T00:00:00.000Z',
      columnSchema: [],
    });
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);
    const args = { query: 'NVDA', forms: ['10-Q'] };

    const at50 = await run({ ...args, filing_limit: 50 });
    const at100 = await run({ ...args, filing_limit: 100 });

    expect(registerDataframe).toHaveBeenCalledTimes(2);
    expect(registerDataframe.mock.calls[1]![1]).toEqual(registerDataframe.mock.calls[0]![1]);
    expect(at100).toEqual(at50);
    expect(at100.result.dataset?.name).toBe('df_FULL1_FULL2');
    expect(at100.result.total_filings).toBe(100);
    const notice = String(at100.enrichment.notice);
    expect(notice).toContain('secedgar_dataframe_describe');
    expect(notice).not.toContain('secedgar_search_filings');
    expect(notice).not.toContain('Raise filing_limit');
  });

  it('spells out a secedgar_search_filings call with both date bounds when more than 50 match, and how to page on past its 100', async () => {
    mockApi.getSubmissions.mockResolvedValue(recentOnly);
    const { enrichment } = await run({
      query: 'NVDA',
      filed_after: '2026-07-01',
      filed_before: '2026-09-24',
      filing_limit: 100,
    });

    // The caller's lower bound and the oldest filing shown as the upper one; no
    // forms filter was given, so there is no amendment matching to disclose.
    expect(enrichment.notice).toBe(
      'Showing 50 of 86 matching filings. The inline list holds at most 50. Call secedgar_search_filings with `{"query":"cik:0001045810","filed_after":"2026-07-01","filed_before":"2026-08-06","limit":100}` — it also returns the filings shown here from 2026-08-06. Each call returns up to 100 filings; for older ones, repeat it with filed_before moved to the oldest filing_date it returns.',
    );
    expect(String(companySearchTool.enrichment?.notice?.description)).not.toContain(
      'returns the rest',
    );
  });

  it('bounds an undated recipe below by history_scanned_through', async () => {
    mockApi.getSubmissions.mockResolvedValue(recentOnly);
    const { result, enrichment } = await run({ query: 'NVDA', filing_limit: 50 });

    expect(result.history_scanned_through).toBe('2026-06-23');
    expect(recipe(enrichment.notice)).toEqual({
      query: 'cik:0001045810',
      filed_after: '2026-06-23',
      filed_before: '2026-08-12',
      limit: 100,
    });
  });

  it('carries the forms filter into the recipe and discloses amendment matching', async () => {
    mockApi.getSubmissions.mockResolvedValue(withArchive);
    const { result, enrichment } = await run({
      query: 'NVDA',
      forms: ['10-Q'],
      filed_before: '2026-12-31',
      filing_limit: 60,
    });

    // filed_before alone walks every page: 10 recent + 90 archived 10-Qs.
    expect(result.total_filings).toBe(100);
    expect(result.history_scanned_through).toBe('2024-12-02');
    expect(result.filings?.at(-1)?.filing_date).toBe('2025-03-22');
    const notice = String(enrichment.notice);
    expect(recipe(notice)).toEqual({
      query: 'cik:0001045810',
      forms: ['10-Q'],
      filed_after: '2024-12-02',
      filed_before: '2025-03-22',
      limit: 100,
    });
    expect(notice).toContain('its forms filter also matches amendments');
  });

  it('starts the recipe at the oldest match when a page lists a start later than its own rows', async () => {
    // The manifest says p1 starts 2025-06-05; its oldest row is 2025-06-01.
    mockApi.getSubmissions.mockResolvedValue({
      ...withArchive,
      filings: {
        recent: daily(60, '2026-09-30', '10-Q', 'r'),
        files: [{ name: 'p1', filingCount: 30, filingFrom: '2025-06-05', filingTo: '2025-06-30' }],
      },
    });
    const { result, enrichment } = await run({
      query: 'NVDA',
      filed_before: '2026-12-31',
      filing_limit: 50,
    });

    expect(result.history_scanned_through).toBe('2025-06-05');
    expect(result.total_filings).toBe(90);
    // The recipe's window must still hold every counted filing, 2025-06-01 included.
    expect(recipe(enrichment.notice)).toMatchObject({
      filed_after: '2025-06-01',
      filed_before: '2026-08-12',
    });
  });

  it('keeps "Raise filing_limit" when every match fits in 50 inline', async () => {
    mockApi.getSubmissions.mockResolvedValue(recentOnly);
    const { result, enrichment } = await run({
      query: 'NVDA',
      filed_after: '2026-09-01',
      filing_limit: 10,
    });

    expect(result.total_filings).toBe(30);
    expect(String(enrichment.notice)).toBe(
      'Showing 10 of 30 matching filings. Raise filing_limit to see more inline.',
    );
  });

  it('serves a call at 100 through the wire with the recipe in content[]', async () => {
    mockApi.getSubmissions.mockResolvedValue(recentOnly);
    const result = await runToolContract(companySearchTool, {
      query: 'NVDA',
      filed_after: '2026-07-01',
      filed_before: '2026-09-24',
      filing_limit: 100,
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { filings: unknown[]; total_filings: number };
    expect(structured.filings).toHaveLength(50);
    expect(structured.total_filings).toBe(86);
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('Filings (50 of 86)');
    expect(text).toContain(
      'secedgar_search_filings with `{"query":"cik:0001045810","filed_after":"2026-07-01","filed_before":"2026-08-06","limit":100}`',
    );
  });

  it('reads the recipe back under CommonMark as the exact JSON, caller form types and all', async () => {
    mockApi.getSubmissions.mockResolvedValue(recentOnly);
    // `4` matches the Form 4s; the other names nothing and still rides into the recipe.
    const odd = 'a"b\\c*d`e_[f](g)';
    const result = await runToolContract(companySearchTool, {
      query: 'NVDA',
      forms: ['4', odd],
      filed_after: '2026-07-01',
      filed_before: '2026-09-24',
      filing_limit: 100,
    });

    expect(result.isError).toBeFalsy();
    const call = JSON.stringify({
      query: 'cik:0001045810',
      forms: ['4', odd.toUpperCase()],
      filed_after: '2026-07-01',
      filed_before: '2026-08-06',
      limit: 100,
    });
    expect(String((result.structuredContent as { notice?: string }).notice)).toContain(call);
    expect(codeSpansIn(allText(result))).toEqual([call]);
  });

  // Wiring only: the clamp above now runs under EDGAR_CLAMP_OVERSIZED_LIMITS; the
  // mechanism itself is tabled in tests/mcp-server/tools/limit-clamp.test.ts (#197).
  describe('under the clamp switch (#197)', () => {
    const args = { query: 'NVDA', filed_after: '2026-07-01', filed_before: '2026-09-24' };

    it('answers filing_limit 51 exactly as 50 on both surfaces', async () => {
      mockApi.getSubmissions.mockResolvedValue(recentOnly);
      const at50 = await runToolContract(companySearchTool, { ...args, filing_limit: 50 });
      const at51 = await runToolContract(companySearchTool, { ...args, filing_limit: 51 });

      expect(at51).toEqual(at50);
      expect(at51.structuredContent).toMatchObject({ truncated: true, shown: 50, cap: 50 });
    });

    it('advertises 1000 as the maximum with the switch on and 50 with it off, which rejects 51', async () => {
      const maximum = (clampOversizedLimits: boolean) => {
        const def = buildToolDefinitions({ dropEnabled: false, clampOversizedLimits }).find(
          (d) => d.name === 'secedgar_company_search',
        );
        return (z.toJSONSchema(def!.input, { io: 'input' }) as any).properties.filing_limit.maximum;
      };
      expect(maximum(true)).toBe(1000);
      expect(maximum(false)).toBe(50);

      const off = createCompanySearchTool({ clampOversizedLimits: false });
      const rejected = await runToolContract(off, { ...args, filing_limit: 51 });
      expect(rejected.isError).toBe(true);
      expect(wireError(rejected).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(mockApi.resolveCik).not.toHaveBeenCalled();
    });
  });
});

// The filter reads the one normalized form list (#194); the value table lives in
// tests/mcp-server/tools/form-filter.test.ts.
describe('companySearchTool form filter (#194)', () => {
  const call = (args: Record<string, unknown>) => runToolContract(companySearchTool, args as never);
  /** Two calls' answers on both surfaces, and the archive pages each one read. */
  const sameAnswer = async (a: Record<string, unknown>, b: Record<string, unknown>) => {
    mockApi.fetchArchivePage.mockClear();
    const first = await call(a);
    const firstPages = mockApi.fetchArchivePage.mock.calls.length;
    mockApi.fetchArchivePage.mockClear();
    const second = await call(b);
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toEqual(second.structuredContent);
    expect(first.content).toEqual(second.content);
    expect(firstPages).toBe(mockApi.fetchArchivePage.mock.calls.length);
    return bag(first.structuredContent);
  };

  beforeEach(() => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
  });

  it.each([[['']], [['  ']]])(
    'returns with forms %j what it returns without forms, walking no archive page',
    async (forms) => {
      mockApi.getSubmissions.mockResolvedValue(mockPagedSubmissions);

      const structured = await sameAnswer({ query: 'AAPL', forms }, { query: 'AAPL' });
      expect(mockApi.fetchArchivePage).not.toHaveBeenCalled();
      expect(structured.total_filings).toBe(2);
      expect(structured.notice).toBeUndefined();
    },
  );

  it('matches a padded form as it matches the bare one', async () => {
    const structured = await sameAnswer(
      { query: 'AAPL', forms: [' 10-K '] },
      { query: 'AAPL', forms: ['10-K'] },
    );
    expect(structured.total_filings).toBe(1);
  });

  it('names only the normalized forms when nothing matched', async () => {
    const result = await call({ query: 'AAPL', forms: ['', ' s-1'] });

    const notice = String(bag(result.structuredContent).notice);
    expect(notice).toBe(
      'No filings matched form types [S-1] for this entity. Try different form types or remove the filter.',
    );
    expect(readCommonMark(blockText(result.content, 1))).toContain(notice);
  });

  it('escapes the form types inside the authored no-match notice', async () => {
    const result = await call({ query: 'AAPL', forms: ['*s-1*'] });

    expect(readCommonMark(blockText(result.content, 1))).toContain(
      'No filings matched form types [*S-1*] for this entity.',
    );
  });

  it('stages the dataframe with the normalized forms', async () => {
    mockApi.getSubmissions.mockResolvedValue(mockPagedSubmissions);
    const registerDataframe = vi.fn().mockResolvedValue({
      tableName: 'df_FORMS_HIST1',
      rowCount: 3,
      expiresAt: '2026-10-25T00:00:00.000Z',
      columnSchema: [],
    });
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);

    await call({ query: 'AAPL', forms: ['10-k ', ''], filing_limit: 2 });

    expect(registerDataframe.mock.calls[0]?.[1].queryParams.forms).toEqual(['10-K']);
  });
});

// SEC's strings are not the tool's text: content[] escapes them, so a CommonMark
// parse reads back each structuredContent value (#221).
describe('companySearchTool — SEC strings in content[] (#221)', () => {
  it('reads back the name, SIC description, and filing description as structuredContent carries them', async () => {
    // A trailing backslash ahead of the bold's closing asterisks, as SEC conforms the name.
    const name = 'US BANCORP \\DE\\';
    const sicDescription = 'NATIONAL *COMMERCIAL* BANKS _x_ `y` [a](b) &amp; <b>z</b>';
    // Its line breaks open lines of their own, which must not start a list or a heading.
    const description = 'EX-99 *DRAFT* \\\n1. not a list\n# not a heading';
    mockApi.resolveCik.mockResolvedValue({ cik: '0000036104', name, ticker: 'USB' });
    mockApi.getSubmissions.mockResolvedValue({
      ...mockSubmissions,
      cik: '0000036104',
      exchanges: ['NYSE'],
      filings: {
        recent: {
          accessionNumber: ['0000036104-26-000001'],
          filingDate: ['2026-01-15'],
          form: ['8-K'],
          primaryDocDescription: [description],
          primaryDocument: ['usb-8k.htm'],
          reportDate: ['2026-01-14'],
        },
        files: [],
      },
      name,
      sic: '6021',
      sicDescription,
      tickers: ['USB'],
    });

    const result = await runToolContract(companySearchTool, { query: 'USB' });

    expect(result.isError).toBeFalsy();
    const output = companySearchTool.output.parse(result.structuredContent);
    expect(output.name).toBe(name);
    expect(output.sic_description).toBe(sicDescription);
    expect(output.filings?.[0]?.description).toBe(description);
    const text = readCommonMark(blockText(result.content));
    expect(text).toContain(`⟨strong⟩${name}⟨/strong⟩ (USB)\nCIK: 0000036104`);
    expect(text).toContain(`| SIC: 6021 (${sicDescription}) | Exchange: NYSE\n`);
    expect(text).toContain(
      `8-K 2026-01-15 (period: 2026-01-14) — ${description} — usb-8k.htm [0000036104-26-000001]`,
    );
  });
});

/**
 * A ticker spelling resolveCik read (#235) names the reading in resolvedAs on both surfaces; a
 * match no reading produced carries none, and a non-US listing's no_match says what the suffix
 * is. The readings themselves are tabled in the resolve-cik and listing-codes tests.
 */
describe('companySearchTool — ticker spellings EDGAR does not list (#235)', () => {
  const READING = 'UEC.N read as UEC (URANIUM ENERGY CORP)';

  it('names the reading in resolvedAs, in structuredContent and content[]', async () => {
    mockApi.resolveCik.mockResolvedValue({
      cik: '0001334933',
      name: 'URANIUM ENERGY CORP',
      ticker: 'UEC',
      reading: READING,
    });

    const result = await runToolContract(companySearchTool, {
      query: 'UEC.N',
      include_filings: false,
    });

    expect(result.isError).toBeFalsy();
    expect(bag(result.structuredContent).resolvedAs).toBe(READING);
    // A code literal, so the parsed text reads back as the structuredContent value.
    expect(readCommonMark(allText(result))).toContain(
      `⟨strong⟩Resolved as:⟨/strong⟩ ⟨code_inline:${READING}⟩`,
    );
  });

  it('carries no resolvedAs for a match no reading produced', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });

    const result = await runToolContract(companySearchTool, {
      query: 'AAPL',
      include_filings: false,
    });

    expect(bag(result.structuredContent)).not.toHaveProperty('resolvedAs');
    expect(allText(result)).not.toContain('Resolved as');
  });

  it.each([
    [
      '7203.T',
      ' The .T suffix marks a non-US listing; EDGAR indexes SEC registrants by US ticker, name, or CIK.',
    ],
    // A name gets no listing note; EDGAR's indexes found nothing for it either (#236).
    [
      'Riot',
      ' No 10-K subsidiaries exhibit (EX-21) names it either; for filings that mention it, call secedgar_search_filings with {"query":"\\"Riot\\""}.',
    ],
  ])(
    'ends the no_match message for %s with the listing note when one applies',
    async (query, note) => {
      mockApi.resolveCik.mockResolvedValue([]);

      const error = wireError(await runToolContract(companySearchTool, { query }));

      expect(error.data.reason).toBe('no_match');
      expect(error.message).toBe(`No company found for '${query}'.${note}`);
    },
  );
});

// --- A name SEC's ticker file misses (#236) ---

/** SEC's ticker file for the entity-index cases: Roper, Duke, and two 10-K filers that mention Vertafore. */
const INDEX_TICKER_FILE = {
  0: { cik_str: 882835, ticker: 'ROP', title: 'ROPER TECHNOLOGIES INC' },
  1: { cik_str: 1326160, ticker: 'DUK', title: 'Duke Energy CORP' },
  2: { cik_str: 1278752, ticker: 'MFIC', title: 'MidCap Financial Investment Corp' },
  3: { cik_str: 1286681, ticker: 'DPZ', title: "DOMINO'S PIZZA, INC." },
};

/** An entity-index answer: `hits` as `[CIK, entity name, tickers?]`, and SEC's count. */
const entityIndex = (
  total: { value: number; relation: string },
  hits: Array<readonly [string, string, string?]>,
) => ({
  hits: {
    total,
    hits: hits.map(([id, entity, tickers]) => ({
      _id: id,
      _source: { entity: tickers ? `${entity} (${tickers})` : entity, ...(tickers && { tickers }) },
    })),
  },
});

const NO_INDEX_HITS = entityIndex({ value: 0, relation: 'eq' }, []);
const NO_DOCUMENTS = { hits: { total: { value: 0, relation: 'eq' }, hits: [] } };

/** The full-text page for a quoted name over 10-Ks, trimmed from a live capture (2026-11-13). */
const fullTextFixture = (name: string): object =>
  JSON.parse(
    readFileSync(
      new URL(`../../../fixtures/company-search/fts10k-${name}.json`, import.meta.url),
      'utf8',
    ),
  );

/** A submissions document with no filings, for a match the entity index resolved. */
const bareSubmissions = (cik: string, name: string): SubmissionsResponse => ({
  cik,
  entityType: 'other',
  exchanges: [],
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
  fiscalYearEnd: null,
  name,
  sic: '',
  sicDescription: '',
  tickers: [],
});

/**
 * How SEC answers one of the stubbed requests: a JSON 200 body, an HTTP status, or a
 * responder given the request's signal.
 */
type SecAnswer = object | number | ((signal: AbortSignal | undefined) => Promise<Response>);

const respond = (answer: SecAnswer, signal: AbortSignal | undefined): Promise<Response> => {
  if (typeof answer === 'function') return answer(signal);
  if (typeof answer === 'number') {
    return Promise.resolve(new Response(`status ${answer}`, { status: answer }));
  }
  return Promise.resolve(Response.json(answer));
};

/**
 * Stand in for SEC: the two ticker files, the entity index (`keysTyped`) and full-text
 * search (`q`) each answered with its `SecAnswer`, and the submissions documents given.
 * Records every request; one it does not route rejects and is recorded in `unrouted`.
 */
function stubSec({
  index,
  fullText,
  submissions = {},
}: {
  index?: SecAnswer;
  fullText?: SecAnswer;
  submissions?: Record<string, SubmissionsResponse>;
}) {
  const requested: URL[] = [];
  const unrouted: string[] = [];
  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    requested.push(url);
    if (url.pathname === '/files/company_tickers.json') {
      return Promise.resolve(Response.json(INDEX_TICKER_FILE));
    }
    if (url.pathname === '/files/company_tickers_mf.json') {
      return Promise.resolve(
        Response.json({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [] }),
      );
    }
    const answer =
      url.hostname !== 'efts.sec.gov'
        ? undefined
        : url.searchParams.has('keysTyped')
          ? index
          : fullText;
    if (answer !== undefined) return respond(answer, init.signal ?? undefined);
    const doc = url.hostname === 'data.sec.gov' ? submissions[url.pathname] : undefined;
    if (doc) return Promise.resolve(Response.json(doc));
    unrouted.push(input);
    return Promise.reject(new Error(`unrouted fetch: ${input}`));
  });
  return {
    unrouted,
    /** The EDGAR full-text requests sent, in order: `index` (keysTyped) or `full-text` (q). */
    efts: () =>
      requested
        .filter((url) => url.hostname === 'efts.sec.gov')
        .map((url) => (url.searchParams.has('keysTyped') ? 'index' : 'full-text')),
    requested,
  };
}

/** The no_match pointer for a name no subsidiaries exhibit holds. */
const searchFilingsPointer = (query: string) =>
  ` No 10-K subsidiaries exhibit (EX-21) names it either; for filings that mention it, call secedgar_search_filings with ${JSON.stringify({ query: `"${query}"` })}.`;

const NO_MATCH_HINT =
  'SEC\'s ticker index reflects the filer\'s own submissions record, which can differ from the exchange-listed symbol. ETFs and mutual funds resolve only by ticker (e.g. "VOO"); operating companies also resolve by full legal name or 10-digit CIK.';

/**
 * A name every local pass misses goes to EDGAR's entity index, and, when no index hit
 * reaches a name tier, to the 10-K subsidiaries exhibits holding it (#236). Driven through
 * `runToolContract` over the real `EdgarApiService`, with fake timers and `fetch` stubbed;
 * SEC's answers are live captures from 2026-11-13. The trigram scan stays mocked.
 */
describe('companySearchTool — a name SEC’s ticker file misses (#236)', () => {
  let edgar: typeof import('@/services/edgar/edgar-api-service.js');

  beforeEach(async () => {
    vi.useFakeTimers();
    edgar = await vi.importActual<typeof import('@/services/edgar/edgar-api-service.js')>(
      '@/services/edgar/edgar-api-service.js',
    );
    edgar.initEdgarApiService();
    vi.mocked(getEdgarApiService).mockReturnValue(edgar.getEdgarApiService());
  });

  afterEach(() => {
    edgar.disposeEdgarApiService();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    config.mirrorFallbackLive = true;
    mirrorRef.current = undefined;
  });

  /** Run the tool with the clock advanced past every pacer gap and retry backoff. */
  async function search(args: Record<string, unknown>, signal?: AbortSignal) {
    const call = runToolContract(
      companySearchTool,
      { include_filings: false, ...args } as never,
      signal ? { context: { signal } } : undefined,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    return call;
  }

  describe('the entity index', () => {
    it.each([
      [
        'GasEntec Holdings',
        ['2152783', 'Gasentec Holdings, Inc.'],
        "'GasEntec Holdings' matched Gasentec Holdings, Inc. (CIK 0002152783) in EDGAR's entity index, with no listed ticker",
      ],
      [
        'Exxon Mobil',
        ['34088', 'EXXON MOBIL CORP'],
        "'Exxon Mobil' matched EXXON MOBIL CORP (CIK 0000034088) in EDGAR's entity index, with no listed ticker",
      ],
      [
        'Acme Rockets',
        ['1111111', 'ACME ROCKETS INC', 'ACRK, ACRK-PA'],
        "'Acme Rockets' matched ACME ROCKETS INC (ACRK, CIK 0001111111) in EDGAR's entity index",
      ],
    ] as const)(
      'resolves %s, its one exact-tier hit, naming the index in resolvedAs on both surfaces',
      async (query, hit, reading) => {
        const cik = hit[0].padStart(10, '0');
        const sec = stubSec({
          index: entityIndex({ value: 1, relation: 'eq' }, [hit]),
          submissions: { [`/submissions/CIK${cik}.json`]: bareSubmissions(cik, hit[1]) },
        });

        const result = await search({ query });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ cik, name: hit[1], resolvedAs: reading });
        expect(readCommonMark(allText(result))).toContain(
          `⟨strong⟩Resolved as:⟨/strong⟩ ⟨code_inline:${reading}⟩`,
        );
        expect(sec.efts()).toEqual(['index']);
        expect(sec.unrouted).toEqual([]);
      },
    );

    it('leaves the SIC out of content[] for a filer SEC records none for', async () => {
      stubSec({
        index: entityIndex({ value: 1, relation: 'eq' }, [['2152783', 'Gasentec Holdings, Inc.']]),
        submissions: {
          '/submissions/CIK0002152783.json': bareSubmissions(
            '0002152783',
            'Gasentec Holdings, Inc.',
          ),
        },
      });

      const result = await search({ query: 'GasEntec Holdings' });

      expect(result.structuredContent).toMatchObject({ sic: '', sic_description: '' });
      expect(allText(result)).toMatch(/^CIK: 0002152783$/m);
      expect(allText(result)).not.toContain('SIC:');
    });

    it('resolves Krones to KRONES AG, its exact hit, past Krones AG / ADR at the prefix tier', async () => {
      const sec = stubSec({
        index: entityIndex({ value: 2, relation: 'eq' }, [
          ['933414', 'KRONES AG'],
          ['1457890', 'Krones AG / ADR'],
        ]),
        submissions: {
          '/submissions/CIK0000933414.json': bareSubmissions('0000933414', 'KRONES AG'),
        },
      });

      const result = await search({ query: 'Krones' });

      expect(result.structuredContent).toMatchObject({
        cik: '0000933414',
        resolvedAs:
          "'Krones' matched KRONES AG (CIK 0000933414) in EDGAR's entity index, with no listed ticker",
      });
      expect(sec.efts()).toEqual(['index']);
    });

    it('fails Novelis as ambiguous_company listing its 3 exact hits of SEC’s 21, with the Showing sentence', async () => {
      const sec = stubSec({
        index: entityIndex({ value: 21, relation: 'eq' }, [
          ['1332463', 'Novelis AG'],
          ['1304280', 'Novelis Inc.'],
          ['1332419', 'Novelis CORP'],
          ['1332462', 'Novelis UK Ltd.'],
          ['1472102', 'Novelis P.A.E. SAS'],
          ['1332421', 'Novelis PAE CORP'],
          ['1382215', 'Novelis Brand LLC'],
          ['1471998', 'Novelis Services Ltd'],
          ['1332444', 'Novelis do Brasil Ltda.'],
          ['1332465', 'Novelis Technology AG'],
        ]),
      });

      const result = await search({ query: 'Novelis' });

      const error = wireError(result);
      const message =
        "'Novelis' matches multiple companies: 0001332463 Novelis AG, 0001304280 Novelis Inc., 0001332419 Novelis CORP. Retry with one of these tickers or 10-digit CIKs. Showing 3 of 21 matches; for one not listed, retry with a fuller name, its ticker, or its CIK.";
      expect(error).toMatchObject({ code: JsonRpcErrorCode.ValidationError, message });
      expect(error.data).toMatchObject({
        reason: 'ambiguous_company',
        query: 'Novelis',
        matches: [
          { cik: '0001332463', name: 'Novelis AG' },
          { cik: '0001304280', name: 'Novelis Inc.' },
          { cik: '0001332419', name: 'Novelis CORP' },
        ],
        total_matches: 21,
      });
      expect(error.data).not.toHaveProperty('total_matches_is_lower_bound');
      expect(readCommonMark(blockText(result.content))).toContain(message);
      expect(sec.efts()).toEqual(['index']);
    });

    it('fails Google as ambiguous_company listing its 4 exact hits as the whole count, SEC’s page being complete', async () => {
      stubSec({
        index: entityIndex({ value: 7, relation: 'eq' }, [
          ['1136101', 'GOOGLE INC'],
          ['1288776', 'GOOGLE INC.'],
          ['1302837', 'Google Inc'],
          ['1824723', 'Google LLC'],
          ['1231833', 'GOOGLE TECHNOLOGY INC'],
          ['1586699', 'Google Ventures 2011, L.P.'],
          ['1639805', 'Google Ventures 2011 GP, L.L.C.'],
        ]),
      });

      const error = wireError(await search({ query: 'Google' }));

      expect(error.message).toBe(
        "'Google' matches multiple companies: 0001136101 GOOGLE INC, 0001288776 GOOGLE INC., 0001302837 Google Inc, 0001824723 Google LLC. Retry with one of these tickers or 10-digit CIKs.",
      );
      expect(error.data).toMatchObject({ reason: 'ambiguous_company', total_matches: 4 });
      expect(error.data.matches).toHaveLength(4);
    });

    it('fails no_match with a lone prefix-tier hit first in data.suggestions, searching no exhibits', async () => {
      vi.mocked(suggestCompanies).mockReturnValue([
        { cik: '0002222222', name: 'ACME WIDGETRY CORP', ticker: 'AWC' },
        { cik: '0003333333', name: 'ACME WIDGET HOLDINGS LLC' },
      ]);
      const sec = stubSec({
        index: entityIndex({ value: 1, relation: 'eq' }, [['3333333', 'ACME WIDGET HOLDINGS LLC']]),
      });

      const result = await search({ query: 'Acme Widget' });

      const error = wireError(result);
      expect(error.data.reason).toBe('no_match');
      // The index hit leads; the trigram list follows without repeating its CIK.
      expect(error.data.suggestions).toEqual([
        { cik: '0003333333', name: 'ACME WIDGET HOLDINGS LLC' },
        { cik: '0002222222', name: 'ACME WIDGETRY CORP', ticker: 'AWC' },
      ]);
      expect(error.message).toBe(
        "No company found for 'Acme Widget'. Near matches: ACME WIDGET HOLDINGS LLC, ACME WIDGETRY CORP (AWC).",
      );
      expect(bag(error.data.recovery).hint).toBe(
        `Check \`data.suggestions\` for near matches. ${NO_MATCH_HINT}`,
      );
      expect(error.data).not.toHaveProperty('parents');
      expect(sec.efts()).toEqual(['index']);
    });
  });

  describe('10-K subsidiaries exhibits', () => {
    it('names Roper, the filer of the EX-21 exhibits holding Vertafore, on both surfaces, and no filer of other documents', async () => {
      const sec = stubSec({ index: NO_INDEX_HITS, fullText: fullTextFixture('vertafore') });

      const result = await search({ query: 'Vertafore' });

      const error = wireError(result);
      const message =
        "No company found for 'Vertafore'. 'Vertafore' appears in the subsidiaries exhibit (EX-21) of ROPER TECHNOLOGIES INC (ROP, CIK 0000882835), in its 10-K filed 2026-02-24 (accession 0000882835-26-000009), so it may be a subsidiary of that filer.";
      expect(error).toMatchObject({ code: JsonRpcErrorCode.NotFound, message });
      expect(error.data).toMatchObject({
        reason: 'no_match',
        parents: [
          {
            cik: '0000882835',
            name: 'ROPER TECHNOLOGIES INC',
            ticker: 'ROP',
            filing_date: '2026-02-24',
            accession_number: '0000882835-26-000009',
          },
        ],
        recovery: {
          hint: `Check \`data.parents\` for the filers whose 10-K subsidiaries exhibit names it. ${NO_MATCH_HINT}`,
        },
      });
      expect(error.data.parents).toHaveLength(1);
      expect(error.data).not.toHaveProperty('suggestions');
      const text = readCommonMark(blockText(result.content));
      expect(text).toContain(message);
      // Apollo Investment (now MidCap Financial) and Domino's mention Vertafore in other
      // 10-K documents, and the ticker file lists both: neither is named.
      expect(allText(result)).not.toMatch(/MIDCAP|MFIC|APOLLO|DOMINO|DPZ/i);
      expect(sec.efts()).toEqual(['index', 'full-text']);
      expect(sec.unrouted).toEqual([]);
    });

    it('names several co-registrants, the one the ticker file lists first, with trigram suggestions after', async () => {
      vi.mocked(suggestCompanies).mockReturnValue([
        { cik: '0001326160', name: 'Duke Energy CORP', ticker: 'DUK' },
      ]);
      stubSec({
        index: NO_INDEX_HITS,
        fullText: {
          hits: {
            total: { value: 1, relation: 'eq' },
            hits: [
              {
                _id: '0001326160-16-000221:duk-20151231x10kxexx21.htm',
                _source: {
                  adsh: '0001326160-16-000221',
                  ciks: ['0000017797', '0001326160'],
                  display_names: [
                    'DUKE ENERGY PROGRESS, LLC.  (CIK 0000017797)',
                    'Duke Energy CORP  (DUK, DUKB, DUKH, DUK-PA)  (CIK 0001326160)',
                  ],
                  file_date: '2016-02-25',
                  file_type: 'EX-21',
                  form: '10-K',
                  root_forms: ['10-K'],
                },
              },
            ],
          },
        },
      });

      const error = wireError(await search({ query: 'Duke Energy Renewables' }));

      expect(error.message).toBe(
        "No company found for 'Duke Energy Renewables'. 'Duke Energy Renewables' appears in the subsidiaries exhibit (EX-21) of Duke Energy CORP (DUK, CIK 0001326160), in its 10-K filed 2016-02-25 (accession 0001326160-16-000221); DUKE ENERGY PROGRESS, LLC. (CIK 0000017797), in its 10-K filed 2016-02-25 (accession 0001326160-16-000221), so it may be a subsidiary of one of these filers. Near matches: Duke Energy CORP (DUK).",
      );
      expect(records(error.data.parents).map((p) => p.cik)).toEqual(['0001326160', '0000017797']);
      expect(bag(error.data.recovery).hint).toBe(
        `Check \`data.parents\` for the filers whose 10-K subsidiaries exhibit names it. Check \`data.suggestions\` for near matches. ${NO_MATCH_HINT}`,
      );
    });

    it.each([
      ['no document', NO_DOCUMENTS],
      [
        'only documents other than a subsidiaries exhibit',
        {
          hits: {
            total: { value: 1, relation: 'eq' },
            hits: [
              {
                _id: '0001278752-20-000010:ex99.htm',
                _source: {
                  adsh: '0001278752-20-000010',
                  ciks: ['0001278752'],
                  display_names: ['APOLLO INVESTMENT CORP  (MFIC, MFICL)  (CIK 0001278752)'],
                  file_date: '2020-05-20',
                  file_type: '10-K',
                  form: '10-K',
                  root_forms: ['10-K'],
                },
              },
            ],
          },
        },
      ],
    ])(
      'fails Nonexistent Widget Makers of Ohio as no_match after one index and one full-text request, given %s',
      async (_case, page) => {
        const sec = stubSec({ index: NO_INDEX_HITS, fullText: page });

        const result = await search({ query: 'Nonexistent Widget Makers of Ohio' });

        const error = wireError(result);
        const message = `No company found for 'Nonexistent Widget Makers of Ohio'.${searchFilingsPointer('Nonexistent Widget Makers of Ohio')}`;
        expect(error).toMatchObject({ code: JsonRpcErrorCode.NotFound, message });
        expect(error.data).not.toHaveProperty('parents');
        expect(bag(error.data.recovery).hint).toBe(NO_MATCH_HINT);
        // content[] prints the arguments as code, so a caller copies them with no escapes.
        const args = '{"query":"\\"Nonexistent Widget Makers of Ohio\\""}';
        expect(codeSpansIn(blockText(result.content))).toEqual([args]);
        expect(readCommonMark(blockText(result.content))).toContain(
          message.replace(args, `⟨code_inline:${args}⟩`),
        );
        expect(sec.efts()).toEqual(['index', 'full-text']);
        const fullText = sec.requested.find((url) => url.searchParams.has('q'));
        expect(fullText?.searchParams.get('q')).toBe('"Nonexistent Widget Makers of Ohio"');
        expect(fullText?.searchParams.get('forms')).toBe('10-K');
      },
    );

    it.each([
      [
        'its search backend refusing it',
        {
          errorType: 'ResponseError',
          errorMessage: 'search_phase_execution_exception',
          trace: [],
        },
        ' The search for a 10-K subsidiaries exhibit (EX-21) naming it did not run (efts_degraded_response); retry the call in a minute to run it.',
      ],
      [
        'a 429',
        429,
        ' The search for a 10-K subsidiaries exhibit (EX-21) naming it did not run (rate_limited); retry the call after 600 seconds to run it.',
      ],
    ])(
      'keeps no_match when full-text search fails, %s, and says that search did not run',
      async (_case, answer, sentence) => {
        const sec = stubSec({ index: NO_INDEX_HITS, fullText: answer });

        const result = await search({ query: 'Vertafore' });

        const error = wireError(result);
        expect(error.code).toBe(JsonRpcErrorCode.NotFound);
        expect(error.data.reason).toBe('no_match');
        expect(error.message).toBe(`No company found for 'Vertafore'.${sentence}`);
        expect(error.data).not.toHaveProperty('parents');
        expect(readCommonMark(blockText(result.content))).toContain(sentence.trim());
        expect(sec.efts()).toEqual(['index', 'full-text']);
      },
    );

    it('ends on the caller’s cancel during the full-text search, settling as RequestCancelled on both surfaces', async () => {
      const caller = new AbortController();
      const signals: Array<AbortSignal | undefined> = [];
      stubSec({
        index: NO_INDEX_HITS,
        fullText: (signal) => {
          signals.push(signal);
          caller.abort('client cancelled');
          return new Promise<Response>((_resolve, reject) => {
            if (signal?.aborted) reject(signal.reason);
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      });

      const result = await search({ query: 'Vertafore' }, caller.signal);

      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(bag(result.structuredContent).error).toEqual({
        code: JsonRpcErrorCode.RequestCancelled,
        message: 'client cancelled',
      });
      expect(blockText(result.content)).toBe('Error: client cancelled');
    });
  });

  it.each([
    [
      'its search backend refusing it',
      { errorType: 'ResponseError', errorMessage: 'search_phase_execution_exception', trace: [] },
      JsonRpcErrorCode.ServiceUnavailable,
      'efts_degraded_response',
    ],
    ['a 503 on every attempt', 503, JsonRpcErrorCode.ServiceUnavailable, 'sec_unavailable'],
    ['a 429', 429, JsonRpcErrorCode.RateLimited, 'rate_limited'],
  ])(
    'fails with the entity index’s own reason, never no_match, given %s (#206)',
    async (_case, answer, code, reason) => {
      const sec = stubSec({ index: answer, fullText: NO_DOCUMENTS });

      const error = wireError(await search({ query: 'Vertafore' }));

      expect(error.code).toBe(code);
      expect(error.data.reason).toBe(reason);
      expect(sec.efts().every((kind) => kind === 'index')).toBe(true);
      expect(sec.efts().length).toBeGreaterThan(0);
    },
  );

  it.each([
    ['a symbol the ticker file lists', 'ROP'],
    ['a name the ticker file lists', 'Roper Technologies'],
  ])('sends no EDGAR full-text request for %s', async (_case, query) => {
    const sec = stubSec({
      submissions: {
        '/submissions/CIK0000882835.json': bareSubmissions('0000882835', 'ROPER TECHNOLOGIES INC'),
      },
    });

    const result = await search({ query });

    expect(result.structuredContent).toMatchObject({ cik: '0000882835' });
    expect(sec.efts()).toEqual([]);
  });

  it.each([
    ['a non-US listing', '7203.T'],
    ['a query with no letter or digit', '.'],
  ])('fails %s as no_match without searching EDGAR’s indexes', async (_case, query) => {
    const sec = stubSec({});

    const error = wireError(await search({ query }));

    expect(error.data.reason).toBe('no_match');
    expect(sec.efts()).toEqual([]);
    expect(sec.unrouted).toEqual([]);
  });

  it('searches the entity index and the exhibits live in strict mirror mode, which mirrors neither', async () => {
    config.mirrorFallbackLive = false;
    mirrorRef.current = {
      tickersReady: async () => true,
      getTickerRows: async () => [
        { cik: '0000882835', name: 'ROPER TECHNOLOGIES INC', ticker: 'ROP' },
      ],
    };
    const sec = stubSec({ index: NO_INDEX_HITS, fullText: fullTextFixture('vertafore') });

    const error = wireError(await search({ query: 'Vertafore' }));

    expect(error.data.reason).toBe('no_match');
    expect(records(error.data.parents).map((p) => p.cik)).toEqual(['0000882835']);
    expect(sec.efts()).toEqual(['index', 'full-text']);
    // Strict mode read its tickers from the mirror: the ticker files were never requested.
    expect(sec.requested.filter((url) => url.hostname === 'www.sec.gov')).toEqual([]);
  });
});
