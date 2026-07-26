/**
 * @fileoverview Fiscal-period caveats for SEC XBRL frame data. SEC reports a
 * filer's fiscal Q4 as the 10-K residual rather than as a discrete quarterly
 * fact, so the calendar quarter that contains a filer's fiscal year end carries
 * no frame-tagged quarterly value at all. The same hazard is visible from two
 * directions: `fetch_frames` sees it from the period side (which filers are
 * missing from a `CY####Q#` frame), the per-company tools see it from the series
 * side (which calendar quarter is missing from one filer's series). Both read
 * from this module so the explanation stays identical.
 * @module services/edgar/fiscal-periods
 */

/**
 * Filers absent from each calendar quarter, keyed by quarter number. Membership
 * follows the span of the filer's fiscal Q4, not the date its fiscal year ends —
 * a January year-end closes a fiscal Q4 running Nov–Jan, which SEC frames as
 * calendar Q4, so Jan-end retailers drop out of Q4 rather than Q1.
 */
const FISCAL_Q4_EXAMPLES: Record<string, string> = {
  '1': 'SJM Apr-end, and other Feb-to-Apr year ends',
  '2': 'MSFT Jun-end, NKE May-end, CSCO Jul-end',
  '3': 'AAPL Sep-end, MU Aug-end, DE Oct-end',
  '4': 'most US filers (calendar fiscal year), plus WMT/TGT Jan-end',
};

/** Duration quarterly frame (`CY2024Q2`). Instant frames (`CY2024Q2I`) are excluded. */
const DURATION_QUARTER_FRAME = /^CY(\d{4})Q([1-4])$/;

/** A year needs at least this many reported quarters before its gaps carry signal. */
const MIN_QUARTERS_PER_YEAR = 3;

/** At least this many qualifying years must agree before a gap is called systematic. */
const MIN_YEARS = 2;

/**
 * How many recent calendar years the gap is read from. SEC's frame tagging is
 * not uniform across history — series that reach back far enough carry all four
 * calendar quarters in their older years and drop the fiscal-Q4 quarter only in
 * recent ones. Reading the whole history would let those older years mask a gap
 * that is real for every period a caller is likely to use, so detection is
 * scoped to the current tagging behavior. The window is the newest years that
 * carry ANY quarterly frame; the per-year quorum is applied inside it, never
 * before, so a filer whose recent years fall below the quorum stays silent
 * rather than describing a tagging regime it has already left.
 */
const RECENT_YEARS = 4;

/**
 * Caveat for a cross-company frame query: any filer whose fiscal Q4 spans the
 * queried calendar quarter is silently absent from a `CY####Q[1-4]` frame. The
 * omission is invisible without domain knowledge — flag it so the caller knows
 * to cross-reference `secedgar_get_financials` with `period_type='annual'` for
 * those filers. Annual (`CY####`) and instant (`CY####Q#I`) periods are
 * unaffected.
 */
export function fiscalQ4Caveats(period: string): string[] {
  const match = period.match(/^CY\d{4}Q([1-4])$/);
  if (!match) return [];
  const q = match[1] as keyof typeof FISCAL_Q4_EXAMPLES;
  return [
    `Filers whose fiscal Q4 spans calendar Q${q} are absent from this frame — SEC XBRL reports their fiscal Q4 as the 10-K residual rather than a discrete quarterly fact (e.g. ${FISCAL_Q4_EXAMPLES[q]}). Use secedgar_get_financials with period_type='annual' for those filers.`,
  ];
}

/**
 * Caveat for one filer's frame-tagged quarterly series: name the calendar
 * quarter that never appears, so a caller can tell "the company did not report"
 * apart from "the frame tagging does not expose it".
 *
 * Detection reads only the frames themselves — no maintained filer list. The
 * newest {@link RECENT_YEARS} years carrying any quarterly frame are the window;
 * inside it a year counts only when it reports at least
 * {@link MIN_QUARTERS_PER_YEAR} of the four calendar quarters (partial first/last
 * years carry no signal), and a caveat is emitted only when at least
 * {@link MIN_YEARS} of the counting years all omit the same single quarter. A
 * year inside the window that reports all four quarters, two that disagree about
 * which quarter is missing, or a window too sparse to reach the quorum all
 * suppress the caveat.
 */
export function missingQuarterCaveats(frames: Iterable<string>): string[] {
  const quartersByYear = new Map<string, Set<string>>();
  for (const frame of frames) {
    const match = DURATION_QUARTER_FRAME.exec(frame);
    if (!match?.[1] || !match[2]) continue;
    let quarters = quartersByYear.get(match[1]);
    if (!quarters) {
      quarters = new Set();
      quartersByYear.set(match[1], quarters);
    }
    quarters.add(match[2]);
  }

  const reportedYears = [...quartersByYear.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, RECENT_YEARS)
    .filter(([, quarters]) => quarters.size >= MIN_QUARTERS_PER_YEAR)
    .map(([, quarters]) => quarters);
  if (reportedYears.length < MIN_YEARS) return [];

  const absent = new Set(['1', '2', '3', '4']);
  for (const quarters of reportedYears) {
    for (const quarter of quarters) absent.delete(quarter);
  }
  const [missing] = absent;
  if (absent.size !== 1 || !missing) return [];

  return [
    `Calendar Q${missing} carries no frame-tagged value in any of this filer's recent fully-reported years. SEC XBRL reports fiscal Q4 as the 10-K residual rather than a discrete quarterly fact, so the calendar quarter that fiscal Q4 spans drops out of the quarterly series — the period was reported, the frame tagging does not expose it. Use period_type='annual' for the full-year figure, or derive the missing quarter as the annual total minus the three reported quarters.`,
  ];
}
