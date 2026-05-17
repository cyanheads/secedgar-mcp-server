/**
 * @fileoverview Tests for fetch-frames tool — cross-company XBRL frames retrieval.
 * @module tests/mcp-server/tools/definitions/fetch-frames.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFramesTool } from '@/mcp-server/tools/definitions/fetch-frames.tool.js';
import type { FramesResponse } from '@/services/edgar/types.js';

vi.mock('@/services/edgar/edgar-api-service.js', () => ({
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
}));

import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';

const mockFramesResponse: FramesResponse = {
  ccp: 'CY2023',
  label: 'Revenue From Contract With Customer Excluding Assessed Tax',
  tag: 'RevenueFromContractWithCustomerExcludingAssessedTax',
  taxonomy: 'us-gaap',
  uom: 'USD',
  pts: 5000,
  data: [
    {
      accn: '0000320193-23-000106',
      cik: 320193,
      end: '2023-09-30',
      entityName: 'Apple Inc.',
      loc: 'CA',
      val: 383285000000,
    },
    {
      accn: '0001018724-24-000007',
      cik: 1018724,
      end: '2023-12-31',
      entityName: 'AMAZON COM INC',
      loc: 'WA',
      val: 574785000000,
    },
    {
      accn: '0001652044-24-000022',
      cik: 1652044,
      end: '2023-12-31',
      entityName: 'Alphabet Inc.',
      loc: 'CA',
      val: 307394000000,
    },
  ],
};

const mockApi = {
  tryGetFrames: vi.fn(),
  cikToTicker: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as any);
  mockApi.tryGetFrames.mockResolvedValue(mockFramesResponse);
  mockApi.cikToTicker.mockImplementation(async (cik: string) => {
    const map: Record<string, string> = {
      '0000320193': 'AAPL',
      '0001018724': 'AMZN',
      '0001652044': 'GOOGL',
    };
    return map[cik];
  });
});

describe('fetchFramesTool', () => {
  it('returns ranked companies for a metric', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.total_companies).toBe(5000);
    expect(result.data.length).toBe(3);
    expect(result.data[0].value).toBeGreaterThanOrEqual(result.data[1].value);
  });

  it('resolves friendly concept names', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    await fetchFramesTool.handler(input, ctx);

    expect(mockApi.tryGetFrames).toHaveBeenCalledWith(
      'us-gaap',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'USD',
      'CY2023',
    );
  });

  it('passes raw XBRL tags directly', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({
      concept: 'AccountsPayableCurrent',
      period: 'CY2023Q4I',
      unit: 'USD',
    });
    await fetchFramesTool.handler(input, ctx);

    expect(mockApi.tryGetFrames).toHaveBeenCalledWith(
      'us-gaap',
      'AccountsPayableCurrent',
      'USD',
      'CY2023Q4I',
    );
  });

  it('sorts ascending when requested', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({
      concept: 'revenue',
      period: 'CY2023',
      sort: 'asc',
    });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.data[0].value).toBeLessThanOrEqual(result.data[1].value);
  });

  it('applies limit', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({
      concept: 'revenue',
      period: 'CY2023',
      limit: 2,
    });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.data).toHaveLength(2);
  });

  it('enriches results with ticker symbols', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await fetchFramesTool.handler(input, ctx);

    const tickers = result.data.map((d) => d.ticker).filter(Boolean);
    expect(tickers).toContain('AAPL');
    expect(tickers).toContain('AMZN');
  });

  it('assigns correct rank numbers', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.data.map((d) => d.rank)).toEqual([1, 2, 3]);
  });

  it('zero-pads CIK to 10 digits', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await fetchFramesTool.handler(input, ctx);

    for (const entry of result.data) {
      expect(entry.cik).toHaveLength(10);
      expect(entry.cik).toMatch(/^\d{10}$/);
    }
  });

  it('throws notFound on 404 from frames API', async () => {
    mockApi.tryGetFrames.mockResolvedValue(null);
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });

    await expect(fetchFramesTool.handler(input, ctx)).rejects.toThrow(/No data for/);
  });

  it('re-throws non-404 errors', async () => {
    mockApi.tryGetFrames.mockRejectedValue(new Error('500 Internal Server Error'));
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });

    await expect(fetchFramesTool.handler(input, ctx)).rejects.toThrow(/500/);
  });

  it('handles ticker lookup returning undefined', async () => {
    mockApi.cikToTicker.mockResolvedValue(undefined);
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await fetchFramesTool.handler(input, ctx);

    for (const entry of result.data) {
      expect(entry.ticker).toBeUndefined();
    }
  });

  it('uses default values for optional inputs', () => {
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    expect(input.unit).toBe('USD');
    expect(input.limit).toBe(25);
    expect(input.sort).toBe('desc');
  });

  it('omits dataset field when canvas bridge is not initialized', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.dataset).toBeUndefined();
  });

  it('surfaces unqueried tags for multi-tag friendly names', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.unqueried_tags).toEqual(['Revenues', 'SalesRevenueNet', 'SalesRevenueGoodsNet']);
  });

  it('returns empty unqueried_tags for raw XBRL tags', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({
      concept: 'AccountsPayableCurrent',
      period: 'CY2023Q4I',
      unit: 'USD',
    });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.unqueried_tags).toEqual([]);
  });

  it('computes value_distribution over the full frame', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await fetchFramesTool.handler(input, ctx);

    // sorted vals: 307394000000 (GOOG), 383285000000 (AAPL), 574785000000 (AMZN)
    expect(result.value_distribution.median).toBe(383285000000);
    expect(result.value_distribution.p95).toBe(574785000000);
    expect(result.value_distribution.max).toBe(574785000000);
    expect(result.value_distribution.max_to_p95_ratio).toBe(1);
  });

  it('value_distribution.max_to_p95_ratio is robust to zero/negative bulk', async () => {
    // Distribution dominated by zeros/losses with one wildcat outlier — the
    // common XBRL scale-factor case (EPS, NetIncomeLoss).
    mockApi.tryGetFrames.mockResolvedValueOnce({
      ccp: 'CY2023',
      label: 'Test',
      tag: 'EarningsPerShareDiluted',
      taxonomy: 'us-gaap',
      uom: 'USD-per-shares',
      pts: 100,
      data: [
        ...Array.from({ length: 90 }, (_, i) => ({
          accn: `A${i}`,
          cik: 1000 + i,
          end: '2023-12-31',
          entityName: `Filer ${i}`,
          loc: 'US-CA',
          val: 0,
        })),
        ...Array.from({ length: 9 }, (_, i) => ({
          accn: `B${i}`,
          cik: 2000 + i,
          end: '2023-12-31',
          entityName: `Real ${i}`,
          loc: 'US-CA',
          val: i + 1, // 1..9
        })),
        // Wildcat scale-factor anomaly
        {
          accn: 'C0',
          cik: 9999,
          end: '2023-12-31',
          entityName: 'Anomaly Co',
          loc: 'US-CA',
          val: 18000,
        },
      ],
    });
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({
      concept: 'eps_diluted',
      period: 'CY2023',
      unit: 'USD-per-shares',
    });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.value_distribution.median).toBe(0);
    expect(result.value_distribution.max).toBe(18000);
    // p95 of 100 values where 90 are 0 and rest are 1..9 → position 95 → small positive
    expect(result.value_distribution.p95).toBeGreaterThan(0);
    // Ratio surfaces the anomaly cleanly despite median=0
    expect(result.value_distribution.max_to_p95_ratio).toBeGreaterThan(1000);
  });

  it('computes period_end_range across the full frame', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.period_end_range.min).toBe('2023-09-30');
    expect(result.period_end_range.max).toBe('2023-12-31');
  });

  it('formats USD values in billions', () => {
    const output = {
      concept: 'Revenues',
      period: 'CY2023',
      unit: 'USD',
      label: 'Revenue',
      total_companies: 5000,
      data: [
        {
          rank: 1,
          company_name: 'AMAZON COM INC',
          cik: '0001018724',
          ticker: 'AMZN',
          value: 574785000000,
          period_end: '2023-12-31',
          accession_number: '0001018724-24-000007',
        },
      ],
      unqueried_tags: [],
      value_distribution: { median: 0, p95: 0, max: 0, max_to_p95_ratio: 0 },
      period_end_range: { min: '', max: '' },
      caveats: [],
    };
    const blocks = fetchFramesTool.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('Revenue');
    expect(blocks[0].text).toContain('5000 companies');
    expect(blocks[0].text).toContain('AMZN');
    expect(blocks[0].text).toMatch(/\$574\.7[89]B/);
  });

  it('formats USD-per-shares values with dollar sign', () => {
    const output = {
      concept: 'EarningsPerShareDiluted',
      period: 'CY2023',
      unit: 'USD-per-shares',
      label: 'EPS (Diluted)',
      total_companies: 100,
      data: [
        {
          rank: 1,
          company_name: 'Test Corp',
          cik: '0000000001',
          value: 15.42,
          period_end: '2023-12-31',
          accession_number: '0000000001-24-000001',
        },
      ],
      unqueried_tags: [],
      value_distribution: { median: 0, p95: 0, max: 0, max_to_p95_ratio: 0 },
      period_end_range: { min: '', max: '' },
      caveats: [],
    };
    const blocks = fetchFramesTool.format!(output);
    expect(blocks[0].text).toContain('$15.42');
  });

  it('renders dataset hint when present', () => {
    const output = {
      concept: 'Revenues',
      period: 'CY2023',
      unit: 'USD',
      label: 'Revenue',
      total_companies: 5000,
      data: [],
      dataset: {
        name: 'df_ABCDE_FGHIJ',
        row_count: 5000,
        expires_at: '2026-05-18T00:00:00.000Z',
      },
      unqueried_tags: [],
      value_distribution: { median: 0, p95: 0, max: 0, max_to_p95_ratio: 0 },
      period_end_range: { min: '', max: '' },
      caveats: [],
    };
    const blocks = fetchFramesTool.format!(output);
    expect(blocks[0].text).toContain('df_ABCDE_FGHIJ');
    expect(blocks[0].text).toContain('5000 rows');
    expect(blocks[0].text).toContain('secedgar_dataframe_query');
  });

  it('renders coverage, value dispersion, and period range in format text', () => {
    const output = {
      concept: 'Revenues',
      period: 'CY2023',
      unit: 'USD',
      label: 'Revenue',
      total_companies: 3131,
      data: [],
      unqueried_tags: ['Revenues', 'SalesRevenueNet'],
      value_distribution: {
        median: 1200000000,
        p95: 42800000000,
        max: 642000000000,
        max_to_p95_ratio: 15,
      },
      period_end_range: { min: '2023-01-31', max: '2024-12-31' },
      caveats: [],
    };
    const blocks = fetchFramesTool.format!(output);
    expect(blocks[0].text).toContain('Coverage: 1 of 3 XBRL tags queried');
    expect(blocks[0].text).toContain('Revenues, SalesRevenueNet');
    expect(blocks[0].text).toContain('max/p95 15×');
    expect(blocks[0].text).toContain('2023-01-31 → 2024-12-31');
  });

  it('emits fiscal-Q4 caveat for duration CY*Q[1-4] periods', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2024Q3' });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.caveats).toHaveLength(1);
    expect(result.caveats[0]).toMatch(/fiscal Q4 closes in calendar Q3/);
    expect(result.caveats[0]).toContain('AAPL Sep-end');
  });

  it.each([
    ['CY2024Q1', 'calendar Q1', 'WMT Jan-end'],
    ['CY2024Q2', 'calendar Q2', 'MSFT Jun-end'],
    ['CY2024Q3', 'calendar Q3', 'AAPL Sep-end'],
    ['CY2024Q4', 'calendar Q4', 'most US filers'],
  ])('caveat for %s names the right calendar quarter and examples', async (period, label, example) => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.caveats[0]).toContain(label);
    expect(result.caveats[0]).toContain(example);
  });

  it('emits no caveats for annual CY#### periods', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.caveats).toEqual([]);
  });

  it('emits no caveats for instant CY####Q#I periods', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({
      concept: 'AccountsPayableCurrent',
      period: 'CY2023Q4I',
      unit: 'USD',
    });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.caveats).toEqual([]);
  });

  it('surfaces caveats in format text', () => {
    const output = {
      concept: 'Revenues',
      period: 'CY2024Q3',
      unit: 'USD',
      label: 'Revenue',
      total_companies: 3000,
      data: [],
      unqueried_tags: [],
      value_distribution: { median: 0, p95: 0, max: 0, max_to_p95_ratio: 0 },
      period_end_range: { min: '', max: '' },
      caveats: ['Filers whose fiscal Q4 closes in calendar Q3 are absent — AAPL Sep-end.'],
    };
    const blocks = fetchFramesTool.format!(output);
    expect(blocks[0].text).toContain('Caveat:');
    expect(blocks[0].text).toContain('AAPL Sep-end');
  });
});
