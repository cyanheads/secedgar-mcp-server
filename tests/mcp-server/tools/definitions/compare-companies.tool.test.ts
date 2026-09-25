/**
 * @fileoverview Tests for compare-companies — period-aligned multi-company
 * concept comparison, including partial company resolution, the inline period
 * cap, and the comparability caveats (#85).
 * @module tests/mcp-server/tools/definitions/compare-companies.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compareCompaniesTool } from '@/mcp-server/tools/definitions/compare-companies.tool.js';
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
import { at, blockText, records, wireError } from '../../../support/assertions.js';

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
      accession_number: 'acc-1',
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
              USD: [2024, 2025].map((year) =>
                fact({ frame: `CY${year}`, end: `${year}-12-31`, val: year }),
              ),
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
