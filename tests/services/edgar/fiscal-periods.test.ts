/**
 * @fileoverview Tests for the shared fiscal-period caveats — the cross-company
 * frame warning `fetch_frames` emits, and the per-filer missing-quarter
 * detection `get_financials` / `get_snapshot` / `compare_companies` emit (#95).
 * @module tests/services/edgar/fiscal-periods
 */

import { describe, expect, it } from 'vitest';
import { fiscalQ4Caveats, missingQuarterCaveats } from '@/services/edgar/fiscal-periods.js';

/** Frames for a filer reporting `quarters` each year across `years`. */
function frames(years: number[], quarters: number[]): string[] {
  return years.flatMap((year) => quarters.map((q) => `CY${year}Q${q}`));
}

describe('fiscalQ4Caveats', () => {
  it('flags a duration quarterly period with the affected fiscal-year-ends', () => {
    const caveats = fiscalQ4Caveats('CY2025Q2');
    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toContain('calendar Q2');
    expect(caveats[0]).toContain('MSFT Jun-end');
  });

  it('places January year-ends in Q4, where their fiscal Q4 actually falls', () => {
    // WMT's fiscal Q4 runs Nov-Jan, which SEC frames as calendar Q4 — it reports
    // CY####Q1 like any other filer, so listing it under Q1 misdirects the caller.
    expect(fiscalQ4Caveats('CY2025Q4')[0]).toContain('WMT/TGT Jan-end');
    expect(fiscalQ4Caveats('CY2025Q1')[0]).not.toContain('WMT');
  });

  it('stays silent for annual and instant periods', () => {
    expect(fiscalQ4Caveats('CY2025')).toEqual([]);
    expect(fiscalQ4Caveats('CY2025Q2I')).toEqual([]);
  });
});

describe('missingQuarterCaveats (#95)', () => {
  it('names the calendar quarter a June-fiscal-year-end filer never frame-tags', () => {
    // Microsoft's fiscal Q4 (Apr-Jun) is the 10-K residual, so CY####Q2 never appears.
    const caveats = missingQuarterCaveats(frames([2023, 2024, 2025], [1, 3, 4]));
    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toContain('Calendar Q2');
    expect(caveats[0]).toContain('10-K residual');
  });

  it('names Q4 for a calendar-fiscal-year filer', () => {
    const caveats = missingQuarterCaveats(frames([2023, 2024], [1, 2, 3]));
    expect(caveats[0]).toContain('Calendar Q4');
  });

  it('stays silent when a single year of data is all there is', () => {
    expect(missingQuarterCaveats(frames([2024], [1, 3, 4]))).toEqual([]);
  });

  it('stays silent when years disagree about which quarter is missing', () => {
    expect(
      missingQuarterCaveats([...frames([2023], [1, 3, 4]), ...frames([2024], [1, 2, 3])]),
    ).toEqual([]);
  });

  it('stays silent when a year inside the recent window reports all four quarters', () => {
    expect(
      missingQuarterCaveats([...frames([2023], [1, 2, 3, 4]), ...frames([2024], [1, 3, 4])]),
    ).toEqual([]);
  });

  it('reads the current tagging regime, not the whole history', () => {
    // SEC frame-tagged all four calendar quarters before ~CY2021 and drops the
    // fiscal-Q4 quarter after. Microsoft's real series has exactly this shape;
    // reading the full history would let the older years mask the live gap.
    const microsoft = [
      ...frames([2015, 2016, 2017, 2018, 2019, 2020], [1, 2, 3, 4]),
      ...frames([2022, 2023, 2024, 2025], [1, 3, 4]),
    ];
    expect(missingQuarterCaveats(microsoft)[0]).toContain('Calendar Q2');
  });

  it('names Q3 for a September-fiscal-year-end filer under the same regime shift', () => {
    const apple = [
      ...frames([2018, 2019, 2020], [1, 2, 3, 4]),
      ...frames([2022, 2023, 2024, 2025], [1, 2, 4]),
    ];
    expect(missingQuarterCaveats(apple)[0]).toContain('Calendar Q3');
  });

  it('stays silent for a series that predates the regime shift entirely', () => {
    expect(missingQuarterCaveats(frames([2015, 2016, 2017, 2018], [1, 2, 3, 4]))).toEqual([]);
  });

  it('stays silent when the recent window is too sparse to reach the quorum', () => {
    // Costco's real shape: three tagged quarters a year until ~CY2020, two after.
    // The recent years cannot carry a caveat, and the window must not reach back
    // to the older regime and name a gap that no longer describes the series.
    const costco = [
      ...frames([2017, 2018, 2019, 2020], [1, 3, 4]),
      ...frames([2021, 2022, 2023, 2024, 2025], [1, 4]),
    ];
    expect(missingQuarterCaveats(costco)).toEqual([]);
  });

  it('ignores sparse years that report fewer than three quarters', () => {
    // The 2022 stub is too thin to carry signal; 2023-2024 still agree on Q2.
    expect(
      missingQuarterCaveats([...frames([2022], [3]), ...frames([2023, 2024], [1, 3, 4])])[0],
    ).toContain('Calendar Q2');
  });

  it('ignores annual and instant frames entirely', () => {
    expect(missingQuarterCaveats(['CY2023', 'CY2024', 'CY2023Q3I', 'CY2024Q3I'])).toEqual([]);
  });
});
