/**
 * @fileoverview Tests for get-snapshot — one-call company financial profile
 * resolved from a single companyfacts payload (#84).
 * @module tests/mcp-server/tools/definitions/get-snapshot.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSnapshotTool } from '@/mcp-server/tools/definitions/get-snapshot.tool.js';
import type { CompanyConceptUnit, CompanyFactsResponse } from '@/services/edgar/types.js';

vi.mock('@/services/edgar/edgar-api-service.js', () => ({
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
}));

import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';

function fact(overrides: Partial<CompanyConceptUnit> & { frame: string }): CompanyConceptUnit {
  return {
    accn: '0000320193-24-000123',
    end: '2024-09-28',
    filed: '2024-11-01',
    form: '10-K',
    fp: 'FY',
    fy: 2024,
    val: 1,
    ...overrides,
  };
}

const appleFacts: CompanyFactsResponse = {
  cik: 320193,
  entityName: 'Apple Inc.',
  facts: {
    'us-gaap': {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        label: 'Revenue from Contract with Customer',
        description: 'Revenue recognized under ASC 606.',
        units: {
          USD: [
            fact({ frame: 'CY2023', end: '2023-09-30', val: 383_285_000_000 }),
            fact({ frame: 'CY2024', end: '2024-09-28', val: 391_035_000_000 }),
            fact({
              frame: 'CY2025Q2',
              end: '2025-06-28',
              val: 94_036_000_000,
              form: '10-Q',
              accn: '0000320193-25-000073',
            }),
          ],
        },
      },
      Assets: {
        label: 'Total Assets',
        units: {
          USD: [
            fact({ frame: 'CY2023Q3I', end: '2023-09-30', val: 352_583_000_000 }),
            fact({ frame: 'CY2024Q3I', end: '2024-09-28', val: 364_980_000_000 }),
          ],
        },
      },
    },
    dei: {
      EntityCommonStockSharesOutstanding: {
        label: 'Shares Outstanding',
        units: {
          shares: [fact({ frame: 'CY2024Q3I', end: '2024-09-28', val: 15_115_823_000 })],
        },
      },
    },
  },
};

const mockApi = {
  resolveCik: vi.fn(),
  tryGetCompanyFacts: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as never);
  mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
  mockApi.tryGetCompanyFacts.mockResolvedValue(appleFacts);
});

describe('getSnapshotTool', () => {
  it('reads companyfacts once rather than per concept', async () => {
    const ctx = createMockContext({ errors: getSnapshotTool.errors });
    const input = getSnapshotTool.input.parse({ company: 'AAPL' });
    await getSnapshotTool.handler(input, ctx);

    expect(mockApi.tryGetCompanyFacts).toHaveBeenCalledTimes(1);
    expect(mockApi.tryGetCompanyFacts).toHaveBeenCalledWith('0000320193');
  });

  it('reports the latest full year and latest quarter for a duration concept', async () => {
    const ctx = createMockContext({ errors: getSnapshotTool.errors });
    const input = getSnapshotTool.input.parse({ company: 'AAPL' });
    const result = await getSnapshotTool.handler(input, ctx);

    const revenue = result.lines.find((l) => l.concept === 'revenue');
    expect(revenue?.tag).toBe('RevenueFromContractWithCustomerExcludingAssessedTax');
    expect(revenue?.unit).toBe('USD');
    expect(revenue?.annual).toMatchObject({
      period: 'CY2024',
      value: 391_035_000_000,
      period_end: '2024-09-28',
      form: '10-K',
    });
    expect(revenue?.quarterly).toMatchObject({ period: 'CY2025Q2', value: 94_036_000_000 });
    expect(revenue?.instant).toBeUndefined();
  });

  it('reports a point-in-time value for a balance-sheet concept', async () => {
    const ctx = createMockContext({ errors: getSnapshotTool.errors });
    const input = getSnapshotTool.input.parse({ company: 'AAPL' });
    const result = await getSnapshotTool.handler(input, ctx);

    const assets = result.lines.find((l) => l.concept === 'assets');
    expect(assets?.instant).toMatchObject({ period: 'CY2024Q3I', value: 364_980_000_000 });
    expect(assets?.annual).toBeUndefined();
  });

  it('resolves entity-info concepts under dei regardless of the requested taxonomy', async () => {
    const ctx = createMockContext({ errors: getSnapshotTool.errors });
    const input = getSnapshotTool.input.parse({ company: 'AAPL', taxonomy: 'us-gaap' });
    const result = await getSnapshotTool.handler(input, ctx);

    const shares = result.lines.find((l) => l.concept === 'shares_outstanding');
    expect(shares?.taxonomy).toBe('dei');
    expect(shares?.unit).toBe('shares');
  });

  it('lists unreported concepts as gaps with the tags tried, never as zeros', async () => {
    const ctx = createMockContext({ errors: getSnapshotTool.errors });
    const input = getSnapshotTool.input.parse({ company: 'AAPL' });
    const result = await getSnapshotTool.handler(input, ctx);

    const goodwill = result.gaps.find((g) => g.concept === 'goodwill');
    expect(goodwill?.tags_tried).toEqual(['Goodwill']);
    expect(result.lines.some((l) => l.concept === 'goodwill')).toBe(false);
    // Nothing is invented for a concept the filer does not report.
    expect(result.lines.every((l) => l.annual || l.quarterly || l.instant)).toBe(true);
  });

  it('counts resolved concepts against the full attempted catalog', async () => {
    const ctx = createMockContext({ errors: getSnapshotTool.errors });
    const input = getSnapshotTool.input.parse({ company: 'AAPL' });
    const result = await getSnapshotTool.handler(input, ctx);

    expect(result.concepts_resolved).toBe(result.lines.length);
    expect(result.concepts_total).toBe(result.lines.length + result.gaps.length);
    expect(result.concepts_total).toBeGreaterThan(result.concepts_resolved);
  });

  it('omits the quarterly slot when period_type is annual', async () => {
    const ctx = createMockContext({ errors: getSnapshotTool.errors });
    const input = getSnapshotTool.input.parse({ company: 'AAPL', period_type: 'annual' });
    const result = await getSnapshotTool.handler(input, ctx);

    const revenue = result.lines.find((l) => l.concept === 'revenue');
    expect(revenue?.annual).toBeDefined();
    expect(revenue?.quarterly).toBeUndefined();
  });

  it('omits the annual slot when period_type is quarterly but keeps instants', async () => {
    const ctx = createMockContext({ errors: getSnapshotTool.errors });
    const input = getSnapshotTool.input.parse({ company: 'AAPL', period_type: 'quarterly' });
    const result = await getSnapshotTool.handler(input, ctx);

    expect(result.lines.find((l) => l.concept === 'revenue')?.annual).toBeUndefined();
    expect(result.lines.find((l) => l.concept === 'assets')?.instant).toBeDefined();
  });

  it('surfaces the off-calendar missing-quarter caveat (#95 mechanism)', async () => {
    const juneFiscalYearEnd: CompanyFactsResponse = {
      cik: 789019,
      entityName: 'MICROSOFT CORP',
      facts: {
        'us-gaap': {
          Revenues: {
            label: 'Revenues',
            units: {
              USD: [2023, 2024, 2025].flatMap((year) =>
                [1, 3, 4].map((q) =>
                  fact({ frame: `CY${year}Q${q}`, end: `${year}-0${q}-30`, val: 1000 + q }),
                ),
              ),
            },
          },
        },
      },
    };
    mockApi.resolveCik.mockResolvedValue({ cik: '0000789019', name: 'MICROSOFT CORP' });
    mockApi.tryGetCompanyFacts.mockResolvedValue(juneFiscalYearEnd);

    const ctx = createMockContext({ errors: getSnapshotTool.errors });
    const input = getSnapshotTool.input.parse({ company: 'MSFT' });
    const result = await getSnapshotTool.handler(input, ctx);

    expect(result.caveats[0]).toContain('Calendar Q2');
  });

  it('names the concept whose line resolved to a retired XBRL tag (#98)', async () => {
    const retiredTagFiler: CompanyFactsResponse = {
      cik: 91419,
      entityName: 'J M SMUCKER Co',
      facts: {
        'us-gaap': {
          SalesRevenueGoodsNet: {
            label: 'Sales Revenue, Goods, Net (Deprecated 2018-01-31)',
            units: { USD: [fact({ frame: 'CY2017', end: '2018-04-30', val: 7_357_100_000 })] },
          },
        },
      },
    };
    mockApi.resolveCik.mockResolvedValue({ cik: '0000091419', name: 'J M SMUCKER Co' });
    mockApi.tryGetCompanyFacts.mockResolvedValue(retiredTagFiler);

    const ctx = createMockContext({ errors: getSnapshotTool.errors });
    const input = getSnapshotTool.input.parse({ company: 'SJM' });
    const result = await getSnapshotTool.handler(input, ctx);

    const stale = result.caveats.find((c) => c.includes('SalesRevenueGoodsNet'));
    expect(stale).toBeDefined();
    // A snapshot resolves the whole catalog at once, so the caveat has to say
    // which line it is about.
    expect(stale).toMatch(/^revenue: /);
  });

  it('raises no staleness caveat for a filer on current tags (#98)', async () => {
    const ctx = createMockContext({ errors: getSnapshotTool.errors });
    const input = getSnapshotTool.input.parse({ company: 'AAPL' });
    const result = await getSnapshotTool.handler(input, ctx);

    expect(result.caveats.some((c) => c.includes('retired from the taxonomy'))).toBe(false);
  });

  it('throws company_not_found for an unresolvable input', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getSnapshotTool.errors });
    const input = getSnapshotTool.input.parse({ company: 'XYZNOTREAL' });

    await expect(getSnapshotTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'company_not_found' },
    });
  });

  it('renders the ambiguous_company candidates into the message', async () => {
    mockApi.resolveCik.mockResolvedValue([
      { cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' },
      { cik: '0006084276', name: 'Apple Bank for Savings' },
    ]);
    const ctx = createMockContext({ errors: getSnapshotTool.errors });
    const input = getSnapshotTool.input.parse({ company: 'Apple' });

    const err = await getSnapshotTool.handler(input, ctx).catch((e) => e);
    expect(err.data.reason).toBe('ambiguous_company');
    expect(err.message).toContain('0000320193 Apple Inc. (AAPL)');
  });

  it('throws no_company_facts when the filer has no XBRL facts', async () => {
    mockApi.tryGetCompanyFacts.mockResolvedValue(null);
    const ctx = createMockContext({ errors: getSnapshotTool.errors });
    const input = getSnapshotTool.input.parse({ company: 'AAPL' });

    await expect(getSnapshotTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_company_facts' },
    });
  });

  it('renders values, gaps, and provenance into the text surface', async () => {
    const ctx = createMockContext({ errors: getSnapshotTool.errors });
    const input = getSnapshotTool.input.parse({ company: 'AAPL' });
    const result = await getSnapshotTool.handler(input, ctx);
    const text = getSnapshotTool.format!(result)[0].text;

    expect(text).toContain('Apple Inc.');
    expect(text).toContain('annual CY2024 = 391035000000');
    expect(text).toContain('0000320193-24-000123');
    expect(text).toContain('Not reported');
    expect(text).toContain('tried: Goodwill');
  });
});
