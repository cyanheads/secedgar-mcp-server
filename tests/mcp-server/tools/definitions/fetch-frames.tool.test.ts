/**
 * @fileoverview Tests for fetch-frames tool — cross-company XBRL frames retrieval.
 * @module tests/mcp-server/tools/definitions/fetch-frames.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFramesTool } from '@/mcp-server/tools/definitions/fetch-frames.tool.js';
import { resolveConceptTarget } from '@/services/edgar/concept-map.js';
import type { FramesResponse } from '@/services/edgar/types.js';

vi.mock('@/services/edgar/edgar-api-service.js', () => ({
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
}));

// Partial mock: only the canvas accessor is stubbed, and it returns undefined by
// default — the uninitialized-bridge state these tests already assume.
// `dataframeGuidance` and `toDatasetField` stay real, so the staged-dataframe
// pointer is asserted against the shipped wording.
vi.mock('@/services/canvas-bridge/canvas-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/canvas-bridge/canvas-bridge.js')>()),
  getCanvasBridge: vi.fn(),
}));

import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { at, blockText, wireError } from '../../../support/assertions.js';

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
    expect(at(result.data, 0).value).toBeGreaterThanOrEqual(at(result.data, 1).value);
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

  // Characterization: the catalog name reached the dei frames before `taxonomy` existed.
  it('queries shares_outstanding under its own dei namespace in the shares unit', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({
      concept: 'shares_outstanding',
      period: 'CY2024Q4I',
    });
    await fetchFramesTool.handler(input, ctx);

    expect(mockApi.tryGetFrames).toHaveBeenCalledWith(
      'dei',
      'EntityCommonStockSharesOutstanding',
      'shares',
      'CY2024Q4I',
    );
  });

  // Characterization: the no_data recovery text before the namespace note existed.
  it('keeps the period/unit guidance in the no_data recovery hint', async () => {
    mockApi.tryGetFrames.mockResolvedValue(null);
    const result = await runToolContract(fetchFramesTool, {
      concept: 'AccountsPayableCurrent',
      period: 'CY2023Q4I',
    });

    const error = wireError(result);
    expect(error.data).toMatchObject({
      reason: 'no_data',
      concept: 'AccountsPayableCurrent',
      period: 'CY2023Q4I',
      unit: 'USD',
    });
    const text = blockText(result.content);
    expect(text).toContain('Check duration vs. instant period');
    expect(text).toContain('period exists (data starts ~CY2009)');
  });

  it('sorts ascending when requested', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({
      concept: 'revenue',
      period: 'CY2023',
      sort: 'asc',
    });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(at(result.data, 0).value).toBeLessThanOrEqual(at(result.data, 1).value);
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

  // ---- #45: well-formed deprecated tag → no_data, not unknown_concept ----

  it('well-formed deprecated raw XBRL tag (404) surfaces no_data, not unknown_concept (#45)', async () => {
    mockApi.tryGetFrames.mockResolvedValue(null);
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({
      concept: 'SalesRevenueNet', // well-formed tag — deprecated in 2018 taxonomy
      period: 'CY2024',
      unit: 'USD',
    });

    await expect(fetchFramesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_data' },
    });
  });

  it('malformed concept (not a valid XBRL tag) still surfaces unknown_concept (#45)', async () => {
    mockApi.tryGetFrames.mockResolvedValue(null);
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({
      concept: 'foo bar concept!', // malformed — spaces and punctuation
      period: 'CY2024',
      unit: 'USD',
    });

    await expect(fetchFramesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'unknown_concept' },
    });
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
    // No table exists, so nothing may promise one (#104).
    expect(String(getEnrichment(ctx).notice ?? '')).not.toContain('secedgar_dataframe_describe');
  });

  describe('staged-dataframe pointer (#104)', () => {
    /** Stage a dataframe the way a successful registration does. */
    function stageDataframe(rowCount = 3) {
      const registerDataframe = vi.fn().mockResolvedValue({
        tableName: 'df_FRAME_ROWS1',
        rowCount,
        expiresAt: '2026-05-18T00:00:00.000Z',
        columnSchema: [],
      });
      vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as never);
      return registerDataframe;
    }

    it('names both dataframe tools when the whole ranking fit inline', async () => {
      stageDataframe();
      const ctx = createMockContext({ errors: fetchFramesTool.errors });
      // The fixture holds 3 reporters; a limit of 25 leaves nothing capped, but
      // the dataframe still carries the full frame.
      const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
      const result = await fetchFramesTool.handler(input, ctx);

      expect(result.dataset?.name).toBe('df_FRAME_ROWS1');
      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBeUndefined();
      const notice = String(enrichment.notice);
      expect(notice).toContain('df_FRAME_ROWS1');
      expect(notice).toContain('secedgar_dataframe_describe');
      expect(notice).toContain('secedgar_dataframe_query');
    });

    it('carries the pointer in the truncation guidance when the page caps the ranking', async () => {
      stageDataframe();
      const ctx = createMockContext({ errors: fetchFramesTool.errors });
      const input = fetchFramesTool.input.parse({
        concept: 'revenue',
        period: 'CY2023',
        limit: 1,
      });
      await fetchFramesTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(true);
      const notice = String(enrichment.notice);
      expect(notice).toContain('secedgar_dataframe_describe');
      expect(notice.match(/secedgar_dataframe_describe/g)).toHaveLength(1);
    });

    it('composes the pointer into the offset-past-the-end notice', async () => {
      stageDataframe();
      const ctx = createMockContext({ errors: fetchFramesTool.errors });
      const input = fetchFramesTool.input.parse({
        concept: 'revenue',
        period: 'CY2023',
        offset: 99,
      });
      await fetchFramesTool.handler(input, ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('Offset (99)');
      expect(notice).toContain('secedgar_dataframe_describe');
      expect(notice.match(/secedgar_dataframe_describe/g)).toHaveLength(1);
    });

    it('keeps the truncation and offset notices whole with no canvas to stage on', async () => {
      // The enrichment moved below registration; neither pre-existing notice may
      // become conditional on a table having been registered (#104).
      vi.mocked(getCanvasBridge).mockReturnValue(undefined);
      const capped = createMockContext({ errors: fetchFramesTool.errors });
      await fetchFramesTool.handler(
        fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023', limit: 1 }),
        capped,
      );
      const cappedEnrichment = getEnrichment(capped);
      expect(cappedEnrichment.truncated).toBe(true);
      expect(cappedEnrichment.shown).toBe(1);
      expect(cappedEnrichment.cap).toBe(1);
      expect(String(cappedEnrichment.notice)).not.toContain('secedgar_dataframe_describe');

      const pastEnd = createMockContext({ errors: fetchFramesTool.errors });
      await fetchFramesTool.handler(
        fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023', offset: 99 }),
        pastEnd,
      );
      const pastEndNotice = String(getEnrichment(pastEnd).notice);
      expect(pastEndNotice).toContain('Offset (99)');
      expect(pastEndNotice).toContain('Lower the offset to page back into the ranking.');
      expect(pastEndNotice).not.toContain('secedgar_dataframe_describe');
    });
  });

  it('surfaces unqueried tags for multi-tag friendly names', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.unqueried_tags).toEqual([
      'Revenues',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'SalesRevenueNet',
      'SalesRevenueGoodsNet',
    ]);
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

  it('surfaces related_tags for single-tag concepts with a known alternate (cash) (#36)', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'cash', period: 'CY2024Q4I' });
    const result = await fetchFramesTool.handler(input, ctx);

    // The queried tag stays tags[0] — related_tags is a hint, not a query target.
    expect(result.concept).toBe('CashAndCashEquivalentsAtCarryingValue');
    expect(result.unqueried_tags).toEqual([]);
    expect(result.related_tags.map((r) => r.tag)).toContain(
      'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
    );
    expect(result.related_tags[0]!.note).toBeTruthy();
  });

  it('returns empty related_tags for multi-tag concepts without alternates (revenue) (#36)', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.related_tags).toEqual([]);
  });

  it('returns empty related_tags for raw XBRL tags (#36)', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({
      concept: 'AccountsPayableCurrent',
      period: 'CY2023Q4I',
      unit: 'USD',
    });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.related_tags).toEqual([]);
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
      taxonomy: 'us-gaap',
      period: 'CY2023',
      unit: 'USD',
      label: 'Revenue',
      total_companies: 5000,
      offset: 0,
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
      related_tags: [],
      value_distribution: { median: 0, p95: 0, max: 0, max_to_p95_ratio: 0 },
      period_end_range: { min: '', max: '' },
      caveats: [],
    };
    const blocks = fetchFramesTool.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blockText(blocks)).toContain('Revenue');
    expect(blockText(blocks)).toContain('5000 companies');
    expect(blockText(blocks)).toContain('[XBRL: us-gaap:Revenues]');
    expect(blockText(blocks)).toContain('AMZN');
    expect(blockText(blocks)).toMatch(/\$574\.7[89]B/);
  });

  it('formats USD-per-shares values with dollar sign', () => {
    const output = {
      concept: 'EarningsPerShareDiluted',
      taxonomy: 'us-gaap',
      period: 'CY2023',
      unit: 'USD-per-shares',
      label: 'EPS (Diluted)',
      total_companies: 100,
      offset: 0,
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
      related_tags: [],
      value_distribution: { median: 0, p95: 0, max: 0, max_to_p95_ratio: 0 },
      period_end_range: { min: '', max: '' },
      caveats: [],
    };
    const blocks = fetchFramesTool.format!(output);
    expect(blockText(blocks)).toContain('$15.42');
  });

  it('renders dataset hint when present', () => {
    const output = {
      concept: 'Revenues',
      taxonomy: 'us-gaap',
      period: 'CY2023',
      unit: 'USD',
      label: 'Revenue',
      total_companies: 5000,
      offset: 0,
      data: [],
      dataset: {
        name: 'df_ABCDE_FGHIJ',
        row_count: 5000,
        expires_at: '2026-05-18T00:00:00.000Z',
      },
      unqueried_tags: [],
      related_tags: [],
      value_distribution: { median: 0, p95: 0, max: 0, max_to_p95_ratio: 0 },
      period_end_range: { min: '', max: '' },
      caveats: [],
    };
    const blocks = fetchFramesTool.format!(output);
    expect(blockText(blocks)).toContain('df_ABCDE_FGHIJ');
    expect(blockText(blocks)).toContain('5000 rows');
    expect(blockText(blocks)).toContain('secedgar_dataframe_query');
  });

  it('renders coverage, value dispersion, and period range in format text', () => {
    const output = {
      concept: 'Revenues',
      taxonomy: 'us-gaap',
      period: 'CY2023',
      unit: 'USD',
      label: 'Revenue',
      total_companies: 3131,
      offset: 0,
      data: [],
      unqueried_tags: ['Revenues', 'SalesRevenueNet'],
      related_tags: [],
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
    expect(blockText(blocks)).toContain('Coverage: 1 of 3 XBRL tags queried');
    expect(blockText(blocks)).toContain('Revenues, SalesRevenueNet');
    expect(blockText(blocks)).toContain('max/p95 15×');
    expect(blockText(blocks)).toContain('2023-01-31 → 2024-12-31');
  });

  it('renders related_tags hint in format text (#36)', () => {
    const output = {
      concept: 'CashAndCashEquivalentsAtCarryingValue',
      taxonomy: 'us-gaap',
      period: 'CY2024Q4I',
      unit: 'USD',
      label: 'Cash and Cash Equivalents',
      total_companies: 4118,
      offset: 0,
      data: [],
      unqueried_tags: [],
      related_tags: [
        {
          tag: 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
          note: 'Total including restricted cash.',
        },
      ],
      value_distribution: { median: 0, p95: 0, max: 0, max_to_p95_ratio: 0 },
      period_end_range: { min: '', max: '' },
      caveats: [],
    };
    const blocks = fetchFramesTool.format!(output);
    expect(blockText(blocks)).toContain('Related tags');
    expect(blockText(blocks)).toContain(
      'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
    );
  });

  it('emits fiscal-Q4 caveat for duration CY*Q[1-4] periods', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2024Q3' });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.caveats).toHaveLength(1);
    expect(result.caveats[0]).toMatch(/fiscal Q4 spans calendar Q3/);
    expect(result.caveats[0]).toContain('AAPL Sep-end');
  });

  // Examples key off the calendar quarter a filer's fiscal Q4 SPANS, not the one
  // its fiscal year ends in — a January year-end closes a Nov-Jan fiscal Q4, which
  // SEC frames as calendar Q4, so Jan-end retailers belong under Q4 not Q1.
  it.each([
    ['CY2024Q1', 'calendar Q1', 'SJM Apr-end'],
    ['CY2024Q2', 'calendar Q2', 'MSFT Jun-end'],
    ['CY2024Q3', 'calendar Q3', 'AAPL Sep-end'],
    ['CY2024Q4', 'calendar Q4', 'WMT/TGT Jan-end'],
  ])(
    'caveat for %s names the right calendar quarter and examples',
    async (period, label, example) => {
      const ctx = createMockContext({ errors: fetchFramesTool.errors });
      const input = fetchFramesTool.input.parse({ concept: 'revenue', period });
      const result = await fetchFramesTool.handler(input, ctx);

      expect(result.caveats[0]).toContain(label);
      expect(result.caveats[0]).toContain(example);
    },
  );

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

  // ---- #123: proxy-held annual NetIncomeLoss frames ----

  describe('proxy-statement caveat on annual NetIncomeLoss (#123)', () => {
    const netIncomeFrame: FramesResponse = {
      ...mockFramesResponse,
      ccp: 'CY2024',
      label: 'Net Income (Loss) Attributable to Parent',
      tag: 'NetIncomeLoss',
    };

    it.each([
      ['net_income', 'CY2024'],
      ['NetIncomeLoss', 'CY2025'],
    ])('flags live %s %s frames as possibly proxy-held', async (concept, period) => {
      mockApi.tryGetFrames.mockResolvedValue(netIncomeFrame);
      const result = await runToolContract(fetchFramesTool, { concept, period });

      expect(result.isError).toBeFalsy();
      const output = fetchFramesTool.output.parse(result.structuredContent);
      const proxy = output.caveats.filter((c) => c.includes('DEF 14A'));
      expect(proxy).toHaveLength(1);
      expect(proxy[0]).toContain('pay-versus-performance');
      expect(proxy[0]).toContain('secedgar_get_financials');
      expect(blockText(result.content)).toContain('Caveat: ');
      expect(blockText(result.content)).toContain('pay-versus-performance');
    });

    it('stays silent on quarterly NetIncomeLoss frames, which no proxy holds', async () => {
      mockApi.tryGetFrames.mockResolvedValue({ ...netIncomeFrame, ccp: 'CY2024Q3' });
      const ctx = createMockContext({ errors: fetchFramesTool.errors });
      const result = await fetchFramesTool.handler(
        fetchFramesTool.input.parse({ concept: 'net_income', period: 'CY2024Q3' }),
        ctx,
      );
      expect(result.caveats.some((c) => c.includes('DEF 14A'))).toBe(false);
    });

    it('stays silent on annual frames of other tags', async () => {
      const ctx = createMockContext({ errors: fetchFramesTool.errors });
      const result = await fetchFramesTool.handler(
        fetchFramesTool.input.parse({ concept: 'eps_diluted', period: 'CY2024' }),
        ctx,
      );
      expect(result.caveats.some((c) => c.includes('DEF 14A'))).toBe(false);
    });

    it('stays silent when the local mirror assembled the frame, which already resolves proxy rows', async () => {
      mockApi.tryGetFrames.mockResolvedValue({ ...netIncomeFrame, holderFormsResolved: true });
      const ctx = createMockContext({ errors: fetchFramesTool.errors });
      const result = await fetchFramesTool.handler(
        fetchFramesTool.input.parse({ concept: 'net_income', period: 'CY2024' }),
        ctx,
      );
      expect(result.caveats.some((c) => c.includes('DEF 14A'))).toBe(false);
    });

    it('keeps the caveat on an empty page past the end of the ranking', async () => {
      mockApi.tryGetFrames.mockResolvedValue(netIncomeFrame);
      const ctx = createMockContext({ errors: fetchFramesTool.errors });
      const result = await fetchFramesTool.handler(
        fetchFramesTool.input.parse({ concept: 'net_income', period: 'CY2024', offset: 50 }),
        ctx,
      );
      expect(result.data).toEqual([]);
      expect(result.caveats.some((c) => c.includes('DEF 14A'))).toBe(true);
    });
  });

  // ---- #142: live annual frames for a year that has not closed ----

  describe('open-year caveat on live annual frames (#142)', () => {
    const ttmCaveat = (caveats: string[]) =>
      caveats.filter((c) => c.includes('trailing-twelve-month'));
    const runAt = async (now: string, period: string, extra: Partial<FramesResponse> = {}) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(now));
      try {
        mockApi.tryGetFrames.mockResolvedValue({ ...mockFramesResponse, ccp: period, ...extra });
        return await runToolContract(fetchFramesTool, { concept: 'revenue', period });
      } finally {
        vi.useRealTimers();
      }
    };

    it('flags an annual frame for the current calendar year, on both surfaces', async () => {
      const result = await runAt('2026-09-25T00:00:00Z', 'CY2026');
      const output = fetchFramesTool.output.parse(result.structuredContent);
      expect(ttmCaveat(output.caveats)).toHaveLength(1);
      expect(ttmCaveat(output.caveats)[0]).toContain('CY2026');
      expect(ttmCaveat(output.caveats)[0]).toContain('secedgar_get_financials');
      expect(blockText(result.content)).toContain('trailing-twelve-month');
    });

    it('still flags last year while its 10-Ks are due', async () => {
      const result = await runAt('2026-03-15T00:00:00Z', 'CY2025');
      expect(
        ttmCaveat(fetchFramesTool.output.parse(result.structuredContent).caveats),
      ).toHaveLength(1);
    });

    it('stays silent once the year and its filing window have closed', async () => {
      const result = await runAt('2026-09-25T00:00:00Z', 'CY2025');
      expect(ttmCaveat(fetchFramesTool.output.parse(result.structuredContent).caveats)).toEqual([]);
    });

    it('stays silent on quarterly and instant frames of the open year', async () => {
      for (const period of ['CY2026Q2', 'CY2026Q2I']) {
        const result = await runAt('2026-09-25T00:00:00Z', period);
        expect(ttmCaveat(fetchFramesTool.output.parse(result.structuredContent).caveats)).toEqual(
          [],
        );
      }
    });

    it('stays silent when the mirror assembled the frame, which drops those rows itself', async () => {
      const result = await runAt('2026-09-25T00:00:00Z', 'CY2026', { holderFormsResolved: true });
      expect(ttmCaveat(fetchFramesTool.output.parse(result.structuredContent).caveats)).toEqual([]);
    });
  });

  // ---- #125 / #130: catalog additions as fetch_frames sees them ----

  it('lists the capex and interest_expense successors in unqueried_tags (#125)', async () => {
    const run = async (concept: string) => {
      const ctx = createMockContext({ errors: fetchFramesTool.errors });
      return fetchFramesTool.handler(
        fetchFramesTool.input.parse({ concept, period: 'CY2025' }),
        ctx,
      );
    };
    const capex = await run('capex');
    expect(capex.concept).toBe('PaymentsToAcquirePropertyPlantAndEquipment');
    expect(capex.unqueried_tags).toEqual(['PaymentsToAcquireProductiveAssets']);
    const interest = await run('interest_expense');
    expect(interest.concept).toBe('InterestExpense');
    expect(interest.unqueried_tags).toEqual(['InterestExpenseDebt', 'InterestExpenseNonoperating']);
  });

  it('queries shares_diluted in the shares unit (#130)', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    await fetchFramesTool.handler(
      fetchFramesTool.input.parse({ concept: 'shares_diluted', period: 'CY2025' }),
      ctx,
    );
    expect(mockApi.tryGetFrames).toHaveBeenCalledWith(
      'us-gaap',
      'WeightedAverageNumberOfDilutedSharesOutstanding',
      'shares',
      'CY2025',
    );
  });

  it('flags the finance-lease-inclusive PP&E tag in related_tags for ppe_net (#130)', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const result = await fetchFramesTool.handler(
      fetchFramesTool.input.parse({ concept: 'ppe_net', period: 'CY2025Q4I' }),
      ctx,
    );
    expect(result.concept).toBe('PropertyPlantAndEquipmentNet');
    expect(result.unqueried_tags).toEqual([]);
    expect(result.related_tags.map((r) => r.tag)).toEqual([
      'PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization',
    ]);
  });

  // ---- #49: artifact caveat for high max/p95 ratio ----

  it('appends artifact caveat when max/p95 ratio > 50 for per-share unit (#49)', async () => {
    mockApi.tryGetFrames.mockResolvedValueOnce({
      ccp: 'CY2024',
      label: 'Earnings Per Share (Basic)',
      tag: 'EarningsPerShareBasic',
      taxonomy: 'us-gaap',
      uom: 'USD-per-shares',
      pts: 100,
      // 99 normal per-share values (5–9) plus one split/denominator artifact far
      // above p95, so max/p95 lands well over the 50× per-share threshold.
      data: [
        ...Array.from({ length: 99 }, (_, i) => ({
          accn: `A${i}`,
          cik: i + 1,
          end: '2024-12-31',
          entityName: `Normal Co ${i}`,
          val: 5 + (i % 5),
        })),
        { accn: 'OUT', cik: 999, end: '2024-12-31', entityName: 'Artifact Inc', val: 5000 },
      ],
    });
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({
      concept: 'eps_basic',
      period: 'CY2024',
      unit: 'USD-per-shares',
    });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.value_distribution.max_to_p95_ratio).toBeGreaterThan(50);
    expect(result.caveats.some((c) => c.includes('split/denominator artifacts'))).toBe(true);
  });

  it('does not append artifact caveat for normal dispersion (#49)', async () => {
    // mockFramesResponse has max/p95 ratio of 1 (all large values close together)
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.value_distribution.max_to_p95_ratio).toBeLessThanOrEqual(50);
    expect(result.caveats.every((c) => !c.includes('split/denominator artifacts'))).toBe(true);
  });

  it('surfaces caveats in format text', () => {
    const output = {
      concept: 'Revenues',
      taxonomy: 'us-gaap',
      period: 'CY2024Q3',
      unit: 'USD',
      label: 'Revenue',
      total_companies: 3000,
      offset: 0,
      data: [],
      unqueried_tags: [],
      related_tags: [],
      value_distribution: { median: 0, p95: 0, max: 0, max_to_p95_ratio: 0 },
      period_end_range: { min: '', max: '' },
      caveats: ['Filers whose fiscal Q4 spans calendar Q3 are absent — AAPL Sep-end.'],
    };
    const blocks = fetchFramesTool.format!(output);
    expect(blockText(blocks)).toContain('Caveat:');
    expect(blockText(blocks)).toContain('AAPL Sep-end');
  });
});

// --- Offset pagination fallback when no canvas is available (#89) ---

/** A frame of `n` reporters with strictly descending values, so ranking is deterministic. */
function framesWith(n: number): FramesResponse {
  return {
    ...mockFramesResponse,
    pts: n,
    data: Array.from({ length: n }, (_, i) => ({
      accn: `000000000${i}-24-000001`,
      cik: 1000 + i,
      end: '2023-12-31',
      entityName: `Reporter ${i}`,
      loc: 'CA',
      val: (n - i) * 1_000_000,
    })),
  };
}

/** Identity of one returned row — cik + value, independent of page position. */
const rowIds = (result: { data: Array<{ cik: string; value: number }> }) =>
  result.data.map((d) => `${d.cik}:${d.value}`);

describe('fetchFramesTool offset pagination (#89)', () => {
  beforeEach(() => {
    mockApi.tryGetFrames.mockResolvedValue(framesWith(12));
    mockApi.cikToTicker.mockResolvedValue(undefined);
  });

  it('pages contiguously — two half pages reconstruct the double page exactly', async () => {
    const run = async (offset: number, limit: number) => {
      const ctx = createMockContext({ errors: fetchFramesTool.errors });
      const input = fetchFramesTool.input.parse({
        concept: 'revenue',
        period: 'CY2023',
        limit,
        offset,
      });
      return await fetchFramesTool.handler(input, ctx);
    };

    const first = await run(0, 5);
    const second = await run(5, 5);
    const combined = await run(0, 10);

    expect([...rowIds(first), ...rowIds(second)]).toEqual(rowIds(combined));
    expect(first.offset).toBe(0);
    expect(first.next_offset).toBe(5);
    expect(second.offset).toBe(5);
    expect(second.next_offset).toBe(10);
  });

  it('continues the global ranking across pages', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({
      concept: 'revenue',
      period: 'CY2023',
      limit: 5,
      offset: 5,
    });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.data.map((d) => d.rank)).toEqual([6, 7, 8, 9, 10]);
  });

  it('omits next_offset on the last page', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({
      concept: 'revenue',
      period: 'CY2023',
      limit: 5,
      offset: 10,
    });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.data).toHaveLength(2);
    expect(result.next_offset).toBeUndefined();
  });

  it('explains an offset past the end instead of returning a bare empty page', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({
      concept: 'revenue',
      period: 'CY2023',
      limit: 5,
      offset: 50,
    });
    const result = await fetchFramesTool.handler(input, ctx);

    expect(result.data).toHaveLength(0);
    expect(result.next_offset).toBeUndefined();
    expect(getEnrichment(ctx).notice).toContain('50');
  });

  it('renders both paging controls in format() so content[] matches structuredContent', async () => {
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    const input = fetchFramesTool.input.parse({
      concept: 'revenue',
      period: 'CY2023',
      limit: 5,
      offset: 5,
    });
    const result = await fetchFramesTool.handler(input, ctx);
    const text = blockText(fetchFramesTool.format!(result));

    expect(text).toContain('Page offset: 5');
    expect(text).toContain('Next offset: 10');
  });
});

// Through the real tool pipeline, so both client surfaces are asserted (#143).
describe('taxonomy selects the frames namespace (#143)', () => {
  const deiFrame: FramesResponse = {
    ccp: 'CY2024Q4I',
    label: 'Entity Common Stock, Shares Outstanding',
    tag: 'EntityCommonStockSharesOutstanding',
    taxonomy: 'dei',
    uom: 'shares',
    pts: 2,
    data: [
      {
        accn: '0000789019-25-000010',
        cik: 789019,
        end: '2025-01-21',
        entityName: 'MICROSOFT CORPORATION',
        loc: 'US-WA',
        val: 7_434_880_776,
      },
      {
        accn: '0000320193-25-000008',
        cik: 320193,
        end: '2025-01-17',
        entityName: 'Apple Inc.',
        loc: 'US-CA',
        val: 15_037_874_000,
      },
    ],
  };

  /** SEC serves the cover-page tag only under dei, and a financial tag only under us-gaap. */
  beforeEach(() => {
    mockApi.tryGetFrames.mockImplementation(async (taxonomy: string, tag: string) => {
      const isDeiTag = tag.startsWith('Entity');
      if (taxonomy === 'dei') return isDeiTag ? deiFrame : null;
      return isDeiTag ? null : mockFramesResponse;
    });
  });

  it('defaults to us-gaap', () => {
    const input = fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    expect(input.taxonomy).toBe('us-gaap');
  });

  it.each(['ifrs-full', 'srt', 'invest'])(
    'rejects %s, a namespace SEC publishes no frames for',
    (taxonomy) => {
      const parsed = fetchFramesTool.input.safeParse({
        concept: 'Revenue',
        period: 'CY2023',
        taxonomy,
      });
      // Rejected as a value outside the enum, not as a key the schema lacks.
      expect(parsed.error?.issues).toEqual([
        expect.objectContaining({ code: 'invalid_value', path: ['taxonomy'] }),
      ]);
    },
  );

  it('answers a raw dei tag from the dei frames on both surfaces', async () => {
    const result = await runToolContract(fetchFramesTool, {
      concept: 'EntityCommonStockSharesOutstanding',
      period: 'CY2024Q4I',
      unit: 'shares',
      taxonomy: 'dei',
    });

    expect(result.isError).toBeFalsy();
    expect(mockApi.tryGetFrames).toHaveBeenCalledWith(
      'dei',
      'EntityCommonStockSharesOutstanding',
      'shares',
      'CY2024Q4I',
    );
    const output = fetchFramesTool.output.parse(result.structuredContent);
    expect(output).toMatchObject({
      concept: 'EntityCommonStockSharesOutstanding',
      taxonomy: 'dei',
      unit: 'shares',
      total_companies: 2,
      unqueried_tags: [],
      related_tags: [],
    });
    expect(output.data.map((d) => [d.rank, d.company_name, d.value])).toEqual([
      [1, 'Apple Inc.', 15_037_874_000],
      [2, 'MICROSOFT CORPORATION', 7_434_880_776],
    ]);
    const text = blockText(result.content);
    expect(text).toContain('[XBRL: dei:EntityCommonStockSharesOutstanding]');
    expect(text).toContain('1. Apple Inc. (AAPL)');
  });

  it('stages the dei frame with its namespace in the dataframe provenance', async () => {
    const registerDataframe = vi.fn().mockResolvedValue({
      tableName: 'df_DEI_FRAME1',
      rowCount: 2,
      expiresAt: '2026-05-18T00:00:00.000Z',
      columnSchema: [],
    });
    vi.mocked(getCanvasBridge).mockReturnValueOnce({ registerDataframe } as never);
    await runToolContract(fetchFramesTool, {
      concept: 'EntityCommonStockSharesOutstanding',
      period: 'CY2024Q4I',
      unit: 'shares',
      taxonomy: 'dei',
    });

    const [, registration] = at(registerDataframe.mock.calls);
    expect(registration.queryParams).toMatchObject({
      concept: 'EntityCommonStockSharesOutstanding',
      taxonomy: 'dei',
    });
    expect(registration.rows).toHaveLength(2);
  });

  it('still reads a raw tag from us-gaap by default, and says where to find a dei one', async () => {
    const result = await runToolContract(fetchFramesTool, {
      concept: 'EntityCommonStockSharesOutstanding',
      period: 'CY2024Q4I',
      unit: 'shares',
    });

    const error = wireError(result);
    expect(error.data).toMatchObject({ reason: 'no_data', taxonomy: 'us-gaap' });
    expect(mockApi.tryGetFrames).toHaveBeenCalledWith(
      'us-gaap',
      'EntityCommonStockSharesOutstanding',
      'shares',
      'CY2024Q4I',
    );
    const text = blockText(result.content);
    expect(text).toContain('us-gaap');
    expect(text).toContain('taxonomy: dei');
  });

  it('points a financial raw tag sent to dei back at us-gaap', async () => {
    const result = await runToolContract(fetchFramesTool, {
      concept: 'AccountsPayableCurrent',
      period: 'CY2023Q4I',
      taxonomy: 'dei',
    });

    expect(wireError(result).data).toMatchObject({ reason: 'no_data', taxonomy: 'dei' });
    expect(blockText(result.content)).toContain('taxonomy: us-gaap');
  });

  // The rule secedgar_get_financials applies through resolveConceptTarget: a
  // catalog name keeps its own taxonomy under the us-gaap default, and an
  // explicit dei reads its tags from dei.
  it.each([
    ['shares_outstanding', 'us-gaap', 'dei', 'EntityCommonStockSharesOutstanding', 'shares'],
    ['shares_outstanding', 'dei', 'dei', 'EntityCommonStockSharesOutstanding', 'shares'],
    ['revenue', 'us-gaap', 'us-gaap', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'USD'],
    ['revenue', 'dei', 'dei', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'USD'],
  ] as const)(
    'reads catalog name %s under taxonomy %s from %s:%s, as secedgar_get_financials resolves it',
    async (concept, taxonomy, expectedTaxonomy, tag, unit) => {
      await runToolContract(fetchFramesTool, { concept, period: 'CY2024Q4I', taxonomy });

      expect(resolveConceptTarget(concept, taxonomy).taxonomy).toBe(expectedTaxonomy);
      expect(mockApi.tryGetFrames).toHaveBeenCalledWith(expectedTaxonomy, tag, unit, 'CY2024Q4I');
    },
  );

  it('echoes the mapped namespace for shares_outstanding on both surfaces', async () => {
    const result = await runToolContract(fetchFramesTool, {
      concept: 'shares_outstanding',
      period: 'CY2024Q4I',
    });

    expect(fetchFramesTool.output.parse(result.structuredContent).taxonomy).toBe('dei');
    expect(blockText(result.content)).toContain('[XBRL: dei:EntityCommonStockSharesOutstanding]');
  });

  it('tells a catalog name sent to the other namespace where its tags live', async () => {
    const result = await runToolContract(fetchFramesTool, {
      concept: 'revenue',
      period: 'CY2023',
      taxonomy: 'dei',
    });

    expect(wireError(result).data).toMatchObject({ reason: 'no_data', taxonomy: 'dei' });
    const text = blockText(result.content);
    expect(text).toContain("'revenue' maps to us-gaap tags");
    expect(text).toContain('omit taxonomy');
  });
});

// Through the real tool pipeline, so both client surfaces are asserted (#128).
describe('concept names that are neither a friendly name nor an XBRL tag (#128)', () => {
  // SEC matches frame tags case-sensitively and answers an unreported one with a 404.
  beforeEach(() => {
    mockApi.tryGetFrames.mockImplementation(async (_tax: string, tag: string) =>
      /^[A-Z][A-Za-z0-9]*$/.test(tag) ? mockFramesResponse : null,
    );
  });

  const edgarCalls = () =>
    mockApi.tryGetFrames.mock.calls.length + mockApi.cikToTicker.mock.calls.length;

  it.each([
    ['free_cash_flow', 'operating_cash_flow − capex'],
    ['ebitda', 'operating_income + depreciation_amortization'],
    ['total_debt', 'debt'],
    ['capital_expenditures', 'capex'],
  ])('fails %s as unknown_concept before the frames request', async (concept, needle) => {
    const result = await runToolContract(fetchFramesTool, { concept, period: 'CY2024' });

    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({ reason: 'unknown_concept', concept });
    const text = blockText(result.content);
    expect(text).toContain(needle);
    expect(text).toContain('secedgar_search_concepts');
    expect(text).toContain('reason unknown_concept');
    expect(edgarCalls()).toBe(0);
  });

  it.each(['../submissions/CIK0000320193', 'netincomeloss', 'fcf', '  '])(
    'fails %j as unknown_concept without building a frames URL',
    async (concept) => {
      const result = await runToolContract(fetchFramesTool, { concept, period: 'CY2024' });

      expect(wireError(result).data.reason).toBe('unknown_concept');
      expect(edgarCalls()).toBe(0);
    },
  );

  it('trims surrounding whitespace, so " revenue" queries the revenue tag', async () => {
    const result = await runToolContract(fetchFramesTool, {
      concept: ' revenue',
      period: 'CY2023',
    });

    expect(result.isError).toBeFalsy();
    expect(mockApi.tryGetFrames).toHaveBeenCalledWith(
      'us-gaap',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'USD',
      'CY2023',
    );
  });

  // Characterization: these shapes reached SEC before the check existed.
  it.each([
    ['Net Income', 'NetIncomeLoss'],
    ['NET_INCOME', 'NetIncomeLoss'],
    ['NetIncomeLoss', 'NetIncomeLoss'],
    ['Revenues', 'Revenues'],
    ['EntityCommonStockSharesOutstanding', 'EntityCommonStockSharesOutstanding'],
  ])('still queries %s as %s', async (concept, tag) => {
    await runToolContract(fetchFramesTool, { concept, period: 'CY2023' });

    expect(mockApi.tryGetFrames).toHaveBeenCalledWith(
      expect.any(String),
      tag,
      expect.any(String),
      'CY2023',
    );
  });

  it('keeps a well-formed tag that 404s as no_data (#45)', async () => {
    mockApi.tryGetFrames.mockResolvedValue(null);
    const result = await runToolContract(fetchFramesTool, {
      concept: 'SalesRevenueNet',
      period: 'CY2024',
    });

    expect(wireError(result).data.reason).toBe('no_data');
    expect(mockApi.tryGetFrames).toHaveBeenCalledTimes(1);
  });
});

describe('business location', () => {
  /** SEC writes `loc` as `<country>-<state>`, and a bare "-" when it has neither. */
  const withLocations = (locs: string[]): FramesResponse => ({
    ...mockFramesResponse,
    data: mockFramesResponse.data.map((entry, i) => ({ ...entry, loc: locs[i] ?? '' })),
  });

  it('treats SEC’s bare "-" and an empty loc as no location, on both surfaces', async () => {
    mockApi.tryGetFrames.mockResolvedValue(withLocations(['US-CA', '-', '']));
    const result = await runToolContract(fetchFramesTool, { concept: 'revenue', period: 'CY2023' });

    const output = fetchFramesTool.output.parse(result.structuredContent);
    expect(output.data.map((d) => [d.company_name, d.location])).toEqual([
      ['AMAZON COM INC', undefined],
      ['Apple Inc.', 'US-CA'],
      ['Alphabet Inc.', undefined],
    ]);
    const text = blockText(result.content);
    expect(text).toContain('| period end 2023-09-30 | US-CA [0000320193-23-000106]');
    expect(text).toContain('| period end 2023-12-31 [0001018724-24-000007]');
    expect(text).toContain('| period end 2023-12-31 [0001652044-24-000022]');
    expect(text).not.toContain('| -');
  });

  it('stages no location for those rows in the dataframe either', async () => {
    mockApi.tryGetFrames.mockResolvedValue(withLocations(['US-CA', '-', '']));
    const registerDataframe = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getCanvasBridge).mockReturnValueOnce({ registerDataframe } as never);
    const ctx = createMockContext({ errors: fetchFramesTool.errors });
    await fetchFramesTool.handler(
      fetchFramesTool.input.parse({ concept: 'revenue', period: 'CY2023' }),
      ctx,
    );

    const { rows } = at(registerDataframe.mock.calls, 0)[1];
    expect(rows.map((r: { location: string | null }) => r.location)).toEqual(['US-CA', null, null]);
  });
});
