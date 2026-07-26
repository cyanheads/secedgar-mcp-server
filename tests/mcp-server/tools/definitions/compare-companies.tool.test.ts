/**
 * @fileoverview Tests for compare-companies — period-aligned multi-company
 * concept comparison, including partial company resolution, the inline period
 * cap, and the comparability caveats (#85).
 * @module tests/mcp-server/tools/definitions/compare-companies.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compareCompaniesTool } from '@/mcp-server/tools/definitions/compare-companies.tool.js';
import type { CompanyConceptUnit, CompanyFactsResponse } from '@/services/edgar/types.js';

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

function fact(overrides: Partial<CompanyConceptUnit> & { frame: string }): CompanyConceptUnit {
  return {
    accn: 'acc-1',
    end: '2024-12-31',
    filed: '2025-02-01',
    form: '10-K',
    fp: 'FY',
    fy: 2024,
    val: 1,
    ...overrides,
  };
}

/** December-fiscal-year-end filer with four annual periods of revenue and assets. */
const calendarFiler: CompanyFactsResponse = {
  cik: 789019,
  entityName: 'CALENDAR CO',
  facts: {
    'us-gaap': {
      Revenues: {
        label: 'Revenues',
        units: {
          USD: [2021, 2022, 2023, 2024, 2025].map((year) =>
            fact({ frame: `CY${year}`, end: `${year}-12-31`, val: year * 100 }),
          ),
        },
      },
      Assets: {
        label: 'Total Assets',
        units: {
          USD: [2023, 2024].map((year) =>
            fact({ frame: `CY${year}Q4I`, end: `${year}-12-31`, val: year * 10 }),
          ),
        },
      },
    },
  },
};

/** June-fiscal-year-end filer — three frame-tagged quarters per year, no calendar Q2. */
const juneFiler: CompanyFactsResponse = {
  cik: 320193,
  entityName: 'JUNE CO',
  facts: {
    'us-gaap': {
      Revenues: {
        label: 'Revenues',
        units: {
          USD: [
            ...[2023, 2024, 2025].map((year) =>
              fact({ frame: `CY${year}`, end: `${year}-06-30`, val: year * 200 }),
            ),
            ...[2023, 2024, 2025].flatMap((year) =>
              [1, 3, 4].map((q) =>
                fact({ frame: `CY${year}Q${q}`, end: `${year}-0${q}-30`, val: q, form: '10-Q' }),
              ),
            ),
          ],
        },
      },
    },
  },
};

const mockApi = {
  resolveCik: vi.fn(),
  tryGetCompanyFacts: vi.fn(),
};

/** Route resolveCik / tryGetCompanyFacts by the supplied ticker. */
function wireTwoFilers() {
  mockApi.resolveCik.mockImplementation((q: string) =>
    q === 'CAL'
      ? { cik: '0000789019', name: 'CALENDAR CO', ticker: 'CAL' }
      : { cik: '0000320193', name: 'JUNE CO', ticker: 'JUN' },
  );
  mockApi.tryGetCompanyFacts.mockImplementation((cik: string) =>
    cik === '0000789019' ? calendarFiler : juneFiler,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as never);
  wireTwoFilers();
});

describe('compareCompaniesTool', () => {
  it('reads companyfacts once per company, not once per company-concept pair', async () => {
    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const input = compareCompaniesTool.input.parse({
      companies: ['CAL', 'JUN'],
      concepts: ['revenue', 'assets'],
    });
    await compareCompaniesTool.handler(input, ctx);

    expect(mockApi.tryGetCompanyFacts).toHaveBeenCalledTimes(2);
  });

  it('aligns both companies on shared calendar period keys', async () => {
    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const input = compareCompaniesTool.input.parse({
      companies: ['CAL', 'JUN'],
      concepts: ['revenue'],
      periods: 3,
    });
    const result = await compareCompaniesTool.handler(input, ctx);

    expect(result.periods).toEqual(['CY2025', 'CY2024', 'CY2023']);
    const cy2024 = result.cells.filter((c) => c.period === 'CY2024');
    expect(cy2024.map((c) => c.company).sort()).toEqual(['CALENDAR CO', 'JUNE CO']);
  });

  it('aligns point-in-time concepts onto the same period keys as duration ones', async () => {
    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const input = compareCompaniesTool.input.parse({
      companies: ['CAL', 'JUN'],
      concepts: ['assets'],
    });
    const result = await compareCompaniesTool.handler(input, ctx);

    const assets = result.cells.find((c) => c.concept === 'assets' && c.period === 'CY2024');
    // The instant frame is preserved alongside the aligned calendar-year key.
    expect(assets?.frame).toBe('CY2024Q4I');
    expect(assets?.period).toBe('CY2024');
  });

  it('caps the inline matrix at periods and registers the full series to the dataframe', async () => {
    const registerDataframe = vi.fn().mockResolvedValue({
      name: 'df_AAAAA_BBBBB',
      rowCount: 99,
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as never);
    vi.mocked(toDatasetField).mockReturnValue({
      name: 'df_AAAAA_BBBBB',
      row_count: 99,
      expires_at: '2026-01-01T00:00:00.000Z',
    });

    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const input = compareCompaniesTool.input.parse({
      companies: ['CAL', 'JUN'],
      concepts: ['revenue'],
      periods: 2,
    });
    const result = await compareCompaniesTool.handler(input, ctx);

    expect(result.periods).toHaveLength(2);
    expect(result.cells.every((c) => result.periods.includes(c.period))).toBe(true);
    // The dataframe holds every aligned period, not just the inline window.
    const { rows } = registerDataframe.mock.calls[0][1];
    expect(new Set(rows.map((r: { period: string }) => r.period)).size).toBeGreaterThan(2);
    expect(result.dataset?.name).toBe('df_AAAAA_BBBBB');
  });

  it('rejects a periods value above the inline cap', () => {
    expect(() =>
      compareCompaniesTool.input.parse({
        companies: ['CAL', 'JUN'],
        concepts: ['revenue'],
        periods: 13,
      }),
    ).toThrow();
  });

  it('bounds companies and concepts', () => {
    expect(() =>
      compareCompaniesTool.input.parse({ companies: ['CAL'], concepts: ['revenue'] }),
    ).toThrow();
    expect(() =>
      compareCompaniesTool.input.parse({
        companies: Array.from({ length: 11 }, (_, i) => `T${i}`),
        concepts: ['revenue'],
      }),
    ).toThrow();
    expect(() =>
      compareCompaniesTool.input.parse({
        companies: ['CAL', 'JUN'],
        concepts: Array.from({ length: 9 }, (_, i) => `c${i}`),
      }),
    ).toThrow();
  });

  it('proceeds with the resolvable companies and reports the rest per company', async () => {
    mockApi.resolveCik.mockImplementation((q: string) => {
      if (q === 'CAL') return { cik: '0000789019', name: 'CALENDAR CO', ticker: 'CAL' };
      if (q === 'NOPE') return [];
      return [
        { cik: '0000000001', name: 'Ambiguous One' },
        { cik: '0000000002', name: 'Ambiguous Two' },
      ];
    });

    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const input = compareCompaniesTool.input.parse({
      companies: ['CAL', 'NOPE', 'AMBIG'],
      concepts: ['revenue'],
    });
    const result = await compareCompaniesTool.handler(input, ctx);

    expect(result.companies.map((c) => c.input)).toEqual(['CAL']);
    expect(result.failed_companies.map((f) => f.reason).sort()).toEqual(['ambiguous', 'not_found']);
    expect(result.cells.length).toBeGreaterThan(0);
  });

  it('reports a filer with no XBRL facts as a per-company failure', async () => {
    mockApi.tryGetCompanyFacts.mockImplementation((cik: string) =>
      cik === '0000789019' ? calendarFiler : null,
    );

    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const input = compareCompaniesTool.input.parse({
      companies: ['CAL', 'JUN'],
      concepts: ['revenue'],
    });
    const result = await compareCompaniesTool.handler(input, ctx);

    expect(result.failed_companies).toEqual([
      expect.objectContaining({ input: 'JUN', reason: 'no_company_facts' }),
    ]);
    expect(result.companies).toHaveLength(1);
  });

  it('throws no_companies_resolved only when every input fails', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const input = compareCompaniesTool.input.parse({
      companies: ['NOPE', 'ALSONOPE'],
      concepts: ['revenue'],
    });

    await expect(compareCompaniesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_companies_resolved' },
    });
  });

  it('throws no_comparable_data when nobody reports any requested concept', async () => {
    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const input = compareCompaniesTool.input.parse({
      companies: ['CAL', 'JUN'],
      concepts: ['goodwill'],
    });

    await expect(compareCompaniesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_comparable_data' },
    });
  });

  it('records a company-concept pair with no data as a gap, never as a value', async () => {
    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const input = compareCompaniesTool.input.parse({
      companies: ['CAL', 'JUN'],
      concepts: ['revenue', 'assets'],
    });
    const result = await compareCompaniesTool.handler(input, ctx);

    // JUNE CO reports no Assets tag at all.
    expect(result.gaps).toContainEqual(
      expect.objectContaining({ company: 'JUNE CO', concept: 'assets', tags_tried: ['Assets'] }),
    );
    expect(result.cells.some((c) => c.company === 'JUNE CO' && c.concept === 'assets')).toBe(false);
  });

  it('flags period ends that differ inside one aligned period', async () => {
    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const input = compareCompaniesTool.input.parse({
      companies: ['CAL', 'JUN'],
      concepts: ['revenue'],
    });
    const result = await compareCompaniesTool.handler(input, ctx);

    // Dates come from the newest aligned period, so they are the cut-offs actually
    // being compared — not a year end inferred from whichever cell came first.
    const mix = result.caveats.find((c) => c.includes('Period ends differ inside CY2025'));
    expect(mix).toContain('CALENDAR CO ends 2025-12-31');
    expect(mix).toContain('JUNE CO ends 2025-06-30');
  });

  it('flags the off-calendar filer missing a calendar quarter, named per company', async () => {
    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const input = compareCompaniesTool.input.parse({
      companies: ['CAL', 'JUN'],
      concepts: ['revenue'],
      period_type: 'quarterly',
    });
    const result = await compareCompaniesTool.handler(input, ctx);

    expect(result.caveats.some((c) => c.startsWith('JUNE CO: ') && c.includes('Calendar Q2'))).toBe(
      true,
    );
  });

  it('omits the period-end caveat when the filers close on the same date', async () => {
    mockApi.tryGetCompanyFacts.mockResolvedValue(calendarFiler);
    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const input = compareCompaniesTool.input.parse({
      companies: ['CAL', 'JUN'],
      concepts: ['revenue'],
    });
    const result = await compareCompaniesTool.handler(input, ctx);

    expect(result.caveats.some((c) => c.includes('Period ends differ'))).toBe(false);
  });

  it('shrinks the inline window when the cell count would overflow the response', async () => {
    // 10 companies x 2 concepts x 12 periods is 240 cells — past what one response
    // can usefully carry, so the window drops older periods and discloses the drop.
    const years = Array.from({ length: 12 }, (_, i) => 2014 + i);
    const wideFiler: CompanyFactsResponse = {
      cik: 1,
      entityName: 'WIDE CO',
      facts: {
        'us-gaap': {
          Revenues: {
            label: 'Revenues',
            units: {
              USD: years.map((year) => fact({ frame: `CY${year}`, end: `${year}-12-31` })),
            },
          },
          NetIncomeLoss: {
            label: 'Net Income',
            units: {
              USD: years.map((year) => fact({ frame: `CY${year}`, end: `${year}-12-31` })),
            },
          },
        },
      },
    };
    mockApi.resolveCik.mockImplementation((q: string) => ({
      cik: String(q).padStart(10, '0'),
      name: `CO ${q}`,
      ticker: q,
    }));
    mockApi.tryGetCompanyFacts.mockResolvedValue(wideFiler);

    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const input = compareCompaniesTool.input.parse({
      companies: Array.from({ length: 10 }, (_, i) => `T${i}`),
      concepts: ['revenue', 'net_income'],
      periods: 12,
    });
    const result = await compareCompaniesTool.handler(input, ctx);

    expect(result.periods.length).toBeLessThan(12);
    expect(result.cells.length).toBeLessThanOrEqual(120);
    expect(result.cells.every((c) => result.periods.includes(c.period))).toBe(true);
  });

  it('renders every cell with its own provenance into the text surface', async () => {
    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const input = compareCompaniesTool.input.parse({
      companies: ['CAL', 'JUN'],
      concepts: ['revenue'],
      periods: 1,
    });
    const result = await compareCompaniesTool.handler(input, ctx);
    const text = compareCompaniesTool.format!(result)[0].text;

    expect(text).toContain('CALENDAR CO');
    expect(text).toContain('JUNE CO');
    expect(text).toContain('CY2025 = ');
    expect(text).toContain('us-gaap:Revenues');
  });
});
