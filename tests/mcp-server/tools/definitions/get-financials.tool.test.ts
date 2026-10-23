/**
 * @fileoverview Tests for get-financials tool — XBRL financial data retrieval.
 * @module tests/mcp-server/tools/definitions/get-financials.tool
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFinancialsTool } from '@/mcp-server/tools/definitions/get-financials.tool.js';
import { CallScope } from '@/services/edgar/call-scope.js';
import { resolveConcept } from '@/services/edgar/concept-map.js';
import type {
  CompanyConceptResponse,
  CompanyConceptUnit,
  CompanyFactsResponse,
} from '@/services/edgar/types.js';

vi.mock('@/services/edgar/edgar-api-service.js', () => ({
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
}));

// Partial mock: the canvas accessors are stubbed, but `dataframeGuidance` stays
// real so the staged-dataframe pointer is asserted against the shipped wording.
vi.mock('@/services/canvas-bridge/canvas-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/canvas-bridge/canvas-bridge.js')>()),
  getCanvasBridge: vi.fn(),
  toDatasetField: vi.fn(),
}));

import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import {
  at,
  bag,
  blockText,
  caught,
  records,
  recoveryHint,
  wireError,
} from '../../../support/assertions.js';

const mockConceptResponse: CompanyConceptResponse = {
  cik: 320193,
  entityName: 'Apple Inc.',
  label: 'Revenue From Contract With Customer Excluding Assessed Tax',
  tag: 'RevenueFromContractWithCustomerExcludingAssessedTax',
  taxonomy: 'us-gaap',
  units: {
    USD: [
      {
        accn: '0000320193-23-000106',
        end: '2023-09-30',
        filed: '2023-11-03',
        form: '10-K',
        fp: 'FY',
        frame: 'CY2023',
        fy: 2023,
        val: 383285000000,
      },
      {
        accn: '0000320193-23-000077',
        end: '2023-07-01',
        filed: '2023-08-04',
        form: '10-Q',
        fp: 'Q3',
        frame: 'CY2023Q3',
        fy: 2023,
        val: 81797000000,
        start: '2023-04-02',
      },
      {
        accn: '0000320193-22-000108',
        end: '2022-09-24',
        filed: '2022-10-28',
        form: '10-K',
        fp: 'FY',
        frame: 'CY2022',
        fy: 2022,
        val: 394328000000,
      },
      // Entry without frame (should be deduped out)
      {
        accn: '0000320193-23-000106',
        end: '2023-09-30',
        filed: '2023-11-03',
        form: '10-K',
        fp: 'FY',
        fy: 2023,
        val: 383285000000,
      },
    ],
  },
};

const mockApi = {
  resolveCik: vi.fn(),
  tryGetCompanyConcept: vi.fn(),
  tryGetCompanyFacts: vi.fn(),
};

/**
 * The staleness caveat measures a single-concept series against the current
 * date (#102), so every fixture here would drift in and out of the two-year
 * floor as real time passes. Pinned just past the base fixture's newest period;
 * the staleness cases below set their own gaps against this instant.
 */
const NOW = '2024-06-30T00:00:00.000Z';

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as any);
  mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
  mockApi.tryGetCompanyConcept.mockResolvedValue(mockConceptResponse);
  mockApi.tryGetCompanyFacts.mockResolvedValue(null);
});

describe('getFinancialsTool', () => {
  it('returns financial data for a valid company and concept', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'AAPL', concept: 'revenue' });
    const result = await getFinancialsTool.handler(input, ctx);

    expect(result.company).toBe('Apple Inc.');
    expect(result.cik).toBe('0000320193');
    expect(result.unit).toBe('USD');
    expect(result.data.length).toBeGreaterThan(0);
  });

  it('resolves friendly concept names to XBRL tags', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'AAPL', concept: 'revenue' });
    await getFinancialsTool.handler(input, ctx);

    // Should try the first tag from revenue mapping
    expect(mockApi.tryGetCompanyConcept).toHaveBeenCalledWith(
      '0000320193',
      'us-gaap',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      expect.any(CallScope),
    );
    // The scope carries the caller's own signal, so a cancel reaches SEC (#179).
    expect(mockApi.tryGetCompanyConcept.mock.calls[0]?.[3].signal).toBe(ctx.signal);
  });

  it('passes raw XBRL tags directly when not a friendly name', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'AAPL',
      concept: 'AccountsPayableCurrent',
    });
    await getFinancialsTool.handler(input, ctx);

    expect(mockApi.tryGetCompanyConcept).toHaveBeenCalledWith(
      '0000320193',
      'us-gaap',
      'AccountsPayableCurrent',
      expect.any(CallScope),
    );
  });

  it('deduplicates by frame field', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'AAPL',
      concept: 'revenue',
      period_type: 'all',
    });
    const result = await getFinancialsTool.handler(input, ctx);

    // 4 entries in mock, but only 3 have frame, and CY2023 appears once after dedup
    const periods = result.data.map((d) => d.period);
    expect(new Set(periods).size).toBe(periods.length);
  });

  it('filters to annual data by default', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'AAPL', concept: 'revenue' });
    const result = await getFinancialsTool.handler(input, ctx);

    for (const d of result.data) {
      expect(d.fiscal_period).toBe('FY');
    }
  });

  it('filters to quarterly data', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'AAPL',
      concept: 'revenue',
      period_type: 'quarterly',
    });
    const result = await getFinancialsTool.handler(input, ctx);

    for (const d of result.data) {
      expect(d.fiscal_period).toMatch(/^Q/);
    }
  });

  it('returns all periods when period_type is all', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'AAPL',
      concept: 'revenue',
      period_type: 'all',
    });
    const result = await getFinancialsTool.handler(input, ctx);

    const periods = result.data.map((d) => d.fiscal_period);
    expect(periods).toContain('FY');
    expect(periods).toContain('Q3');
  });

  it('pins the line fields and every row field for a single-tag series', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'AAPL',
      concept: 'revenue',
      period_type: 'all',
    });
    const result = await getFinancialsTool.handler(input, ctx);

    expect(result).toMatchObject({
      company: 'Apple Inc.',
      cik: '0000320193',
      concept: 'RevenueFromContractWithCustomerExcludingAssessedTax',
      label: 'Revenue From Contract With Customer Excluding Assessed Tax',
      unit: 'USD',
    });
    expect(result.description).toBeUndefined();
    expect(result.data.map((d) => d.period)).toEqual(['CY2023', 'CY2023Q3', 'CY2022']);
    expect(at(result.data, 1)).toMatchObject({
      period: 'CY2023Q3',
      value: 81797000000,
      start: '2023-04-02',
      end: '2023-07-01',
      fiscal_year: 2023,
      fiscal_period: 'Q3',
      form: '10-Q',
      filed: '2023-08-04',
      accession_number: '0000320193-23-000077',
    });
  });

  it('sorts data newest first', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'AAPL',
      concept: 'revenue',
      period_type: 'all',
    });
    const result = await getFinancialsTool.handler(input, ctx);

    for (let i = 1; i < result.data.length; i++) {
      expect(at(result.data, i - 1).end >= at(result.data, i).end).toBe(true);
    }
  });

  // ---- #48: instant concept period_type fallback ----

  it('raw instant tag (AssetsCurrent) with no period_type returns its instant series (#48)', async () => {
    // Post-fetch fallback: annual filter empties a non-empty all-instant series → return full set.
    const instantResponse: CompanyConceptResponse = {
      cik: 320193,
      entityName: 'Apple Inc.',
      label: 'Assets, Current',
      tag: 'AssetsCurrent',
      taxonomy: 'us-gaap',
      units: {
        USD: [
          {
            accn: '0000320193-23-000106',
            end: '2023-09-30',
            filed: '2023-11-03',
            form: '10-K',
            fp: 'FY',
            frame: 'CY2023Q3I',
            fy: 2023,
            val: 135405000000,
          },
          {
            accn: '0000320193-22-000108',
            end: '2022-09-24',
            filed: '2022-10-28',
            form: '10-K',
            fp: 'FY',
            frame: 'CY2022Q3I',
            fy: 2022,
            val: 128645000000,
          },
        ],
      },
    };
    mockApi.tryGetCompanyConcept.mockResolvedValue(instantResponse);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'AAPL', concept: 'AssetsCurrent' });
    const result = await getFinancialsTool.handler(input, ctx);

    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data.every((d) => /I$/.test(d.period))).toBe(true);
  });

  it('friendly balance-sheet concept (assets) with no period_type returns instant series (#48)', async () => {
    const balanceSheetResponse: CompanyConceptResponse = {
      cik: 320193,
      entityName: 'Apple Inc.',
      label: 'Total Assets',
      tag: 'Assets',
      taxonomy: 'us-gaap',
      units: {
        USD: [
          {
            accn: '0000320193-23-000106',
            end: '2023-09-30',
            filed: '2023-11-03',
            form: '10-K',
            fp: 'FY',
            frame: 'CY2023Q3I',
            fy: 2023,
            val: 352755000000,
          },
          {
            accn: '0000320193-22-000108',
            end: '2022-09-24',
            filed: '2022-10-28',
            form: '10-K',
            fp: 'FY',
            frame: 'CY2022Q3I',
            fy: 2022,
            val: 352755000000,
          },
        ],
      },
    };
    mockApi.tryGetCompanyConcept.mockResolvedValue(balanceSheetResponse);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'AAPL', concept: 'assets' });
    const result = await getFinancialsTool.handler(input, ctx);

    expect(result.data.length).toBeGreaterThan(0);
    expect(at(result.data, 0).period).toMatch(/I$/);
  });

  it('duration concept still defaults to clean annual series (#48)', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'AAPL', concept: 'revenue' });
    const result = await getFinancialsTool.handler(input, ctx);

    // mockConceptResponse has CY2023 and CY2022 (annual) — these should be returned
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data.every((d) => /^CY\d{4}$/.test(d.period))).toBe(true);
  });

  it('explicit period_type: annual on an instant concept returns its fiscal-year-end values (#48, #167)', async () => {
    const balanceSheetResponse: CompanyConceptResponse = {
      cik: 320193,
      entityName: 'Apple Inc.',
      label: 'Total Assets',
      tag: 'Assets',
      taxonomy: 'us-gaap',
      units: {
        USD: [
          {
            accn: '0000320193-23-000106',
            end: '2023-09-30',
            filed: '2023-11-03',
            form: '10-K',
            fp: 'FY',
            frame: 'CY2023Q3I',
            fy: 2023,
            val: 352755000000,
          },
          {
            accn: '0000320193-23-000077',
            end: '2023-07-01',
            filed: '2023-08-04',
            form: '10-Q',
            fp: 'Q3',
            frame: 'CY2023Q2I',
            fy: 2023,
            val: 335038000000,
          },
        ],
      },
    };
    mockApi.tryGetCompanyConcept.mockResolvedValue(balanceSheetResponse);
    // Apple's FY2023 10-K closes its year on 2023-09-30.
    mockApi.tryGetCompanyFacts.mockResolvedValue({
      facts: {
        'us-gaap': {
          NetIncomeLoss: {
            label: 'Net Income (Loss)',
            units: {
              USD: [
                {
                  start: '2022-09-25',
                  end: '2023-09-30',
                  accn: '0000320193-23-000106',
                  filed: '2023-11-03',
                  form: '10-K',
                  fp: 'FY',
                  frame: 'CY2023',
                  fy: 2023,
                  val: 96995000000,
                },
              ],
            },
          },
        },
      },
    });
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'AAPL',
      concept: 'assets',
      period_type: 'annual',
    });
    const result = await getFinancialsTool.handler(input, ctx);

    expect(result.data.map((d) => [d.period, d.value])).toEqual([['CY2023Q3I', 352755000000]]);
  });

  // ---- #44: tag-priority-aware frame dedup ----

  it('lower tag-index wins when two tags report the same frame (#44)', async () => {
    // Simulate the Spotify case: two IFRS tags report CY2024 with the same filed date.
    // Revenue (index 0, the total) should win over RevenueFromContractsWithCustomers (index 1).
    const totalRevenue = 15_673_000_000;
    const sublineRevenue = 606_000_000;
    const frame = 'CY2024';
    const filed = '2026-02-10';

    mockApi.tryGetCompanyConcept
      .mockResolvedValueOnce({
        // index 0 tag: Revenue (total)
        cik: 1639920,
        entityName: 'Spotify Technology S.A.',
        label: 'Revenue',
        tag: 'Revenue',
        taxonomy: 'ifrs-full',
        units: {
          EUR: [
            {
              accn: '0001193125-26-040001',
              end: '2024-12-31',
              filed,
              form: '20-F',
              fp: 'FY',
              frame,
              fy: 2024,
              val: totalRevenue,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        // index 1 tag: RevenueFromContractsWithCustomers (sub-line)
        cik: 1639920,
        entityName: 'Spotify Technology S.A.',
        label: 'Revenue From Contracts With Customers',
        tag: 'RevenueFromContractsWithCustomers',
        taxonomy: 'ifrs-full',
        units: {
          EUR: [
            {
              accn: '0001193125-26-040001',
              end: '2024-12-31',
              filed,
              form: '20-F',
              fp: 'FY',
              frame,
              fy: 2024,
              val: sublineRevenue,
            },
          ],
        },
      });

    mockApi.resolveCik.mockResolvedValue({
      cik: '0001639920',
      name: 'Spotify Technology S.A.',
      ticker: 'SPOT',
    });

    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'SPOT',
      concept: 'revenue',
      taxonomy: 'ifrs-full',
      period_type: 'annual',
    });
    const result = await getFinancialsTool.handler(input, ctx);

    expect(result.data).toHaveLength(1);
    // The total (Revenue, tag index 0) must win
    expect(at(result.data, 0).value).toBe(totalRevenue);
  });

  it('same tag / later filed wins over earlier filed (restatement) (#44)', async () => {
    const amended = 400_000_000_000;
    const original = 383_285_000_000;
    mockApi.tryGetCompanyConcept.mockResolvedValue({
      cik: 320193,
      entityName: 'Apple Inc.',
      label: 'Revenue',
      tag: 'RevenueFromContractWithCustomerExcludingAssessedTax',
      taxonomy: 'us-gaap',
      units: {
        USD: [
          {
            accn: '0000320193-23-000106',
            end: '2023-09-30',
            filed: '2023-11-03',
            form: '10-K',
            fp: 'FY',
            frame: 'CY2023',
            fy: 2023,
            val: original,
          },
          {
            accn: '0000320193-24-000001',
            end: '2023-09-30',
            filed: '2024-01-15', // Later filed = restatement
            form: '10-K/A',
            fp: 'FY',
            frame: 'CY2023',
            fy: 2023,
            val: amended,
          },
        ],
      },
    });

    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'AAPL',
      concept: 'revenue',
      period_type: 'annual',
    });
    const result = await getFinancialsTool.handler(input, ctx);

    expect(result.data).toHaveLength(1);
    // Later filed (restatement) wins within the same tag
    expect(at(result.data, 0).value).toBe(amended);
  });

  it('IFRS revenue ifrsTags lists the IAS 1 total (Revenue) first (#44)', () => {
    // Guards the reorder half of #44: the consolidated total must sit at index 0
    // so the tag-priority dedup keeps it over the RevenueFromContractsWithCustomers sub-line.
    const mapping = resolveConcept('revenue');
    expect(mapping?.ifrsTags?.[0]).toBe('Revenue');
    expect(mapping?.ifrsTags).toContain('RevenueFromContractsWithCustomers');
  });

  it('throws notFound when company not found', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'XYZNOTREAL', concept: 'revenue' });

    await expect(getFinancialsTool.handler(input, ctx)).rejects.toThrow(/not found/);
  });

  it('throws ambiguous_company when resolveCik returns multiple matches (#23)', async () => {
    mockApi.resolveCik.mockResolvedValue([
      { cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' },
      { cik: '0006084276', name: 'Apple Bank for Savings', ticker: undefined },
    ]);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'Apple', concept: 'revenue' });

    await expect(getFinancialsTool.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'ambiguous_company',
        matches: expect.arrayContaining([
          expect.objectContaining({ cik: '0000320193', name: 'Apple Inc.' }),
        ]),
      },
    });
  });

  it('caps ambiguous_company matches at 10 (#23)', async () => {
    const manyMatches = Array.from({ length: 15 }, (_, i) => ({
      cik: `000000000${i}`,
      name: `Company ${i}`,
      ticker: undefined,
    }));
    mockApi.resolveCik.mockResolvedValue(manyMatches);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'Company', concept: 'revenue' });

    await expect(getFinancialsTool.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'ambiguous_company',
        matches: expect.arrayContaining([expect.objectContaining({ cik: '0000000000' })]),
      },
    });
    const err = await caught(getFinancialsTool.handler(input, ctx));
    expect(records(err.data.matches).length).toBeLessThanOrEqual(10);
  });

  it('renders the ambiguous_company candidates in the message, not just error data (#90)', async () => {
    mockApi.resolveCik.mockResolvedValue([
      { cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' },
      { cik: '0001418121', name: 'Apple Hospitality REIT, Inc.', ticker: 'APLE' },
      { cik: '0006084276', name: 'Apple Bank for Savings', ticker: undefined },
    ]);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'Apple', concept: 'revenue' });

    const err = await caught(getFinancialsTool.handler(input, ctx));
    // CIK, name, and ticker (when present) all reach the text surface, so a
    // content-only client can act on the "retry with a ticker or CIK" recovery.
    expect(err.message).toContain('0000320193 Apple Inc. (AAPL)');
    expect(err.message).toContain('0001418121 Apple Hospitality REIT, Inc. (APLE)');
    expect(err.message).toContain('0006084276 Apple Bank for Savings');
    // Text and structured data are built from one capped list, so they cannot drift.
    for (const m of records(err.data.matches)) expect(err.message).toContain(m.cik);
  });

  it('caps the rendered ambiguous_company candidate list at 10 (#90)', async () => {
    const manyMatches = Array.from({ length: 15 }, (_, i) => ({
      cik: `000000001${i}`,
      name: `Company ${i}`,
      ticker: undefined,
    }));
    mockApi.resolveCik.mockResolvedValue(manyMatches);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'Company', concept: 'revenue' });

    const err = await caught(getFinancialsTool.handler(input, ctx));
    expect(err.message).toContain('0000000010 Company 0');
    expect(err.message).toContain('0000000019 Company 9');
    expect(err.message).not.toContain('Company 10');
  });

  it('uses ifrsTags when taxonomy is ifrs-full for a friendly name (#19)', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'SPOT',
      concept: 'revenue',
      taxonomy: 'ifrs-full',
    });
    await getFinancialsTool.handler(input, ctx);

    // Should use the IFRS tags in order (Revenue first per #44 reorder)
    expect(mockApi.tryGetCompanyConcept).toHaveBeenCalledWith(
      '0000320193',
      'ifrs-full',
      'Revenue',
      expect.any(CallScope),
    );
    // Should also try the sub-line tag
    expect(mockApi.tryGetCompanyConcept).toHaveBeenCalledWith(
      '0000320193',
      'ifrs-full',
      'RevenueFromContractsWithCustomers',
      expect.any(CallScope),
    );
    // Should NOT have been called with a us-gaap tag under ifrs-full
    expect(mockApi.tryGetCompanyConcept).not.toHaveBeenCalledWith(
      '0000320193',
      'ifrs-full',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      expect.any(CallScope),
    );
  });

  it('falls back to standard tags for ifrs-full when concept has no ifrsTags (#19)', async () => {
    // notes_payable has no ifrsTags — IFRS has no element for the notes/debt
    // split — so the standard tags are used under the requested taxonomy.
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'SPOT',
      concept: 'notes_payable',
      taxonomy: 'ifrs-full',
    });
    await getFinancialsTool.handler(input, ctx);

    expect(mockApi.tryGetCompanyConcept).toHaveBeenCalledWith(
      '0000320193',
      'ifrs-full',
      'LongTermNotesPayable',
      expect.any(CallScope),
    );
  });

  it('throws notFound when no XBRL data exists', async () => {
    mockApi.tryGetCompanyConcept.mockResolvedValue(null);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'AAPL', concept: 'revenue' });

    await expect(getFinancialsTool.handler(input, ctx)).rejects.toThrow(/No XBRL data/);
  });

  it('tries multiple tags for friendly names and merges results', async () => {
    // First tag 404s (returned as null), second succeeds
    mockApi.tryGetCompanyConcept
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mockConceptResponse);

    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'AAPL', concept: 'revenue' });
    const result = await getFinancialsTool.handler(input, ctx);

    expect(result.tags_tried).toBeDefined();
    expect(result.tags_tried!.length).toBeGreaterThan(1);
    expect(result.data.length).toBeGreaterThan(0);
  });

  it('re-throws non-404 errors', async () => {
    mockApi.tryGetCompanyConcept.mockRejectedValue(new Error('500 Internal Server Error'));
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'AAPL', concept: 'revenue' });

    await expect(getFinancialsTool.handler(input, ctx)).rejects.toThrow(/500/);
  });

  it('omits tags_tried when only one tag was needed', async () => {
    // Raw XBRL tag → single tag tried
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'AAPL',
      concept: 'AccountsPayableCurrent',
    });
    const result = await getFinancialsTool.handler(input, ctx);

    expect(result.tags_tried).toBeUndefined();
  });

  it('caps inline data[] to the most-recent N when limit is set (#32)', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'AAPL',
      concept: 'revenue',
      period_type: 'all',
      limit: 1,
    });
    const result = await getFinancialsTool.handler(input, ctx);

    expect(result.data).toHaveLength(1);
    // Series is newest-first, so the single inline row is the most recent period.
    expect(at(result.data, 0).period).toBe('CY2023');
  });

  it('returns every period inline when limit is omitted (#32)', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'AAPL',
      concept: 'revenue',
      period_type: 'all',
    });
    const result = await getFinancialsTool.handler(input, ctx);

    // 3 frame-bearing entries in the mock (CY2023, CY2023Q3, CY2022).
    expect(result.data).toHaveLength(3);
  });

  it('format() flags the inline slice against the full dataframe series (#32)', () => {
    const output = {
      company: 'Apple Inc.',
      cik: '0000320193',
      concept: 'Revenues',
      label: 'Revenue',
      unit: 'USD',
      data: [
        {
          period: 'CY2023',
          value: 383285000000,
          end: '2023-09-30',
          fiscal_year: 2023,
          fiscal_period: 'FY',
          form: '10-K',
          filed: '2023-11-03',
          accession_number: '0000320193-23-000106',
          tag: 'Revenues',
        },
      ],
      dataset: {
        name: 'df_ABCDE_FGHIJ',
        row_count: 5,
        expires_at: '2026-05-18T00:00:00.000Z',
      },
    };
    const blocks = getFinancialsTool.format!(output);
    expect(blockText(blocks)).toContain('showing the 1 most-recent of 5 periods');
    expect(blockText(blocks)).toContain('df_ABCDE_FGHIJ');
  });

  it('formats USD values in millions', () => {
    const output = {
      company: 'Apple Inc.',
      cik: '0000320193',
      concept: 'Revenues',
      label: 'Revenue',
      unit: 'USD',
      data: [
        {
          period: 'CY2023',
          value: 383285000000,
          end: '2023-09-30',
          fiscal_year: 2023,
          fiscal_period: 'FY',
          form: '10-K',
          filed: '2023-11-03',
          accession_number: '0000320193-23-000106',
          tag: 'Revenues',
        },
      ],
    };
    const blocks = getFinancialsTool.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blockText(blocks)).toContain('Revenue');
    expect(blockText(blocks)).toContain('$383285.0M');
  });

  it('formats USD/shares values with decimal', () => {
    const output = {
      company: 'Apple Inc.',
      cik: '0000320193',
      concept: 'EarningsPerShareDiluted',
      label: 'EPS (Diluted)',
      unit: 'USD/shares',
      data: [
        {
          period: 'CY2023',
          value: 6.13,
          end: '2023-09-30',
          fiscal_year: 2023,
          fiscal_period: 'FY',
          form: '10-K',
          filed: '2023-11-03',
          accession_number: '0000320193-23-000106',
          tag: 'EarningsPerShareDiluted',
        },
      ],
    };
    const blocks = getFinancialsTool.format!(output);
    expect(blockText(blocks)).toContain('$6.13');
  });
});

describe('off-calendar fiscal-period caveat (#95)', () => {
  /**
   * A June-fiscal-year-end filer: SEC frame-tags only three of its four fiscal
   * quarters, so calendar Q2 never appears in the quarterly series. The gap must
   * be attributable to frame tagging rather than looking like non-reporting.
   */
  const juneFiscalYearEnd: CompanyConceptResponse = {
    cik: 789019,
    entityName: 'MICROSOFT CORP',
    label: 'Revenues',
    tag: 'Revenues',
    taxonomy: 'us-gaap',
    units: {
      USD: [2024, 2025].flatMap((year) =>
        [1, 3, 4].map((q) => ({
          accn: `0000789019-${String(year).slice(2)}-0000${q}`,
          end: `${year}-0${q === 4 ? 9 : q * 3}-30`,
          filed: `${year}-1${q === 4 ? 0 : 1}-01`,
          form: '10-Q',
          fp: `Q${q}`,
          frame: `CY${year}Q${q}`,
          fy: year,
          val: 60_000_000_000 + q,
        })),
      ),
    },
  };

  beforeEach(() => {
    mockApi.resolveCik.mockResolvedValue({
      cik: '0000789019',
      name: 'MICROSOFT CORP',
      ticker: 'MSFT',
    });
    mockApi.tryGetCompanyConcept.mockResolvedValue(juneFiscalYearEnd);
  });

  it('names the absent calendar quarter on a quarterly series', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'MSFT',
      concept: 'Revenues',
      period_type: 'quarterly',
    });
    const result = await getFinancialsTool.handler(input, ctx);

    // The series itself has no CY####Q2 row — that is the gap being explained.
    expect(result.data.some((d) => /Q2$/.test(d.period))).toBe(false);
    expect(result.caveats).toHaveLength(1);
    expect(result.caveats?.[0]).toContain('Calendar Q2');
    expect(result.caveats?.[0]).toContain('10-K residual');
  });

  it('also surfaces the caveat under period_type all', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'MSFT',
      concept: 'Revenues',
      period_type: 'all',
    });
    const result = await getFinancialsTool.handler(input, ctx);
    expect(result.caveats?.[0]).toContain('Calendar Q2');
  });

  it('renders the caveat into the text surface', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'MSFT',
      concept: 'Revenues',
      period_type: 'quarterly',
    });
    const result = await getFinancialsTool.handler(input, ctx);
    const blocks = getFinancialsTool.format!(result);
    expect(blockText(blocks)).toContain('Caveat: Calendar Q2');
  });

  it('omits caveats on an annual series', async () => {
    const annual: CompanyConceptResponse = {
      ...juneFiscalYearEnd,
      units: {
        USD: [
          {
            accn: '0000789019-25-000001',
            end: '2025-06-30',
            filed: '2025-07-30',
            form: '10-K',
            fp: 'FY',
            frame: 'CY2025',
            fy: 2025,
            val: 245_000_000_000,
          },
        ],
      },
    };
    mockApi.tryGetCompanyConcept.mockResolvedValue(annual);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'MSFT',
      concept: 'Revenues',
      period_type: 'annual',
    });
    const result = await getFinancialsTool.handler(input, ctx);
    expect(result.caveats).toBeUndefined();
  });

  it('omits caveats for a filer whose quarterly series has no systematic gap', async () => {
    const everyQuarter: CompanyConceptResponse = {
      ...juneFiscalYearEnd,
      units: {
        USD: [2023, 2024].flatMap((year) =>
          [1, 2, 3, 4].map((q) => ({
            accn: `acc-${year}-${q}`,
            end: `${year}-0${q}-28`,
            filed: `${year}-0${q}-30`,
            form: '10-Q',
            fp: `Q${q}`,
            frame: `CY${year}Q${q}`,
            fy: year,
            val: 1000 + q,
          })),
        ),
      },
    };
    mockApi.tryGetCompanyConcept.mockResolvedValue(everyQuarter);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'MSFT',
      concept: 'Revenues',
      period_type: 'quarterly',
    });
    const result = await getFinancialsTool.handler(input, ctx);
    expect(result.caveats).toBeUndefined();
  });
});

describe('deprecated-tag staleness caveat (#98)', () => {
  /**
   * A filer that presents revenue gross of assessed tax reports none of the
   * current tags, so the priority walk reaches `SalesRevenueGoodsNet` — retired
   * from the taxonomy in 2018. The values look ordinary and the series simply
   * stops years ago; SEC's own label is the only thing that says the tag is dead.
   */
  const retiredRevenueTag: CompanyConceptResponse = {
    cik: 91419,
    entityName: 'J M SMUCKER Co',
    label: 'Sales Revenue, Goods, Net (Deprecated 2018-01-31)',
    tag: 'SalesRevenueGoodsNet',
    taxonomy: 'us-gaap',
    units: {
      USD: [
        {
          accn: '0000091419-18-000030',
          end: '2018-04-30',
          filed: '2018-06-14',
          form: '10-K',
          fp: 'FY',
          frame: 'CY2017',
          fy: 2018,
          val: 7_357_100_000,
        },
        {
          accn: '0000091419-17-000024',
          end: '2017-04-30',
          filed: '2017-06-15',
          form: '10-K',
          fp: 'FY',
          frame: 'CY2016',
          fy: 2017,
          val: 7_392_300_000,
        },
      ],
    },
  };

  beforeEach(() => {
    mockApi.resolveCik.mockResolvedValue({
      cik: '0000091419',
      name: 'J M SMUCKER Co',
      ticker: 'SJM',
    });
  });

  it('flags a series that fell through to a tag SEC retired', async () => {
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (_cik: string, _tax: string, tag: string) =>
        tag === 'SalesRevenueGoodsNet' ? retiredRevenueTag : null,
    );
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'SJM', concept: 'revenue' });
    const result = await getFinancialsTool.handler(input, ctx);

    expect(result.concept).toBe('SalesRevenueGoodsNet');
    expect(result.caveats).toHaveLength(1);
    expect(result.caveats?.[0]).toContain('SalesRevenueGoodsNet');
    expect(result.caveats?.[0]).toContain('2018-01-31');
  });

  it('renders the staleness caveat into the text surface', async () => {
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (_cik: string, _tax: string, tag: string) =>
        tag === 'SalesRevenueGoodsNet' ? retiredRevenueTag : null,
    );
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'SJM', concept: 'revenue' });
    const result = await getFinancialsTool.handler(input, ctx);
    const blocks = getFinancialsTool.format!(result);

    expect(blockText(blocks)).toContain('Caveat:');
    expect(blockText(blocks)).toContain('SalesRevenueGoodsNet');
  });

  it('stays silent once the Including-assessed-tax tag resolves the filer (#98)', async () => {
    // The tag-coverage half of the fix: the filer's real current tag now sits in
    // the priority list, so the walk never reaches a retired one.
    const includingAssessedTax: CompanyConceptResponse = {
      cik: 91419,
      entityName: 'J M SMUCKER Co',
      label: 'Revenue from Contract with Customer, Including Assessed Tax',
      tag: 'RevenueFromContractWithCustomerIncludingAssessedTax',
      taxonomy: 'us-gaap',
      units: {
        USD: [
          {
            accn: '0000091419-26-000030',
            end: '2026-04-30',
            filed: '2026-06-12',
            form: '10-K',
            fp: 'FY',
            frame: 'CY2025',
            fy: 2026,
            val: 9_050_900_000,
          },
        ],
      },
    };
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (_cik: string, _tax: string, tag: string) => {
        if (tag === 'RevenueFromContractWithCustomerIncludingAssessedTax') {
          return includingAssessedTax;
        }
        return tag === 'SalesRevenueGoodsNet' ? retiredRevenueTag : null;
      },
    );
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'SJM', concept: 'revenue' });
    const result = await getFinancialsTool.handler(input, ctx);

    expect(result.concept).toBe('RevenueFromContractWithCustomerIncludingAssessedTax');
    expect(result.data[0]?.value).toBe(9_050_900_000);
    expect(result.caveats).toBeUndefined();
  });

  it('flags cogs falling through to its retired fallback, not just revenue (#98)', async () => {
    const retiredCogsTag: CompanyConceptResponse = {
      cik: 91419,
      entityName: 'J M SMUCKER Co',
      label: 'Cost of Goods Sold (Deprecated 2018-01-31)',
      tag: 'CostOfGoodsSold',
      taxonomy: 'us-gaap',
      units: {
        USD: [
          {
            accn: '0000091419-18-000030',
            end: '2018-04-30',
            filed: '2018-06-14',
            form: '10-K',
            fp: 'FY',
            frame: 'CY2017',
            fy: 2018,
            val: 4_355_200_000,
          },
        ],
      },
    };
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (_cik: string, _tax: string, tag: string) =>
        tag === 'CostOfGoodsSold' ? retiredCogsTag : null,
    );
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'SJM', concept: 'cogs' });
    const result = await getFinancialsTool.handler(input, ctx);

    expect(result.caveats?.[0]).toContain('CostOfGoodsSold');
  });

  it('leaves a current tag uncaveated', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'AAPL', concept: 'revenue' });
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    mockApi.tryGetCompanyConcept.mockResolvedValue(mockConceptResponse);
    const result = await getFinancialsTool.handler(input, ctx);

    expect(result.caveats).toBeUndefined();
  });
});

/** Build a companyconcept response from `[frame, periodEnd, value]` triples. */
function conceptOf(
  tag: string,
  label: string,
  unitKey: string,
  rows: Array<[string, string, number]>,
): CompanyConceptResponse {
  return {
    cik: 1000184,
    entityName: 'Fixture Co',
    label,
    tag,
    taxonomy: 'ifrs-full',
    units: {
      [unitKey]: rows.map(([frame, end, val]) => ({
        accn: `0001000184-${end.slice(2, 4)}-000001`,
        end,
        filed: `${Number(end.slice(0, 4)) + 1}-02-26`,
        form: '20-F',
        fp: 'FY',
        frame,
        fy: Number(end.slice(0, 4)) + 1,
        val,
      })),
    },
  };
}

const EMPLOYEE_TAG = 'ExpenseFromSharebasedPaymentTransactionsWithEmployees';
const BROAD_TAG =
  'ExpenseFromSharebasedPaymentTransactionsInWhichGoodsOrServicesReceivedDidNotQualifyForRecognitionAsAssets';

describe('IFRS share-based payment alternates (#101)', () => {
  /** Real SEC values; the clock has to sit past them for the series to read as current. */
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'));
    mockApi.resolveCik.mockResolvedValue({ cik: '0001000184', name: 'SAP SE', ticker: 'SAP' });
  });
  afterAll(() => {
    vi.setSystemTime(new Date(NOW));
  });

  /** SAP: the employee element is a two-period fringe, the IFRS 2.51(a) total is the real line. */
  const sapEmployee = conceptOf(EMPLOYEE_TAG, 'Employee scheme expense', 'EUR', [
    ['CY2019', '2019-12-31', 79_000_000],
    ['CY2020', '2020-12-31', 46_000_000],
  ]);
  const sapBroad = conceptOf(BROAD_TAG, 'Share-based payment expense', 'EUR', [
    ['CY2019', '2019-12-31', 1_835_000_000],
    ['CY2020', '2020-12-31', 1_084_000_000],
    ['CY2023', '2023-12-31', 2_220_000_000],
    ['CY2024', '2024-12-31', 2_385_000_000],
    ['CY2025', '2025-12-31', 1_695_000_000],
  ]);

  async function run(company: string, byTag: Record<string, CompanyConceptResponse>) {
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (_cik: string, _tax: string, tag: string) => byTag[tag] ?? null,
    );
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company,
      concept: 'stock_based_compensation',
      taxonomy: 'ifrs-full',
      period_type: 'annual',
    });
    return getFinancialsTool.handler(input, ctx);
  }

  it('resolves the filer’s reported expense, not the fringe disclosure ahead of it', async () => {
    const result = await run('SAP', { [EMPLOYEE_TAG]: sapEmployee, [BROAD_TAG]: sapBroad });

    expect(result.concept).toBe(BROAD_TAG);
    expect(result.data[0]?.period).toBe('CY2025');
    expect(result.data[0]?.value).toBe(1_695_000_000);
  });

  it('does not switch definition mid-history on the frames the fringe also covers', async () => {
    // The failure a plain index-1 fallback produces: 46M sitting inside a series
    // that runs above a billion on either side.
    const result = await run('SAP', { [EMPLOYEE_TAG]: sapEmployee, [BROAD_TAG]: sapBroad });

    expect(result.data.find((d) => d.period === 'CY2020')?.value).toBe(1_084_000_000);
    expect(result.data.find((d) => d.period === 'CY2019')?.value).toBe(1_835_000_000);
    expect(result.data.map((d) => d.value)).not.toContain(46_000_000);
  });

  it('reports the concept under the tag that won, not the first one to answer', async () => {
    const result = await run('SAP', { [EMPLOYEE_TAG]: sapEmployee, [BROAD_TAG]: sapBroad });

    expect(result.label).toBe('Share-based payment expense');
    expect(result.unit).toBe('EUR');
    expect(result.tags_tried).toEqual([EMPLOYEE_TAG, BROAD_TAG]);
  });

  it('resolves the inverse filer the other way from the same rule', async () => {
    // Sanofi: the employee element is the real line and the total is the fringe.
    const result = await run('SNY', {
      [EMPLOYEE_TAG]: conceptOf(EMPLOYEE_TAG, 'Employee scheme expense', 'EUR', [
        ['CY2019', '2019-12-31', 252_000_000],
        ['CY2020', '2020-12-31', 274_000_000],
        ['CY2021', '2021-12-31', 244_000_000],
        ['CY2022', '2022-12-31', 245_000_000],
      ]),
      [BROAD_TAG]: conceptOf(BROAD_TAG, 'Share-based payment expense', 'EUR', [
        ['CY2019', '2019-12-31', 1_700_000],
      ]),
    });

    expect(result.concept).toBe(EMPLOYEE_TAG);
    expect(result.data[0]?.value).toBe(245_000_000);
    expect(result.data.find((d) => d.period === 'CY2019')?.value).toBe(252_000_000);
  });

  it('resolves a filer that never tags the employee element at all', async () => {
    // TSM and HSBC returned no_concept_data under a single-tag mapping.
    const result = await run('TSM', {
      [BROAD_TAG]: conceptOf(BROAD_TAG, 'Share-based payment expense', 'TWD', [
        ['CY2023', '2023-12-31', 544_400_000],
        ['CY2024', '2024-12-31', 1_646_200_000],
      ]),
    });

    expect(result.concept).toBe(BROAD_TAG);
    expect(result.data[0]?.value).toBe(1_646_200_000);
  });

  it('leaves revenue on declared priority, where coverage would pick the wrong element', async () => {
    // Molson Coors reports gross sales and net-of-excise sales under separate
    // elements and keeps eleven years under a 2018-retired one. Ranking by
    // coverage hands it either the dead tag or the gross line; declared order
    // keeps the net series definitionally continuous.
    mockApi.resolveCik.mockResolvedValue({
      cik: '0000024545',
      name: 'Molson Coors Beverage Co',
      ticker: 'TAP',
    });
    const usGaap = (r: CompanyConceptResponse) => ({ ...r, taxonomy: 'us-gaap' });
    mockApi.tryGetCompanyConcept.mockImplementation(async (_c: string, _t: string, tag: string) => {
      const byTag: Record<string, CompanyConceptResponse> = {
        RevenueFromContractWithCustomerExcludingAssessedTax: usGaap(
          conceptOf('RevenueFromContractWithCustomerExcludingAssessedTax', 'Excluding', 'USD', [
            ['CY2019', '2019-12-31', 13_009_100_000],
            ['CY2020', '2020-12-31', 11_723_800_000],
            ['CY2025', '2025-12-31', 13_040_300_000],
          ]),
        ),
        Revenues: usGaap(
          conceptOf('Revenues', 'Revenues', 'USD', [
            ['CY2016', '2016-12-31', 6_597_400_000],
            ['CY2017', '2017-12-31', 13_471_500_000],
            ['CY2018', '2018-12-31', 13_338_000_000],
            ['CY2019', '2019-12-31', 13_009_100_000],
            ['CY2020', '2020-12-31', 11_723_800_000],
          ]),
        ),
        RevenueFromContractWithCustomerIncludingAssessedTax: usGaap(
          conceptOf('RevenueFromContractWithCustomerIncludingAssessedTax', 'Including', 'USD', [
            ['CY2016', '2016-12-31', 4_885_000_000],
            ['CY2017', '2017-12-31', 11_002_800_000],
            ['CY2018', '2018-12-31', 10_769_600_000],
            ['CY2019', '2019-12-31', 10_579_400_000],
            ['CY2020', '2020-12-31', 9_654_000_000],
            ['CY2021', '2021-12-31', 10_279_700_000],
            ['CY2022', '2022-12-31', 10_701_000_000],
            ['CY2023', '2023-12-31', 11_702_100_000],
            ['CY2024', '2024-12-31', 11_627_000_000],
            ['CY2025', '2025-12-31', 11_140_800_000],
          ]),
        ),
        SalesRevenueGoodsNet: usGaap(
          conceptOf(
            'SalesRevenueGoodsNet',
            'Sales Revenue, Goods, Net (Deprecated 2018-01-31)',
            'USD',
            [
              ['CY2013', '2013-12-31', 5_999_600_000],
              ['CY2014', '2014-12-31', 5_927_500_000],
              ['CY2015', '2015-12-31', 3_567_500_000],
              ['CY2016', '2016-12-31', 4_885_000_000],
              ['CY2017', '2017-12-31', 11_002_800_000],
            ],
          ),
        ),
      };
      return byTag[tag] ?? null;
    });
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'TAP',
      concept: 'revenue',
      period_type: 'annual',
    });
    const result = await getFinancialsTool.handler(input, ctx);

    const at = (period: string) => result.data.find((d) => d.period === period)?.value;
    expect(result.concept).toBe('RevenueFromContractWithCustomerExcludingAssessedTax');
    expect(at('CY2016')).toBe(6_597_400_000);
    expect(at('CY2017')).toBe(13_471_500_000);
    expect(at('CY2018')).toBe(13_338_000_000);
    expect(at('CY2019')).toBe(13_009_100_000);
    expect(result.caveats).toBeUndefined();
  });
});

describe('stopped-series staleness caveat (#102)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'));
    mockApi.resolveCik.mockResolvedValue({ cik: '0001121404', name: 'Sanofi', ticker: 'SNY' });
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (_cik: string, _tax: string, tag: string) =>
        tag === EMPLOYEE_TAG
          ? conceptOf(EMPLOYEE_TAG, 'Employee scheme expense', 'EUR', [
              ['CY2021', '2021-12-31', 244_000_000],
              ['CY2022', '2022-12-31', 245_000_000],
            ])
          : null,
    );
  });
  afterAll(() => {
    vi.setSystemTime(new Date(NOW));
  });

  const input = () =>
    getFinancialsTool.input.parse({
      company: 'SNY',
      concept: 'stock_based_compensation',
      taxonomy: 'ifrs-full',
      period_type: 'annual',
    });

  it('flags a current tag whose series stops years before today', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const result = await getFinancialsTool.handler(input(), ctx);

    expect(result.caveats).toHaveLength(1);
    expect(result.caveats?.[0]).toContain('CY2022');
    expect(result.caveats?.[0]).toContain('3.6 years');
    expect(result.caveats?.[0]).toContain('today (2026-07-26)');
    expect(result.caveats?.[0]).toContain('is a current tag');
  });

  it('renders the caveat into the text surface', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const result = await getFinancialsTool.handler(input(), ctx);
    const blocks = getFinancialsTool.format!(result);

    expect(blockText(blocks)).toContain('Caveat:');
    expect(blockText(blocks)).toContain('is a current tag');
  });

  it('stays silent for a filer one fiscal year plus a filing window behind', async () => {
    // A 20-F filer's newest annual period sits a year back until the next report
    // lands, four months after year end — the floor has to clear that.
    vi.setSystemTime(new Date('2026-04-29T00:00:00.000Z'));
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (_cik: string, _tax: string, tag: string) =>
        tag === EMPLOYEE_TAG
          ? conceptOf(EMPLOYEE_TAG, 'Employee scheme expense', 'EUR', [
              ['CY2024', '2024-12-31', 244_000_000],
            ])
          : null,
    );
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const result = await getFinancialsTool.handler(input(), ctx);

    expect(result.caveats).toBeUndefined();
  });

  it('measures the full deduped set, so a live quarterly series clears an old annual one', async () => {
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (_cik: string, _tax: string, tag: string) =>
        tag === EMPLOYEE_TAG
          ? conceptOf(EMPLOYEE_TAG, 'Employee scheme expense', 'EUR', [
              ['CY2022', '2022-12-31', 245_000_000],
              ['CY2026Q1', '2026-03-31', 60_000_000],
            ])
          : null,
    );
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const result = await getFinancialsTool.handler(input(), ctx);

    expect(result.data.map((d) => d.period)).toEqual(['CY2022']);
    expect(result.caveats).toBeUndefined();
  });
});

describe('dataframe registration (#72)', () => {
  it('registers source-filing fiscal keys as source_filing_fy/source_filing_fp columns', async () => {
    const registerDataframe = vi.fn().mockResolvedValue({
      name: 'df_ABCDE_FGHIJ',
      rowCount: 3,
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);
    vi.mocked(toDatasetField).mockReturnValue({
      name: 'df_ABCDE_FGHIJ',
      row_count: 3,
      expires_at: '2026-01-01T00:00:00.000Z',
    });

    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'AAPL',
      concept: 'revenue',
      period_type: 'all',
    });
    const result = await getFinancialsTool.handler(input, ctx);

    expect(registerDataframe).toHaveBeenCalledTimes(1);
    const { rows } = at(registerDataframe.mock.calls, 0)[1];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toHaveProperty('source_filing_fy');
      expect(row).toHaveProperty('source_filing_fp');
      expect(row).not.toHaveProperty('fiscal_year');
      expect(row).not.toHaveProperty('fiscal_period');
    }
    // Source-filing values pass through unchanged under the new names.
    expect(rows[0].source_filing_fy).toBe(2023);
    expect(rows[0].source_filing_fp).toBe('FY');
    expect(rows[0]).toMatchObject({
      cik: '0000320193',
      entity_name: 'Apple Inc.',
      concept: 'RevenueFromContractWithCustomerExcludingAssessedTax',
      taxonomy: 'us-gaap',
      unit: 'USD',
      period: 'CY2023',
      value: 383285000000,
      period_start: null,
      period_end: '2023-09-30',
      form: '10-K',
      filed: '2023-11-03',
      accession_number: '0000320193-23-000106',
    });

    // The inline data[] keeps the documented field names — out of scope for the rename.
    expect(result.data[0]).toHaveProperty('fiscal_year');
    expect(result.data[0]).toHaveProperty('fiscal_period');
    expect(result.dataset?.name).toBe('df_ABCDE_FGHIJ');
  });

  describe('staged-dataframe pointer (#104)', () => {
    /** Stage a dataframe the way a successful registration does. */
    function stageDataframe(rowCount = 3) {
      const registerDataframe = vi.fn().mockResolvedValue({
        name: 'df_ABCDE_FGHIJ',
        rowCount,
        expiresAt: '2026-01-01T00:00:00.000Z',
      });
      vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);
      vi.mocked(toDatasetField).mockReturnValue({
        name: 'df_ABCDE_FGHIJ',
        row_count: rowCount,
        expires_at: '2026-01-01T00:00:00.000Z',
      });
      return registerDataframe;
    }

    it('names both dataframe tools when the full series is staged and nothing was capped', async () => {
      stageDataframe();
      const ctx = createMockContext({ errors: getFinancialsTool.errors });
      const input = getFinancialsTool.input.parse({
        company: 'AAPL',
        concept: 'revenue',
        period_type: 'all',
      });
      await getFinancialsTool.handler(input, ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('df_ABCDE_FGHIJ');
      expect(notice).toContain('secedgar_dataframe_describe');
      expect(notice).toContain('secedgar_dataframe_query');
      expect(getEnrichment(ctx).truncated).toBeUndefined();
    });

    it('composes the pointer into the truncation guidance rather than emitting a second notice', async () => {
      stageDataframe();
      const ctx = createMockContext({ errors: getFinancialsTool.errors });
      const input = getFinancialsTool.input.parse({
        company: 'AAPL',
        concept: 'revenue',
        period_type: 'all',
        limit: 1,
      });
      await getFinancialsTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      const notice = String(enrichment.notice);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.shown).toBe(1);
      // Both halves survive in one string — the cap disclosure and the pointer.
      expect(notice).toContain('most-recent of 3 periods');
      expect(notice).toContain('secedgar_dataframe_describe');
      // Written once, not once per enrich call.
      expect(notice.match(/secedgar_dataframe_describe/g)).toHaveLength(1);
    });

    it('promises no pointer when the canvas is unavailable', async () => {
      vi.mocked(getCanvasBridge).mockReturnValue(undefined);
      const ctx = createMockContext({ errors: getFinancialsTool.errors });
      const input = getFinancialsTool.input.parse({
        company: 'AAPL',
        concept: 'revenue',
        period_type: 'all',
        limit: 1,
      });
      const result = await getFinancialsTool.handler(input, ctx);

      expect(result.dataset).toBeUndefined();
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).not.toContain('secedgar_dataframe_describe');
      expect(notice).toContain('Raise limit');
    });

    it('reaches both structuredContent and content[] through the real tool pipeline', async () => {
      // The prerequisite this issue names: without `notice` in the enrichment
      // block the framework strips it from the effective output and the pointer
      // never leaves the handler.
      stageDataframe();
      const result = await runToolContract(getFinancialsTool, {
        company: 'AAPL',
        concept: 'revenue',
        period_type: 'all',
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { notice?: string };
      expect(structured.notice).toContain('secedgar_dataframe_describe');
      expect(structured.notice).toContain('secedgar_dataframe_query');
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain('secedgar_dataframe_describe');
      expect(text).toContain('secedgar_dataframe_query');
    });
  });
});

/** A companyconcept payload for one tag, from full-control unit rows. */
function conceptPayload(
  tag: string,
  label: string,
  units: CompanyConceptResponse['units'],
  description?: string,
): CompanyConceptResponse {
  return {
    cik: 310158,
    entityName: 'Merck & Co., Inc.',
    label,
    tag,
    taxonomy: 'us-gaap',
    units,
    ...(description ? { description } : {}),
  };
}

describe('proxy-held annual frames (#123)', () => {
  const FY2021 = { start: '2021-01-01', end: '2021-12-31' };
  /** Merck's NetIncomeLoss: the DEF 14A holds the CY2021 frame at a rounded figure. */
  const merck = conceptPayload('NetIncomeLoss', 'Net Income (Loss) Attributable to Parent', {
    USD: [
      {
        ...FY2021,
        accn: '0001193125-26-147704',
        filed: '2026-04-08',
        form: 'DEF 14A',
        fp: null,
        frame: 'CY2021',
        fy: null,
        val: 12_345_000_000,
      },
      {
        ...FY2021,
        accn: '0000310158-22-000010',
        filed: '2022-02-25',
        form: '10-K',
        fp: 'FY',
        fy: 2021,
        val: 13_049_000_000,
      },
      {
        start: '2021-07-01',
        end: '2021-09-30',
        accn: '0000310158-21-000031',
        filed: '2021-11-05',
        form: '10-Q',
        fp: 'Q3',
        frame: 'CY2021Q3',
        fy: 2021,
        val: 3_232_000_000,
      },
    ],
  });

  beforeEach(() => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000310158', name: 'Merck & Co., Inc.' });
    mockApi.tryGetCompanyConcept.mockResolvedValue(merck);
  });

  it('answers the frame with the 10-K fact and its provenance, keeping the frame', async () => {
    const result = await runToolContract(getFinancialsTool, {
      company: 'MRK',
      concept: 'net_income',
    });

    expect(result.isError).toBeFalsy();
    const output = getFinancialsTool.output.parse(result.structuredContent);
    expect(output.data).toEqual([
      {
        period: 'CY2021',
        value: 13_049_000_000,
        start: '2021-01-01',
        end: '2021-12-31',
        fiscal_year: 2021,
        fiscal_period: 'FY',
        form: '10-K',
        filed: '2022-02-25',
        accession_number: '0000310158-22-000010',
        tag: 'NetIncomeLoss',
      },
    ]);
    const text = blockText(result.content);
    expect(text).toContain('CY2021: $13049.0M (raw 13049000000)');
    expect(text).toContain('10-K (FY2021 FY) filed 2022-02-25 [0000310158-22-000010]');
    expect(text).not.toContain('DEF 14A');
  });

  it('leaves the quarterly series unchanged', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const result = await getFinancialsTool.handler(
      getFinancialsTool.input.parse({
        company: 'MRK',
        concept: 'net_income',
        period_type: 'quarterly',
      }),
      ctx,
    );
    expect(result.data).toEqual([
      expect.objectContaining({ period: 'CY2021Q3', value: 3_232_000_000, form: '10-Q' }),
    ]);
  });
});

describe('successor tags and per-value attribution (#125)', () => {
  /** NVIDIA's capex: the PP&E tag stops at CY2020, the productive-assets successor runs on. */
  const ppe = conceptPayload(
    'PaymentsToAcquirePropertyPlantAndEquipment',
    'Payments to Acquire Property, Plant, and Equipment',
    {
      USD: [
        {
          start: '2019-01-28',
          end: '2020-01-26',
          accn: '0001045810-20-000010',
          filed: '2020-02-20',
          form: '10-K',
          fp: 'FY',
          frame: 'CY2019',
          fy: 2020,
          val: 489_000_000,
        },
        {
          start: '2020-01-27',
          end: '2021-01-31',
          accn: '0001045810-21-000010',
          filed: '2021-02-26',
          form: '10-K',
          fp: 'FY',
          frame: 'CY2020',
          fy: 2021,
          val: 1_128_000_000,
        },
      ],
    },
    'Cash outflow for PP&E.',
  );
  const productive = conceptPayload(
    'PaymentsToAcquireProductiveAssets',
    'Payments to Acquire Productive Assets',
    {
      USD: [
        {
          start: '2020-01-27',
          end: '2021-01-31',
          accn: '0001045810-21-000010',
          filed: '2021-02-26',
          form: '10-K',
          fp: 'FY',
          frame: 'CY2020',
          fy: 2021,
          val: 1_130_000_000,
        },
        {
          start: '2025-01-27',
          end: '2026-01-25',
          accn: '0001045810-26-000021',
          filed: '2026-02-25',
          form: '10-K',
          fp: 'FY',
          frame: 'CY2025',
          fy: 2026,
          val: 6_042_000_000,
        },
      ],
    },
    'Cash outflow for capex, software, and intangibles.',
  );

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-07-26T00:00:00.000Z'));
    mockApi.resolveCik.mockResolvedValue({
      cik: '0001045810',
      name: 'NVIDIA CORP',
      ticker: 'NVDA',
    });
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (_cik: string, _tax: string, tag: string) =>
        ({ [ppe.tag]: ppe, [productive.tag]: productive })[tag] ?? null,
    );
  });
  afterAll(() => {
    vi.setSystemTime(new Date(NOW));
  });

  it('walks the successor behind the PP&E tag and names each row’s source tag', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const result = await getFinancialsTool.handler(
      getFinancialsTool.input.parse({ company: 'NVDA', concept: 'capex' }),
      ctx,
    );

    expect(result.data.map((d) => [d.period, d.value, d.tag])).toEqual([
      ['CY2025', 6_042_000_000, 'PaymentsToAcquireProductiveAssets'],
      // A frame both tags report stays with the PP&E-only leader.
      ['CY2020', 1_128_000_000, 'PaymentsToAcquirePropertyPlantAndEquipment'],
      ['CY2019', 489_000_000, 'PaymentsToAcquirePropertyPlantAndEquipment'],
    ]);
    expect(result.tags_tried).toEqual([
      'PaymentsToAcquirePropertyPlantAndEquipment',
      'PaymentsToAcquireProductiveAssets',
    ]);
  });

  it('describes the line by the tag behind the newest value, with no staleness caveat', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const result = await getFinancialsTool.handler(
      getFinancialsTool.input.parse({ company: 'NVDA', concept: 'capex' }),
      ctx,
    );

    expect(result).toMatchObject({
      concept: 'PaymentsToAcquireProductiveAssets',
      label: 'Payments to Acquire Productive Assets',
      description: 'Cash outflow for capex, software, and intangibles.',
      unit: 'USD',
    });
    expect(result.caveats).toBeUndefined();
  });

  it('renders the source tag on rows that came from a different tag than the line', async () => {
    const result = await runToolContract(getFinancialsTool, { company: 'NVDA', concept: 'capex' });
    const text = blockText(result.content);

    expect(text).toContain('XBRL tag: PaymentsToAcquireProductiveAssets');
    expect(text).toMatch(/CY2020: .*\| tag PaymentsToAcquirePropertyPlantAndEquipment/);
    expect(text).not.toMatch(/CY2025: .*\| tag /);
  });

  it('carries the source tag on inline rows capped by limit and on every dataframe row', async () => {
    const registerDataframe = vi.fn().mockResolvedValue({
      name: 'df_ABCDE_FGHIJ',
      rowCount: 3,
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);
    vi.mocked(toDatasetField).mockReturnValue({
      name: 'df_ABCDE_FGHIJ',
      row_count: 3,
      expires_at: '2026-01-01T00:00:00.000Z',
    });
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const result = await getFinancialsTool.handler(
      getFinancialsTool.input.parse({ company: 'NVDA', concept: 'capex', limit: 1 }),
      ctx,
    );

    expect(result.data).toEqual([
      expect.objectContaining({ period: 'CY2025', tag: 'PaymentsToAcquireProductiveAssets' }),
    ]);
    expect(getEnrichment(ctx).truncated).toBe(true);
    const { rows } = at(registerDataframe.mock.calls, 0)[1];
    expect(rows.map((r: { tag: string }) => r.tag)).toEqual([
      'PaymentsToAcquireProductiveAssets',
      'PaymentsToAcquirePropertyPlantAndEquipment',
      'PaymentsToAcquirePropertyPlantAndEquipment',
    ]);
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);
  });
});

describe('banks’ operating interest caption (#147)', () => {
  /** JPMorgan's shape: InterestExpense stops at CY2024Q1, the operating caption runs to CY2026Q2. */
  const fact = (
    frame: string,
    start: string,
    end: string,
    val: number,
    form: string,
    filed: string,
    accn: string,
  ) => ({ frame, start, end, val, form, filed, accn, fp: form === '10-K' ? 'FY' : 'Q', fy: 2026 });
  const interestExpense = conceptPayload('InterestExpense', 'Interest Expense', {
    USD: [
      fact(
        'CY2023',
        '2023-01-01',
        '2023-12-31',
        81_321_000_000,
        '10-K',
        '2024-02-16',
        '0000019617-24-000225',
      ),
      fact(
        'CY2024Q1',
        '2024-01-01',
        '2024-03-31',
        24_356_000_000,
        '10-Q',
        '2024-05-01',
        '0000019617-24-000326',
      ),
    ],
  });
  /** SEC serves this tag's companyconcept with `"label":null`. */
  const interestExpenseOperating = conceptPayload('InterestExpenseOperating', null as never, {
    USD: [
      // Filed later and (here) disagreeing: the older tag still owns the frame.
      fact(
        'CY2023',
        '2023-01-01',
        '2023-12-31',
        80_000_000_000,
        '10-K',
        '2026-02-13',
        '0001628280-26-008131',
      ),
      fact(
        'CY2024Q1',
        '2024-01-01',
        '2024-03-31',
        24_356_000_000,
        '10-Q',
        '2025-05-01',
        '0000019617-25-000421',
      ),
      fact(
        'CY2025',
        '2025-01-01',
        '2025-12-31',
        97_898_000_000,
        '10-K',
        '2026-02-13',
        '0001628280-26-008131',
      ),
      fact(
        'CY2026Q2',
        '2026-04-01',
        '2026-06-30',
        25_113_000_000,
        '10-Q',
        '2026-08-06',
        '0001628280-26-054343',
      ),
    ],
  });

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
    mockApi.resolveCik.mockResolvedValue({
      cik: '0000019617',
      name: 'JPMORGAN CHASE & CO',
      ticker: 'JPM',
    });
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (_cik: string, _tax: string, tag: string) =>
        ({
          [interestExpense.tag]: interestExpense,
          [interestExpenseOperating.tag]: interestExpenseOperating,
        })[tag] ?? null,
    );
  });
  afterAll(() => {
    vi.setSystemTime(new Date(NOW));
  });

  it('reaches CY2026Q2 under the operating caption, labelled Interest Expense, with no staleness caveat', async () => {
    const result = await runToolContract(getFinancialsTool, {
      company: 'JPM',
      concept: 'interest_expense',
      period_type: 'all',
    });

    const output = getFinancialsTool.output.parse(result.structuredContent);
    expect(output).toMatchObject({
      concept: 'InterestExpenseOperating',
      label: 'Interest Expense',
      unit: 'USD',
    });
    expect(output.caveats).toBeUndefined();
    expect(at(output.data, 0)).toMatchObject({
      period: 'CY2026Q2',
      value: 25_113_000_000,
      tag: 'InterestExpenseOperating',
    });
    const text = blockText(result.content);
    expect(text).toContain('**Interest Expense** — JPMORGAN CHASE & CO');
    expect(text).not.toContain('**InterestExpenseOperating**');
    expect(text).not.toContain('Caveat:');
  });

  it('moves no frame the older tags resolve', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const result = await getFinancialsTool.handler(
      getFinancialsTool.input.parse({
        company: 'JPM',
        concept: 'interest_expense',
        period_type: 'all',
      }),
      ctx,
    );

    expect(result.data.map((d) => [d.period, d.value, d.tag])).toEqual([
      ['CY2026Q2', 25_113_000_000, 'InterestExpenseOperating'],
      ['CY2025', 97_898_000_000, 'InterestExpenseOperating'],
      ['CY2024Q1', 24_356_000_000, 'InterestExpense'],
      ['CY2023', 81_321_000_000, 'InterestExpense'],
    ]);
  });
});

describe('a tag reported under several unit keys (#146)', () => {
  /** An annual 20-F fact on Harmony Gold's 30 June fiscal year end. */
  const fy = (year: number, val: number, filed: string, form = '20-F') => ({
    start: `${year - 1}-07-01`,
    end: `${year}-06-30`,
    accn: `0001628280-${filed.slice(2, 4)}-0${year}`,
    filed,
    form,
    fp: 'FY',
    frame: `CY${year}`,
    fy: year,
    val,
  });
  /**
   * Harmony's ifrs-full Revenue: ZAR from CY2017, plus a USD convenience
   * translation for CY2016–CY2018 filed on one 20-F/A ahead of the ZAR facts.
   */
  const harmony = conceptPayload('Revenue', 'Revenue', {
    USD: [
      fy(2016, 1_264_000_000, '2018-11-23', '20-F/A'),
      fy(2017, 1_416_000_000, '2018-11-23', '20-F/A'),
      fy(2018, 1_584_000_000, '2018-11-23', '20-F/A'),
    ],
    ZAR: [
      fy(2017, 19_494_000_000, '2019-10-24'),
      fy(2018, 20_452_000_000, '2020-10-29'),
      fy(2025, 73_896_000_000, '2025-10-31'),
    ],
  });
  const run = (input: Record<string, unknown>) =>
    runToolContract(getFinancialsTool, {
      company: 'HMY',
      concept: 'revenue',
      taxonomy: 'ifrs-full',
      ...input,
    });

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
    mockApi.resolveCik.mockResolvedValue({
      cik: '0001023514',
      name: 'HARMONY GOLD MINING CO LTD',
      ticker: 'HMY',
    });
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (_cik: string, _tax: string, tag: string) => (tag === 'Revenue' ? harmony : null),
    );
  });
  afterAll(() => {
    vi.setSystemTime(new Date(NOW));
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);
  });

  it('reads the unit of the newest value and names the other unit in a caveat, on both surfaces', async () => {
    const result = await run({});
    const output = getFinancialsTool.output.parse(result.structuredContent);

    expect(output.unit).toBe('ZAR');
    expect(output.data.map((d) => [d.period, d.value])).toEqual([
      ['CY2025', 73_896_000_000],
      ['CY2018', 20_452_000_000],
      ['CY2017', 19_494_000_000],
    ]);
    expect(output.caveats).toEqual([
      'Also reported in USD (3 periods, CY2016–CY2018). This series holds ZAR values only — values in different units never share a series; pass unit: "USD" to read another.',
    ]);
    const text = blockText(result.content);
    expect(text).toContain('(CIK 0001023514, ZAR)');
    expect(text).toContain('CY2017: 19,494,000,000');
    expect(text).not.toContain('CY2016:');
    expect(text).toContain('Caveat: Also reported in USD (3 periods, CY2016–CY2018).');
  });

  it('reads the series in the unit asked for, naming the default unit in its place', async () => {
    const result = await run({ unit: 'USD' });
    const output = getFinancialsTool.output.parse(result.structuredContent);

    expect(output.unit).toBe('USD');
    expect(output.data.map((d) => [d.period, d.value, d.form])).toEqual([
      ['CY2018', 1_584_000_000, '20-F/A'],
      ['CY2017', 1_416_000_000, '20-F/A'],
      ['CY2016', 1_264_000_000, '20-F/A'],
    ]);
    // Staleness reads the concept across units: the ZAR series runs to CY2025.
    expect(output.caveats).toEqual([
      'Also reported in ZAR (3 periods, CY2017–CY2025). This series holds USD values only — values in different units never share a series; pass unit: "ZAR" to read another.',
    ]);
    expect(blockText(result.content)).toContain('CY2016: $1264.0M');
  });

  describe('when every unit has stopped', () => {
    beforeEach(() => {
      vi.setSystemTime(new Date('2030-10-04T00:00:00.000Z'));
    });

    it('measures the default series by its own end', async () => {
      const output = getFinancialsTool.output.parse((await run({})).structuredContent);
      expect(output.caveats).toContainEqual(
        expect.stringContaining('This series ends at CY2025, period ending 2025-06-30'),
      );
    });

    it('describes the series in the unit asked for by its own end, on both surfaces', async () => {
      const result = await run({ unit: 'USD' });
      const output = getFinancialsTool.output.parse(result.structuredContent);
      const stale = output.caveats?.find((c) => c.startsWith('This series ends at'));

      expect(stale).toContain('This series ends at CY2018, period ending 2018-06-30');
      expect(output.caveats?.join(' ')).not.toContain('ends at CY2025');
      expect(blockText(result.content)).toContain(`Caveat: ${stale}`);
    });
  });

  it('accepts the unit key in another case', async () => {
    const output = getFinancialsTool.output.parse((await run({ unit: 'zar' })).structuredContent);
    expect(output.unit).toBe('ZAR');
    expect(output.data).toHaveLength(3);
  });

  it('accepts fetch_frames’ -per- spelling of a ratio unit', async () => {
    /** SAP's AverageForeignExchangeRate: every pair framed for the same year, filed the same day. */
    const rate = (val: number) => ({ ...fy(2025, val, '2026-02-26'), end: '2025-12-31' });
    mockApi.tryGetCompanyConcept.mockResolvedValue(
      conceptPayload('AverageForeignExchangeRate', 'Average foreign exchange rate', {
        'USD/EUR': [rate(1.13)],
        'AUD/EUR': [rate(1.75)],
        'JPY/EUR': [rate(163.9)],
      }),
    );
    const base = {
      company: 'SAP',
      concept: 'AverageForeignExchangeRate',
      taxonomy: 'ifrs-full',
    } as const;

    const byDefault = getFinancialsTool.output.parse(
      (await runToolContract(getFinancialsTool, base)).structuredContent,
    );
    expect(byDefault.unit).toBe('AUD/EUR');
    expect(at(byDefault.caveats)).toContain(
      'Also reported in JPY/EUR (1 period, CY2025); USD/EUR (1 period, CY2025).',
    );

    const perEuro = getFinancialsTool.output.parse(
      (await runToolContract(getFinancialsTool, { ...base, unit: 'USD-per-EUR' }))
        .structuredContent,
    );
    expect(perEuro.unit).toBe('USD/EUR');
    expect(perEuro.data.map((d) => d.value)).toEqual([1.13]);
  });

  it('fails as no_unit_data, listing the units the tag reports, for a unit it does not', async () => {
    const result = await run({ unit: 'GBP' });
    const error = wireError(result);

    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'no_unit_data',
      unit: 'GBP',
      units: ['USD', 'ZAR'],
    });
    expect(error.message).toContain('USD, ZAR');
    const text = blockText(result.content);
    expect(text).toContain('USD, ZAR');
    expect(text).toContain('omit unit');
  });

  it('still fails as no_concept_data when no tag is reported, whatever the unit', async () => {
    mockApi.tryGetCompanyConcept.mockResolvedValue(null);
    const error = wireError(await run({ unit: 'GBP' }));
    expect(error.data.reason).toBe('no_concept_data');
  });

  it('fails as no_frame_data for a reported unit whose values carry no frame', async () => {
    const { frame: _frame, ...unframed } = fy(2025, 5, '2025-10-31');
    mockApi.tryGetCompanyConcept.mockResolvedValue(
      conceptPayload('Revenue', 'Revenue', { ...harmony.units, GBP: [unframed] }),
    );
    expect(wireError(await run({ unit: 'GBP' })).data.reason).toBe('no_frame_data');
  });

  it('caps the inline series with limit and stages one unit on the dataframe', async () => {
    const registerDataframe = vi.fn().mockResolvedValue({
      name: 'df_ABCDE_FGHIJ',
      rowCount: 3,
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);
    vi.mocked(toDatasetField).mockReturnValue({
      name: 'df_ABCDE_FGHIJ',
      row_count: 3,
      expires_at: '2026-01-01T00:00:00.000Z',
    });

    const result = await run({ unit: 'USD', limit: 1 });
    const output = getFinancialsTool.output.parse(result.structuredContent);
    expect(output.data.map((d) => d.period)).toEqual(['CY2018']);
    expect(bag(result.structuredContent).truncated).toBe(true);
    const [, { rows, queryParams }] = at(registerDataframe.mock.calls, 0);
    expect(rows.map((r: { unit: string; period: string }) => [r.period, r.unit])).toEqual([
      ['CY2018', 'USD'],
      ['CY2017', 'USD'],
      ['CY2016', 'USD'],
    ]);
    expect(queryParams).toMatchObject({ unit: 'USD' });
  });
});

describe('10-Q trailing-twelve-month annual frames (#142)', () => {
  /** Amazon's NetIncomeLoss as SEC frames it: the Q2-2026 10-Q TTM holds CY2026. */
  const amazon = conceptPayload('NetIncomeLoss', 'Net Income (Loss)', {
    USD: [
      {
        start: '2025-01-01',
        end: '2025-12-31',
        accn: '0001018724-26-000004',
        filed: '2026-02-06',
        form: '10-K',
        fp: 'FY',
        frame: 'CY2025',
        fy: 2025,
        val: 77_670_000_000,
      },
      {
        start: '2025-07-01',
        end: '2026-06-30',
        accn: '0001018724-26-000026',
        filed: '2026-07-31',
        form: '10-Q',
        fp: 'Q2',
        frame: 'CY2026',
        fy: 2026,
        val: 135_281_000_000,
      },
      {
        start: '2026-04-01',
        end: '2026-06-30',
        accn: '0001018724-26-000026',
        filed: '2026-07-31',
        form: '10-Q',
        fp: 'Q2',
        frame: 'CY2026Q2',
        fy: 2026,
        val: 18_164_000_000,
      },
    ],
  });

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-09-25T00:00:00.000Z'));
    mockApi.resolveCik.mockResolvedValue({
      cik: '0001018724',
      name: 'AMAZON COM INC',
      ticker: 'AMZN',
    });
    mockApi.tryGetCompanyConcept.mockResolvedValue(amazon);
  });
  afterAll(() => {
    vi.setSystemTime(new Date(NOW));
  });

  it('ends the annual series at the 10-K year, on both surfaces', async () => {
    const result = await runToolContract(getFinancialsTool, {
      company: 'AMZN',
      concept: 'net_income',
      period_type: 'annual',
      limit: 3,
    });

    expect(result.isError).toBeFalsy();
    const output = getFinancialsTool.output.parse(result.structuredContent);
    expect(output.data.map((d) => [d.period, d.value, d.form])).toEqual([
      ['CY2025', 77_670_000_000, '10-K'],
    ]);
    const text = blockText(result.content);
    expect(text).toContain('CY2025: $77670.0M');
    expect(text).not.toContain('CY2026:');
  });

  it('keeps the 10-Q’s quarterly frame', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const result = await getFinancialsTool.handler(
      getFinancialsTool.input.parse({
        company: 'AMZN',
        concept: 'net_income',
        period_type: 'quarterly',
      }),
      ctx,
    );
    expect(result.data).toEqual([
      expect.objectContaining({ period: 'CY2026Q2', value: 18_164_000_000 }),
    ]);
  });
});

describe('a 10-Q-held year its own series cannot test (#148)', () => {
  const fxTag =
    'EffectOfExchangeRateOnCashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents';
  /** Every fact Amazon reports under the tag, all from its Q1-2022 10-Q. */
  const fxUnits: CompanyConceptResponse['units'] = {
    USD: (
      [
        ['2020-04-01', '2021-03-31', 'CY2020', 809_000_000],
        ['2021-01-01', '2021-03-31', 'CY2021Q1', -293_000_000],
        ['2021-04-01', '2022-03-31', 'CY2021', -55_000_000],
        ['2022-01-01', '2022-03-31', 'CY2022Q1', 16_000_000],
      ] as const
    ).map(([start, end, frame, val]) => ({
      start,
      end,
      frame,
      val,
      accn: '0001018724-22-000013',
      filed: '2022-04-29',
      form: '10-Q',
      fp: 'Q1',
      fy: 2022,
    })),
  };
  const fxPayload = { ...conceptPayload(fxTag, 'Effect of Exchange Rate', fxUnits), cik: 1018724 };
  /** Amazon's companyfacts: its 10-Ks close each year on December 31. */
  const amazonFacts = {
    cik: 1018724,
    entityName: 'AMAZON COM INC',
    facts: {
      'us-gaap': {
        NetIncomeLoss: {
          label: 'Net Income (Loss)',
          units: {
            USD: [
              {
                start: '2021-01-01',
                end: '2021-12-31',
                accn: '0001018724-22-000005',
                filed: '2022-02-04',
                form: '10-K',
                fp: 'FY',
                frame: 'CY2021',
                fy: 2021,
                val: 33_364_000_000,
              },
            ],
          },
        },
        [fxTag]: { label: 'Effect of Exchange Rate', units: fxUnits },
      },
    },
  };

  beforeEach(() => {
    vi.setSystemTime(new Date('2022-06-30T00:00:00.000Z'));
    mockApi.resolveCik.mockResolvedValue({
      cik: '0001018724',
      name: 'AMAZON COM INC',
      ticker: 'AMZN',
    });
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (_cik: string, _tax: string, tag: string) => (tag === fxTag ? fxPayload : null),
    );
    mockApi.tryGetCompanyFacts.mockResolvedValue(amazonFacts);
  });
  afterAll(() => {
    vi.setSystemTime(new Date(NOW));
  });

  it('tests Amazon’s April–March frames against its December year ends, on both surfaces', async () => {
    const result = await runToolContract(getFinancialsTool, {
      company: 'AMZN',
      concept: fxTag,
      period_type: 'all',
    });

    expect(result.isError).toBeFalsy();
    const output = getFinancialsTool.output.parse(result.structuredContent);
    expect(output.data.map((d) => [d.period, d.value])).toEqual([
      ['CY2022Q1', 16_000_000],
      ['CY2021Q1', -293_000_000],
    ]);
    const text = blockText(result.content);
    expect(text).toContain('CY2022Q1: $16.0M');
    expect(text).not.toContain('CY2021: ');
    expect(text).not.toContain('CY2020: ');
    expect(mockApi.tryGetCompanyFacts).toHaveBeenCalledTimes(1);
    expect(mockApi.tryGetCompanyFacts).toHaveBeenCalledWith('0001018724', expect.any(CallScope));
  });

  it('leaves the annual view empty, failing as no_period_data', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const err = await caught(
      getFinancialsTool.handler(
        getFinancialsTool.input.parse({ company: 'AMZN', concept: fxTag, period_type: 'annual' }),
        ctx,
      ),
    );
    expect(err.data.reason).toBe('no_period_data');
  });

  it('keeps the frames when the filer has no annual-report accession', async () => {
    mockApi.tryGetCompanyFacts.mockResolvedValue({
      ...amazonFacts,
      facts: { 'us-gaap': { [fxTag]: { label: 'Effect of Exchange Rate', units: fxUnits } } },
    });
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const result = await getFinancialsTool.handler(
      getFinancialsTool.input.parse({ company: 'AMZN', concept: fxTag, period_type: 'annual' }),
      ctx,
    );
    expect(result.data.map((d) => [d.period, d.value])).toEqual([
      ['CY2021', -55_000_000],
      ['CY2020', 809_000_000],
    ]);
  });

  it('keeps the frames when companyfacts holds nothing for the filer', async () => {
    mockApi.tryGetCompanyFacts.mockResolvedValue(null);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const result = await getFinancialsTool.handler(
      getFinancialsTool.input.parse({ company: 'AMZN', concept: fxTag, period_type: 'annual' }),
      ctx,
    );
    expect(result.data.map((d) => d.period)).toEqual(['CY2021', 'CY2020']);
  });

  describe('when the companyfacts read fails', () => {
    const unavailable = () =>
      new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'SEC EDGAR API request failed after retries',
      );

    it('keeps the untested frames and names them in a caveat, on both surfaces', async () => {
      mockApi.tryGetCompanyFacts.mockRejectedValue(unavailable());
      const result = await runToolContract(getFinancialsTool, {
        company: 'AMZN',
        concept: fxTag,
        period_type: 'annual',
      });

      expect(result.isError).toBeFalsy();
      const output = getFinancialsTool.output.parse(result.structuredContent);
      expect(output.data.map((d) => [d.period, d.value])).toEqual([
        ['CY2021', -55_000_000],
        ['CY2020', 809_000_000],
      ]);
      const caveat = output.caveats?.find((c) => c.includes('fiscal-year ends'));
      expect(caveat).toContain('CY2021, CY2020');
      expect(caveat).toContain('trailing-twelve-month');
      expect(blockText(result.content)).toContain(`Caveat: ${caveat}`);
      expect(mockApi.tryGetCompanyFacts).toHaveBeenCalledTimes(1);
    });

    it('adds no caveat when the series shown holds no 10-Q-held year', async () => {
      mockApi.tryGetCompanyFacts.mockRejectedValue(new TypeError('fetch failed'));
      const result = await runToolContract(getFinancialsTool, {
        company: 'AMZN',
        concept: fxTag,
        period_type: 'quarterly',
      });

      expect(result.isError).toBeFalsy();
      const output = getFinancialsTool.output.parse(result.structuredContent);
      expect(output.data.map((d) => d.period)).toEqual(['CY2022Q1', 'CY2021Q1']);
      expect(output.caveats ?? []).not.toContainEqual(expect.stringContaining('fiscal-year ends'));
    });

    it('fails a cancelled call instead of returning the untested series', async () => {
      const controller = new AbortController();
      mockApi.tryGetCompanyFacts.mockImplementation(async () => {
        controller.abort();
        throw unavailable();
      });
      const ctx = createMockContext({
        errors: getFinancialsTool.errors,
        signal: controller.signal,
      });
      await expect(
        getFinancialsTool.handler(
          getFinancialsTool.input.parse({ company: 'AMZN', concept: fxTag, period_type: 'annual' }),
          ctx,
        ),
      ).rejects.toThrow('SEC EDGAR API request failed after retries');
    });
  });

  it('reuses the companyfacts payload a served-empty tag already read', async () => {
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (_cik: string, _tax: string, tag: string) => {
        if (tag === 'RevenueFromContractWithCustomerExcludingAssessedTax') {
          return conceptPayload(tag, 'Excluding', {});
        }
        if (tag === 'Revenues') return conceptPayload('Revenues', 'Revenues', fxUnits);
        return null;
      },
    );
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const result = await getFinancialsTool.handler(
      getFinancialsTool.input.parse({ company: 'AMZN', concept: 'revenue', period_type: 'all' }),
      ctx,
    );
    expect(result.data.map((d) => d.period)).toEqual(['CY2022Q1', 'CY2021Q1']);
    expect(mockApi.tryGetCompanyFacts).toHaveBeenCalledTimes(1);
  });

  it('sends no companyfacts request when every 10-Q-held year is testable in its own series', async () => {
    mockApi.tryGetCompanyConcept.mockResolvedValue(
      conceptPayload('NetIncomeLoss', 'Net Income (Loss)', {
        USD: [
          {
            start: '2021-01-01',
            end: '2021-12-31',
            accn: 'k',
            filed: '2022-02-04',
            form: '10-K',
            fp: 'FY',
            frame: 'CY2021',
            fy: 2021,
            val: 1,
          },
          {
            start: '2021-04-01',
            end: '2022-03-31',
            accn: 'q',
            filed: '2022-04-29',
            form: '10-Q',
            fp: 'Q1',
            frame: 'CY2022',
            fy: 2022,
            val: 2,
          },
        ],
      }),
    );
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const result = await getFinancialsTool.handler(
      getFinancialsTool.input.parse({ company: 'AMZN', concept: 'net_income' }),
      ctx,
    );
    expect(result.data.map((d) => d.period)).toEqual(['CY2021']);
    expect(mockApi.tryGetCompanyFacts).not.toHaveBeenCalled();
  });
});

describe('companyconcept served without values (#141)', () => {
  /**
   * SEC answers Visa's and Coca-Cola's NetIncomeLoss companyconcept with
   * `"units":{"USD":{}}`; the service edge drops the non-array unit, so the tool
   * receives a payload that names the tag and carries no values.
   */
  const servedEmpty = conceptPayload(
    'NetIncomeLoss',
    'Net Income (Loss) Attributable to Parent',
    {},
  );
  const visaFacts = {
    cik: 1403161,
    entityName: 'Visa Inc.',
    facts: {
      'us-gaap': {
        NetIncomeLoss: {
          label: 'Net Income (Loss) Attributable to Parent',
          description: 'Net income attributable to the parent.',
          units: {
            USD: [
              {
                start: '2024-10-01',
                end: '2025-09-30',
                accn: '0001403161-25-000080',
                filed: '2025-11-06',
                form: '10-K',
                fp: 'FY',
                frame: 'CY2025',
                fy: 2025,
                val: 20_058_000_000,
              },
            ],
          },
        },
      },
    },
  };

  beforeEach(() => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0001403161', name: 'Visa Inc.', ticker: 'V' });
    mockApi.tryGetCompanyConcept.mockResolvedValue(servedEmpty);
  });

  it('answers from companyfacts when companyconcept names the tag but carries no values', async () => {
    mockApi.tryGetCompanyFacts.mockResolvedValue(visaFacts);
    const result = await runToolContract(getFinancialsTool, {
      company: 'V',
      concept: 'net_income',
      limit: 3,
    });

    expect(result.isError).toBeFalsy();
    const output = getFinancialsTool.output.parse(result.structuredContent);
    expect(output).toMatchObject({
      concept: 'NetIncomeLoss',
      description: 'Net income attributable to the parent.',
      data: [
        {
          period: 'CY2025',
          value: 20_058_000_000,
          form: '10-K',
          accession_number: '0001403161-25-000080',
          tag: 'NetIncomeLoss',
        },
      ],
    });
    expect(mockApi.tryGetCompanyFacts).toHaveBeenCalledTimes(1);
    expect(blockText(result.content)).toContain('CY2025: $20058.0M');
  });

  it('fails as no_concept_data when companyfacts holds nothing either', async () => {
    mockApi.tryGetCompanyFacts.mockResolvedValue(null);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const err = await caught(
      getFinancialsTool.handler(
        getFinancialsTool.input.parse({ company: 'V', concept: 'net_income' }),
        ctx,
      ),
    );

    expect(err.data.reason).toBe('no_concept_data');
    expect(err.message).not.toContain('is not iterable');
    expect(mockApi.tryGetCompanyFacts).toHaveBeenCalledTimes(1);
  });

  it('reads companyfacts only for the tag served empty, keeping the rest of the ladder', async () => {
    // Tag 0 served empty, tag 1 well-formed: the ladder still resolves tag 0 from
    // companyfacts rather than letting the lower tag answer alone.
    mockApi.resolveCik.mockResolvedValue({ cik: '0000021344', name: 'COCA COLA CO', ticker: 'KO' });
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (_cik: string, _tax: string, tag: string) => {
        if (tag === 'RevenueFromContractWithCustomerExcludingAssessedTax') {
          return { ...servedEmpty, tag, label: 'Excluding' };
        }
        if (tag === 'Revenues') {
          return conceptPayload('Revenues', 'Revenues', {
            USD: [
              {
                accn: 'r-2025',
                end: '2025-12-31',
                start: '2025-01-01',
                filed: '2026-02-20',
                form: '10-K',
                fp: 'FY',
                frame: 'CY2025',
                fy: 2025,
                val: 1,
              },
            ],
          });
        }
        return null;
      },
    );
    mockApi.tryGetCompanyFacts.mockResolvedValue({
      facts: {
        'us-gaap': {
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            label: 'Excluding',
            units: {
              USD: [
                {
                  accn: 'x-2025',
                  end: '2025-12-31',
                  start: '2025-01-01',
                  filed: '2026-02-20',
                  form: '10-K',
                  fp: 'FY',
                  frame: 'CY2025',
                  fy: 2025,
                  val: 47_900_000_000,
                },
              ],
            },
          },
        },
      },
    });
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const result = await getFinancialsTool.handler(
      getFinancialsTool.input.parse({ company: 'KO', concept: 'revenue' }),
      ctx,
    );

    expect(result.data).toEqual([
      expect.objectContaining({
        period: 'CY2025',
        value: 47_900_000_000,
        tag: 'RevenueFromContractWithCustomerExcludingAssessedTax',
      }),
    ]);
  });

  it('never reads companyfacts on the happy path', async () => {
    mockApi.tryGetCompanyConcept.mockResolvedValue(mockConceptResponse);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    await getFinancialsTool.handler(
      getFinancialsTool.input.parse({ company: 'AAPL', concept: 'revenue' }),
      ctx,
    );
    expect(mockApi.tryGetCompanyFacts).not.toHaveBeenCalled();
  });
});

// Through the real argument-parsing path, where `inputAliases` is applied (#115).
describe('getFinancialsTool parameter names (#115)', () => {
  const call = (args: Record<string, unknown>) => runToolContract(getFinancialsTool, args as never);

  it.each([
    ['ticker', 'AAPL'],
    ['cik', '320193'],
    ['ticker_or_cik', 'AAPL'],
  ])('accepts %s as an alias of company', async (key, value) => {
    const result = await call({ [key]: value, concept: 'revenue' });

    expect(result.isError).toBeFalsy();
    expect(mockApi.resolveCik).toHaveBeenCalledWith(value, expect.any(CallScope));
    expect(result.structuredContent).toMatchObject({ company: 'Apple Inc.', cik: '0000320193' });
    expect(blockText(result.content)).toContain('Apple Inc.');
  });

  it('still rejects an unrelated unknown key by name', async () => {
    const result = await call({ company: 'AAPL', concept: 'revenue', bogus: true });

    expect(result.isError).toBe(true);
    expect(blockText(result.content)).toContain('bogus');
    expect(mockApi.resolveCik).not.toHaveBeenCalled();
  });
});

// Through the real tool pipeline, so the wire envelope is what a client receives (#128).
describe('concept names that are neither a friendly name nor an XBRL tag (#128)', () => {
  // SEC matches tags case-sensitively and answers an unreported one with a 404.
  beforeEach(() => {
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (_cik: string, _tax: string, tag: string) =>
        /^[A-Z][A-Za-z0-9]*$/.test(tag) ? mockConceptResponse : null,
    );
  });

  const edgarCalls = () =>
    mockApi.resolveCik.mock.calls.length +
    mockApi.tryGetCompanyConcept.mock.calls.length +
    mockApi.tryGetCompanyFacts.mock.calls.length;

  it.each([
    ['free_cash_flow', 'operating_cash_flow − capex'],
    ['ebitda', 'operating_income + depreciation_amortization'],
  ])(
    'fails %s as unknown_concept with its derivation, before any EDGAR call',
    async (concept, formula) => {
      const result = await runToolContract(getFinancialsTool, { company: 'AAPL', concept });

      const error = wireError(result);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data).toMatchObject({ reason: 'unknown_concept', concept, derivation: formula });
      expect(error.data.suggestions).toEqual([]);
      const hint = String(bag(error.data.recovery).hint);
      expect(hint).toContain(formula);
      expect(hint).toContain('secedgar_search_concepts');
      const text = blockText(result.content);
      expect(text).toContain(formula);
      expect(text).toContain('secedgar_search_concepts');
      expect(text).toContain('reason unknown_concept');
      expect(text).not.toContain('This filer reports under');
      expect(edgarCalls()).toBe(0);
    },
  );

  it('suggests debt for total_debt, on both surfaces', async () => {
    const result = await runToolContract(getFinancialsTool, {
      company: 'AAPL',
      concept: 'total_debt',
    });

    const error = wireError(result);
    expect(error.data.reason).toBe('unknown_concept');
    expect(error.data.derivation).toBeUndefined();
    expect(error.data.suggestions).toContain('debt');
    expect(blockText(result.content)).toMatch(/Closest supported names are [a-z_, ]*\bdebt\b/);
    expect(edgarCalls()).toBe(0);
  });

  it('suggests capex for capital_expenditures, matched on its label', async () => {
    const result = await runToolContract(getFinancialsTool, {
      company: 'AAPL',
      concept: 'capital_expenditures',
    });

    const suggestions = wireError(result).data.suggestions;
    expect(Array.isArray(suggestions) && suggestions[0]).toBe('capex');
    expect(edgarCalls()).toBe(0);
  });

  it('names secedgar_search_concepts even with nothing close to suggest (fcf)', async () => {
    const result = await runToolContract(getFinancialsTool, { company: 'AAPL', concept: 'fcf' });

    const error = wireError(result);
    expect(error.data.reason).toBe('unknown_concept');
    expect(error.data.suggestions).toEqual([]);
    expect(error.data.derivation).toBeUndefined();
    expect(blockText(result.content)).toContain('secedgar_search_concepts');
    expect(edgarCalls()).toBe(0);
  });

  it.each([
    '../submissions/CIK0000320193',
    'us-gaap:NetIncomeLoss',
    'netincomeloss',
    'Net Income!',
    '   ',
  ])('fails %j as unknown_concept without building a request', async (concept) => {
    const result = await runToolContract(getFinancialsTool, { company: 'AAPL', concept });

    expect(wireError(result).data.reason).toBe('unknown_concept');
    expect(edgarCalls()).toBe(0);
  });

  it('trims surrounding whitespace, so " revenue" resolves to the revenue concept', async () => {
    const result = await runToolContract(getFinancialsTool, {
      company: 'AAPL',
      concept: ' revenue ',
    });

    expect(result.isError).toBeFalsy();
    expect(mockApi.tryGetCompanyConcept).toHaveBeenCalledWith(
      '0000320193',
      'us-gaap',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      expect.any(CallScope),
    );
  });

  it('trims a raw tag before it becomes the lookup key', async () => {
    await runToolContract(getFinancialsTool, { company: 'AAPL', concept: ' NetIncomeLoss\t' });

    expect(mockApi.tryGetCompanyConcept).toHaveBeenCalledWith(
      '0000320193',
      'us-gaap',
      'NetIncomeLoss',
      expect.any(CallScope),
    );
  });

  // Characterization: every input shape below reached SEC before the check existed.
  it.each([
    ['Net Income', 'us-gaap', 'us-gaap', 'NetIncomeLoss'],
    ['NET_INCOME', 'us-gaap', 'us-gaap', 'NetIncomeLoss'],
    ['net-income', 'us-gaap', 'us-gaap', 'NetIncomeLoss'],
    ['NetIncomeLoss', 'us-gaap', 'us-gaap', 'NetIncomeLoss'],
    ['Revenues', 'us-gaap', 'us-gaap', 'Revenues'],
    ['SalesRevenueNet', 'us-gaap', 'us-gaap', 'SalesRevenueNet'],
    ['NetIncomeLoss', 'ifrs-full', 'ifrs-full', 'NetIncomeLoss'],
    ['ProfitLoss', 'ifrs-full', 'ifrs-full', 'ProfitLoss'],
    ['EntityCommonStockSharesOutstanding', 'dei', 'dei', 'EntityCommonStockSharesOutstanding'],
    ['NetIncomeLoss', 'dei', 'dei', 'NetIncomeLoss'],
  ] as const)(
    'still sends %s under %s to SEC as %s:%s',
    async (concept, taxonomy, expectedTaxonomy, tag) => {
      await runToolContract(getFinancialsTool, { company: 'AAPL', concept, taxonomy });

      expect(mockApi.resolveCik).toHaveBeenCalledWith('AAPL', expect.any(CallScope));
      expect(mockApi.tryGetCompanyConcept).toHaveBeenCalledWith(
        '0000320193',
        expectedTaxonomy,
        tag,
        expect.any(CallScope),
      );
    },
  );
});

// Through the real tool pipeline, so the hint is asserted as a client receives it (#164).
describe('no_concept_data names the taxonomy to retry (#164)', () => {
  /** Each filer's companyfacts, trimmed to a few of the tags SEC served on 2026-10-14. */
  const sophFacts: CompanyFactsResponse = {
    facts: {
      dei: {
        EntityCommonStockSharesOutstanding: {
          label: 'Entity Common Stock, Shares Outstanding',
          units: {
            shares: [
              {
                end: '2025-12-31',
                val: 68_486_338,
                accn: '0001840706-26-000006',
                fy: 2025,
                fp: 'FY',
                form: '20-F',
                filed: '2026-03-03',
                frame: 'CY2025Q4I',
              },
            ],
          },
        },
      },
      'ifrs-full': {
        DilutedEarningsLossPerShare: {
          units: {
            'USD/shares': [
              {
                start: '2025-01-01',
                end: '2025-12-31',
                val: -1.17,
                accn: '0001840706-26-000006',
                fy: 2025,
                fp: 'FY',
                form: '20-F',
                filed: '2026-03-03',
                frame: 'CY2025',
              },
              {
                start: '2024-01-01',
                end: '2024-12-31',
                val: -0.95,
                accn: '0001840706-26-000006',
                fy: 2025,
                fp: 'FY',
                form: '20-F',
                filed: '2026-03-03',
                frame: 'CY2024',
              },
            ],
          },
        },
        Equity: {
          units: {
            USD: [
              {
                end: '2025-12-31',
                val: 47_145_000,
                accn: '0001840706-26-000006',
                fy: 2025,
                fp: 'FY',
                form: '20-F',
                filed: '2026-03-03',
                frame: 'CY2025Q4I',
              },
            ],
          },
        },
      },
    },
  };
  const aaplFacts: CompanyFactsResponse = {
    facts: {
      dei: {
        EntityCommonStockSharesOutstanding: {
          label: 'Entity Common Stock, Shares Outstanding',
          units: {
            shares: [
              {
                end: '2026-07-17',
                val: 14_594_180_000,
                accn: '0000320193-26-000020',
                fy: 2026,
                fp: 'Q3',
                form: '10-Q',
                filed: '2026-07-31',
                frame: 'CY2026Q2I',
              },
            ],
          },
        },
      },
      'us-gaap': {
        EarningsPerShareDiluted: {
          label: 'Earnings Per Share, Diluted',
          units: {
            'USD/shares': [
              {
                start: '2024-09-29',
                end: '2025-09-27',
                val: 7.46,
                accn: '0000320193-25-000079',
                fy: 2025,
                fp: 'FY',
                form: '10-K',
                filed: '2025-10-31',
                frame: 'CY2025',
              },
            ],
          },
        },
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          label: 'Revenue from Contract with Customer, Excluding Assessed Tax',
          units: {
            USD: [
              {
                start: '2024-09-29',
                end: '2025-09-27',
                val: 416_161_000_000,
                accn: '0000320193-25-000079',
                fy: 2025,
                fp: 'FY',
                form: '10-K',
                filed: '2025-10-31',
                frame: 'CY2025',
              },
            ],
          },
        },
      },
    },
  };
  /** Toyota reports both namespaces, and cost of sales only under us-gaap. */
  const tmFacts: CompanyFactsResponse = {
    facts: {
      dei: {
        EntityCommonStockSharesOutstanding: {
          label: 'Entity Common Stock, Shares Outstanding',
          units: {
            shares: [
              {
                end: '2026-03-31',
                val: 13_033_931_974,
                accn: '0001193125-26-264811',
                fy: 2026,
                fp: 'FY',
                form: '20-F',
                filed: '2026-06-10',
                frame: 'CY2026Q1I',
              },
            ],
          },
        },
      },
      'ifrs-full': {
        Revenue: {
          units: {
            JPY: [
              {
                start: '2024-04-01',
                end: '2025-03-31',
                val: 48_036_704_000_000,
                accn: '0001193125-25-142326',
                fy: 2025,
                fp: 'FY',
                form: '20-F',
                filed: '2025-06-18',
                frame: 'CY2024',
              },
            ],
          },
        },
      },
      'us-gaap': {
        CostOfGoodsAndServicesSold: {
          label: 'Cost of Goods and Services Sold',
          units: {
            JPY: [
              {
                start: '2017-04-01',
                end: '2018-03-31',
                val: 22_600_474_000_000,
                accn: '0001193125-18-201591',
                fy: 2018,
                fp: 'FY',
                form: '20-F',
                filed: '2018-06-25',
                frame: 'CY2017',
              },
            ],
          },
        },
      },
    },
  };
  /** Boston Scientific's lone `srt` tag, framed, beside a us-gaap tag. */
  const bsxFacts: CompanyFactsResponse = {
    facts: {
      'us-gaap': {
        StockholdersEquity: {
          label: "Stockholders' Equity Attributable to Parent",
          units: {
            USD: [
              {
                end: '2025-12-31',
                val: 24_233_000_000,
                accn: '0000885725-26-000053',
                fy: 2026,
                fp: 'Q2',
                form: '10-Q',
                filed: '2026-08-03',
                frame: 'CY2025Q4I',
              },
            ],
          },
        },
      },
      srt: {
        StockRepurchaseProgramAuthorizedAmount1: {
          label: 'Stock Repurchase Program, Authorized Amount',
          units: {
            USD: [
              {
                end: '2020-12-14',
                val: 1_000_000_000,
                accn: '0000885725-26-000053',
                fy: 2026,
                fp: 'Q2',
                form: '10-Q',
                filed: '2026-08-03',
                frame: 'CY2020Q4I',
              },
            ],
          },
        },
      },
    },
  };
  const filers: Record<string, { cik: string; name: string; facts: CompanyFactsResponse }> = {
    SOPH: { cik: '0001840706', name: 'SOPHiA GENETICS SA', facts: sophFacts },
    AAPL: { cik: '0000320193', name: 'Apple Inc.', facts: aaplFacts },
    TM: { cik: '0001094517', name: 'TOYOTA MOTOR CORP/', facts: tmFacts },
    BSX: { cik: '0000885725', name: 'BOSTON SCIENTIFIC CORPORATION', facts: bsxFacts },
  };
  const byCik = (cik: string) => Object.values(filers).find((filer) => filer.cik === cik);

  beforeEach(() => {
    mockApi.resolveCik.mockImplementation(async (company: string) => {
      const filer = filers[company];
      return filer ? { cik: filer.cik, name: filer.name, ticker: company } : [];
    });
    // companyconcept answers exactly what the filer's companyfacts holds, as SEC does.
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (cik: string, taxonomy: string, tag: string) => {
        const concept = byCik(cik)?.facts.facts[taxonomy]?.[tag];
        return concept
          ? {
              cik: Number(cik),
              entityName: '',
              label: concept.label ?? '',
              tag,
              taxonomy,
              units: concept.units,
            }
          : null;
      },
    );
    mockApi.tryGetCompanyFacts.mockImplementation(async (cik: string) => byCik(cik)?.facts ?? null);
  });

  const call = (company: string, concept: string, taxonomy: string) =>
    runToolContract(getFinancialsTool, { company, concept, taxonomy } as never);

  it.each([
    [
      'SOPH',
      'eps_diluted',
      'us-gaap',
      'ifrs-full',
      'Retry with taxonomy: "ifrs-full" — eps_diluted resolves there to DilutedEarningsLossPerShare.',
    ],
    [
      'AAPL',
      'eps_diluted',
      'ifrs-full',
      'us-gaap',
      'Retry with taxonomy: "us-gaap" — eps_diluted resolves there to EarningsPerShareDiluted.',
    ],
    [
      'TM',
      'cogs',
      'ifrs-full',
      'us-gaap',
      'Retry with taxonomy: "us-gaap" — cogs resolves there to CostOfGoodsAndServicesSold.',
    ],
    [
      'SOPH',
      'shares_outstanding',
      'ifrs-full',
      'dei',
      'Retry with taxonomy: "dei" — shares_outstanding resolves there to EntityCommonStockSharesOutstanding.',
    ],
    [
      'AAPL',
      'revenue',
      'dei',
      'us-gaap',
      'Retry with taxonomy: "us-gaap" — revenue resolves there to RevenueFromContractWithCustomerExcludingAssessedTax.',
    ],
    [
      'SOPH',
      'DilutedEarningsLossPerShare',
      'us-gaap',
      'ifrs-full',
      'DilutedEarningsLossPerShare is reported under ifrs-full — retry with taxonomy: "ifrs-full".',
    ],
    [
      'AAPL',
      'EarningsPerShareDiluted',
      'ifrs-full',
      'us-gaap',
      'EarningsPerShareDiluted is reported under us-gaap — retry with taxonomy: "us-gaap".',
    ],
    // Past the first other taxonomy: SOPH reports nothing under us-gaap.
    [
      'SOPH',
      'EntityCommonStockSharesOutstanding',
      'ifrs-full',
      'dei',
      'EntityCommonStockSharesOutstanding is reported under dei — retry with taxonomy: "dei".',
    ],
  ])(
    '%s %s under %s leads the hint with a retry under %s, on both surfaces',
    async (company, concept, taxonomy, retryTaxonomy, retry) => {
      const result = await call(company, concept, taxonomy);

      const error = wireError(result);
      expect(error.data.reason).toBe('no_concept_data');
      const hint = String(bag(error.data.recovery).hint);
      expect(hint.startsWith(`${retry} This filer reports under: `)).toBe(true);
      expect(blockText(result.content)).toContain(retry);
      expect(mockApi.tryGetCompanyFacts).toHaveBeenCalledTimes(1);

      // The retry the hint names answers.
      const retried = await call(company, concept, retryTaxonomy);
      expect(retried.isError).toBeFalsy();
      expect(getFinancialsTool.output.parse(retried.structuredContent).data.length).toBeGreaterThan(
        0,
      );
    },
  );

  it('keeps the error data fields and the namespace summary after the retry line', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const err = await caught(
      getFinancialsTool.handler(
        getFinancialsTool.input.parse({ company: 'SOPH', concept: 'eps_diluted' }),
        ctx,
      ),
    );

    expect(err.data).toEqual({
      reason: 'no_concept_data',
      recovery: {
        hint: 'Retry with taxonomy: "ifrs-full" — eps_diluted resolves there to DilutedEarningsLossPerShare. This filer reports under: dei (1 tags); ifrs-full (2 tags). Try a raw XBRL tag from one of these namespaces, or switch taxonomy to match.',
      },
      concept: 'eps_diluted',
      taxonomy: 'us-gaap',
      tags_tried: ['EarningsPerShareDiluted'],
      available_namespaces: ['dei', 'ifrs-full'],
    });
  });

  // Characterization: the namespace summary the probe already returned stands alone.
  it.each([
    ['SOPH', 'notes_payable', 'ifrs-full'],
    ['SOPH', 'notes_payable', 'us-gaap'],
  ])(
    'names no retry for %s %s under %s, which no accepted taxonomy carries',
    async (company, concept, taxonomy) => {
      const ctx = createMockContext({ errors: getFinancialsTool.errors });
      const err = await caught(
        getFinancialsTool.handler(
          getFinancialsTool.input.parse({ company, concept, taxonomy }),
          ctx,
        ),
      );

      expect(err.data.reason).toBe('no_concept_data');
      expect(recoveryHint(err)).toBe(
        'This filer reports under: dei (1 tags); ifrs-full (2 tags). Try a raw XBRL tag from one of these namespaces, or switch taxonomy to match.',
      );
      expect(mockApi.tryGetCompanyFacts).toHaveBeenCalledTimes(1);
    },
  );

  it('names no retry for a raw tag the filer never reports', async () => {
    const result = await call('AAPL', 'NoSuchTagAnywhere', 'us-gaap');

    const hint = String(bag(wireError(result).data.recovery).hint);
    expect(hint).toBe(
      'This filer reports under: dei (1 tags); us-gaap (2 tags). Try a raw XBRL tag from one of these namespaces, or switch taxonomy to match.',
    );
    expect(blockText(result.content)).not.toContain('Retry with taxonomy');
  });

  it('names no namespace outside the taxonomy input, though companyfacts carries it', async () => {
    const result = await call('BSX', 'StockRepurchaseProgramAuthorizedAmount1', 'us-gaap');

    const hint = String(bag(wireError(result).data.recovery).hint);
    expect(hint.startsWith('This filer reports under: ')).toBe(true);
    expect(hint).not.toContain('retry with taxonomy');
    expect(hint).not.toContain('taxonomy: "srt"');
  });

  it('names no retry where the other taxonomy holds the tag with no framed value', async () => {
    mockApi.tryGetCompanyFacts.mockResolvedValue({
      facts: {
        'ifrs-full': {
          DilutedEarningsLossPerShare: {
            units: {
              // Unframed only, plus a unit served as an object where an array belongs (#141).
              'USD/shares': [
                {
                  start: '2025-01-01',
                  end: '2025-12-31',
                  val: -1.17,
                  accn: '0001840706-26-000006',
                  fy: 2025,
                  fp: 'FY',
                  form: '20-F',
                  filed: '2026-03-03',
                },
              ],
              EUR: {} as never,
            },
          },
        },
      },
    } satisfies CompanyFactsResponse);

    for (const concept of ['eps_diluted', 'DilutedEarningsLossPerShare']) {
      const result = await call('SOPH', concept, 'us-gaap');
      const hint = String(bag(wireError(result).data.recovery).hint);
      expect(hint).toMatch(/^This filer reports under: ifrs-full \(1 tags/);
    }
  });

  it('names the first tag of the ladder the other taxonomy reports, past the first', async () => {
    // Revenue tagged only under the ladder's second tag.
    const { RevenueFromContractWithCustomerExcludingAssessedTax: excluding, ...rest } =
      aaplFacts.facts['us-gaap'] ?? {};
    mockApi.tryGetCompanyFacts.mockResolvedValue({
      facts: { ...aaplFacts.facts, 'us-gaap': { ...rest, Revenues: excluding! } },
    });

    const result = await call('AAPL', 'revenue', 'dei');

    expect(String(bag(wireError(result).data.recovery).hint)).toMatch(
      /^Retry with taxonomy: "us-gaap" — revenue resolves there to Revenues\. /,
    );
  });

  // Characterization: with no companyfacts payload the probe's static hints stand.
  it.each([
    ['ifrs-full', 'Try a raw XBRL tag instead of a friendly name, or check the company uses IFRS.'],
    [
      'us-gaap',
      "This company may use a different tag or taxonomy. Try 'ifrs-full' for foreign filers.",
    ],
  ])('keeps the static hint under %s when companyfacts holds nothing', async (taxonomy, hint) => {
    mockApi.tryGetCompanyFacts.mockResolvedValue(null);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const err = await caught(
      getFinancialsTool.handler(
        getFinancialsTool.input.parse({ company: 'SOPH', concept: 'cogs', taxonomy }),
        ctx,
      ),
    );

    expect(recoveryHint(err)).toBe(hint);
    expect(err.data.available_namespaces).toBeUndefined();
  });
});

describe('explicit annual on an instant concept (#167)', () => {
  /** A fixture row's space-separated fields, checked for count so a typo fails loudly. */
  const fields = (row: string, count: number): string[] => {
    const parts = row.split(' ');
    if (parts.length !== count) throw new Error(`Fixture row needs ${count} fields: ${row}`);
    return parts;
  };
  /**
   * Framed instants as SEC served them, one row each: end, value, frame, then the
   * frame holder's form, fiscal period, fiscal year (`-` when the filing encodes
   * none), filed date, and accession.
   */
  const instants = (rows: readonly string[]): CompanyConceptUnit[] =>
    rows.map((row) => {
      const [end, val, frame, form, fp, fy, filed, accn] = fields(row, 8) as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      return {
        end,
        val: Number(val),
        frame,
        form,
        fp: fp === '-' ? null : fp,
        fy: fy === '-' ? null : Number(fy),
        filed,
        accn,
      };
    });
  /**
   * Annual reports' own year-long facts, which the filer's fiscal-year ends are
   * read from, one row each: start, end, form, filed date, accession, and value.
   */
  const reportYears = (rows: readonly string[]): CompanyConceptUnit[] =>
    rows.map((row) => {
      const [start, end, form, filed, accn, val] = fields(row, 6) as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      return {
        start,
        end,
        form,
        filed,
        accn,
        val: Number(val),
        fp: 'FY',
        fy: Number(end.slice(0, 4)),
      };
    });
  /** A companyfacts payload holding the given concepts, each `[taxonomy, tag, unit, values, label?]`. */
  const companyFacts = (
    ...concepts: ReadonlyArray<
      readonly [
        taxonomy: string,
        tag: string,
        unit: string,
        values: CompanyConceptUnit[],
        label?: string,
      ]
    >
  ): CompanyFactsResponse => {
    const facts: CompanyFactsResponse['facts'] = {};
    for (const [taxonomy, tag, unit, values, label] of concepts) {
      facts[taxonomy] = {
        ...facts[taxonomy],
        [tag]: { ...(label === undefined ? {} : { label }), units: { [unit]: values } },
      };
    }
    return { facts };
  };

  /**
   * Each filer's equity (Apple's assets) and the annual-report facts its fiscal-year
   * ends come from, trimmed from what SEC served on 2026-10-14. Boston Scientific's
   * 2025-12-31 instant is framed on its Q2-2026 10-Q, and the 10-K's own fact for
   * that date carries no frame.
   */
  const bsxEquity = [
    ...instants([
      '2021-12-31 16622000000 CY2021Q4I 10-K FY 2023 2024-02-20 0000885725-24-000017',
      '2022-03-31 16735000000 CY2022Q1I 10-Q Q1 2023 2023-05-04 0000885725-23-000026',
      '2022-06-30 17251000000 CY2022Q2I 10-Q Q2 2023 2023-08-03 0000885725-23-000043',
      '2022-09-30 17640000000 CY2022Q3I 10-Q Q3 2023 2023-11-01 0000885725-23-000048',
      '2022-12-31 17573000000 CY2022Q4I 10-K FY 2024 2025-02-18 0000885725-25-000011',
      '2023-03-31 17850000000 CY2023Q1I 10-Q Q1 2024 2024-05-01 0000885725-24-000046',
      '2023-06-30 18226000000 CY2023Q2I 10-Q Q2 2024 2024-08-01 0000885725-24-000068',
      '2023-09-30 18886000000 CY2023Q3I 10-Q Q3 2024 2024-11-01 0000885725-24-000073',
      '2023-12-31 19282000000 CY2023Q4I 10-K FY 2024 2025-02-18 0000885725-25-000011',
      '2024-03-31 19926000000 CY2024Q1I 10-Q Q1 2024 2024-05-01 0000885725-24-000046',
      '2024-06-30 20371000000 CY2024Q2I 10-Q Q2 2025 2025-08-01 0000885725-25-000041',
      '2024-09-30 20708000000 CY2024Q3I 10-Q Q3 2025 2025-11-03 0000885725-25-000050',
      '2024-12-31 21770000000 CY2024Q4I 10-K FY 2025 2026-02-17 0000885725-26-000010',
      '2025-03-31 22212000000 CY2025Q1I 10-Q Q1 2025 2025-05-01 0000885725-25-000026',
      '2025-06-30 22418000000 CY2025Q2I 10-Q Q2 2026 2026-08-03 0000885725-26-000053',
      '2025-09-30 23394000000 CY2025Q3I 10-Q Q3 2025 2025-11-03 0000885725-25-000050',
      '2025-12-31 24233000000 CY2025Q4I 10-Q Q2 2026 2026-08-03 0000885725-26-000053',
      '2026-03-31 25864000000 CY2026Q1I 10-Q Q1 2026 2026-05-01 0000885725-26-000033',
      '2026-06-30 24930000000 CY2026Q2I 10-Q Q2 2026 2026-08-03 0000885725-26-000053',
    ]),
    {
      end: '2025-12-31',
      val: 24_233_000_000,
      accn: '0000885725-26-000010',
      fy: 2025,
      fp: 'FY',
      form: '10-K',
      filed: '2026-02-17',
    },
  ];
  /** Boston Scientific's cover-page share counts, dated weeks after each year end. */
  const bsxShares = instants([
    '2025-01-31 1475778104 CY2024Q4I 10-K FY 2024 2025-02-18 0000885725-25-000011',
    '2025-04-29 1479446345 CY2025Q1I 10-Q Q1 2025 2025-05-01 0000885725-25-000026',
    '2025-07-29 1481751634 CY2025Q2I 10-Q Q2 2025 2025-08-01 0000885725-25-000041',
    '2025-10-30 1482442039 CY2025Q3I 10-Q Q3 2025 2025-11-03 0000885725-25-000050',
    '2026-01-30 1483885456 CY2025Q4I 10-K FY 2025 2026-02-17 0000885725-26-000010',
    '2026-04-29 1486355179 CY2026Q1I 10-Q Q1 2026 2026-05-01 0000885725-26-000033',
    '2026-07-30 1449229526 CY2026Q2I 10-Q Q2 2026 2026-08-03 0000885725-26-000053',
  ]);
  const bsxYears = reportYears([
    '2020-01-01 2020-12-31 10-K 2021-02-23 0000885725-21-000008 0.01',
    '2021-01-01 2021-12-31 10-K 2022-02-23 0000885725-22-000006 0.01',
    '2022-01-01 2022-12-31 10-K 2023-02-23 0000885725-23-000008 0.01',
    '2023-01-01 2023-12-31 10-K 2024-02-20 0000885725-24-000017 0.01',
    '2023-01-01 2023-12-31 10-K/A 2024-02-21 0000885725-24-000020 0.01',
    '2024-01-01 2024-12-31 10-K 2025-02-18 0000885725-25-000011 0.01',
    '2025-01-01 2025-12-31 10-K 2026-02-17 0000885725-26-000010 0.01',
  ]);
  const EQUITY_LABEL = "Stockholders' Equity Attributable to Parent";

  const filers: Record<string, { cik: string; name: string; facts: CompanyFactsResponse }> = {
    BSX: {
      cik: '0000885725',
      name: 'BOSTON SCIENTIFIC CORPORATION',
      facts: companyFacts(
        ['us-gaap', 'StockholdersEquity', 'USD', bsxEquity, EQUITY_LABEL],
        ['dei', 'EntityCommonStockSharesOutstanding', 'shares', bsxShares],
        ['dei', 'EntityListingParValuePerShare', 'USD/shares', bsxYears],
      ),
    },
    MSFT: {
      cik: '0000789019',
      name: 'MICROSOFT CORPORATION',
      facts: companyFacts(
        [
          'us-gaap',
          'StockholdersEquity',
          'USD',
          instants([
            '2023-06-30 206223000000 CY2023Q2I 10-K FY 2025 2025-07-30 0000950170-25-100235',
            '2023-09-30 220714000000 CY2023Q3I 10-Q Q1 2025 2024-10-30 0000950170-24-118967',
            '2023-12-31 238268000000 CY2023Q4I 10-Q Q2 2025 2025-01-29 0000950170-25-010491',
            '2024-03-31 253152000000 CY2024Q1I 10-Q Q3 2025 2025-04-30 0000950170-25-061046',
            '2024-06-30 268477000000 CY2024Q2I 10-K FY 2026 2026-07-29 0001193125-26-323660',
            '2024-09-30 287723000000 CY2024Q3I 10-Q Q1 2026 2025-10-29 0001193125-25-256321',
            '2024-12-31 302695000000 CY2024Q4I 10-Q Q2 2026 2026-01-28 0001193125-26-027207',
            '2025-03-31 321891000000 CY2025Q1I 10-Q Q3 2026 2026-04-29 0001193125-26-191507',
            '2025-06-30 343479000000 CY2025Q2I 10-K FY 2026 2026-07-29 0001193125-26-323660',
            '2025-09-30 363076000000 CY2025Q3I 10-Q Q1 2026 2025-10-29 0001193125-25-256321',
            '2025-12-31 390875000000 CY2025Q4I 10-Q Q2 2026 2026-01-28 0001193125-26-027207',
            '2026-03-31 414367000000 CY2026Q1I 10-Q Q3 2026 2026-04-29 0001193125-26-191507',
            '2026-06-30 442387000000 CY2026Q2I 10-K FY 2026 2026-07-29 0001193125-26-323660',
          ]),
          EQUITY_LABEL,
        ],
        [
          'dei',
          'EntityListingParValuePerShare',
          'USD/shares',
          reportYears([
            '2022-07-01 2023-06-30 10-K 2023-07-27 0000950170-23-035122 0.000006',
            '2023-07-01 2024-06-30 10-K 2024-07-30 0000950170-24-087843 0.000006',
            '2024-07-01 2025-06-30 10-K 2025-07-30 0000950170-25-100235 0.000006',
            '2025-07-01 2026-06-30 10-K 2026-07-29 0001193125-26-323660 0.000006',
          ]),
        ],
      ),
    },
    AAPL: {
      cik: '0000320193',
      name: 'Apple Inc.',
      facts: companyFacts(
        [
          'us-gaap',
          'Assets',
          'USD',
          instants([
            '2023-07-01 335038000000 CY2023Q2I 10-Q Q3 2023 2023-08-04 0000320193-23-000077',
            '2023-09-30 352583000000 CY2023Q3I 10-K FY 2024 2024-11-01 0000320193-24-000123',
            '2023-12-30 353514000000 CY2023Q4I 10-Q Q1 2024 2024-02-02 0000320193-24-000006',
            '2024-03-30 337411000000 CY2024Q1I 10-Q Q2 2024 2024-05-03 0000320193-24-000069',
            '2024-06-29 331612000000 CY2024Q2I 10-Q Q3 2024 2024-08-02 0000320193-24-000081',
            '2024-09-28 364980000000 CY2024Q3I 10-K FY 2025 2025-10-31 0000320193-25-000079',
            '2024-12-28 344085000000 CY2024Q4I 10-Q Q1 2025 2025-01-31 0000320193-25-000008',
            '2025-03-29 331233000000 CY2025Q1I 10-Q Q2 2025 2025-05-02 0000320193-25-000057',
            '2025-06-28 331495000000 CY2025Q2I 10-Q Q3 2025 2025-08-01 0000320193-25-000073',
            '2025-09-27 359241000000 CY2025Q3I 10-Q Q3 2026 2026-07-31 0000320193-26-000020',
            '2025-12-27 379297000000 CY2025Q4I 10-Q Q1 2026 2026-01-30 0000320193-26-000006',
            '2026-03-28 371082000000 CY2026Q1I 10-Q Q2 2026 2026-05-01 0000320193-26-000013',
            '2026-06-27 383266000000 CY2026Q2I 10-Q Q3 2026 2026-07-31 0000320193-26-000020',
          ]),
          'Assets',
        ],
        [
          'us-gaap',
          'AllocatedShareBasedCompensationExpense',
          'USD',
          reportYears([
            '2021-09-26 2022-09-24 10-K 2022-10-28 0000320193-22-000108 9038000000',
            '2022-09-25 2023-09-30 10-K 2023-11-03 0000320193-23-000106 10833000000',
            '2023-10-01 2024-09-28 10-K 2024-11-01 0000320193-24-000123 11688000000',
            '2024-09-29 2025-09-27 10-K 2025-10-31 0000320193-25-000079 12863000000',
          ]),
        ],
      ),
    },
    WMT: {
      cik: '0000104169',
      name: 'WALMART INC.',
      facts: companyFacts(
        [
          'us-gaap',
          'StockholdersEquity',
          'USD',
          instants([
            '2024-01-31 83861000000 CY2023Q4I 10-K FY 2025 2025-03-14 0000104169-25-000021',
            '2024-04-30 81293000000 CY2024Q1I 10-Q Q1 2026 2025-06-06 0000104169-25-000090',
            '2024-07-31 84423000000 CY2024Q2I 10-Q Q2 2026 2025-08-29 0000104169-25-000137',
            '2024-10-31 88108000000 CY2024Q3I 10-Q Q3 2026 2025-12-03 0000104169-25-000191',
            '2025-01-31 91013000000 CY2024Q4I 10-K FY 2026 2026-03-13 0000104169-26-000055',
            '2025-04-30 83793000000 CY2025Q1I 10-Q Q1 2027 2026-05-29 0000104169-26-000102',
            '2025-07-31 90110000000 CY2025Q2I 10-Q Q2 2027 2026-08-28 0000104169-26-000154',
            '2025-10-31 96094000000 CY2025Q3I 10-Q Q3 2026 2025-12-03 0000104169-25-000191',
            '2026-01-31 99617000000 CY2025Q4I 10-Q Q2 2027 2026-08-28 0000104169-26-000154',
            '2026-04-30 94330000000 CY2026Q1I 10-Q Q1 2027 2026-05-29 0000104169-26-000102',
            '2026-07-31 98238000000 CY2026Q2I 10-Q Q2 2027 2026-08-28 0000104169-26-000154',
          ]),
          EQUITY_LABEL,
        ],
        [
          'us-gaap',
          'AdvertisingExpense',
          'USD',
          reportYears([
            '2022-02-01 2023-01-31 10-K 2023-03-17 0000104169-23-000020 4100000000',
            '2023-02-01 2024-01-31 10-K 2024-03-15 0000104169-24-000056 4400000000',
            '2024-02-01 2025-01-31 10-K 2025-03-14 0000104169-25-000021 5100000000',
            '2025-02-01 2026-01-31 10-K 2026-03-13 0000104169-26-000055 5400000000',
          ]),
        ],
      ),
    },
    ORCL: {
      cik: '0001341439',
      name: 'Oracle Corporation',
      facts: companyFacts(
        [
          'us-gaap',
          'StockholdersEquity',
          'USD',
          instants([
            '2024-05-31 8704000000 CY2024Q2I 10-K FY 2025 2025-06-18 0000950170-25-087926',
            '2024-08-31 10816000000 CY2024Q3I 10-Q Q1 2025 2024-09-10 0000950170-24-104905',
            '2024-11-30 13746000000 CY2024Q4I 10-Q Q2 2025 2024-12-10 0000950170-24-134973',
            '2025-02-28 16730000000 CY2025Q1I 10-Q Q3 2025 2025-03-11 0000950170-25-037143',
            '2025-05-31 20451000000 CY2025Q2I 10-K FY 2026 2026-06-22 0001193125-26-277521',
            '2025-08-31 24154000000 CY2025Q3I 10-Q Q1 2026 2025-09-10 0001193125-25-200095',
            '2025-11-30 29951000000 CY2025Q4I 10-Q Q2 2026 2025-12-11 0001193125-25-315925',
            '2026-02-28 38495000000 CY2026Q1I 10-Q Q3 2026 2026-03-11 0001193125-26-101045',
            '2026-05-31 42508000000 CY2026Q2I 10-Q Q1 2026 2026-09-11 0001193125-26-389274',
            '2026-08-31 66772000000 CY2026Q3I 10-Q Q1 2026 2026-09-11 0001193125-26-389274',
          ]),
          EQUITY_LABEL,
        ],
        [
          'us-gaap',
          'AdjustmentsRelatedToTaxWithholdingForShareBasedCompensation',
          'USD',
          reportYears([
            '2022-06-01 2023-05-31 10-K 2023-06-20 0000950170-23-028914 1203000000',
            '2023-06-01 2024-05-31 10-K 2024-06-20 0000950170-24-075605 2040000000',
            '2024-06-01 2025-05-31 10-K 2025-06-18 0000950170-25-087926 900000000',
            '2025-06-01 2026-05-31 10-K 2026-06-22 0001193125-26-277521 111000000',
          ]),
        ],
      ),
    },
    SOPH: {
      cik: '0001840706',
      name: 'SOPHiA GENETICS SA',
      facts: companyFacts(
        [
          'ifrs-full',
          'Equity',
          'USD',
          // 6-K interim reports encode no fiscal period or year.
          instants([
            '2023-03-31 184912000 CY2023Q1I 6-K - - 2024-08-06 0001840706-24-000123',
            '2023-06-30 171702000 CY2023Q2I 6-K - - 2024-08-06 0001840706-24-000123',
            '2023-12-31 151442000 CY2023Q4I 20-F FY 2025 2026-03-03 0001840706-26-000006',
            '2024-03-31 132232000 CY2024Q1I 6-K - - 2025-08-05 0001840706-25-000026',
            '2024-06-30 121443000 CY2024Q2I 6-K - - 2025-08-05 0001840706-25-000026',
            '2024-12-31 96490000 CY2024Q4I 20-F FY 2025 2026-03-03 0001840706-26-000006',
            '2025-03-31 85613000 CY2025Q1I 6-K - - 2025-08-05 0001840706-25-000026',
            '2025-06-30 76692000 CY2025Q2I 6-K - - 2025-08-05 0001840706-25-000026',
            '2025-12-31 47145000 CY2025Q4I 20-F FY 2025 2026-03-03 0001840706-26-000006',
          ]),
        ],
        [
          'dei',
          'EntityCommonStockSharesOutstanding',
          'shares',
          instants([
            '2023-12-31 65230559 CY2023Q4I 20-F FY 2023 2024-03-05 0001840706-24-000012',
            '2024-12-31 66687085 CY2024Q4I 20-F FY 2024 2025-03-04 0001840706-25-000009',
            '2025-12-31 68486338 CY2025Q4I 20-F FY 2025 2026-03-03 0001840706-26-000006',
          ]),
          'Entity Common Stock, Shares Outstanding',
        ],
        [
          'ifrs-full',
          'AccountingProfit',
          'USD',
          reportYears([
            '2023-01-01 2023-12-31 20-F 2024-03-05 0001840706-24-000012 -77893000',
            '2024-01-01 2024-12-31 20-F 2025-03-04 0001840706-25-000009 -61270000',
            '2025-01-01 2025-12-31 20-F 2026-03-03 0001840706-26-000006 -77487000',
          ]),
        ],
      ),
    },
  };
  const byCik = (cik: string) => Object.values(filers).find((filer) => filer.cik === cik);

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-10-14T00:00:00.000Z'));
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);
    mockApi.resolveCik.mockImplementation(async (company: string) => {
      const filer = filers[company];
      return filer ? { cik: filer.cik, name: filer.name, ticker: company } : [];
    });
    // companyconcept answers exactly what the filer's companyfacts holds, as SEC does.
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (cik: string, taxonomy: string, tag: string) => {
        const concept = byCik(cik)?.facts.facts[taxonomy]?.[tag];
        return concept
          ? {
              cik: Number(cik),
              entityName: '',
              label: concept.label ?? '',
              tag,
              taxonomy,
              units: concept.units,
            }
          : null;
      },
    );
    mockApi.tryGetCompanyFacts.mockImplementation(async (cik: string) => byCik(cik)?.facts ?? null);
  });
  afterAll(() => {
    vi.setSystemTime(new Date(NOW));
  });

  const annual = (company: string, concept: string, extra: Record<string, unknown> = {}) =>
    getFinancialsTool.input.parse({ company, concept, period_type: 'annual', ...extra });

  it.each([
    [
      'BSX',
      'equity',
      'us-gaap',
      [
        ['CY2025Q4I', 24_233_000_000],
        ['CY2024Q4I', 21_770_000_000],
        ['CY2023Q4I', 19_282_000_000],
      ],
    ],
    [
      'MSFT',
      'equity',
      'us-gaap',
      [
        ['CY2026Q2I', 442_387_000_000],
        ['CY2025Q2I', 343_479_000_000],
        ['CY2024Q2I', 268_477_000_000],
      ],
    ],
    [
      'AAPL',
      'assets',
      'us-gaap',
      [
        ['CY2025Q3I', 359_241_000_000],
        ['CY2024Q3I', 364_980_000_000],
        ['CY2023Q3I', 352_583_000_000],
      ],
    ],
    [
      'WMT',
      'equity',
      'us-gaap',
      [
        ['CY2025Q4I', 99_617_000_000],
        ['CY2024Q4I', 91_013_000_000],
        ['CY2023Q4I', 83_861_000_000],
      ],
    ],
    [
      'ORCL',
      'equity',
      'us-gaap',
      [
        ['CY2026Q2I', 42_508_000_000],
        ['CY2025Q2I', 20_451_000_000],
        ['CY2024Q2I', 8_704_000_000],
      ],
    ],
    [
      'SOPH',
      'equity',
      'ifrs-full',
      [
        ['CY2025Q4I', 47_145_000],
        ['CY2024Q4I', 96_490_000],
        ['CY2023Q4I', 151_442_000],
      ],
    ],
  ] as const)(
    '%s %s under %s returns its fiscal-year-end values, newest first, on both surfaces',
    async (company, concept, taxonomy, expected) => {
      const result = await runToolContract(getFinancialsTool, {
        company,
        concept,
        taxonomy,
        period_type: 'annual',
        limit: 3,
      });

      expect(result.isError).toBeFalsy();
      const output = getFinancialsTool.output.parse(result.structuredContent);
      expect(output.data.map((d) => [d.period, d.value])).toEqual(expected);
      const text = blockText(result.content);
      for (const [period] of expected) expect(text).toContain(`\n${period}: `);
      expect(mockApi.tryGetCompanyFacts).toHaveBeenCalledTimes(1);
    },
  );

  it('selects every year end the filer reported, keeping the frame holder’s provenance', async () => {
    const result = await getFinancialsTool.handler(
      annual('BSX', 'equity'),
      createMockContext({ errors: getFinancialsTool.errors }),
    );

    // 2021 and 2022 are framed on later 10-Ks; 2025 on a 10-Q, beside the 10-K's unframed fact.
    expect(result.data.map((d) => [d.period, d.end])).toEqual([
      ['CY2025Q4I', '2025-12-31'],
      ['CY2024Q4I', '2024-12-31'],
      ['CY2023Q4I', '2023-12-31'],
      ['CY2022Q4I', '2022-12-31'],
      ['CY2021Q4I', '2021-12-31'],
    ]);
    expect(at(result.data)).toEqual({
      period: 'CY2025Q4I',
      value: 24_233_000_000,
      end: '2025-12-31',
      fiscal_year: 2026,
      fiscal_period: 'Q2',
      form: '10-Q',
      filed: '2026-08-03',
      accession_number: '0000885725-26-000053',
      tag: 'StockholdersEquity',
    });
    // An annual view: no missing-quarter caveat.
    expect(result.caveats).toBeUndefined();
  });

  it('keeps the first 10-K’s comparative year-end balances, on both surfaces', async () => {
    /**
     * Microsoft's first XBRL 10-K (fiscal 2010, filed 2010-07-30) restates
     * fiscal 2009 and 2008 beside its own year, as SEC served it on 2026-10-14.
     * The fiscal 2011 10-K adds a year-long figure ending 2009-09-30, off the
     * filer's calendar (Merck's and P&G's 09-30 shape), which closes no year.
     */
    const firstXbrl = companyFacts(
      [
        'us-gaap',
        'StockholdersEquity',
        'USD',
        instants([
          '2008-06-30 36286000000 CY2008Q2I 10-K FY 2010 2010-07-30 0001193125-10-171791',
          '2008-09-30 33594000000 CY2008Q3I 10-Q Q1 2010 2009-10-23 0001193125-09-212454',
          '2009-06-30 39558000000 CY2009Q2I 10-K FY 2011 2011-07-28 0001193125-11-200680',
          '2009-09-30 41212000000 CY2009Q3I 10-Q Q1 2011 2010-10-28 0001193125-10-239825',
          '2010-06-30 46175000000 CY2010Q2I 10-K FY 2012 2012-07-26 0001193125-12-316848',
        ]),
        EQUITY_LABEL,
      ],
      [
        'us-gaap',
        'Revenues',
        'USD',
        reportYears([
          '2007-07-01 2008-06-30 10-K 2010-07-30 0001193125-10-171791 60420000000',
          '2008-07-01 2009-06-30 10-K 2010-07-30 0001193125-10-171791 58437000000',
          '2009-07-01 2010-06-30 10-K 2010-07-30 0001193125-10-171791 62484000000',
          '2008-10-01 2009-09-30 10-K 2011-07-28 0001193125-11-200680 60000000000',
          '2010-07-01 2011-06-30 10-K 2011-07-28 0001193125-11-200680 69943000000',
        ]),
      ],
    );
    mockApi.resolveCik.mockResolvedValue({
      cik: '0000789019',
      name: 'MICROSOFT CORPORATION',
      ticker: 'MSFT',
    });
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (_cik: string, taxonomy: string, tag: string) => {
        const concept = firstXbrl.facts[taxonomy]?.[tag];
        return concept ? conceptPayload(tag, concept.label ?? '', concept.units) : null;
      },
    );
    mockApi.tryGetCompanyFacts.mockResolvedValue(firstXbrl);

    const result = await runToolContract(getFinancialsTool, {
      company: 'MSFT',
      concept: 'equity',
      period_type: 'annual',
    });

    expect(result.isError).toBeFalsy();
    const output = getFinancialsTool.output.parse(result.structuredContent);
    expect(output.data.map((d) => [d.period, d.value, d.end])).toEqual([
      ['CY2010Q2I', 46_175_000_000, '2010-06-30'],
      ['CY2009Q2I', 39_558_000_000, '2009-06-30'],
      ['CY2008Q2I', 36_286_000_000, '2008-06-30'],
    ]);
    const text = blockText(result.content);
    expect(text).toContain('\nCY2009Q2I: ');
    expect(text).toContain('\nCY2008Q2I: ');
    expect(text).not.toContain('CY2009Q3I');
    expect(mockApi.tryGetCompanyFacts).toHaveBeenCalledTimes(1);
  });

  it('caps the inline year ends at limit, disclosing the full count', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const result = await getFinancialsTool.handler(annual('BSX', 'equity', { limit: 3 }), ctx);

    expect(result.data).toHaveLength(3);
    const enrichment = getEnrichment(ctx);
    expect(enrichment).toMatchObject({ truncated: true, shown: 3, cap: 3 });
    expect(String(enrichment.notice)).toContain('most-recent of 5 periods');
  });

  it('stages the year ends as an annual dataframe', async () => {
    const registerDataframe = vi.fn().mockResolvedValue({
      name: 'df_ABCDE_FGHIJ',
      rowCount: 5,
      expiresAt: '2026-10-15T00:00:00.000Z',
    });
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as any);
    vi.mocked(toDatasetField).mockReturnValue({
      name: 'df_ABCDE_FGHIJ',
      row_count: 5,
      expires_at: '2026-10-15T00:00:00.000Z',
    });

    await getFinancialsTool.handler(
      annual('BSX', 'equity'),
      createMockContext({ errors: getFinancialsTool.errors }),
    );

    const [, registration] = at(registerDataframe.mock.calls);
    expect(registration.queryParams).toMatchObject({
      period_type: 'annual',
      concept: 'StockholdersEquity',
    });
    expect(registration.rows.map((row: { period: string }) => row.period)).toEqual([
      'CY2025Q4I',
      'CY2024Q4I',
      'CY2023Q4I',
      'CY2022Q4I',
      'CY2021Q4I',
    ]);
  });

  it('reads a year-end cover-page count only where the filer dates it at the year end', async () => {
    const result = await getFinancialsTool.handler(
      annual('SOPH', 'shares_outstanding'),
      createMockContext({ errors: getFinancialsTool.errors }),
    );

    expect(result.data.map((d) => [d.period, d.value])).toEqual([
      ['CY2025Q4I', 68_486_338],
      ['CY2024Q4I', 66_687_085],
      ['CY2023Q4I', 65_230_559],
    ]);
  });

  it('fails a cover-page count dated after each year end as no_period_data, on both surfaces', async () => {
    const result = await runToolContract(getFinancialsTool, {
      company: 'BSX',
      concept: 'shares_outstanding',
      period_type: 'annual',
    });

    const error = wireError(result);
    expect(error.data).toMatchObject({
      reason: 'no_period_data',
      tag: 'EntityCommonStockSharesOutstanding',
      period_type: 'annual',
    });
    const hint = String(bag(error.data.recovery).hint);
    expect(hint).toContain('fiscal-year end');
    expect(hint).toContain('period_type: "quarterly" or "all"');
    expect(blockText(result.content)).toContain(hint);
    expect(mockApi.tryGetCompanyFacts).toHaveBeenCalledTimes(1);
  });

  // Characterization: calls that succeed today return the same values and read no companyfacts.
  it.each([
    ['omitted', {}],
    ['quarterly', { period_type: 'quarterly' }],
    ['all', { period_type: 'all' }],
  ] as const)(
    'keeps the full instant series with period_type %s, with no companyfacts request',
    async (_label, periodType) => {
      const result = await getFinancialsTool.handler(
        getFinancialsTool.input.parse({ company: 'BSX', concept: 'equity', ...periodType }),
        createMockContext({ errors: getFinancialsTool.errors }),
      );

      expect(result.data).toHaveLength(19);
      expect(at(result.data)).toMatchObject({ period: 'CY2026Q2I', value: 24_930_000_000 });
      expect(mockApi.tryGetCompanyFacts).not.toHaveBeenCalled();
    },
  );

  it('keeps an explicit annual duration series unchanged, with no companyfacts request', async () => {
    mockApi.tryGetCompanyConcept.mockResolvedValue(mockConceptResponse);
    const result = await getFinancialsTool.handler(
      annual('AAPL', 'revenue'),
      createMockContext({ errors: getFinancialsTool.errors }),
    );

    expect(result.data.map((d) => [d.period, d.value])).toEqual([
      ['CY2023', 383285000000],
      ['CY2022', 394328000000],
    ]);
    expect(mockApi.tryGetCompanyFacts).not.toHaveBeenCalled();
  });

  it('reuses the companyfacts payload a served-empty tag already read', async () => {
    // companyconcept names the tag with no values, so the series itself comes from companyfacts.
    mockApi.tryGetCompanyConcept.mockImplementation(
      async (_cik: string, _taxonomy: string, tag: string) =>
        tag === 'StockholdersEquity' ? conceptPayload(tag, EQUITY_LABEL, {}) : null,
    );
    const result = await getFinancialsTool.handler(
      annual('BSX', 'equity', { limit: 1 }),
      createMockContext({ errors: getFinancialsTool.errors }),
    );

    expect(result.data.map((d) => [d.period, d.value])).toEqual([['CY2025Q4I', 24_233_000_000]]);
    expect(mockApi.tryGetCompanyFacts).toHaveBeenCalledTimes(1);
  });

  describe('when the fiscal-year ends cannot be read', () => {
    it('fails as no_period_data when companyfacts holds nothing for the filer', async () => {
      mockApi.tryGetCompanyFacts.mockResolvedValue(null);
      const err = await caught(
        getFinancialsTool.handler(
          annual('BSX', 'equity'),
          createMockContext({ errors: getFinancialsTool.errors }),
        ),
      );

      expect(err.message).toBe("No annual data for 'StockholdersEquity'.");
      expect(err.data).toMatchObject({ reason: 'no_period_data', period_type: 'annual' });
      expect(recoveryHint(err)).toContain('fiscal-year ends could not be read');
    });

    it('fails as no_period_data, logging the failed read, when companyfacts fails', async () => {
      mockApi.tryGetCompanyFacts.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'SEC EDGAR API request failed after retries',
        ),
      );
      const ctx = createMockContext({ errors: getFinancialsTool.errors });
      const err = await caught(getFinancialsTool.handler(annual('BSX', 'equity'), ctx));

      expect(err.data.reason).toBe('no_period_data');
      expect(recoveryHint(err)).toContain('fiscal-year ends could not be read');
      const log = ctx.log as MockContextLogger;
      expect(log.calls).toContainEqual(
        expect.objectContaining({
          level: 'warning',
          msg: expect.stringContaining('fiscal-year ends'),
        }),
      );
    });

    it('fails a cancelled call with its own error rather than no_period_data', async () => {
      const controller = new AbortController();
      mockApi.tryGetCompanyFacts.mockImplementation(async () => {
        controller.abort();
        throw new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'SEC EDGAR API request failed after retries',
        );
      });
      const err = await caught(
        getFinancialsTool.handler(
          annual('BSX', 'equity'),
          createMockContext({ errors: getFinancialsTool.errors, signal: controller.signal }),
        ),
      );

      expect(err.message).toBe('SEC EDGAR API request failed after retries');
      expect(err.data.reason).toBeUndefined();
    });
  });
});
