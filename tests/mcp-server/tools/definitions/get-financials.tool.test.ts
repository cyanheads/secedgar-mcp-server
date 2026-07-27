/**
 * @fileoverview Tests for get-financials tool — XBRL financial data retrieval.
 * @module tests/mcp-server/tools/definitions/get-financials.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFinancialsTool } from '@/mcp-server/tools/definitions/get-financials.tool.js';
import { resolveConcept } from '@/services/edgar/concept-map.js';
import type { CompanyConceptResponse } from '@/services/edgar/types.js';

vi.mock('@/services/edgar/edgar-api-service.js', () => ({
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
}));

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  toDatasetField: vi.fn(),
}));

import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';

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
    );
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

  it('sorts data newest first', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'AAPL',
      concept: 'revenue',
      period_type: 'all',
    });
    const result = await getFinancialsTool.handler(input, ctx);

    for (let i = 1; i < result.data.length; i++) {
      expect(result.data[i - 1].end >= result.data[i].end).toBe(true);
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
    expect(result.data[0].period).toMatch(/I$/);
  });

  it('duration concept still defaults to clean annual series (#48)', async () => {
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'AAPL', concept: 'revenue' });
    const result = await getFinancialsTool.handler(input, ctx);

    // mockConceptResponse has CY2023 and CY2022 (annual) — these should be returned
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data.every((d) => /^CY\d{4}$/.test(d.period))).toBe(true);
  });

  it('explicit period_type: annual on an instant concept still throws no_period_data (#48)', async () => {
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
        ],
      },
    };
    mockApi.tryGetCompanyConcept.mockResolvedValue(balanceSheetResponse);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'AAPL',
      concept: 'assets',
      period_type: 'annual',
    });

    await expect(getFinancialsTool.handler(input, ctx)).rejects.toMatchObject({
      message: /No annual data for 'Assets'/,
      data: {
        reason: 'no_period_data',
        period_type: 'annual',
        recovery: { hint: expect.stringMatching(/balance sheet \(instant\) item/) },
      },
    });
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
    expect(result.data[0].value).toBe(totalRevenue);
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
    expect(result.data[0].value).toBe(amended);
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
    const err = await getFinancialsTool.handler(input, ctx).catch((e) => e);
    expect(err.data.matches.length).toBeLessThanOrEqual(10);
  });

  it('renders the ambiguous_company candidates in the message, not just error data (#90)', async () => {
    mockApi.resolveCik.mockResolvedValue([
      { cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' },
      { cik: '0001418121', name: 'Apple Hospitality REIT, Inc.', ticker: 'APLE' },
      { cik: '0006084276', name: 'Apple Bank for Savings', ticker: undefined },
    ]);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({ company: 'Apple', concept: 'revenue' });

    const err = await getFinancialsTool.handler(input, ctx).catch((e) => e);
    // CIK, name, and ticker (when present) all reach the text surface, so a
    // content-only client can act on the "retry with a ticker or CIK" recovery.
    expect(err.message).toContain('0000320193 Apple Inc. (AAPL)');
    expect(err.message).toContain('0001418121 Apple Hospitality REIT, Inc. (APLE)');
    expect(err.message).toContain('0006084276 Apple Bank for Savings');
    // Text and structured data are built from one capped list, so they cannot drift.
    for (const m of err.data.matches) expect(err.message).toContain(m.cik);
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

    const err = await getFinancialsTool.handler(input, ctx).catch((e) => e);
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
    expect(mockApi.tryGetCompanyConcept).toHaveBeenCalledWith('0000320193', 'ifrs-full', 'Revenue');
    // Should also try the sub-line tag
    expect(mockApi.tryGetCompanyConcept).toHaveBeenCalledWith(
      '0000320193',
      'ifrs-full',
      'RevenueFromContractsWithCustomers',
    );
    // Should NOT have been called with a us-gaap tag under ifrs-full
    expect(mockApi.tryGetCompanyConcept).not.toHaveBeenCalledWith(
      '0000320193',
      'ifrs-full',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
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
    expect(result.data[0].period).toBe('CY2023');
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
        },
      ],
      dataset: {
        name: 'df_ABCDE_FGHIJ',
        row_count: 5,
        expires_at: '2026-05-18T00:00:00.000Z',
      },
    };
    const blocks = getFinancialsTool.format!(output);
    expect(blocks[0].text).toContain('showing the 1 most-recent of 5 periods');
    expect(blocks[0].text).toContain('df_ABCDE_FGHIJ');
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
        },
      ],
    };
    const blocks = getFinancialsTool.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('Revenue');
    expect(blocks[0].text).toContain('$383285.0M');
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
        },
      ],
    };
    const blocks = getFinancialsTool.format!(output);
    expect(blocks[0].text).toContain('$6.13');
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
    expect(blocks[0].text).toContain('Caveat: Calendar Q2');
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

    expect(blocks[0].text).toContain('Caveat:');
    expect(blocks[0].text).toContain('SalesRevenueGoodsNet');
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

    expect(blocks[0].text).toContain('Caveat:');
    expect(blocks[0].text).toContain('is a current tag');
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
    const { rows } = registerDataframe.mock.calls[0][1];
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

    // The inline data[] keeps the documented field names — out of scope for the rename.
    expect(result.data[0]).toHaveProperty('fiscal_year');
    expect(result.data[0]).toHaveProperty('fiscal_period');
    expect(result.dataset?.name).toBe('df_ABCDE_FGHIJ');
  });
});
