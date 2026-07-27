/**
 * @fileoverview Tests for get-material-events — 8-K filings filtered by item code.
 * Covers item decoding across both numbering regimes, the item filter, the archive
 * scan and its page cap, and both zero-hit causes.
 * @module tests/mcp-server/tools/definitions/get-material-events.tool
 */

import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMaterialEventsTool } from '@/mcp-server/tools/definitions/get-material-events.tool.js';
import type { FilingsRecent, SubmissionsResponse } from '@/services/edgar/types.js';

vi.mock('@/services/edgar/edgar-api-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/edgar/edgar-api-service.js')>();
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

interface FilingSpec {
  accession: string;
  date: string;
  doc?: string;
  form?: string;
  items?: string;
  report?: string;
}

function block(filings: FilingSpec[]): FilingsRecent {
  return {
    accessionNumber: filings.map((f) => f.accession),
    filingDate: filings.map((f) => f.date),
    form: filings.map((f) => f.form ?? '8-K'),
    items: filings.map((f) => f.items ?? ''),
    primaryDocDescription: filings.map(() => '8-K'),
    primaryDocument: filings.map((f) => f.doc ?? 'doc.htm'),
    reportDate: filings.map((f) => f.report ?? f.date),
  };
}

function buildSubmissions(opts: {
  filings: FilingSpec[];
  files?: Array<{ name: string; filingCount: number; filingFrom: string; filingTo: string }>;
  name?: string;
}): SubmissionsResponse {
  return {
    cik: '0000320193',
    entityType: 'operating',
    exchanges: ['Nasdaq'],
    filings: { recent: block(opts.filings), files: opts.files ?? [] },
    fiscalYearEnd: '0930',
    name: opts.name ?? 'Apple Inc.',
    sic: '3571',
    sicDescription: 'Electronic Computers',
    tickers: ['AAPL'],
  };
}

const mockApi = {
  resolveCik: vi.fn(),
  getSubmissions: vi.fn(),
  fetchArchivePage: vi.fn(),
  getAllEntries: vi.fn(),
};

const RECENT_FILINGS: FilingSpec[] = [
  { accession: '0000320193-26-000011', date: '2026-04-30', items: '2.02,9.01' },
  { accession: '0001140361-26-015711', date: '2026-04-20', items: '5.02', report: '2026-04-17' },
  { accession: '0001140361-26-006577', date: '2026-02-24', items: '5.07,9.01' },
  { accession: '0000320193-26-000005', date: '2026-01-29', items: '2.02,9.01' },
  { accession: '0000320193-25-000100', date: '2025-11-03', items: '8.01', form: '8-K/A' },
  { accession: '0000320193-25-000090', date: '2025-10-30', form: '10-Q', items: '' },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCanvasBridge).mockReturnValue(undefined as never);
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as never);
  mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
  mockApi.getSubmissions.mockResolvedValue(buildSubmissions({ filings: RECENT_FILINGS }));
  mockApi.getAllEntries.mockResolvedValue([]);
});

describe('getMaterialEventsTool', () => {
  it('returns 8-K filings with items decoded, excluding other forms', async () => {
    const ctx = createMockContext({ errors: getMaterialEventsTool.errors });
    const input = getMaterialEventsTool.input.parse({ company: 'AAPL' });
    const result = await getMaterialEventsTool.handler(input, ctx);

    expect(result.cik).toBe('0000320193');
    expect(result.total_8k_scanned).toBe(5);
    expect(result.filings.map((f) => f.form)).toEqual(['8-K', '8-K', '8-K', '8-K', '8-K/A']);
    expect(result.filings[0]?.items).toEqual([
      { code: '2.02', label: 'Results of Operations and Financial Condition', regime: 'current' },
      { code: '9.01', label: 'Financial Statements and Exhibits', regime: 'current' },
    ]);
  });

  it('counts item codes across the scanned window before the filter', async () => {
    const ctx = createMockContext({ errors: getMaterialEventsTool.errors });
    const input = getMaterialEventsTool.input.parse({ company: 'AAPL' });
    const result = await getMaterialEventsTool.handler(input, ctx);

    expect(result.item_distribution).toEqual({
      '2.02': 2,
      '9.01': 3,
      '5.02': 1,
      '5.07': 1,
      '8.01': 1,
    });
  });

  it('keeps a filing reporting any of the requested items', async () => {
    const ctx = createMockContext({ errors: getMaterialEventsTool.errors });
    const input = getMaterialEventsTool.input.parse({ company: 'AAPL', items: ['2.02', '5.02'] });
    const result = await getMaterialEventsTool.handler(input, ctx);

    expect(result.items_filter).toEqual(['2.02', '5.02']);
    expect(result.total_matched).toBe(3);
    expect(result.total_8k_scanned).toBe(5);
    expect(result.filings.map((f) => f.accession_number)).toEqual([
      '0000320193-26-000011',
      '0001140361-26-015711',
      '0000320193-26-000005',
    ]);
  });

  it('decodes pre-2004 filings against the legacy regime', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        filings: [
          { accession: '0000320193-98-000010', date: '1998-12-23', items: '1', doc: '' },
          { accession: '0000320193-97-000012', date: '1997-07-28', items: '4', doc: '' },
        ],
      }),
    );
    const ctx = createMockContext({ errors: getMaterialEventsTool.errors });
    const input = getMaterialEventsTool.input.parse({ company: 'AAPL' });
    const result = await getMaterialEventsTool.handler(input, ctx);

    // Legacy 1 is a control change, not the current 1.01 material agreement, and
    // legacy 4 is the auditor change that the current regime numbers 4.01.
    expect(result.filings[0]?.items).toEqual([
      { code: '1', label: 'Changes in Control of Registrant', regime: 'legacy' },
    ]);
    expect(result.filings[1]?.items).toEqual([
      { code: '4', label: "Changes in Registrant's Certifying Accountant", regime: 'legacy' },
    ]);
    // EDGAR records no primary document for filings this old.
    expect(result.filings[0]?.primary_document).toBeUndefined();
  });

  it('never matches a legacy filing with a dotted filter', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        filings: [{ accession: '0001104659-04-019574', date: '2004-07-14', items: '12,7' }],
      }),
    );
    const ctx = createMockContext({ errors: getMaterialEventsTool.errors });
    const input = getMaterialEventsTool.input.parse({ company: 'AAPL', items: ['2.02'] });
    const result = await getMaterialEventsTool.handler(input, ctx);

    expect(result.total_matched).toBe(0);
    expect(result.total_8k_scanned).toBe(1);
  });

  it('spans the 2004 changeover when both regimes are in the filter', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        filings: [
          { accession: '0000320193-04-000200', date: '2004-10-13', items: '2.02,9.01' },
          { accession: '0001104659-04-019574', date: '2004-07-14', items: '12,7' },
          { accession: '0000320193-04-000050', date: '2004-05-01', items: '5,7' },
        ],
      }),
    );
    const ctx = createMockContext({ errors: getMaterialEventsTool.errors });
    const input = getMaterialEventsTool.input.parse({ company: 'AAPL', items: ['2.02', '12'] });
    const result = await getMaterialEventsTool.handler(input, ctx);

    expect(result.filings.map((f) => f.accession_number)).toEqual([
      '0000320193-04-000200',
      '0001104659-04-019574',
    ]);
    expect(result.filings[1]?.items[0]?.regime).toBe('legacy');
  });

  it('pages into the archive for a date window older than the recent block', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        filings: RECENT_FILINGS,
        files: [
          {
            name: 'CIK0000320193-submissions-001.json',
            filingCount: 1236,
            filingFrom: '1994-01-26',
            filingTo: '2015-05-27',
          },
        ],
      }),
    );
    mockApi.fetchArchivePage.mockResolvedValue(
      block([{ accession: '0000320193-96-000006', date: '1996-04-12', items: '1' }]),
    );

    const ctx = createMockContext({ errors: getMaterialEventsTool.errors });
    const input = getMaterialEventsTool.input.parse({
      company: 'AAPL',
      filed_after: '1996-01-01',
      filed_before: '1999-12-31',
    });
    const result = await getMaterialEventsTool.handler(input, ctx);

    expect(mockApi.fetchArchivePage).toHaveBeenCalledWith('CIK0000320193-submissions-001.json');
    expect(result.total_matched).toBe(1);
    expect(result.history_scanned_through).toBe('1994-01-26');
  });

  it('stops the archive scan at the page cap and flags the dataframe truncated', async () => {
    const files = Array.from({ length: 14 }, (_, i) => ({
      name: `CIK0000320193-submissions-${String(i + 1).padStart(3, '0')}.json`,
      filingCount: 100,
      filingFrom: `19${80 + i}-01-01`,
      filingTo: `19${80 + i}-12-31`,
    }));
    mockApi.getSubmissions.mockResolvedValue(buildSubmissions({ filings: [], files }));
    mockApi.fetchArchivePage.mockImplementation(async (name: string) =>
      block([
        { accession: `${name}-a`, date: '1990-01-01', items: '5' },
        { accession: `${name}-b`, date: '1990-02-01', items: '5' },
      ]),
    );
    vi.mocked(getCanvasBridge).mockReturnValue(stubBridge() as never);

    const ctx = createMockContext({ errors: getMaterialEventsTool.errors });
    const input = getMaterialEventsTool.input.parse({
      company: 'AAPL',
      filed_after: '1980-01-01',
      filed_before: '1995-12-31',
      limit: 5,
    });
    const result = await getMaterialEventsTool.handler(input, ctx);

    expect(mockApi.fetchArchivePage).toHaveBeenCalledTimes(10);
    expect(result.total_matched).toBe(20);
    expect(result.dataset?.truncated).toBe(true);
  });

  it('reports an empty date window as having no 8-K filings at all', async () => {
    const ctx = createMockContext({ errors: getMaterialEventsTool.errors });
    const input = getMaterialEventsTool.input.parse({
      company: 'AAPL',
      filed_after: '2000-01-01',
      filed_before: '2000-12-31',
    });
    const result = await getMaterialEventsTool.handler(input, ctx);

    expect(result.total_8k_scanned).toBe(0);
    expect(result.total_matched).toBe(0);
    expect(getEnrichment(ctx).notice).toContain('filed no 8-K between 2000-01-01 and 2000-12-31');
  });

  it('separates an items filter that excluded everything from an empty window', async () => {
    const ctx = createMockContext({ errors: getMaterialEventsTool.errors });
    const input = getMaterialEventsTool.input.parse({ company: 'AAPL', items: ['4.02'] });
    const result = await getMaterialEventsTool.handler(input, ctx);

    expect(result.total_8k_scanned).toBe(5);
    expect(result.total_matched).toBe(0);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('none reporting items [4.02]');
    // Echoing what IS present is the difference between "widen the window" and
    // "pick a different item".
    expect(notice).toContain(
      'Items actually reported in this window: 2.02, 5.02, 5.07, 8.01, 9.01',
    );
  });

  it('materializes the full filtered set with item codes on every row', async () => {
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);
    const ctx = createMockContext({ errors: getMaterialEventsTool.errors });
    const input = getMaterialEventsTool.input.parse({ company: 'AAPL', limit: 2 });
    const result = await getMaterialEventsTool.handler(input, ctx);

    expect(result.filings).toHaveLength(2);
    expect(result.dataset?.row_count).toBe(5);
    const rows = bridge.registerDataframe.mock.calls[0]?.[1].rows;
    expect(rows?.[0]).toMatchObject({
      accession_number: '0000320193-26-000011',
      item_codes: '2.02,9.01',
      item_regime: 'current',
    });
    expect(getEnrichment(ctx).truncated).toBe(true);
  });

  it('fails with suggestions when the company does not resolve', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getMaterialEventsTool.errors });
    const input = getMaterialEventsTool.input.parse({ company: 'Nonexistent Co' });

    await expect(getMaterialEventsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_match' },
    });
  });

  it('fails on an ambiguous company rather than picking one', async () => {
    mockApi.resolveCik.mockResolvedValue([
      { cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' },
      { cik: '0001604778', name: 'Apple Hospitality REIT', ticker: 'APLE' },
    ]);
    const ctx = createMockContext({ errors: getMaterialEventsTool.errors });
    const input = getMaterialEventsTool.input.parse({ company: 'Apple' });

    await expect(getMaterialEventsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'multiple_matches' },
    });
  });

  it('converts a bare-CIK submissions 404 into a no-match', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '9999999999' });
    mockApi.getSubmissions.mockRejectedValue(notFound('not found'));
    const ctx = createMockContext({ errors: getMaterialEventsTool.errors });
    const input = getMaterialEventsTool.input.parse({ company: '9999999999' });

    await expect(getMaterialEventsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_match' },
    });
  });

  it('rejects unknown item codes and out-of-range inputs at the schema', () => {
    expect(() => getMaterialEventsTool.input.parse({ company: 'AAPL', items: ['2.99'] })).toThrow();
    expect(() => getMaterialEventsTool.input.parse({ company: 'AAPL', items: ['13'] })).toThrow();
    expect(() =>
      getMaterialEventsTool.input.parse({ company: 'AAPL', items: ['earnings'] }),
    ).toThrow();
    expect(() =>
      getMaterialEventsTool.input.parse({ company: 'AAPL', filed_after: '04/30/2026' }),
    ).toThrow();
    expect(() => getMaterialEventsTool.input.parse({ company: 'AAPL', limit: 101 })).toThrow();
    expect(() => getMaterialEventsTool.input.parse({ company: '  ' })).toThrow();
    expect(
      getMaterialEventsTool.input.parse({ company: 'AAPL', items: ['2.02', '12'] }).items,
    ).toEqual(['2.02', '12']);
  });

  it('renders decoded items and the distribution into format()', () => {
    const text = getMaterialEventsTool.format?.({
      cik: '0000320193',
      company_name: 'Apple Inc.',
      items_filter: ['2.02'],
      total_matched: 1,
      total_8k_scanned: 5,
      item_distribution: { '2.02': 2, '9.01': 3 },
      history_scanned_through: '2015-06-10',
      filings: [
        {
          accession_number: '0000320193-26-000011',
          form: '8-K',
          filing_date: '2026-04-30',
          report_date: '2026-04-30',
          primary_document: 'aapl-20260430.htm',
          description: '8-K',
          items: [
            {
              code: '2.02',
              label: 'Results of Operations and Financial Condition',
              regime: 'current',
            },
          ],
        },
      ],
      dataset: undefined,
    })?.[0];

    const rendered = text?.type === 'text' ? text.text : '';
    expect(rendered).toContain('2.02 Results of Operations and Financial Condition [current]');
    expect(rendered).toContain('Item distribution across the scanned window: 2.02: 2, 9.01: 3');
    expect(rendered).toContain('History scanned through: 2015-06-10');
  });
});
