/**
 * @fileoverview Tests for get-financials tool — XBRL financial data retrieval.
 * @module tests/mcp-server/tools/definitions/get-financials.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFinancialsTool } from '@/mcp-server/tools/definitions/get-financials.tool.js';
import { resolveConcept } from '@/services/edgar/concept-map.js';
import type { CompanyConceptResponse } from '@/services/edgar/types.js';

vi.mock('@/services/edgar/edgar-api-service.js', () => ({
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
}));

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
    // equity has no ifrsTags — standard tags should be used
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const input = getFinancialsTool.input.parse({
      company: 'SPOT',
      concept: 'equity',
      taxonomy: 'ifrs-full',
    });
    await getFinancialsTool.handler(input, ctx);

    expect(mockApi.tryGetCompanyConcept).toHaveBeenCalledWith(
      '0000320193',
      'ifrs-full',
      'StockholdersEquity',
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
