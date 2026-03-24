/**
 * @fileoverview Tests for compare-metric tool — cross-company financial metric comparison.
 * @module tests/mcp-server/tools/definitions/compare-metric.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compareMetricTool } from '@/mcp-server/tools/definitions/compare-metric.tool.js';
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
  getFrames: vi.fn(),
  cikToTicker: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as any);
  mockApi.getFrames.mockResolvedValue(mockFramesResponse);
  mockApi.cikToTicker.mockImplementation(async (cik: string) => {
    const map: Record<string, string> = {
      '0000320193': 'AAPL',
      '0001018724': 'AMZN',
      '0001652044': 'GOOGL',
    };
    return map[cik];
  });
});

describe('compareMetricTool', () => {
  it('returns ranked companies for a metric', async () => {
    const ctx = createMockContext();
    const input = compareMetricTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await compareMetricTool.handler(input, ctx);

    expect(result.total_companies).toBe(5000);
    expect(result.data.length).toBe(3);
    // Default sort is desc
    expect(result.data[0].value).toBeGreaterThanOrEqual(result.data[1].value);
  });

  it('resolves friendly concept names', async () => {
    const ctx = createMockContext();
    const input = compareMetricTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    await compareMetricTool.handler(input, ctx);

    expect(mockApi.getFrames).toHaveBeenCalledWith(
      'us-gaap',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'USD',
      'CY2023',
    );
  });

  it('passes raw XBRL tags directly', async () => {
    const ctx = createMockContext();
    const input = compareMetricTool.input.parse({
      concept: 'AccountsPayableCurrent',
      period: 'CY2023Q4I',
      unit: 'USD',
    });
    await compareMetricTool.handler(input, ctx);

    expect(mockApi.getFrames).toHaveBeenCalledWith(
      'us-gaap',
      'AccountsPayableCurrent',
      'USD',
      'CY2023Q4I',
    );
  });

  it('sorts ascending when requested', async () => {
    const ctx = createMockContext();
    const input = compareMetricTool.input.parse({
      concept: 'revenue',
      period: 'CY2023',
      sort: 'asc',
    });
    const result = await compareMetricTool.handler(input, ctx);

    expect(result.data[0].value).toBeLessThanOrEqual(result.data[1].value);
  });

  it('applies limit', async () => {
    const ctx = createMockContext();
    const input = compareMetricTool.input.parse({
      concept: 'revenue',
      period: 'CY2023',
      limit: 2,
    });
    const result = await compareMetricTool.handler(input, ctx);

    expect(result.data).toHaveLength(2);
  });

  it('enriches results with ticker symbols', async () => {
    const ctx = createMockContext();
    const input = compareMetricTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await compareMetricTool.handler(input, ctx);

    const tickers = result.data.map((d) => d.ticker).filter(Boolean);
    expect(tickers).toContain('AAPL');
    expect(tickers).toContain('AMZN');
  });

  it('assigns correct rank numbers', async () => {
    const ctx = createMockContext();
    const input = compareMetricTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await compareMetricTool.handler(input, ctx);

    expect(result.data.map((d) => d.rank)).toEqual([1, 2, 3]);
  });

  it('zero-pads CIK to 10 digits', async () => {
    const ctx = createMockContext();
    const input = compareMetricTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await compareMetricTool.handler(input, ctx);

    for (const entry of result.data) {
      expect(entry.cik).toHaveLength(10);
      expect(entry.cik).toMatch(/^\d{10}$/);
    }
  });

  it('throws notFound on 404 from frames API', async () => {
    mockApi.getFrames.mockRejectedValue(new Error('404 Not Found'));
    const ctx = createMockContext();
    const input = compareMetricTool.input.parse({ concept: 'revenue', period: 'CY2023' });

    await expect(compareMetricTool.handler(input, ctx)).rejects.toThrow(/No data for/);
  });

  it('re-throws non-404 errors', async () => {
    mockApi.getFrames.mockRejectedValue(new Error('500 Internal Server Error'));
    const ctx = createMockContext();
    const input = compareMetricTool.input.parse({ concept: 'revenue', period: 'CY2023' });

    await expect(compareMetricTool.handler(input, ctx)).rejects.toThrow(/500/);
  });

  it('handles ticker lookup returning undefined', async () => {
    mockApi.cikToTicker.mockResolvedValue(undefined);
    const ctx = createMockContext();
    const input = compareMetricTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    const result = await compareMetricTool.handler(input, ctx);

    for (const entry of result.data) {
      expect(entry.ticker).toBeUndefined();
    }
  });

  it('uses default values for optional inputs', () => {
    const input = compareMetricTool.input.parse({ concept: 'revenue', period: 'CY2023' });
    expect(input.unit).toBe('USD');
    expect(input.limit).toBe(25);
    expect(input.sort).toBe('desc');
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
    };
    const blocks = compareMetricTool.format!(output);
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
    };
    const blocks = compareMetricTool.format!(output);
    expect(blocks[0].text).toContain('$15.42');
  });
});
