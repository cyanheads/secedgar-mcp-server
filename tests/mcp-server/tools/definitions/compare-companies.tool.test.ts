/**
 * @fileoverview Tests for compare-companies — period-aligned multi-company
 * concept comparison, including partial company resolution, the inline period
 * cap, and the comparability caveats (#85).
 * @module tests/mcp-server/tools/definitions/compare-companies.tool
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compareCompaniesTool,
  createCompareCompaniesTool,
} from '@/mcp-server/tools/definitions/compare-companies.tool.js';
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import type { CompanyConceptUnit, CompanyFactsResponse } from '@/services/edgar/types.js';

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
import { allText, at, bag, blockText, records, wireError } from '../../../support/assertions.js';
import { readCommonMark } from '../../../support/commonmark.js';

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

/**
 * A December-year 10-K's full-year fact, filed in its own accession after the year
 * closes — the shape the filer's fiscal-year ends are read from (#148).
 */
function calendarYear10K(prefix: string, year: number, val: number): CompanyConceptUnit {
  return fact({
    frame: `CY${year}`,
    start: `${year}-01-01`,
    end: `${year}-12-31`,
    filed: `${year + 1}-02-01`,
    accn: `${prefix}-${year}`,
    val,
  });
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
            calendarYear10K('cal', year, year * 100),
          ),
        },
      },
      Assets: {
        label: 'Total Assets',
        units: {
          USD: [2023, 2024].map((year) =>
            fact({
              frame: `CY${year}Q4I`,
              end: `${year}-12-31`,
              filed: `${year + 1}-02-01`,
              accn: `cal-${year}`,
              val: year * 10,
            }),
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

  it('pins every field of an aligned cell', async () => {
    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const input = compareCompaniesTool.input.parse({
      companies: ['CAL', 'JUN'],
      concepts: ['revenue'],
      periods: 1,
    });
    const result = await compareCompaniesTool.handler(input, ctx);

    expect(result.cells.find((c) => c.company === 'CALENDAR CO')).toMatchObject({
      cik: '0000789019',
      company: 'CALENDAR CO',
      concept: 'revenue',
      period: 'CY2025',
      value: 202_500,
      unit: 'USD',
      taxonomy: 'us-gaap',
      tag: 'Revenues',
      frame: 'CY2025',
      period_end: '2025-12-31',
      form: '10-K',
      accession_number: 'cal-2025',
    });
    expect(result.concepts).toEqual([{ concept: 'revenue', label: 'Revenue', units: ['USD'] }]);
  });

  it('cites the 10-K for a proxy-held annual frame (#123)', async () => {
    const proxyHeld: CompanyFactsResponse = {
      facts: {
        'us-gaap': {
          NetIncomeLoss: {
            label: 'Net Income (Loss)',
            units: {
              USD: [
                fact({
                  frame: 'CY2024',
                  start: '2024-01-01',
                  end: '2024-12-31',
                  form: 'DEF 14A',
                  accn: 'proxy',
                  filed: '2026-04-27',
                  val: 134_202_000_000,
                }),
                {
                  start: '2024-01-01',
                  end: '2024-12-31',
                  form: '10-K',
                  accn: 'ten-k',
                  filed: '2025-03-10',
                  fp: 'FY',
                  fy: 2024,
                  val: -134_202_000,
                },
              ],
            },
          },
        },
      },
    };
    mockApi.tryGetCompanyFacts.mockResolvedValue(proxyHeld);
    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const result = await compareCompaniesTool.handler(
      compareCompaniesTool.input.parse({ companies: ['CAL', 'JUN'], concepts: ['net_income'] }),
      ctx,
    );

    for (const cell of result.cells) {
      expect(cell).toMatchObject({
        period: 'CY2024',
        frame: 'CY2024',
        value: -134_202_000,
        form: '10-K',
        accession_number: 'ten-k',
      });
    }
  });

  it('names each cell’s own source tag and unit (#125)', async () => {
    const successor: CompanyFactsResponse = {
      facts: {
        'us-gaap': {
          InterestExpense: {
            label: 'Interest Expense',
            units: { USD: [fact({ frame: 'CY2023', end: '2023-12-31', val: 257 })] },
          },
          InterestExpenseNonoperating: {
            label: 'Interest Expense, Nonoperating',
            units: {
              USD: [
                fact({ frame: 'CY2023', end: '2023-12-31', val: 999 }),
                fact({ frame: 'CY2025', end: '2025-12-31', val: 251 }),
              ],
            },
          },
        },
      },
    };
    mockApi.tryGetCompanyFacts.mockResolvedValue(successor);
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: ['interest_expense'],
    });
    expect(result.isError).toBeFalsy();
    const output = compareCompaniesTool.output.parse(result.structuredContent);
    const cal = output.cells.filter((c) => c.company === 'CALENDAR CO');
    expect(cal.map((c) => [c.period, c.value, c.tag, c.unit])).toEqual([
      ['CY2025', 251, 'InterestExpenseNonoperating', 'USD'],
      ['CY2023', 257, 'InterestExpense', 'USD'],
    ]);
    const text = blockText(result.content);
    expect(text).toContain('CY2023 = 257 USD | us-gaap:InterestExpense |');
    expect(text).toContain('CY2025 = 251 USD | us-gaap:InterestExpenseNonoperating |');
  });

  it('aligns on closed years only, leaving a 10-Q TTM frame out (#142)', async () => {
    mockApi.tryGetCompanyFacts.mockResolvedValue({
      facts: {
        'us-gaap': {
          PaymentsToAcquireProductiveAssets: {
            label: 'Capex',
            units: {
              USD: [
                fact({ frame: 'CY2025', start: '2025-01-01', end: '2025-12-31', val: 131_819 }),
                fact({
                  frame: 'CY2026',
                  start: '2025-07-01',
                  end: '2026-06-30',
                  filed: '2026-07-31',
                  form: '10-Q',
                  fp: 'Q2',
                  val: 173_028,
                }),
              ],
            },
          },
        },
      },
    } satisfies CompanyFactsResponse);
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: ['capex'],
    });
    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(output.periods).toEqual(['CY2025']);
    expect(output.cells.every((c) => c.form === '10-K' && c.value === 131_819)).toBe(true);
    expect(blockText(result.content)).not.toContain('CY2026');
  });

  describe('units (#146)', () => {
    /** One company's Revenues under the given unit keys, an annual frame per year. */
    const revenues = (units: Record<string, Array<{ year: number; filed?: string }>>) =>
      ({
        facts: {
          'us-gaap': {
            Revenues: {
              label: 'Revenues',
              units: Object.fromEntries(
                Object.entries(units).map(([key, years]) => [
                  key,
                  years.map(({ year, filed = '2025-02-01' }) =>
                    fact({ frame: `CY${year}`, end: `${year}-12-31`, val: year, filed }),
                  ),
                ]),
              ),
            },
          },
        },
      }) satisfies CompanyFactsResponse;
    const wire = (cal: CompanyFactsResponse, jun: CompanyFactsResponse) =>
      mockApi.tryGetCompanyFacts.mockImplementation((cik: string) =>
        cik === '0000789019' ? cal : jun,
      );
    const unitsCaveat = (caveats: readonly string[]) =>
      caveats.filter((c) => c.includes('more than one unit'));

    it('flags a concept whose unit differs between companies', async () => {
      wire(
        revenues({ USD: [{ year: 2024 }, { year: 2025 }] }),
        revenues({ EUR: [{ year: 2024 }, { year: 2025 }] }),
      );
      const result = await runToolContract(compareCompaniesTool, {
        companies: ['CAL', 'JUN'],
        concepts: ['revenue'],
      });
      const output = compareCompaniesTool.output.parse(result.structuredContent);
      expect(unitsCaveat(output.caveats)).toEqual([
        "Concept 'revenue' resolved to more than one unit across these companies (USD, EUR). Values in different units are not directly comparable — each cell carries its own unit.",
      ]);
      expect(at(output.concepts).units).toEqual(['USD', 'EUR']);
    });

    it('reads each company in one unit, so a convenience translation raises no cross-company caveat', async () => {
      // JUN reports ZAR plus a USD translation of its two newest years, filed
      // later; CAL reports ZAR only. Frames compete within one unit, so JUN
      // reads ZAR throughout and both companies share one unit.
      wire(
        revenues({ ZAR: [{ year: 2023 }, { year: 2024 }, { year: 2025 }] }),
        revenues({
          ZAR: [{ year: 2023 }, { year: 2024 }, { year: 2025 }],
          USD: [
            { year: 2024, filed: '2026-03-01' },
            { year: 2025, filed: '2026-03-01' },
          ],
        }),
      );
      const result = await runToolContract(compareCompaniesTool, {
        companies: ['CAL', 'JUN'],
        concepts: ['revenue'],
      });
      const output = compareCompaniesTool.output.parse(result.structuredContent);
      expect(new Set(output.cells.map((c) => c.unit))).toEqual(new Set(['ZAR']));
      expect(unitsCaveat(output.caveats)).toEqual([]);
      expect(at(output.concepts).units).toEqual(['ZAR']);
      expect(blockText(result.content)).not.toContain(' USD |');
    });
  });

  /**
   * One filer reaching a period the others have not takes the inline window, so
   * a company that reports the concept only for older periods has no value
   * inline (#144).
   */
  describe('a company whose values all sit outside the inline window (#144)', () => {
    /** June filer that has already filed a CY2026 annual report. */
    const aheadFiler: CompanyFactsResponse = {
      cik: 222222,
      entityName: 'AHEAD CO',
      facts: {
        'us-gaap': {
          Revenues: {
            label: 'Revenues',
            units: {
              USD: [2024, 2025, 2026].map((year) =>
                fact({ frame: `CY${year}`, end: `${year}-06-30`, val: year * 300 }),
              ),
            },
          },
        },
      },
    };

    beforeEach(() => {
      mockApi.resolveCik.mockImplementation(async (q: string) =>
        q === 'AHD'
          ? { cik: '0000222222', name: 'AHEAD CO', ticker: 'AHD' }
          : q === 'CAL'
            ? { cik: '0000789019', name: 'CALENDAR CO', ticker: 'CAL' }
            : { cik: '0000320193', name: 'JUNE CO', ticker: 'JUN' },
      );
      mockApi.tryGetCompanyFacts.mockImplementation(async (cik: string) =>
        cik === '0000222222' ? aheadFiler : cik === '0000789019' ? calendarFiler : juneFiler,
      );
    });

    // Characterization: the window and the gaps list as they stood before #144.
    it('fills the window from the filer that is ahead and lists no gap for the other', async () => {
      const result = await runToolContract(compareCompaniesTool, {
        companies: ['CAL', 'AHD'],
        concepts: ['revenue'],
        periods: 1,
      });

      expect(result.isError).toBeFalsy();
      const output = compareCompaniesTool.output.parse(result.structuredContent);
      expect(output.periods).toEqual(['CY2026']);
      expect(output.cells.map((c) => [c.company, c.period])).toEqual([['AHEAD CO', 'CY2026']]);
      expect(output.gaps).toEqual([]);
      expect(output.companies.map((c) => c.name)).toEqual(['CALENDAR CO', 'AHEAD CO']);
    });

    /** Caveats naming companies whose values all sit outside the inline window. */
    const outsideWindow = (caveats: string[]) =>
      caveats.filter((c) => c.includes('no value inside the inline periods'));

    /** Stage a dataframe the way a successful registration does. */
    function stageDataframe() {
      const registerDataframe = vi.fn().mockResolvedValue({
        name: 'df_WINDOW_ROWS1',
        rowCount: 8,
        expiresAt: '2026-01-01T00:00:00.000Z',
      });
      vi.mocked(getCanvasBridge).mockReturnValueOnce({ registerDataframe } as never);
      vi.mocked(toDatasetField).mockReturnValueOnce({
        name: 'df_WINDOW_ROWS1',
        row_count: 8,
        expires_at: '2026-01-01T00:00:00.000Z',
      });
    }

    it('names the company, the concept, its newest period, and the dataframe, on both surfaces', async () => {
      stageDataframe();
      const result = await runToolContract(compareCompaniesTool, {
        companies: ['CAL', 'AHD'],
        concepts: ['revenue'],
        periods: 1,
      });

      const output = compareCompaniesTool.output.parse(result.structuredContent);
      const [caveat, ...rest] = outsideWindow(output.caveats);
      expect(rest).toEqual([]);
      expect(caveat).toBe(
        'revenue: no value inside the inline periods (CY2026) for CALENDAR CO (newest CY2025). It reports revenue for earlier periods only; those values are in dataframe df_WINDOW_ROWS1 — query it with secedgar_dataframe_query — or raise periods to bring them inline.',
      );
      // gaps keeps its meaning: no value in any period.
      expect(output.gaps).toEqual([]);
      expect(blockText(result.content)).toContain(`Caveat: ${caveat}`);
    });

    it('groups every out-of-window company under one caveat per concept', async () => {
      const result = await runToolContract(compareCompaniesTool, {
        companies: ['CAL', 'JUN', 'AHD'],
        concepts: ['revenue', 'assets'],
        periods: 1,
      });

      const output = compareCompaniesTool.output.parse(result.structuredContent);
      const lines = outsideWindow(output.caveats);
      expect(lines).toHaveLength(2);
      const [revenue, assets] = lines;
      expect(revenue).toContain(
        'revenue: no value inside the inline periods (CY2026) for CALENDAR CO (newest CY2025), JUNE CO (newest CY2025). Each reports revenue for earlier periods only;',
      );
      expect(revenue).not.toContain('AHEAD CO');
      // Assets is instant: CALENDAR CO's CY2024Q4I snapshot aligns on CY2024.
      expect(assets).toContain(
        'assets: no value inside the inline periods (CY2026) for CALENDAR CO (newest CY2024).',
      );
      // A pair with no value in any period stays a gap and is not named again.
      expect(output.gaps.map((g) => [g.company, g.concept])).toEqual([
        ['JUNE CO', 'assets'],
        ['AHEAD CO', 'assets'],
      ]);
      expect(assets).not.toContain('JUNE CO');
      const text = blockText(result.content);
      for (const line of lines) expect(text).toContain(`Caveat: ${line}`);
    });

    it('names a company whose newest value is older than every period of a wider window', async () => {
      const result = await runToolContract(compareCompaniesTool, {
        companies: ['CAL', 'AHD'],
        concepts: ['assets', 'revenue'],
        periods: 2,
      });

      const output = compareCompaniesTool.output.parse(result.structuredContent);
      expect(output.periods).toEqual(['CY2026', 'CY2025']);
      // CALENDAR CO's revenue reaches CY2025, inside the window; its assets stop at CY2024.
      expect(outsideWindow(output.caveats)).toEqual([
        expect.stringContaining(
          'assets: no value inside the inline periods (CY2026, CY2025) for CALENDAR CO (newest CY2024).',
        ),
      ]);
    });

    it('points at raising periods when no dataframe was staged', async () => {
      vi.mocked(getCanvasBridge).mockReturnValueOnce(undefined);
      const result = await runToolContract(compareCompaniesTool, {
        companies: ['CAL', 'AHD'],
        concepts: ['revenue'],
        periods: 1,
      });

      const [caveat] = outsideWindow(
        compareCompaniesTool.output.parse(result.structuredContent).caveats,
      );
      expect(caveat).toContain('for CALENDAR CO (newest CY2025).');
      // periods (1) bounds this window, so narrowing the call would not widen it.
      expect(caveat).toContain('raise periods to bring those values inline');
      expect(caveat).not.toContain('narrow companies');
      expect(caveat).not.toContain('secedgar_dataframe');
    });

    it('points at narrowing the call when the cell ceiling, not periods, bounds the window', async () => {
      const years = Array.from({ length: 12 }, (_, i) => 2014 + i);
      const series = years.map((year) => fact({ frame: `CY${year}`, end: `${year}-12-31` }));
      const wideFiler: CompanyFactsResponse = {
        cik: 1,
        entityName: 'WIDE CO',
        facts: {
          'us-gaap': {
            Revenues: { label: 'Revenues', units: { USD: series } },
            NetIncomeLoss: { label: 'Net Income', units: { USD: series } },
          },
        },
      };
      const oldFiler: CompanyFactsResponse = {
        cik: 2,
        entityName: 'OLD CO',
        facts: {
          'us-gaap': {
            Revenues: {
              label: 'Revenues',
              units: {
                USD: [2010, 2011].map((year) => fact({ frame: `CY${year}`, end: `${year}-12-31` })),
              },
            },
          },
        },
      };
      mockApi.resolveCik.mockImplementation(async (q: string) => ({
        cik: String(q === 'OLD' ? 2 : 1 + Number(q.slice(1)) * 10).padStart(10, '0'),
        name: `CO ${q}`,
        ticker: q,
      }));
      mockApi.tryGetCompanyFacts.mockImplementation(async (cik: string) =>
        cik === '0000000002' ? oldFiler : wideFiler,
      );
      stageDataframe();

      const result = await runToolContract(compareCompaniesTool, {
        companies: [...Array.from({ length: 9 }, (_, i) => `T${i}`), 'OLD'],
        concepts: ['revenue', 'net_income'],
        periods: 12,
      });

      const output = compareCompaniesTool.output.parse(result.structuredContent);
      expect(output.periods).toEqual(['CY2025', 'CY2024', 'CY2023', 'CY2022', 'CY2021', 'CY2020']);
      expect(outsideWindow(output.caveats)).toEqual([
        'revenue: no value inside the inline periods (CY2025, CY2024, CY2023, CY2022, CY2021, CY2020) for CO OLD (newest CY2011). It reports revenue for earlier periods only; those values are in dataframe df_WINDOW_ROWS1 — query it with secedgar_dataframe_query — or narrow companies or concepts to bring them inline.',
      ]);
    });

    it('says nothing once every reporting company has a value inside the window', async () => {
      const result = await runToolContract(compareCompaniesTool, {
        companies: ['CAL', 'AHD'],
        concepts: ['revenue'],
        periods: 2,
      });

      const output = compareCompaniesTool.output.parse(result.structuredContent);
      expect(output.periods).toEqual(['CY2026', 'CY2025']);
      expect(outsideWindow(output.caveats)).toEqual([]);
      expect(blockText(result.content)).not.toContain('no value inside the inline periods');
    });
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
    const { rows } = at(registerDataframe.mock.calls, 0)[1];
    expect(new Set(rows.map((r: { period: string }) => r.period)).size).toBeGreaterThan(2);
    expect(result.dataset?.name).toBe('df_AAAAA_BBBBB');

    // The dropped periods are only reachable through the dataframe, so the
    // truncation guidance carries the describe-then-query pointer (#104).
    const enrichment = getEnrichment(ctx);
    const notice = String(enrichment.notice);
    expect(enrichment.truncated).toBe(true);
    expect(notice).toContain('df_AAAAA_BBBBB');
    expect(notice).toContain('secedgar_dataframe_describe');
    expect(notice).toContain('secedgar_dataframe_query');
    expect(notice.match(/secedgar_dataframe_describe/g)).toHaveLength(1);
  });

  describe('staged-dataframe pointer (#104)', () => {
    /** Stage a dataframe the way a successful registration does. */
    function stageDataframe(rowCount = 12) {
      const registerDataframe = vi.fn().mockResolvedValue({
        name: 'df_AAAAA_BBBBB',
        rowCount,
        expiresAt: '2026-01-01T00:00:00.000Z',
      });
      vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as never);
      vi.mocked(toDatasetField).mockReturnValue({
        name: 'df_AAAAA_BBBBB',
        row_count: rowCount,
        expires_at: '2026-01-01T00:00:00.000Z',
      });
    }

    it('points at the staged dataframe even when every aligned period fit inline', async () => {
      stageDataframe();
      const ctx = createMockContext({ errors: compareCompaniesTool.errors });
      const input = compareCompaniesTool.input.parse({
        companies: ['CAL', 'JUN'],
        concepts: ['revenue'],
        periods: 12,
      });
      await compareCompaniesTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBeUndefined();
      expect(String(enrichment.notice)).toContain('secedgar_dataframe_describe');
    });

    it('reaches both structuredContent and content[] through the real tool pipeline', async () => {
      // Without `notice` declared in the enrichment block the framework strips
      // it from the effective output and the pointer never leaves the handler.
      stageDataframe();
      const result = await runToolContract(compareCompaniesTool, {
        companies: ['CAL', 'JUN'],
        concepts: ['revenue'],
        periods: 2,
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { notice?: string };
      expect(structured.notice).toContain('secedgar_dataframe_describe');
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain('secedgar_dataframe_describe');
    });

    it('promises no pointer when the canvas is unavailable', async () => {
      vi.mocked(getCanvasBridge).mockReturnValue(undefined);
      const ctx = createMockContext({ errors: compareCompaniesTool.errors });
      const input = compareCompaniesTool.input.parse({
        companies: ['CAL', 'JUN'],
        concepts: ['revenue'],
        periods: 2,
      });
      const result = await compareCompaniesTool.handler(input, ctx);

      expect(result.dataset).toBeUndefined();
      expect(String(getEnrichment(ctx).notice)).not.toContain('secedgar_dataframe_describe');
    });
  });

  describe('truncation guidance without a canvas', () => {
    /** Ten filers x two concepts x twelve years: 240 cells, past the inline ceiling. */
    function wireWideFilers() {
      const years = Array.from({ length: 12 }, (_, i) => 2014 + i);
      const series = years.map((year) => fact({ frame: `CY${year}`, end: `${year}-12-31` }));
      mockApi.resolveCik.mockImplementation((q: string) => ({
        cik: String(q).padStart(10, '0'),
        name: `CO ${q}`,
        ticker: q,
      }));
      mockApi.tryGetCompanyFacts.mockResolvedValue({
        cik: 1,
        entityName: 'WIDE CO',
        facts: {
          'us-gaap': {
            Revenues: { label: 'Revenues', units: { USD: series } },
            NetIncomeLoss: { label: 'Net Income', units: { USD: series } },
          },
        },
      });
    }

    it('tells the caller to raise periods when periods is what bounds the window', async () => {
      vi.mocked(getCanvasBridge).mockReturnValueOnce(undefined);
      const result = await runToolContract(compareCompaniesTool, {
        companies: ['CAL', 'JUN'],
        concepts: ['revenue'],
        periods: 2,
      });

      const output = compareCompaniesTool.output.parse(result.structuredContent);
      expect(output.periods).toEqual(['CY2025', 'CY2024']);
      const notice = String((result.structuredContent as { notice?: string }).notice);
      expect(notice).toBe(
        'Showing the 2 most-recent of 5 aligned periods. Raise periods (up to 12) to fit more periods inline.',
      );
      // The notice renders in the enrichment trailer, a block after format()'s.
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain(notice);
    });

    it('tells the caller to narrow companies or concepts when the cell ceiling bounds it', async () => {
      wireWideFilers();
      vi.mocked(getCanvasBridge).mockReturnValueOnce(undefined);
      const ctx = createMockContext({ errors: compareCompaniesTool.errors });
      const input = compareCompaniesTool.input.parse({
        companies: Array.from({ length: 10 }, (_, i) => `T${i}`),
        concepts: ['revenue', 'net_income'],
        periods: 12,
      });
      const result = await compareCompaniesTool.handler(input, ctx);

      expect(result.periods).toHaveLength(6);
      expect(String(getEnrichment(ctx).notice)).toBe(
        'Showing the 6 most-recent of 12 aligned periods. Narrow companies or concepts to fit more periods inline.',
      );
    });

    it('points at secedgar_get_financials once periods is already at its cap', async () => {
      const years = Array.from({ length: 14 }, (_, i) => 2012 + i);
      mockApi.tryGetCompanyFacts.mockResolvedValue({
        cik: 1,
        entityName: 'LONG CO',
        facts: {
          'us-gaap': {
            Revenues: {
              label: 'Revenues',
              units: {
                USD: years.map((year) => fact({ frame: `CY${year}`, end: `${year}-12-31` })),
              },
            },
          },
        },
      });
      vi.mocked(getCanvasBridge).mockReturnValueOnce(undefined);
      const ctx = createMockContext({ errors: compareCompaniesTool.errors });
      const input = compareCompaniesTool.input.parse({
        companies: ['CAL', 'JUN'],
        concepts: ['revenue'],
        periods: 12,
      });
      const result = await compareCompaniesTool.handler(input, ctx);

      expect(result.periods).toHaveLength(12);
      expect(String(getEnrichment(ctx).notice)).toBe(
        'Showing the 12 most-recent of 14 aligned periods. 12 is the most periods the inline matrix shows; secedgar_get_financials returns one company’s full history of a concept.',
      );
    });
  });

  // periods above 12 is served at 12 while EDGAR_CLAMP_OVERSIZED_LIMITS is on; the mechanism
  // is tabled in tests/mcp-server/tools/limit-clamp.test.ts (#197).
  describe('periods above the 12 cap (#197)', () => {
    const args = { companies: ['CAL', 'JUN'], concepts: ['revenue'] };

    beforeEach(() => {
      const years = Array.from({ length: 14 }, (_, i) => 2012 + i);
      mockApi.tryGetCompanyFacts.mockResolvedValue({
        cik: 1,
        entityName: 'LONG CO',
        facts: {
          'us-gaap': {
            Revenues: {
              label: 'Revenues',
              units: {
                USD: years.map((year) => fact({ frame: `CY${year}`, end: `${year}-12-31` })),
              },
            },
          },
        },
      });
    });

    it('answers periods 13 exactly as periods 12, cap and widening guidance included', async () => {
      vi.mocked(getCanvasBridge).mockReturnValue(undefined);
      const at12 = await runToolContract(compareCompaniesTool, { ...args, periods: 12 });
      const at13 = await runToolContract(compareCompaniesTool, { ...args, periods: 13 });

      expect(at13).toEqual(at12);
      expect(at13.structuredContent).toMatchObject({ cap: 12, shown: 12 });
      expect(String((at13.structuredContent as { notice?: string }).notice)).toContain(
        '12 is the most periods the inline matrix shows',
      );
    });

    it('answers periods 13 exactly as periods 12 when the series is staged as a dataframe', async () => {
      const registerDataframe = vi.fn().mockResolvedValue({
        name: 'df_PERIO_CLAMP',
        rowCount: 28,
        expiresAt: '2026-11-01T00:00:00.000Z',
      });
      vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as never);
      vi.mocked(toDatasetField).mockReturnValue({
        name: 'df_PERIO_CLAMP',
        row_count: 28,
        expires_at: '2026-11-01T00:00:00.000Z',
      });

      const at12 = await runToolContract(compareCompaniesTool, { ...args, periods: 12 });
      const at13 = await runToolContract(compareCompaniesTool, { ...args, periods: 13 });

      expect(registerDataframe).toHaveBeenCalledTimes(2);
      expect(registerDataframe.mock.calls[1]?.[1]).toEqual(registerDataframe.mock.calls[0]?.[1]);
      expect(at13).toEqual(at12);
    });

    it('advertises 1000 as the maximum with the switch on and 12 with it off, which rejects 13', async () => {
      const maximum = (clampOversizedLimits: boolean) => {
        const def = buildToolDefinitions({ dropEnabled: false, clampOversizedLimits }).find(
          (d) => d.name === 'secedgar_compare_companies',
        );
        return (z.toJSONSchema(def!.input, { io: 'input' }) as any).properties.periods.maximum;
      };
      expect(maximum(true)).toBe(1000);
      expect(maximum(false)).toBe(12);

      const off = createCompareCompaniesTool({ clampOversizedLimits: false });
      const rejected = await runToolContract(off, { ...args, periods: 13 });
      expect(wireError(rejected).code).toBe(JsonRpcErrorCode.InvalidParams);
    });
  });

  // A list past its cap is answered up to the cap while EDGAR_CLAMP_OVERSIZED_LIMITS is
  // on; switched off, the cap is the list's maximum, as before (#201).
  it.each([
    // [switch, companies, concepts, accepted]
    [true, 1, 1, false],
    [true, 2, 0, false],
    [true, 11, 9, true],
    [true, 100, 100, true],
    [true, 101, 1, false],
    [true, 2, 101, false],
    [false, 10, 8, true],
    [false, 11, 1, false],
    [false, 2, 9, false],
    [false, 101, 1, false],
  ])(
    'switch %s: %i companies and %i concepts accepted is %s',
    (clampOversizedLimits, companies, concepts, accepted) => {
      const input = {
        companies: Array.from({ length: companies }, (_, i) => `T${i}`),
        concepts: Array.from({ length: concepts }, (_, i) => `C${i}`),
      };
      expect(
        createCompareCompaniesTool({ clampOversizedLimits }).input.safeParse(input).success,
      ).toBe(accepted);
    },
  );

  it('switched off, rejects an 11th company before resolving any', async () => {
    const off = createCompareCompaniesTool({ clampOversizedLimits: false });
    const rejected = await runToolContract(off, {
      companies: Array.from({ length: 11 }, (_, i) => `T${i}`),
      concepts: ['revenue'],
    });

    expect(wireError(rejected).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(mockApi.resolveCik).not.toHaveBeenCalled();
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

  it('says plainly that nobody reports the concept when no snapshot was left out', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: ['goodwill'],
    });

    const error = wireError(result);
    expect(error.message).toBe(
      'None of the 2 resolved companies report any of the requested concepts for annual periods.',
    );
    expect(bag(error.data.recovery).hint).toBe(
      'Switch period_type, or discover reported concept names with secedgar_search_concepts.',
    );
  });

  it('describes annual alignment on fiscal years, not calendar periods', () => {
    expect(compareCompaniesTool.description).toMatch(
      /^Compare 2-10 named companies across 1-8 XBRL concepts, aligned on fiscal years \(annual\) or calendar quarters \(quarterly\)\. /,
    );
    expect(compareCompaniesTool.description).not.toContain('aligned on calendar periods');
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

  /**
   * One company's series stopping years back sits next to current values from
   * the others, and the spread reads as a business fact unless the gap is named.
   */
  describe('stopped-series staleness caveat (#102)', () => {
    /** Reports revenue through CY2025 but stopped tagging assets after CY2021. */
    const laggingFiler: CompanyFactsResponse = {
      cik: 111111,
      entityName: 'LAGGING CO',
      facts: {
        'us-gaap': {
          Revenues: {
            label: 'Revenues',
            units: {
              USD: [2021, 2022, 2023, 2024, 2025].map((year) => calendarYear10K('lag', year, year)),
            },
          },
          Assets: {
            label: 'Total Assets',
            units: { USD: [fact({ frame: 'CY2021Q4I', end: '2021-12-31', val: 42 })] },
          },
        },
      },
    };

    beforeEach(() => {
      mockApi.tryGetCompanyFacts.mockImplementation(async (cik: string) =>
        cik === '0000111111' ? laggingFiler : calendarFiler,
      );
      mockApi.resolveCik.mockImplementation(async (input: string) =>
        input === 'LAG'
          ? { cik: '0000111111', name: 'LAGGING CO' }
          : { cik: '0000789019', name: 'CALENDAR CO' },
      );
    });

    it('names the company and concept whose series stopped', async () => {
      const ctx = createMockContext({ errors: compareCompaniesTool.errors });
      const input = compareCompaniesTool.input.parse({
        companies: ['CAL', 'LAG'],
        concepts: ['assets'],
      });
      const result = await compareCompaniesTool.handler(input, ctx);

      const stale = result.caveats.find((c) => c.startsWith('LAGGING CO / assets: '));
      expect(stale).toBeDefined();
      expect(stale).toContain('4.0 years');
      expect(result.caveats.some((c) => c.startsWith('CALENDAR CO / assets: '))).toBe(false);
    });

    it('measures against the filer’s whole catalog, not just the requested concepts', async () => {
      // With only `assets` requested, a reference drawn from the request would
      // compare that series against itself and never report it.
      const ctx = createMockContext({ errors: compareCompaniesTool.errors });
      const input = compareCompaniesTool.input.parse({
        companies: ['CAL', 'LAG'],
        concepts: ['assets'],
      });
      const result = await compareCompaniesTool.handler(input, ctx);

      expect(
        result.caveats.some((c) =>
          c.includes('the newest period this filer reports (ending 2025-12-31)'),
        ),
      ).toBe(true);
    });
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
    const text = blockText(compareCompaniesTool.format!(result));

    expect(text).toContain('CALENDAR CO');
    expect(text).toContain('JUNE CO');
    expect(text).toContain('CY2025 = ');
    expect(text).toContain('us-gaap:Revenues');
  });
});

// Through the real tool pipeline, so both client surfaces are asserted (#128).
describe('concept names that are neither a friendly name nor an XBRL tag (#128)', () => {
  const edgarCalls = () =>
    mockApi.resolveCik.mock.calls.length + mockApi.tryGetCompanyFacts.mock.calls.length;

  it('fails as unknown_concept before any EDGAR call when every concept is unknown', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: ['free_cash_flow', 'ebitda', 'total_debt'],
    });

    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('unknown_concept');
    expect(records(error.data.unknown_concepts).map((u) => u.concept)).toEqual([
      'free_cash_flow',
      'ebitda',
      'total_debt',
    ]);
    const text = blockText(result.content);
    for (const needle of [
      'free_cash_flow',
      'operating_cash_flow − capex',
      'operating_income + depreciation_amortization',
      'debt',
      'secedgar_search_concepts',
      'reason unknown_concept',
    ]) {
      expect(text).toContain(needle);
    }
    expect(edgarCalls()).toBe(0);
  });

  it('answers the known concepts and reports an unknown one once, apart from the gaps', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: ['revenue', 'free_cash_flow'],
    });

    expect(result.isError).toBeFalsy();
    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(new Set(output.cells.map((c) => c.company))).toEqual(
      new Set(['CALENDAR CO', 'JUNE CO']),
    );
    expect(output.cells.every((c) => c.concept === 'revenue')).toBe(true);
    expect(output.gaps).toEqual([]);
    expect(output.concepts.map((c) => c.concept)).toEqual(['revenue']);
    expect(output.unknown_concepts).toEqual([
      { concept: 'free_cash_flow', derivation: 'operating_cash_flow − capex', suggestions: [] },
    ]);

    // The text carries the same hint the unknown_concept error would.
    const text = blockText(result.content);
    expect(text).not.toContain('reports no free_cash_flow');
    expect(text.match(/free_cash_flow/g)).toHaveLength(1);
    expect(text).toContain(
      'Unknown concept: free_cash_flow — not queried. Derive it as operating_cash_flow − capex from those concepts. List every supported name with secedgar_search_concepts',
    );
  });

  it('reports a repeated unknown concept once', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: ['revenue', 'fcf', ' fcf'],
    });

    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(output.unknown_concepts.map((u) => u.concept)).toEqual(['fcf']);
    expect(at(output.unknown_concepts).suggestions).toEqual([]);
  });

  it('reports no unknown concepts when every concept resolves', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: ['revenue'],
    });

    expect(compareCompaniesTool.output.parse(result.structuredContent).unknown_concepts).toEqual(
      [],
    );
    expect(blockText(result.content)).not.toContain('Unknown concept');
  });

  it('trims surrounding whitespace, so " revenue " resolves to the revenue concept', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: [' revenue '],
    });

    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(output.gaps).toEqual([]);
    expect(output.cells.every((c) => c.tag === 'Revenues')).toBe(true);
    expect(output.cells.length).toBeGreaterThan(0);
  });

  it('names the unknown concepts on a no_comparable_data failure too', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: ['goodwill', 'free_cash_flow'],
    });

    const error = wireError(result);
    expect(error.data.reason).toBe('no_comparable_data');
    expect(records(error.data.unknown_concepts).map((u) => u.concept)).toEqual(['free_cash_flow']);
    expect(blockText(result.content)).toContain('free_cash_flow');
  });

  // Characterization: these shapes resolved before the check existed.
  it.each([
    ['REVENUE', 'Revenues'],
    ['Revenues', 'Revenues'],
  ])('resolves %j and reads its values', async (concept, tag) => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: [concept],
    });

    expect(result.isError).toBeFalsy();
    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(output.cells.length).toBeGreaterThan(0);
    expect(output.cells.every((c) => c.tag === tag)).toBe(true);
  });
});

describe('concept inputs that resolve to the same concept (#145)', () => {
  /** Merge notes among the caveats. */
  const mergeNotes = (caveats: string[]) => caveats.filter((c) => c.includes('same concept as'));

  it('compares spellings of one catalog concept once, under the first spelling, on both surfaces', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: ['revenue', 'Revenue', ' revenue'],
      periods: 2,
    });

    expect(result.isError).toBeFalsy();
    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(output.concepts.map((c) => c.concept)).toEqual(['revenue']);
    const keys = output.cells.map((c) => `${c.company}|${c.concept}|${c.period}`);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(keys.length);
    expect(output.cells.every((c) => c.concept === 'revenue')).toBe(true);
    expect(mergeNotes(output.caveats)).toEqual([
      "'Revenue' and ' revenue' resolve to the same concept as 'revenue', so the comparison reads them once, under 'revenue'.",
    ]);
    const text = blockText(result.content);
    expect(text).toContain(`Caveat: ${at(mergeNotes(output.caveats))}`);
    expect(text.match(/^Concept: /gm)).toHaveLength(1);
  });

  it('merges a raw tag repeated with surrounding whitespace', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: ['Revenues', ' Revenues '],
      periods: 2,
    });

    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(output.concepts.map((c) => c.concept)).toEqual(['Revenues']);
    expect(output.cells).toHaveLength(4);
    expect(mergeNotes(output.caveats)).toEqual([
      "' Revenues ' resolves to the same concept as 'Revenues', so the comparison reads it once, under 'Revenues'.",
    ]);
  });

  it('keeps a catalog name and a raw tag it walks as separate concepts', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: ['revenue', 'Revenues'],
      periods: 2,
    });

    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(output.concepts.map((c) => c.concept)).toEqual(['revenue', 'Revenues']);
    expect(output.cells).toHaveLength(8);
    expect(mergeNotes(output.caveats)).toEqual([]);
  });

  it('reports a gap once rather than once per merged spelling', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: ['assets', 'Assets '],
    });

    const output = compareCompaniesTool.output.parse(result.structuredContent);
    // JUNE CO reports no assets at all.
    expect(output.gaps.map((g) => [g.company, g.concept])).toEqual([['JUNE CO', 'assets']]);
    expect(blockText(result.content).match(/reports no assets/g)).toHaveLength(1);
  });
});

/** Eight distinct catalog concepts: the most one call compares. */
const EIGHT_CONCEPTS = [
  'revenue',
  'assets',
  'net_income',
  'goodwill',
  'cogs',
  'eps_diluted',
  'liabilities',
  'cash',
];

/** CAL and JUN resolve; any other input resolves to nothing. */
function wireTwoFilersAmongUnresolved() {
  mockApi.resolveCik.mockImplementation(async (q: string) =>
    q === 'CAL'
      ? { cik: '0000789019', name: 'CALENDAR CO', ticker: 'CAL' }
      : q === 'JUN'
        ? { cik: '0000320193', name: 'JUNE CO', ticker: 'JUN' }
        : [],
  );
}

/**
 * Characterization: a call at both caps — ten company inputs (an unresolved one
 * keeps its place) and eight distinct concepts — pinned on both surfaces as it
 * answered before an over-cap list was accepted (#201).
 */
describe('lists at their caps', () => {
  const atCaps = {
    companies: ['CAL', 'JUN', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8'],
    concepts: EIGHT_CONCEPTS,
    periods: 1,
  };

  beforeEach(() => {
    wireTwoFilersAmongUnresolved();
  });

  it('answers on both surfaces as before, with no deferred field', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);
    const result = await runToolContract(compareCompaniesTool, atCaps);

    expect(result.isError).toBeFalsy();
    expect(Object.keys(bag(result.structuredContent)).sort()).toEqual([
      'cap',
      'caveats',
      'cells',
      'companies',
      'concepts',
      'dataset',
      'failed_companies',
      'gaps',
      'notice',
      'period_type',
      'periods',
      'shown',
      'taxonomy',
      'truncated',
      'unknown_concepts',
    ]);
    const excluded = atCaps.companies
      .slice(2)
      .map(
        (q) =>
          `Excluded: ${q} (not_found) — '${q}' did not resolve to a CIK. Use a ticker symbol or 10-digit CIK.`,
      );
    const notReported = (company: string, cik: string, concepts: string[][]) =>
      concepts.map(
        ([concept, tags]) => `- ${company} (CIK ${cik}) reports no ${concept} — tried: ${tags}`,
      );
    const unreported = [
      ['net_income', 'NetIncomeLoss'],
      ['goodwill', 'Goodwill'],
      ['cogs', 'CostOfGoodsAndServicesSold, CostOfRevenue, CostOfGoodsSold'],
      ['eps_diluted', 'EarningsPerShareDiluted'],
      ['liabilities', 'Liabilities'],
      ['cash', 'CashAndCashEquivalentsAtCarryingValue'],
    ];
    expect(result.content.map((b) => (b.type === 'text' ? b.text : b.type))).toEqual([
      [
        '**Company comparison** — 2 companies x 8 concepts (us-gaap, annual)',
        'Periods: CY2025',
        'Companies: CALENDAR CO [CAL → CIK 0000789019, CAL]; JUNE CO [JUN → CIK 0000320193, JUN]',
        ...excluded,
        'Concept: Revenue [revenue] — units: USD',
        'Concept: Total Assets [assets] — units: USD',
        'Concept: Net Income (Loss) [net_income] — units: none',
        'Concept: Goodwill [goodwill] — units: none',
        'Concept: Cost of Goods Sold [cogs] — units: none',
        'Concept: Earnings Per Share (Diluted) [eps_diluted] — units: none',
        'Concept: Total Liabilities [liabilities] — units: none',
        'Concept: Cash and Cash Equivalents [cash] — units: none',
        '',
        '### Values',
        '- revenue | CALENDAR CO (CIK 0000789019) | CY2025 = 202500 USD | us-gaap:Revenues | frame CY2025 | ends 2025-12-31 | 10-K [cal-2025]',
        '- revenue | JUNE CO (CIK 0000320193) | CY2025 = 405000 USD | us-gaap:Revenues | frame CY2025 | ends 2025-06-30 | 10-K [acc-1]',
        '',
        '### Not reported (13)',
        ...notReported('CALENDAR CO', '0000789019', unreported),
        ...notReported('JUNE CO', '0000320193', [['assets', 'Assets'], ...unreported]),
        '',
        'Caveat: Period ends differ inside CY2025 — CALENDAR CO ends 2025-12-31, JUNE CO ends 2025-06-30. Each company’s fiscal year sits under the calendar year SEC frames it as, and fiscal years ending months apart share that column, so the comparison is approximate; each cell carries its own period_end.',
        '',
        'Caveat: assets: no value inside the inline periods (CY2025) for CALENDAR CO (newest CY2024). It reports assets for earlier periods only; raise periods to bring those values inline.',
      ].join('\n'),
      '\n\n**truncated:** true\n**shown:** 1\n**cap:** 1\n> Showing the 1 most-recent of 5 aligned periods. Raise periods (up to 12) to fit more periods inline.',
    ]);
  });

  it('stages every concept input and each resolved company in the dataframe parameters', async () => {
    const registerDataframe = vi.fn().mockResolvedValue({
      name: 'df_ATCAP_PARAM',
      rowCount: 9,
      expiresAt: '2026-11-01T00:00:00.000Z',
    });
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as never);
    vi.mocked(toDatasetField).mockReturnValue({
      name: 'df_ATCAP_PARAM',
      row_count: 9,
      expires_at: '2026-11-01T00:00:00.000Z',
    });
    const result = await runToolContract(compareCompaniesTool, {
      ...atCaps,
      concepts: ['revenue', 'Revenue', ...EIGHT_CONCEPTS.slice(1, 7)],
    });

    expect(result.isError).toBeFalsy();
    expect(at(registerDataframe.mock.calls)[1].queryParams).toEqual({
      companies: ['0000789019', '0000320193'],
      concepts: ['revenue', 'Revenue', ...EIGHT_CONCEPTS.slice(1, 7)],
      taxonomy: 'us-gaap',
      period_type: 'annual',
    });
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      'Showing the 1 most-recent of 5 aligned periods. Full set staged as df_ATCAP_PARAM (9 rows) — use secedgar_dataframe_describe to inspect its columns, then secedgar_dataframe_query to analyze it with SQL.',
    );
  });

  it('writes no clamp log line', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);
    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    await compareCompaniesTool.handler(compareCompaniesTool.input.parse(atCaps), ctx);

    expect((ctx.log as MockContextLogger).calls.map((c) => c.msg)).toEqual(['Comparison built']);
  });

  it('counts the supplied companies when none of the ten resolves', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const result = await runToolContract(compareCompaniesTool, atCaps);

    const error = wireError(result);
    expect(error.data.reason).toBe('no_companies_resolved');
    expect(error.message).toBe('None of the 10 supplied companies resolved to a CIK.');
    expect(Object.keys(error.data).sort()).toEqual(['failed_companies', 'reason', 'recovery']);
  });
});

/**
 * Two inputs naming one company (a ticker beside its CIK, or the same ticker
 * twice) read its companyfacts once and enter the comparison once, under the
 * first input, the way spellings of one concept do (#217).
 */
describe('a company named twice (#217)', () => {
  const CAL_CIK = '0000789019';

  beforeEach(() => {
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);
    // Every input but JUN resolves to CALENDAR CO, as a ticker and its CIK both do.
    mockApi.resolveCik.mockImplementation(async (q: string) =>
      q === 'JUN'
        ? { cik: '0000320193', name: 'JUNE CO', ticker: 'JUN' }
        : { cik: CAL_CIK, name: 'CALENDAR CO', ticker: 'CAL' },
    );
  });

  const calReads = () => mockApi.tryGetCompanyFacts.mock.calls.filter(([cik]) => cik === CAL_CIK);

  it('reads a ticker and its CIK once, under the first input, on both surfaces', async () => {
    const registerDataframe = vi.fn().mockResolvedValue({
      name: 'df_TWICE_NAMED',
      rowCount: 10,
      expiresAt: '2026-11-01T00:00:00.000Z',
    });
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as never);
    vi.mocked(toDatasetField).mockReturnValue({
      name: 'df_TWICE_NAMED',
      row_count: 10,
      expires_at: '2026-11-01T00:00:00.000Z',
    });

    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', CAL_CIK, 'JUN'],
      concepts: ['revenue', 'assets'],
      periods: 2,
    });

    expect(result.isError).toBeFalsy();
    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(output.companies.map((c) => [c.input, c.cik])).toEqual([
      ['CAL', CAL_CIK],
      ['JUN', '0000320193'],
    ]);
    expect(output.failed_companies).toEqual([]);
    expect(calReads()).toHaveLength(1);
    // Revenue for CY2025 and CY2024 plus the CY2024 balance — once each.
    expect(
      output.cells.filter((c) => c.cik === CAL_CIK).map((c) => `${c.concept}|${c.period}`),
    ).toEqual(['revenue|CY2025', 'revenue|CY2024', 'assets|CY2024']);
    expect(output.gaps.map((g) => [g.company, g.concept])).toEqual([['JUNE CO', 'assets']]);

    const note =
      "'0000789019' names the same company as 'CAL', so the comparison reads it once, under 'CAL'.";
    expect(output.caveats.filter((c) => c.includes('same company as'))).toEqual([note]);
    const text = blockText(result.content);
    expect(text).toContain(`Caveat: ${note}`);
    expect(text.match(/CALENDAR CO \[/g)).toHaveLength(1);
    expect(text.match(/- revenue \| CALENDAR CO/g)).toHaveLength(2);

    const staged = at(registerDataframe.mock.calls)[1];
    expect(staged.queryParams.companies).toEqual([CAL_CIK, '0000320193']);
    // Five revenue years and two balances for CALENDAR CO, three revenue years for JUNE CO.
    expect(staged.rows.filter((r: { cik: string }) => r.cik === CAL_CIK)).toHaveLength(7);
    expect(staged.rows).toHaveLength(10);
  });

  it('answers the same ticker twice exactly as once', async () => {
    const twice = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'CAL', 'JUN'],
      concepts: ['revenue', 'assets'],
    });
    expect(calReads()).toHaveLength(1);

    const once = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: ['revenue', 'assets'],
    });
    expect(twice).toEqual(once);
  });

  it('names every later input in one caveat', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', '789019', CAL_CIK, 'JUN'],
      concepts: ['revenue'],
    });

    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(output.companies.map((c) => c.input)).toEqual(['CAL', 'JUN']);
    expect(output.caveats.filter((c) => c.includes('same company as'))).toEqual([
      "'789019' and '0000789019' name the same company as 'CAL', so the comparison reads them once, under 'CAL'.",
    ]);
    expect(calReads()).toHaveLength(1);
  });
});

/** The log line one deferred list writes, by field. */
const clampLines = (ctx: ReturnType<typeof createMockContext>) =>
  (ctx.log as MockContextLogger).calls
    .filter((c) => c.msg === 'List above its cap answered up to the cap, the rest deferred')
    .map((c) => c.data);

/**
 * A `companies` list past 10 or a `concepts` list past 8 distinct concepts
 * answers up to the cap and returns the rest, as supplied, for a re-call
 * (#201). The mechanism (schema bounds, log line, counter) is tabled in
 * tests/mcp-server/tools/limit-clamp.test.ts; this proves the wiring.
 */
describe('lists past their caps (#201)', () => {
  const TEN = ['CAL', 'JUN', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8'];
  const ONE_COMPANY_DEFERRED =
    'This call takes the first 10 of 11 companies; deferred_companies lists the rest. Re-call with deferred_companies as companies and the same other inputs to compare them. Add a company from this call beside the lone deferred one, since companies takes at least two.';
  const CONCEPTS_DEFERRED =
    'This call takes the first 8 distinct concepts; deferred_concepts lists the rest. Re-call with deferred_concepts as concepts and the same other inputs to compare them.';

  beforeEach(() => {
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);
    wireTwoFilersAmongUnresolved();
  });

  /** Stage the comparison as a dataframe, returning the registration spy. */
  function stage() {
    const registerDataframe = vi.fn().mockResolvedValue({
      name: 'df_PAST_CAPS1',
      rowCount: 8,
      expiresAt: '2026-11-01T00:00:00.000Z',
    });
    vi.mocked(getCanvasBridge).mockReturnValue({ registerDataframe } as never);
    vi.mocked(toDatasetField).mockReturnValue({
      name: 'df_PAST_CAPS1',
      row_count: 8,
      expires_at: '2026-11-01T00:00:00.000Z',
    });
    return registerDataframe;
  }

  it('answers the first 10 companies and lists the 11th, never resolving it, on both surfaces', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: [...TEN, 'X11'],
      concepts: ['revenue'],
      periods: 1,
    });

    expect(result.isError).toBeFalsy();
    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(output.deferred_companies).toEqual(['X11']);
    expect(output.failed_companies.map((f) => f.input)).toEqual(TEN.slice(2));
    expect(mockApi.resolveCik.mock.calls.map(([q]) => q)).toEqual(TEN);
    expect(blockText(result.content)).toContain("Deferred companies (not read): 'X11'");
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toBe(
      `${ONE_COMPANY_DEFERRED} Showing the 1 most-recent of 5 aligned periods. Raise periods (up to 12) to fit more periods inline.`,
    );
    expect(allText(result)).toContain(`> ${notice}`);
  });

  it('answers exactly what the call with only the first 10 answers, dataframe included', async () => {
    const registerDataframe = stage();
    const over = await runToolContract(compareCompaniesTool, {
      companies: [...TEN, 'X11', 'X12'],
      concepts: ['revenue', 'assets'],
      periods: 1,
    });
    const atCap = await runToolContract(compareCompaniesTool, {
      companies: TEN,
      concepts: ['revenue', 'assets'],
      periods: 1,
    });

    const { deferred_companies, notice, ...answered } = bag(over.structuredContent);
    const { notice: atCapNotice, ...atCapAnswered } = bag(atCap.structuredContent);
    expect(deferred_companies).toEqual(['X11', 'X12']);
    expect(answered).toEqual(atCapAnswered);
    expect(notice).toBe(
      `This call takes the first 10 of 12 companies; deferred_companies lists the rest. Re-call with deferred_companies as companies and the same other inputs to compare them. ${atCapNotice}`,
    );
    expect(
      blockText(over.content).replace("\nDeferred companies (not read): 'X11', 'X12'", ''),
    ).toBe(blockText(atCap.content));
    expect(registerDataframe).toHaveBeenCalledTimes(2);
    expect(at(registerDataframe.mock.calls, 0)[1]).toEqual(at(registerDataframe.mock.calls, 1)[1]);
  });

  it('counts a company named twice in its place, so the 11th input is still deferred', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'CAL', ...TEN.slice(2), 'JUN'],
      concepts: ['revenue'],
    });

    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(output.deferred_companies).toEqual(['JUN']);
    expect(output.companies.map((c) => c.input)).toEqual(['CAL']);
    expect(mockApi.resolveCik.mock.calls.map(([q]) => q)).not.toContain('JUN');
  });

  it('answers the first 8 distinct concepts and lists the inputs after them', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: [...EIGHT_CONCEPTS, 'debt', 'capex'],
      periods: 1,
    });

    expect(result.isError).toBeFalsy();
    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(output.deferred_concepts).toEqual(['debt', 'capex']);
    expect(output.concepts.map((c) => c.concept)).toEqual(EIGHT_CONCEPTS);
    expect(output.gaps.some((g) => g.concept === 'debt' || g.concept === 'capex')).toBe(false);
    const text = blockText(result.content);
    expect(text).toContain("Deferred concepts (not read): 'debt', 'capex'");
    expect(text).not.toContain('reports no debt');
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      `${CONCEPTS_DEFERRED} Showing the 1 most-recent of 5 aligned periods. Raise periods (up to 12) to fit more periods inline.`,
    );
  });

  it('defers nothing when the ninth input is another spelling of an earlier concept', async () => {
    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const result = await compareCompaniesTool.handler(
      compareCompaniesTool.input.parse({
        companies: ['CAL', 'JUN'],
        concepts: [...EIGHT_CONCEPTS, 'Revenue'],
      }),
      ctx,
    );

    expect(result).not.toHaveProperty('deferred_concepts');
    expect(result.concepts.map((c) => c.concept)).toEqual(EIGHT_CONCEPTS);
    expect(result.caveats).toContain(
      "'Revenue' resolves to the same concept as 'revenue', so the comparison reads it once, under 'revenue'.",
    );
    expect(clampLines(ctx)).toEqual([]);
  });

  it('counts an unrecognized name as no concept and merges a later spelling of an answered one', async () => {
    const registerDataframe = stage();
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: ['revenue', 'fcf', ...EIGHT_CONCEPTS.slice(1), 'debt', 'Revenue', 'DEBT'],
    });

    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(output.unknown_concepts.map((u) => u.concept)).toEqual(['fcf']);
    expect(output.concepts.map((c) => c.concept)).toEqual(EIGHT_CONCEPTS);
    // A spelling of a deferred concept is deferred with it, as supplied.
    expect(output.deferred_concepts).toEqual(['debt', 'DEBT']);
    expect(output.caveats).toContain(
      "'Revenue' resolves to the same concept as 'revenue', so the comparison reads it once, under 'revenue'.",
    );
    expect(at(registerDataframe.mock.calls)[1].queryParams.concepts).toEqual([
      'revenue',
      'fcf',
      ...EIGHT_CONCEPTS.slice(1),
      'Revenue',
    ]);
  });

  it('returns deferred inputs exactly as supplied, surrounding spaces included', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: [...TEN, ' x11 '],
      concepts: [...EIGHT_CONCEPTS, ' debt '],
    });

    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(output.deferred_companies).toEqual([' x11 ']);
    expect(output.deferred_concepts).toEqual([' debt ']);
    const text = readCommonMark(blockText(result.content));
    expect(text).toContain("Deferred companies (not read): ' x11 '");
    expect(text).toContain("Deferred concepts (not read): ' debt '");
  });

  it('reports an unrecognized name past the eighth concept as unknown, not deferred', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: [...EIGHT_CONCEPTS, 'debt', 'fcf'],
    });

    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(output.deferred_concepts).toEqual(['debt']);
    expect(output.unknown_concepts.map((u) => u.concept)).toEqual(['fcf']);
  });

  it('composes both deferrals into one notice ahead of the dataframe pointer', async () => {
    stage();
    const result = await runToolContract(compareCompaniesTool, {
      companies: [...TEN, 'X11', 'X12'],
      concepts: [...EIGHT_CONCEPTS, 'debt'],
      periods: 12,
    });

    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(output.deferred_companies).toEqual(['X11', 'X12']);
    expect(output.deferred_concepts).toEqual(['debt']);
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      'This call takes the first 10 of 12 companies and the first 8 distinct concepts; deferred_companies and deferred_concepts list the rest. To compare them, re-call three times with the same other inputs: (1) deferred_companies as companies with those 8 concepts, (2) those 10 companies with deferred_concepts as concepts, and (3) deferred_companies as companies with deferred_concepts as concepts. Full set staged as df_PAST_CAPS1 (8 rows) — use secedgar_dataframe_describe to inspect its columns, then secedgar_dataframe_query to analyze it with SQL.',
    );
  });

  it('carries the deferral alone when nothing else needs a notice', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['CAL', 'JUN'],
      concepts: [...EIGHT_CONCEPTS, 'debt'],
      periods: 12,
    });

    const structured = result.structuredContent as { notice?: string; truncated?: boolean };
    expect(structured.truncated).toBeUndefined();
    expect(structured.notice).toBe(CONCEPTS_DEFERRED);
  });

  it('writes one clamp log line per deferred list', async () => {
    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    await compareCompaniesTool.handler(
      compareCompaniesTool.input.parse({
        companies: [...TEN, 'X11', 'X12'],
        concepts: [...EIGHT_CONCEPTS, 'debt'],
      }),
      ctx,
    );

    expect(clampLines(ctx)).toEqual([
      { tool: 'secedgar_compare_companies', field: 'companies', cap: 10, deferred: 2 },
      { tool: 'secedgar_compare_companies', field: 'concepts', cap: 8, deferred: 1 },
    ]);
  });

  it('records no deferral when every concept is unknown and nothing is read', async () => {
    const ctx = createMockContext({ errors: compareCompaniesTool.errors });
    const input = compareCompaniesTool.input.parse({
      companies: [...TEN, 'X11'],
      concepts: ['fcf'],
    });

    await expect(compareCompaniesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'unknown_concept' },
    });
    expect(clampLines(ctx)).toEqual([]);
    expect(mockApi.resolveCik).not.toHaveBeenCalled();
  });

  it('names the deferred companies on a no_companies_resolved failure, in message and data', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: [...TEN.slice(2), 'N9', 'N10', 'CAL'],
      concepts: ['revenue'],
    });

    const error = wireError(result);
    expect(error.data.reason).toBe('no_companies_resolved');
    expect(error.message).toBe(
      "None of the first 10 supplied companies resolved to a CIK. Inputs past the first 10 companies were not read — deferred_companies: 'CAL'.",
    );
    expect(error.data.deferred_companies).toEqual(['CAL']);
    expect(error.data).not.toHaveProperty('deferred_concepts');
    expect(mockApi.resolveCik.mock.calls.map(([q]) => q)).not.toContain('CAL');
    expect(blockText(result.content)).toContain("deferred_companies: 'CAL'");
  });

  it('names the deferred concepts on a no_comparable_data failure, in message and data', async () => {
    const unreported = [
      'goodwill',
      'net_income',
      'cogs',
      'eps_diluted',
      'liabilities',
      'cash',
      'debt',
      'capex',
    ];
    const result = await runToolContract(compareCompaniesTool, {
      companies: [...TEN, 'X11'],
      concepts: [...unreported, 'revenue'],
    });

    const error = wireError(result);
    expect(error.data.reason).toBe('no_comparable_data');
    expect(error.message).toBe(
      "None of the 2 resolved companies report any of the requested concepts for annual periods. Inputs past the first 10 companies and the first 8 distinct concepts were not read — deferred_companies: 'X11'; deferred_concepts: 'revenue'.",
    );
    expect(error.data.deferred_companies).toEqual(['X11']);
    expect(error.data.deferred_concepts).toEqual(['revenue']);
    expect(blockText(result.content)).toContain("deferred_concepts: 'revenue'");
  });

  it('says in the error contract that a failure names the deferred lists', () => {
    const when = (reason: string) =>
      compareCompaniesTool.errors?.find((e) => e.reason === reason)?.when;
    for (const reason of ['no_companies_resolved', 'no_comparable_data']) {
      expect(when(reason)).toContain('deferred_companies and deferred_concepts');
    }
  });
});

/**
 * When both lists defer, the cells the call left unread are three sets: the
 * deferred companies under the compared concepts, the compared companies under
 * the deferred concepts, and the two deferred lists together. Each test builds
 * the re-calls the notice names from the first call's output, runs them, and
 * proves they read each of those cells once, every re-call within both caps
 * (#201).
 */
describe('re-calls a two-list deferral names (#201)', () => {
  /** Nine raw tags: every company reports each one for CY2024. */
  const NINE_TAGS = Array.from({ length: 9 }, (_, i) => `Metric${String.fromCharCode(65 + i)}`);
  const companies = (count: number) => Array.from({ length: count }, (_, i) => `C${i + 1}`);

  beforeEach(() => {
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);
    mockApi.resolveCik.mockImplementation(async (q: string) => ({
      cik: `000000${q.slice(1).padStart(4, '0')}`,
      name: `CO ${q}`,
      ticker: q,
    }));
    mockApi.tryGetCompanyFacts.mockImplementation(async (cik: string) => ({
      cik: Number(cik),
      entityName: `CIK ${cik}`,
      facts: {
        'us-gaap': Object.fromEntries(
          NINE_TAGS.map((tag) => [
            tag,
            { label: tag, units: { USD: [calendarYear10K(cik, 2024, 1)] } },
          ]),
        ),
      },
    }));
  });

  /** One call: its output, its notice, and the company|concept cells it read. */
  async function compare(companyInputs: string[], conceptInputs: string[]) {
    const result = await runToolContract(compareCompaniesTool, {
      companies: companyInputs,
      concepts: conceptInputs,
      periods: 1,
    });
    expect(result.isError).toBeFalsy();
    const output = compareCompaniesTool.output.parse(result.structuredContent);
    const notice = (result.structuredContent as { notice?: string }).notice;
    return {
      output,
      notice,
      text: allText(result),
      cells: output.cells.map((c) => `${c.company.slice(3)}|${c.concept}`),
    };
  }

  /** Every company|concept pair of two lists. */
  const pairs = (companyList: string[], conceptList: string[]) =>
    companyList.flatMap((company) => conceptList.map((concept) => `${company}|${concept}`));

  /** Run each re-call, asserting it defers nothing, and return every cell read, repeats kept. */
  async function follow(recalls: Array<{ companies: string[]; concepts: string[] }>) {
    const read: string[] = [];
    for (const recall of recalls) {
      const { output, cells } = await compare(recall.companies, recall.concepts);
      expect(output).not.toHaveProperty('deferred_companies');
      expect(output).not.toHaveProperty('deferred_concepts');
      read.push(...cells);
    }
    return read;
  }

  it('reads each unread cell once across three re-calls, each within both caps', async () => {
    const supplied = companies(12);
    const first = await compare(supplied, NINE_TAGS);

    expect(first.output.deferred_companies).toEqual(['C11', 'C12']);
    expect(first.output.deferred_concepts).toEqual(['MetricI']);
    expect(first.notice).toBe(
      'This call takes the first 10 of 12 companies and the first 8 distinct concepts; deferred_companies and deferred_concepts list the rest. To compare them, re-call three times with the same other inputs: (1) deferred_companies as companies with those 8 concepts, (2) those 10 companies with deferred_concepts as concepts, and (3) deferred_companies as companies with deferred_concepts as concepts.',
    );
    expect(first.text).toContain(`> ${first.notice}`);

    const deferredCompanies = first.output.deferred_companies ?? [];
    const deferredConcepts = first.output.deferred_concepts ?? [];
    const comparedConcepts = first.output.concepts.map((c) => c.concept);
    const thoseTen = supplied.slice(0, 10);
    const read = await follow([
      { companies: deferredCompanies, concepts: comparedConcepts },
      { companies: thoseTen, concepts: deferredConcepts },
      { companies: deferredCompanies, concepts: deferredConcepts },
    ]);

    const unread = [
      ...pairs(deferredCompanies, comparedConcepts),
      ...pairs(thoseTen, deferredConcepts),
      ...pairs(deferredCompanies, deferredConcepts),
    ];
    expect(first.cells).toEqual(pairs(thoseTen, comparedConcepts));
    expect(read.sort()).toEqual(unread.sort());
    expect(new Set(read).size).toBe(read.length);
  });

  it('reads each unread cell once when one company is deferred, pairing it in calls 1 and 3', async () => {
    const supplied = companies(11);
    const first = await compare(supplied, NINE_TAGS);

    expect(first.output.deferred_companies).toEqual(['C11']);
    expect(first.notice).toBe(
      'This call takes the first 10 of 11 companies and the first 8 distinct concepts; deferred_companies and deferred_concepts list the rest. To compare them, re-call three times with the same other inputs: (1) deferred_companies as companies with those 8 concepts, (2) those 10 companies with deferred_concepts as concepts, and (3) deferred_companies as companies with deferred_concepts as concepts. Since companies takes at least two, add one of those 10 beside the lone deferred company in calls 1 and 3, and leave it out of call 2.',
    );

    const deferredConcepts = first.output.deferred_concepts ?? [];
    const comparedConcepts = first.output.concepts.map((c) => c.concept);
    const thoseTen = supplied.slice(0, 10);
    const [beside = '', ...otherNine] = thoseTen;
    const lonePair = [...(first.output.deferred_companies ?? []), beside];
    const read = await follow([
      { companies: lonePair, concepts: comparedConcepts },
      { companies: otherNine, concepts: deferredConcepts },
      { companies: lonePair, concepts: deferredConcepts },
    ]);

    const unread = [
      ...pairs(['C11'], comparedConcepts),
      ...pairs(thoseTen, deferredConcepts),
      ...pairs(['C11'], deferredConcepts),
    ];
    // Call 1 re-reads its added company's compared cells: companies takes at least two.
    const reread = pairs([beside], comparedConcepts);
    expect(read.sort()).toEqual([...unread, ...reread].sort());
    expect(new Set(read).size).toBe(read.length);
  });
});

/**
 * An annual matrix places each fiscal-year-end balance under its fiscal year's
 * annual key, beside that year's income lines, and leaves interim snapshots out
 * (#171). Values are SEC's, from each filer's companyfacts.
 */
describe('annual alignment of point-in-time concepts (#171)', () => {
  /** [start, end, val, frame, form, accn, filed] — start and frame absent where SEC has none. */
  type Row = [string | undefined, string, number, string | undefined, string, string, string];
  const units = (rows: Row[]): CompanyConceptUnit[] =>
    rows.map(([start, end, val, frame, form, accn, filed]) => ({
      ...(start ? { start } : {}),
      end,
      val,
      ...(frame ? { frame } : {}),
      form,
      accn,
      filed,
      fp: null,
      fy: null,
    }));
  const filer = (
    entityName: string,
    revenue: Row[],
    equity: Row[],
    dei?: CompanyFactsResponse['facts'][string],
  ): CompanyFactsResponse => ({
    entityName,
    facts: {
      'us-gaap': {
        ...(revenue.length > 0
          ? {
              RevenueFromContractWithCustomerExcludingAssessedTax: {
                label: 'Revenue',
                units: { USD: units(revenue) },
              },
            }
          : {}),
        StockholdersEquity: { label: "Stockholders' Equity", units: { USD: units(equity) } },
      },
      ...(dei ? { dei } : {}),
    },
  });

  /** Fiscal year ends June 30. */
  const msft = filer(
    'MICROSOFT CORP',
    [
      [
        '2022-07-01',
        '2023-06-30',
        211915000000,
        undefined,
        '10-K',
        '0000950170-23-035122',
        '2023-07-27',
      ],
      [
        '2022-07-01',
        '2023-06-30',
        211915000000,
        undefined,
        '10-K',
        '0000950170-24-087843',
        '2024-07-30',
      ],
      [
        '2023-07-01',
        '2024-06-30',
        245122000000,
        undefined,
        '10-K',
        '0000950170-24-087843',
        '2024-07-30',
      ],
      [
        '2022-07-01',
        '2023-06-30',
        211915000000,
        'CY2023',
        '10-K',
        '0000950170-25-100235',
        '2025-07-30',
      ],
      [
        '2024-07-01',
        '2025-06-30',
        281724000000,
        undefined,
        '10-K',
        '0000950170-25-100235',
        '2025-07-30',
      ],
      [
        '2023-07-01',
        '2024-06-30',
        245122000000,
        'CY2024',
        '10-K',
        '0001193125-26-323660',
        '2026-07-29',
      ],
      [
        '2024-07-01',
        '2025-06-30',
        281724000000,
        'CY2025',
        '10-K',
        '0001193125-26-323660',
        '2026-07-29',
      ],
      [
        '2025-07-01',
        '2026-06-30',
        331839000000,
        'CY2026',
        '10-K',
        '0001193125-26-323660',
        '2026-07-29',
      ],
    ],
    [
      [
        undefined,
        '2023-06-30',
        206223000000,
        'CY2023Q2I',
        '10-K',
        '0000950170-25-100235',
        '2025-07-30',
      ],
      [
        undefined,
        '2023-09-30',
        220714000000,
        'CY2023Q3I',
        '10-Q',
        '0000950170-24-118967',
        '2024-10-30',
      ],
      [
        undefined,
        '2023-12-31',
        238268000000,
        'CY2023Q4I',
        '10-Q',
        '0000950170-25-010491',
        '2025-01-29',
      ],
      [
        undefined,
        '2024-03-31',
        253152000000,
        'CY2024Q1I',
        '10-Q',
        '0000950170-25-061046',
        '2025-04-30',
      ],
      [
        undefined,
        '2024-06-30',
        268477000000,
        'CY2024Q2I',
        '10-K',
        '0001193125-26-323660',
        '2026-07-29',
      ],
      [
        undefined,
        '2024-09-30',
        287723000000,
        'CY2024Q3I',
        '10-Q',
        '0001193125-25-256321',
        '2025-10-29',
      ],
      [
        undefined,
        '2024-12-31',
        302695000000,
        'CY2024Q4I',
        '10-Q',
        '0001193125-26-027207',
        '2026-01-28',
      ],
      [
        undefined,
        '2025-03-31',
        321891000000,
        'CY2025Q1I',
        '10-Q',
        '0001193125-26-191507',
        '2026-04-29',
      ],
      [
        undefined,
        '2025-06-30',
        343479000000,
        'CY2025Q2I',
        '10-K',
        '0001193125-26-323660',
        '2026-07-29',
      ],
      [
        undefined,
        '2025-09-30',
        363076000000,
        'CY2025Q3I',
        '10-Q',
        '0001193125-25-256321',
        '2025-10-29',
      ],
      [
        undefined,
        '2025-12-31',
        390875000000,
        'CY2025Q4I',
        '10-Q',
        '0001193125-26-027207',
        '2026-01-28',
      ],
      [
        undefined,
        '2026-03-31',
        414367000000,
        'CY2026Q1I',
        '10-Q',
        '0001193125-26-191507',
        '2026-04-29',
      ],
      [
        undefined,
        '2026-06-30',
        442387000000,
        'CY2026Q2I',
        '10-K',
        '0001193125-26-323660',
        '2026-07-29',
      ],
    ],
  );

  /** Fiscal year ends May 31; the newest year-end balance is framed from a later 10-Q. */
  const orcl = filer(
    'ORACLE CORP',
    [
      [
        '2022-06-01',
        '2023-05-31',
        49954000000,
        undefined,
        '10-K',
        '0000950170-23-028914',
        '2023-06-20',
      ],
      [
        '2022-06-01',
        '2023-05-31',
        49954000000,
        undefined,
        '10-K',
        '0000950170-24-075605',
        '2024-06-20',
      ],
      [
        '2023-06-01',
        '2024-05-31',
        52961000000,
        undefined,
        '10-K',
        '0000950170-24-075605',
        '2024-06-20',
      ],
      [
        '2022-06-01',
        '2023-05-31',
        49954000000,
        'CY2022',
        '10-K',
        '0000950170-25-087926',
        '2025-06-18',
      ],
      [
        '2024-06-01',
        '2025-05-31',
        57399000000,
        undefined,
        '10-K',
        '0000950170-25-087926',
        '2025-06-18',
      ],
      [
        '2023-06-01',
        '2024-05-31',
        52961000000,
        'CY2023',
        '10-K',
        '0001193125-26-277521',
        '2026-06-22',
      ],
      [
        '2024-06-01',
        '2025-05-31',
        57399000000,
        'CY2024',
        '10-K',
        '0001193125-26-277521',
        '2026-06-22',
      ],
      [
        '2025-06-01',
        '2026-05-31',
        67357000000,
        'CY2025',
        '10-K',
        '0001193125-26-277521',
        '2026-06-22',
      ],
    ],
    [
      [
        undefined,
        '2023-05-31',
        1073000000,
        'CY2023Q2I',
        '10-K',
        '0000950170-24-075605',
        '2024-06-20',
      ],
      [
        undefined,
        '2023-08-31',
        2370000000,
        'CY2023Q3I',
        '10-Q',
        '0000950170-23-047713',
        '2023-09-12',
      ],
      [
        undefined,
        '2023-11-30',
        3866000000,
        'CY2023Q4I',
        '10-Q',
        '0000950170-23-069682',
        '2023-12-12',
      ],
      [
        undefined,
        '2024-02-29',
        5623000000,
        'CY2024Q1I',
        '10-Q',
        '0000950170-24-029904',
        '2024-03-12',
      ],
      [
        undefined,
        '2024-05-31',
        8704000000,
        'CY2024Q2I',
        '10-K',
        '0000950170-25-087926',
        '2025-06-18',
      ],
      [
        undefined,
        '2024-08-31',
        10816000000,
        'CY2024Q3I',
        '10-Q',
        '0000950170-24-104905',
        '2024-09-10',
      ],
      [
        undefined,
        '2024-11-30',
        13746000000,
        'CY2024Q4I',
        '10-Q',
        '0000950170-24-134973',
        '2024-12-10',
      ],
      [
        undefined,
        '2025-02-28',
        16730000000,
        'CY2025Q1I',
        '10-Q',
        '0000950170-25-037143',
        '2025-03-11',
      ],
      [
        undefined,
        '2025-05-31',
        20451000000,
        'CY2025Q2I',
        '10-K',
        '0001193125-26-277521',
        '2026-06-22',
      ],
      [
        undefined,
        '2025-08-31',
        24154000000,
        'CY2025Q3I',
        '10-Q',
        '0001193125-25-200095',
        '2025-09-10',
      ],
      [
        undefined,
        '2025-11-30',
        29951000000,
        'CY2025Q4I',
        '10-Q',
        '0001193125-25-315925',
        '2025-12-11',
      ],
      [
        undefined,
        '2026-02-28',
        38495000000,
        'CY2026Q1I',
        '10-Q',
        '0001193125-26-101045',
        '2026-03-11',
      ],
      [
        undefined,
        '2026-05-31',
        42508000000,
        'CY2026Q2I',
        '10-Q',
        '0001193125-26-389274',
        '2026-09-11',
      ],
      [
        undefined,
        '2026-08-31',
        66772000000,
        'CY2026Q3I',
        '10-Q',
        '0001193125-26-389274',
        '2026-09-11',
      ],
    ],
  );

  /** December fiscal year, with 2026 still open; its cover page dates shares to 2026-01-30. */
  const bsx = filer(
    'BOSTON SCIENTIFIC CORP',
    [
      [
        '2023-01-01',
        '2023-12-31',
        14240000000,
        undefined,
        '10-K',
        '0000885725-24-000017',
        '2024-02-20',
      ],
      [
        '2023-01-01',
        '2023-12-31',
        14240000000,
        undefined,
        '10-K',
        '0000885725-25-000011',
        '2025-02-18',
      ],
      [
        '2024-01-01',
        '2024-12-31',
        16747000000,
        undefined,
        '10-K',
        '0000885725-25-000011',
        '2025-02-18',
      ],
      [
        '2023-01-01',
        '2023-12-31',
        14240000000,
        'CY2023',
        '10-K',
        '0000885725-26-000010',
        '2026-02-17',
      ],
      [
        '2024-01-01',
        '2024-12-31',
        16747000000,
        'CY2024',
        '10-K',
        '0000885725-26-000010',
        '2026-02-17',
      ],
      [
        '2025-01-01',
        '2025-12-31',
        20074000000,
        'CY2025',
        '10-K',
        '0000885725-26-000010',
        '2026-02-17',
      ],
    ],
    [
      [
        undefined,
        '2023-06-30',
        18226000000,
        'CY2023Q2I',
        '10-Q',
        '0000885725-24-000068',
        '2024-08-01',
      ],
      [
        undefined,
        '2023-09-30',
        18886000000,
        'CY2023Q3I',
        '10-Q',
        '0000885725-24-000073',
        '2024-11-01',
      ],
      [
        undefined,
        '2023-12-31',
        19282000000,
        'CY2023Q4I',
        '10-K',
        '0000885725-25-000011',
        '2025-02-18',
      ],
      [
        undefined,
        '2024-03-31',
        19926000000,
        'CY2024Q1I',
        '10-Q',
        '0000885725-24-000046',
        '2024-05-01',
      ],
      [
        undefined,
        '2024-06-30',
        20371000000,
        'CY2024Q2I',
        '10-Q',
        '0000885725-25-000041',
        '2025-08-01',
      ],
      [
        undefined,
        '2024-09-30',
        20708000000,
        'CY2024Q3I',
        '10-Q',
        '0000885725-25-000050',
        '2025-11-03',
      ],
      [
        undefined,
        '2024-12-31',
        21770000000,
        'CY2024Q4I',
        '10-K',
        '0000885725-26-000010',
        '2026-02-17',
      ],
      [
        undefined,
        '2025-03-31',
        22212000000,
        'CY2025Q1I',
        '10-Q',
        '0000885725-25-000026',
        '2025-05-01',
      ],
      [
        undefined,
        '2025-06-30',
        22418000000,
        'CY2025Q2I',
        '10-Q',
        '0000885725-26-000053',
        '2026-08-03',
      ],
      [
        undefined,
        '2025-09-30',
        23394000000,
        'CY2025Q3I',
        '10-Q',
        '0000885725-25-000050',
        '2025-11-03',
      ],
      [
        undefined,
        '2025-12-31',
        24233000000,
        'CY2025Q4I',
        '10-Q',
        '0000885725-26-000053',
        '2026-08-03',
      ],
      [
        undefined,
        '2026-03-31',
        25864000000,
        'CY2026Q1I',
        '10-Q',
        '0000885725-26-000033',
        '2026-05-01',
      ],
      [
        undefined,
        '2026-06-30',
        24930000000,
        'CY2026Q2I',
        '10-Q',
        '0000885725-26-000053',
        '2026-08-03',
      ],
    ],
    {
      EntityCommonStockSharesOutstanding: {
        label: 'Entity Common Stock, Shares Outstanding',
        units: {
          shares: units([
            [
              undefined,
              '2026-01-30',
              1482000000,
              'CY2025Q4I',
              '10-K',
              '0000885725-26-000010',
              '2026-02-17',
            ],
          ]),
        },
      },
    },
  );

  const byTicker: Record<string, { cik: string; facts: CompanyFactsResponse }> = {
    MSFT: { cik: '0000789019', facts: msft },
    ORCL: { cik: '0001341439', facts: orcl },
    BSX: { cik: '0000885725', facts: bsx },
  };

  beforeEach(() => {
    mockApi.resolveCik.mockImplementation(async (q: string) => {
      const known = byTicker[q];
      return known ? { cik: known.cik, name: known.facts.entityName, ticker: q } : [];
    });
    mockApi.tryGetCompanyFacts.mockImplementation(
      async (cik: string) => Object.values(byTicker).find((k) => k.cik === cik)?.facts ?? null,
    );
  });

  /** [period, value, period_end, frame] of one company-concept's cells, newest first. */
  const line = (
    cells: Array<{
      company: string;
      concept: string;
      period: string;
      value: number;
      period_end: string;
      frame: string;
    }>,
    company: string,
    concept: string,
  ) =>
    cells
      .filter((c) => c.company === company && c.concept === concept)
      .sort((a, b) => b.period.localeCompare(a.period))
      .map((c) => [c.period, c.value, c.period_end, c.frame]);

  const compare = async (args: Record<string, unknown>) => {
    const result = await runToolContract(compareCompaniesTool, args as never);
    expect(result.isError).toBeFalsy();
    return {
      output: compareCompaniesTool.output.parse(result.structuredContent),
      text: blockText(result.content),
    };
  };

  it('keeps a December filer’s closed-year balances as they were', async () => {
    const { output } = await compare({
      companies: ['BSX', 'MSFT'],
      concepts: ['equity'],
      periods: 12,
    });

    expect(
      line(output.cells, 'BOSTON SCIENTIFIC CORP', 'equity').filter(([p]) => p !== 'CY2026'),
    ).toEqual([
      ['CY2025', 24233000000, '2025-12-31', 'CY2025Q4I'],
      ['CY2024', 21770000000, '2024-12-31', 'CY2024Q4I'],
      ['CY2023', 19282000000, '2023-12-31', 'CY2023Q4I'],
    ]);
  });

  it('places a June year-end balance beside the income lines of the year it closes', async () => {
    const { output, text } = await compare({
      companies: ['MSFT', 'BSX'],
      concepts: ['revenue', 'equity'],
      periods: 4,
    });

    expect(line(output.cells, 'MICROSOFT CORP', 'equity')).toEqual([
      ['CY2026', 442387000000, '2026-06-30', 'CY2026Q2I'],
      ['CY2025', 343479000000, '2025-06-30', 'CY2025Q2I'],
      ['CY2024', 268477000000, '2024-06-30', 'CY2024Q2I'],
      ['CY2023', 206223000000, '2023-06-30', 'CY2023Q2I'],
    ]);
    // Each fiscal year's balance and revenue end on the same day.
    const revenueEnds = line(output.cells, 'MICROSOFT CORP', 'revenue').map(([p, , end]) => [
      p,
      end,
    ]);
    const equityEnds = line(output.cells, 'MICROSOFT CORP', 'equity').map(([p, , end]) => [p, end]);
    expect(equityEnds).toEqual(revenueEnds);
    expect(text).toContain(
      'equity | MICROSOFT CORP (CIK 0000789019) | CY2025 = 343479000000 USD | us-gaap:StockholdersEquity | frame CY2025Q2I | ends 2025-06-30 | 10-K [0001193125-26-323660]',
    );
    expect(text).not.toContain('390875000000');
  });

  it('places a May year-end balance under its fiscal year’s key, framed in the next calendar year', async () => {
    const { output } = await compare({
      companies: ['ORCL', 'BSX'],
      concepts: ['revenue', 'equity'],
      periods: 4,
    });

    expect(line(output.cells, 'ORACLE CORP', 'equity')).toEqual([
      ['CY2025', 42508000000, '2026-05-31', 'CY2026Q2I'],
      ['CY2024', 20451000000, '2025-05-31', 'CY2025Q2I'],
      ['CY2023', 8704000000, '2024-05-31', 'CY2024Q2I'],
      ['CY2022', 1073000000, '2023-05-31', 'CY2023Q2I'],
    ]);
    expect(line(output.cells, 'ORACLE CORP', 'revenue').map(([p, , end]) => [p, end])).toEqual([
      ['CY2025', '2026-05-31'],
      ['CY2024', '2025-05-31'],
      ['CY2023', '2024-05-31'],
      ['CY2022', '2023-05-31'],
    ]);
  });

  it('gives a year still open no annual balance', async () => {
    const { output, text } = await compare({
      companies: ['BSX', 'ORCL'],
      concepts: ['equity'],
      periods: 2,
    });

    // BSX's 2026-06-30 and ORCL's 2026-08-31 snapshots close no fiscal year.
    expect(output.periods).toEqual(['CY2025', 'CY2024']);
    expect(output.cells.some((c) => c.period === 'CY2026')).toBe(false);
    expect(text).not.toContain('24930000000');
    expect(text).not.toContain('66772000000');
  });

  it('keys a balance requested without any income line from the payload’s own annual frames', async () => {
    const { output } = await compare({
      companies: ['MSFT', 'ORCL'],
      concepts: ['equity'],
      periods: 2,
    });

    expect(line(output.cells, 'MICROSOFT CORP', 'equity').map(([p, , end]) => [p, end])).toEqual([
      ['CY2026', '2026-06-30'],
      ['CY2025', '2025-06-30'],
    ]);
    expect(line(output.cells, 'ORACLE CORP', 'equity').map(([p, , end]) => [p, end])).toEqual([
      ['CY2025', '2026-05-31'],
    ]);
  });

  it('keys a year-end no framed duration ends on by the year SEC frames that fiscal year as', async () => {
    /** One unframed year-long 10-K fact ending `end`, plus the balance on that day. */
    const unframedYear = (name: string, start: string, end: string, frame: string) =>
      filer(
        name,
        [[start, end, 1, undefined, '10-K', `${name}-10k`, '2026-08-20']],
        [[undefined, end, 7, frame, '10-K', `${name}-10k`, '2026-08-20']],
      );
    const cases: Record<string, [string, CompanyFactsResponse]> = {
      MAY: ['0000000001', unframedYear('MAY', '2024-06-01', '2025-05-31', 'CY2025Q2I')],
      WEEK: ['0000000002', unframedYear('WEEK', '2024-06-29', '2025-06-27', 'CY2025Q2I')],
      JUNE: ['0000000003', unframedYear('JUNE', '2024-07-01', '2025-06-30', 'CY2025Q2I')],
    };
    mockApi.resolveCik.mockImplementation(async (q: string) => ({ cik: cases[q]![0], name: q }));
    mockApi.tryGetCompanyFacts.mockImplementation(
      async (cik: string) => Object.values(cases).find(([c]) => c === cik)?.[1] ?? null,
    );

    const { output } = await compare({ companies: ['MAY', 'WEEK', 'JUNE'], concepts: ['equity'] });

    expect(output.cells.map((c) => [c.company, c.period, c.period_end])).toEqual([
      ['MAY', 'CY2024', '2025-05-31'],
      ['WEEK', 'CY2024', '2025-06-27'],
      ['JUNE', 'CY2025', '2025-06-30'],
    ]);
  });

  it('follows the key SEC framed the fiscal year under, wherever the computed year differs', async () => {
    /**
     * SEC frames Seagate's and Western Digital's 2011-07-02 → 2012-06-29 year
     * CY2012, where the computed year is CY2011 — SEC is not consistent for years
     * ending in the last days of June (their 2024-06-28 and 2025-06-27 years are
     * CY2023 and CY2024).
     */
    mockApi.tryGetCompanyFacts.mockResolvedValue(
      filer(
        'FRAMED CO',
        [['2011-07-02', '2012-06-29', 5, 'CY2012', '10-K', 'framed-10k', '2012-08-10']],
        [[undefined, '2012-06-29', 9, 'CY2012Q2I', '10-K', 'framed-10k', '2012-08-10']],
      ),
    );

    const { output } = await compare({
      companies: ['MSFT', 'BSX'],
      concepts: ['revenue', 'equity'],
    });

    // Balance and revenue share the fiscal year's column.
    expect(new Set(output.cells.map((c) => [c.concept, c.period].join(' ')))).toEqual(
      new Set(['revenue CY2012', 'equity CY2012']),
    );
  });

  describe('a balance dated on a comparative year end', () => {
    /**
     * A December filer whose first XBRL 10-K carries 2008 as its comparative year.
     * Its second 10-K also tags a year-long figure ending 2009-09-30, off its
     * fiscal calendar (Merck's and P&G's 09-30 shape).
     */
    const firstXbrl = filer(
      'FIRST CO',
      [
        ['2008-01-01', '2008-12-31', 800, 'CY2008', '10-K', 'first-10k', '2010-02-20'],
        ['2009-01-01', '2009-12-31', 900, undefined, '10-K', 'first-10k', '2010-02-20'],
        ['2009-01-01', '2009-12-31', 900, 'CY2009', '10-K', 'second-10k', '2011-02-20'],
        ['2008-10-01', '2009-09-30', 870, undefined, '10-K', 'second-10k', '2011-02-20'],
        ['2010-01-01', '2010-12-31', 1000, 'CY2010', '10-K', 'second-10k', '2011-02-20'],
      ],
      [
        [undefined, '2008-12-31', 80, 'CY2008Q4I', '10-K', 'first-10k', '2010-02-20'],
        [undefined, '2009-09-30', 85, 'CY2009Q3I', '10-Q', 'q3-10q', '2009-11-01'],
        [undefined, '2009-12-31', 90, 'CY2009Q4I', '10-K', 'second-10k', '2011-02-20'],
        [undefined, '2010-12-31', 100, 'CY2010Q4I', '10-K', 'second-10k', '2011-02-20'],
      ],
    );

    beforeEach(() => {
      mockApi.resolveCik.mockImplementation(async (q: string) =>
        q === 'FIRST' ? { cik: '0000000009', name: 'FIRST CO' } : { cik: '0000885725', name: q },
      );
      mockApi.tryGetCompanyFacts.mockImplementation(async (cik: string) =>
        cik === '0000000009' ? firstXbrl : bsx,
      );
    });

    it('keeps the first 10-K’s comparative year-end balance beside that year’s income line', async () => {
      const { output } = await compare({
        companies: ['FIRST', 'BSX'],
        concepts: ['revenue', 'equity'],
        periods: 12,
      });

      expect(line(output.cells, 'FIRST CO', 'equity')).toEqual([
        ['CY2010', 100, '2010-12-31', 'CY2010Q4I'],
        ['CY2009', 90, '2009-12-31', 'CY2009Q4I'],
        ['CY2008', 80, '2008-12-31', 'CY2008Q4I'],
      ]);
      expect(line(output.cells, 'FIRST CO', 'revenue').map(([p, , end]) => [p, end])).toEqual([
        ['CY2010', '2010-12-31'],
        ['CY2009', '2009-12-31'],
        ['CY2008', '2008-12-31'],
      ]);
    });

    it('still leaves out a year-long figure that ends off the report’s fiscal calendar', async () => {
      const { output, text } = await compare({
        companies: ['FIRST', 'BSX'],
        concepts: ['equity'],
        periods: 12,
      });

      expect(output.cells.some((c) => c.period_end === '2009-09-30')).toBe(false);
      expect(text).not.toContain('= 85 USD');
    });
  });

  it('leaves a cover-date snapshot out of an annual matrix and says why', async () => {
    const { output, text } = await compare({
      companies: ['BSX', 'MSFT'],
      concepts: ['equity', 'shares_outstanding'],
    });

    expect(output.cells.some((c) => c.concept === 'shares_outstanding')).toBe(false);
    expect(output.gaps.map((g) => [g.company, g.concept])).toContainEqual([
      'BOSTON SCIENTIFIC CORP',
      'shares_outstanding',
    ]);
    const caveat =
      'BOSTON SCIENTIFIC CORP / shares_outstanding: every value is a point-in-time snapshot off the company’s fiscal-year ends (newest 2026-01-30, frame CY2025Q4I), so the annual matrix holds none — period_type "quarterly" aligns them on calendar quarters.';
    expect(output.caveats).toContain(caveat);
    expect(text).toContain(`Caveat: ${caveat}`);
    // A company that never reports the concept gets the gap alone.
    expect(output.caveats.some((c) => c.startsWith('MICROSOFT CORP / shares_outstanding'))).toBe(
      false,
    );
  });

  it('says why an annual compare of cover-date concepts alone holds nothing, and names the call that works', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: ['BSX', 'MSFT'],
      concepts: ['shares_outstanding'],
    });

    const error = wireError(result);
    expect(error.data.reason).toBe('no_comparable_data');
    const message =
      'None of the 2 resolved companies has a value an annual matrix can hold. Every value found is a point-in-time snapshot dated off its company’s fiscal-year ends — a cover-page or interim date, which an annual matrix cannot pair with fiscal-year-end income lines: BOSTON SCIENTIFIC CORP / shares_outstanding (newest 2026-01-30).';
    const hint =
      'Retry with period_type: "quarterly" — it aligns point-in-time snapshots on the calendar quarter they fall in. Omitting period_type does not help: it defaults to annual.';
    expect(error.message).toBe(message);
    expect(bag(error.data.recovery).hint).toBe(hint);
    const text = blockText(result.content);
    expect(text).toContain(message);
    expect(text).toContain(hint);

    // The call the hint names returns the snapshot.
    const { output } = await compare({
      companies: ['BSX', 'MSFT'],
      concepts: ['shares_outstanding'],
      period_type: 'quarterly',
    });
    expect(line(output.cells, 'BOSTON SCIENTIFIC CORP', 'shares_outstanding')).toEqual([
      ['CY2025Q4', 1482000000, '2026-01-30', 'CY2025Q4I'],
    ]);
  });

  it('flags period ends that differ in any inline column, not only the newest', async () => {
    const { output, text } = await compare({
      companies: ['BSX', 'MSFT', 'ORCL'],
      concepts: ['revenue', 'equity'],
    });

    // The newest column holds Microsoft alone, so it has nothing to compare.
    expect(output.periods).toEqual(['CY2026', 'CY2025', 'CY2024', 'CY2023']);
    expect(
      new Set(output.cells.filter((c) => c.period === 'CY2026').map((c) => c.company)),
    ).toEqual(new Set(['MICROSOFT CORP']));
    const caveat =
      'Period ends differ inside CY2025 — BOSTON SCIENTIFIC CORP ends 2025-12-31, MICROSOFT CORP ends 2025-06-30, ORACLE CORP ends 2026-05-31; also inside CY2024, CY2023. Each company’s fiscal year sits under the calendar year SEC frames it as, and fiscal years ending months apart share that column, so the comparison is approximate; each cell carries its own period_end.';
    expect(output.caveats).toContain(caveat);
    expect(text).toContain(`Caveat: ${caveat}`);
  });

  it('leaves quarterly alignment of snapshots as it was', async () => {
    const { output } = await compare({
      companies: ['MSFT', 'BSX'],
      concepts: ['equity', 'shares_outstanding'],
      period_type: 'quarterly',
      periods: 3,
    });

    expect(line(output.cells, 'MICROSOFT CORP', 'equity')).toEqual([
      ['CY2026Q2', 442387000000, '2026-06-30', 'CY2026Q2I'],
      ['CY2026Q1', 414367000000, '2026-03-31', 'CY2026Q1I'],
      ['CY2025Q4', 390875000000, '2025-12-31', 'CY2025Q4I'],
    ]);
    expect(line(output.cells, 'BOSTON SCIENTIFIC CORP', 'shares_outstanding')).toEqual([
      ['CY2025Q4', 1482000000, '2026-01-30', 'CY2025Q4I'],
    ]);
  });

  it('says fiscal years months apart share an annual column', async () => {
    const { output } = await compare({ companies: ['BSX', 'ORCL'], concepts: ['equity'] });

    const mix = output.caveats.find((c) => c.startsWith('Period ends differ inside CY2025'));
    expect(mix).toBe(
      'Period ends differ inside CY2025 — BOSTON SCIENTIFIC CORP ends 2025-12-31, ORACLE CORP ends 2026-05-31; also inside CY2024, CY2023. Each company’s fiscal year sits under the calendar year SEC frames it as, and fiscal years ending months apart share that column, so the comparison is approximate; each cell carries its own period_end.',
    );
  });

  it('stages the same fiscal-year keys in the dataframe', async () => {
    const registerDataframe = vi.fn().mockResolvedValue({
      name: 'df_FYEND_ROWS1',
      rowCount: 1,
      expiresAt: '2026-11-01T00:00:00.000Z',
    });
    vi.mocked(getCanvasBridge).mockReturnValueOnce({ registerDataframe } as never);
    vi.mocked(toDatasetField).mockReturnValueOnce({
      name: 'df_FYEND_ROWS1',
      row_count: 1,
      expires_at: '2026-11-01T00:00:00.000Z',
    });

    await compare({ companies: ['ORCL', 'BSX'], concepts: ['equity'], periods: 1 });

    const rows = at(registerDataframe.mock.calls, 0)[1].rows as Array<{
      company: string;
      period: string;
      period_end: string;
    }>;
    expect(
      rows.filter((r) => r.company === 'ORACLE CORP').map((r) => [r.period, r.period_end]),
    ).toEqual([
      ['CY2025', '2026-05-31'],
      ['CY2024', '2025-05-31'],
      ['CY2023', '2024-05-31'],
      ['CY2022', '2023-05-31'],
    ]);
  });
});

/**
 * Company names, the caller's company and concept inputs, and failure messages are
 * not the tool's text: content[] escapes them as it renders, caveats included, so a
 * CommonMark parse reads back each structuredContent value. An error message carries
 * them raw, since the framework escapes the whole message (#221).
 */
describe('caller and SEC strings in content[] (#221)', () => {
  // A trailing backslash ahead of the quote, colon, or space the render puts after a name.
  const USB = 'US BANCORP \\DE\\';
  const JPM = 'JPMORGAN *CHASE* & CO _x_ `y` <b>z</b> &amp;';
  const UNRESOLVED = '[x](y) *nope* \\';
  const DEFERRED = '*later* \\';
  const UNKNOWN = 'eps *x*';
  const FILLER = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6'];
  /** JPM reports revenue alone, so its assets pair is a gap. */
  const jpmFacts: CompanyFactsResponse = {
    cik: 19617,
    entityName: JPM,
    facts: {
      'us-gaap': {
        Revenues: {
          label: 'Revenues',
          units: { USD: [2024, 2025].map((year) => calendarYear10K('jpm', year, year * 100)) },
        },
      },
    },
  };

  beforeEach(() => {
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);
    mockApi.resolveCik.mockImplementation(async (q: string) =>
      q === USB || q === 'usb'
        ? { cik: '0000036104', name: USB, ticker: 'USB' }
        : q === 'JPM'
          ? { cik: '0000019617', name: JPM, ticker: 'JPM' }
          : [],
    );
    mockApi.tryGetCompanyFacts.mockImplementation((cik: string) =>
      cik === '0000036104' ? calendarFiler : jpmFacts,
    );
  });

  it('reads back names, inputs, failure messages, and caveats as structuredContent carries them', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: [USB, 'usb', UNRESOLVED, 'JPM', ...FILLER, DEFERRED],
      concepts: ['revenue', 'assets', UNKNOWN],
      periods: 1,
    });

    expect(result.isError).toBeFalsy();
    const output = compareCompaniesTool.output.parse(result.structuredContent);
    expect(output.companies.map((c) => [c.input, c.name])).toEqual([
      [USB, USB],
      ['JPM', JPM],
    ]);
    expect(output.deferred_companies).toEqual([DEFERRED]);
    expect(output.unknown_concepts.map((u) => u.concept)).toEqual([UNKNOWN]);
    const failure = output.failed_companies.find((f) => f.input === UNRESOLVED);
    expect(failure?.message).toContain(`'${UNRESOLVED}'`);
    expect(output.caveats).toContain(
      `'usb' names the same company as '${USB}', so the comparison reads it once, under '${USB}'.`,
    );
    const text = readCommonMark(blockText(result.content));
    expect(text).toContain(
      `Companies: ${USB} [${USB} → CIK 0000036104, USB]; ${JPM} [JPM → CIK 0000019617, JPM]\n`,
    );
    expect(text).toContain(`Excluded: ${UNRESOLVED} (not_found) — ${failure?.message}\n`);
    expect(text).toContain(`Deferred companies (not read): '${DEFERRED}'\n`);
    expect(text).toContain(`Unknown concept: ${UNKNOWN} — not queried.`);
    expect(text).toContain(`revenue | ${USB} (CIK 0000036104) | CY2025 = `);
    expect(text).toContain(`revenue | ${JPM} (CIK 0000019617) | CY2025 = `);
    expect(text).toContain(`${JPM} (CIK 0000019617) reports no assets — tried: Assets`);
    for (const caveat of output.caveats) expect(text.split('\n\n')).toContain(`Caveat: ${caveat}`);
  });

  it('names a deferred input raw in an error message, which reads back once the framework escapes it', async () => {
    const result = await runToolContract(compareCompaniesTool, {
      companies: [UNRESOLVED, ...FILLER, 'N7', 'N8', 'N9', DEFERRED],
      concepts: ['revenue'],
    });

    const error = wireError(result);
    expect(error.data.reason).toBe('no_companies_resolved');
    expect(error.message).toBe(
      `None of the first 10 supplied companies resolved to a CIK. Inputs past the first 10 companies were not read — deferred_companies: '${DEFERRED}'.`,
    );
    expect(readCommonMark(blockText(result.content))).toContain(
      `deferred_companies: '${DEFERRED}'.`,
    );
  });
});
