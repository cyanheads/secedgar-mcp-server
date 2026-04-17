/**
 * @fileoverview Tests for get-financials tool — XBRL financial data retrieval.
 * @module tests/mcp-server/tools/definitions/get-financials.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFinancialsTool } from '@/mcp-server/tools/definitions/get-financials.tool.js';
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
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as any);
  mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
  mockApi.tryGetCompanyConcept.mockResolvedValue(mockConceptResponse);
});

describe('getFinancialsTool', () => {
  it('returns financial data for a valid company and concept', async () => {
    const ctx = createMockContext();
    const input = getFinancialsTool.input.parse({ company: 'AAPL', concept: 'revenue' });
    const result = await getFinancialsTool.handler(input, ctx);

    expect(result.company).toBe('Apple Inc.');
    expect(result.cik).toBe('0000320193');
    expect(result.unit).toBe('USD');
    expect(result.data.length).toBeGreaterThan(0);
  });

  it('resolves friendly concept names to XBRL tags', async () => {
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    const input = getFinancialsTool.input.parse({ company: 'AAPL', concept: 'revenue' });
    const result = await getFinancialsTool.handler(input, ctx);

    for (const d of result.data) {
      expect(d.fiscal_period).toBe('FY');
    }
  });

  it('filters to quarterly data', async () => {
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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

  it('throws notFound when company not found', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = getFinancialsTool.input.parse({ company: 'XYZNOTREAL', concept: 'revenue' });

    await expect(getFinancialsTool.handler(input, ctx)).rejects.toThrow(/not found/);
  });

  it('throws notFound when no XBRL data exists', async () => {
    mockApi.tryGetCompanyConcept.mockResolvedValue(null);
    const ctx = createMockContext();
    const input = getFinancialsTool.input.parse({ company: 'AAPL', concept: 'revenue' });

    await expect(getFinancialsTool.handler(input, ctx)).rejects.toThrow(/No XBRL data/);
  });

  it('tries multiple tags for friendly names and merges results', async () => {
    // First tag 404s (returned as null), second succeeds
    mockApi.tryGetCompanyConcept
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mockConceptResponse);

    const ctx = createMockContext();
    const input = getFinancialsTool.input.parse({ company: 'AAPL', concept: 'revenue' });
    const result = await getFinancialsTool.handler(input, ctx);

    expect(result.tags_tried).toBeDefined();
    expect(result.tags_tried!.length).toBeGreaterThan(1);
    expect(result.data.length).toBeGreaterThan(0);
  });

  it('re-throws non-404 errors', async () => {
    mockApi.tryGetCompanyConcept.mockRejectedValue(new Error('500 Internal Server Error'));
    const ctx = createMockContext();
    const input = getFinancialsTool.input.parse({ company: 'AAPL', concept: 'revenue' });

    await expect(getFinancialsTool.handler(input, ctx)).rejects.toThrow(/500/);
  });

  it('omits tags_tried when only one tag was needed', async () => {
    // Raw XBRL tag → single tag tried
    const ctx = createMockContext();
    const input = getFinancialsTool.input.parse({
      company: 'AAPL',
      concept: 'AccountsPayableCurrent',
    });
    const result = await getFinancialsTool.handler(input, ctx);

    expect(result.tags_tried).toBeUndefined();
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
