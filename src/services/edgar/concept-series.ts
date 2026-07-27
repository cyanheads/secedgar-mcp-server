/**
 * @fileoverview Frame-aligned XBRL series resolution, shared by every tool that
 * reads company facts. One value per standard calendar period: entries without a
 * `frame` are dropped, same-frame collisions resolve by tag priority (index 0 =
 * the preferred total), and ties within one tag resolve to the latest `filed`
 * date so a restatement replaces the original. Extracted from `get_financials`
 * so the snapshot and comparison tools produce numbers identical to it rather
 * than re-implementing the rules.
 * @module services/edgar/concept-series
 */

import { listConcepts, resolveConceptTarget } from './concept-map.js';
import type {
  CompanyConceptUnit,
  CompanyFactsResponse,
  ConceptTaxonomy,
  TagSelection,
} from './types.js';

/** A reported value carrying the priority index of the tag that produced it. */
export interface TagPrioritizedUnit extends CompanyConceptUnit {
  /** Position of the source tag in the concept's tag array. Lower wins a collision. */
  tagIndex: number;
}

/** A reported value guaranteed to carry a standard calendar-period frame. */
export interface FramedUnit extends CompanyConceptUnit {
  frame: string;
}

/** Period filter applied to a resolved series. */
export type PeriodType = 'annual' | 'quarterly' | 'all';

/**
 * SEC stamps a retired element's retirement date into the taxonomy label it
 * serves with every companyconcept and companyfacts payload — e.g.
 * `"Sales Revenue, Goods, Net (Deprecated 2018-01-31)"`. Matching it is the whole
 * staleness signal; no extra upstream call is involved.
 */
const DEPRECATED_LABEL = /\(Deprecated\s+(\d{4}-\d{2}-\d{2})\)/i;

/** Annual duration frame — `CY2023`. */
const ANNUAL_FRAME = /^CY\d{4}$/;

/** Quarterly frame — `CY2023Q3` (duration) or `CY2023Q3I` (instant). */
const QUARTERLY_FRAME = /^CY\d{4}Q\d/;

/**
 * Tag positions ordered by how many standard calendar periods each covers for
 * this filer, widest first, with the declared order breaking a tie. A tag that
 * reported only non-standard periods counts as zero and sorts last rather than
 * dropping out, so it can still supply a label when it is all the filer has.
 */
function coverageOrder(units: readonly TagPrioritizedUnit[]): number[] {
  const framesByTag = new Map<number, Set<string>>();
  for (const unit of units) {
    const frames = framesByTag.get(unit.tagIndex) ?? new Set<string>();
    if (unit.frame) frames.add(unit.frame);
    framesByTag.set(unit.tagIndex, frames);
  }
  return [...framesByTag.keys()].sort(
    (a, b) => (framesByTag.get(b)?.size ?? 0) - (framesByTag.get(a)?.size ?? 0) || a - b,
  );
}

/**
 * Original index of the tag that answers the concept for this filer, or
 * `undefined` when no tag reported anything. This is the tag whose label,
 * description, and unit describe the resolved series.
 */
export function preferredTagIndex(
  units: readonly TagPrioritizedUnit[],
  selection: TagSelection = 'priority',
): number | undefined {
  if (units.length === 0) return;
  if (selection === 'coverage') return coverageOrder(units)[0];
  return units.reduce((lowest, unit) => Math.min(lowest, unit.tagIndex), Number.POSITIVE_INFINITY);
}

/**
 * Collapse a company's reported values to one per standard calendar period.
 *
 * Values with no `frame` are non-standard periods and are dropped. What happens
 * to the rest depends on the selection, because the two selections describe
 * different relationships between the tags.
 *
 * Under the default `priority` the tags are a ladder, so the whole array
 * contributes: a same-frame collision goes to the lower array index (index 0 is
 * the preferred total, e.g. IFRS `Revenue` over the
 * `RevenueFromContractsWithCustomers` sub-line) and a lower tag fills the frames
 * the leader does not report.
 *
 * Under `coverage` the tags are alternates the filer chooses between, so only
 * the tag it maintains contributes and the others drop out entirely. Letting a
 * loser fill the winner's gaps would splice two definitions into one series: the
 * filers that report both tags disagree on the years they overlap — Ferrari
 * tags CY2022 at EUR 16.2M under the employee element and EUR 20.9M under the
 * IFRS 2.51(a) total — so a gap-filled series prints a step that is a tag
 * switch, not a business fact. A series that then ends years back is what
 * {@link seriesStalenessCaveats} exists to report (#101, #102).
 *
 * Within one tag, the later `filed` date wins so an amended filing replaces the
 * original. Returns an empty map when nothing carried a frame — the caller
 * distinguishes that from "the concept is not reported at all".
 */
export function resolveFrameSeries(
  units: readonly TagPrioritizedUnit[],
  selection: TagSelection = 'priority',
): Map<string, FramedUnit> {
  const winner = selection === 'coverage' ? preferredTagIndex(units, selection) : undefined;
  const considered =
    winner === undefined ? units : units.filter((unit) => unit.tagIndex === winner);

  const byFrame = new Map<string, TagPrioritizedUnit & FramedUnit>();
  for (const unit of considered) {
    const { frame } = unit;
    if (!frame) continue;
    const existing = byFrame.get(frame);
    if (
      !existing ||
      unit.tagIndex < existing.tagIndex ||
      (unit.tagIndex === existing.tagIndex && unit.filed > existing.filed)
    ) {
      byFrame.set(frame, { ...unit, frame });
    }
  }

  const resolved = new Map<string, FramedUnit>();
  for (const [frame, { tagIndex: _tagIndex, ...unit }] of byFrame) {
    resolved.set(frame, unit);
  }
  return resolved;
}

/**
 * Two full fiscal years closed with no newer value.
 *
 * One year is the floor a current filer can reach on its own: an annual-only
 * concept sits a whole fiscal year behind until the next report lands, and a
 * 20-F is due four months after fiscal year end (Form 12b-25 adds fifteen days,
 * and SEC assigns the frame weeks after that), so a foreign private issuer with
 * nothing wrong can show a newest annual period around 500 days old. Two years
 * clears that by a wide margin and is the first gap that cannot be a filing
 * artifact — the filer has closed and reported two annual periods since this
 * line last carried a value.
 */
const STALE_AFTER_DAYS = 730;

/** What a series' newest period is being measured against. */
export interface StalenessReference {
  /** The date itself (YYYY-MM-DD). */
  date: string;
  /**
   * `reported-period` — the newest period end this filer reports across every
   * concept read from the same companyfacts payload. The strongest reference:
   * it isolates a line that lags the filer's own reporting, and stays silent for
   * a filer that stopped filing altogether, whose whole profile is equally old
   * and would otherwise repeat one warning per concept.
   *
   * `current-date` — today. What a single-concept read has, since one
   * companyconcept payload carries no filer-wide period to compare against and
   * fetching one would cost an extra upstream call.
   */
  kind: 'current-date' | 'reported-period';
}

/**
 * Newest standard calendar period this filer reports anywhere in the supported
 * concept catalog, as a `reported-period` reference for
 * {@link seriesStalenessCaveats}. Empty string when the filer reports none of
 * them under this taxonomy.
 *
 * Reads the whole catalog rather than only the concepts a caller asked about,
 * because the reference has to be independent of the request: a comparison of
 * one concept would otherwise measure that concept against itself and could
 * never report it as lagging. Scans candidate tags directly instead of
 * resolving series — only the newest framed period is needed, and the payload
 * is already in hand, so this adds no upstream call.
 *
 * The `dei` namespace is excluded. Cover-page facts track the *filing*, not the
 * financial statements, so a registrant that stopped reporting under this
 * taxonomy keeps a current `dei` period anyway — Toyota migrated its XBRL from
 * us-gaap to IFRS after fiscal 2020, and a reference that counted `dei` put its
 * us-gaap profile six years behind a cover-page date and flagged all 28 of its
 * lines at once. Excluding it is what keeps the reference a statement of what
 * the filer reports and preserves the silence for a filer whose whole profile is
 * equally old. It also makes the two taxonomies agree: `shares_outstanding` is
 * the only `dei` concept, and an `ifrs-full` request never resolved it there.
 */
export function newestReportedPeriod(
  facts: CompanyFactsResponse,
  taxonomy: ConceptTaxonomy,
): string {
  let newest = '';
  for (const entry of listConcepts()) {
    const target = resolveConceptTarget(entry.name, taxonomy);
    if (target.taxonomy === 'dei') continue;
    const namespace = facts.facts[target.taxonomy];
    if (!namespace) continue;
    for (const tag of target.tags) {
      for (const values of Object.values(namespace[tag]?.units ?? {})) {
        for (const value of values) {
          if (value.frame && value.end > newest) newest = value.end;
        }
      }
    }
  }
  return newest;
}

/**
 * Caveat for a resolved series whose newest value is far enough behind the
 * reference that the caller should not read it as current.
 *
 * Two causes, one symptom. A friendly name is an ordered list of tags walked
 * until one returns data, so a tag SEC retired can win when every current tag
 * comes back empty for a filer, producing a series that looks complete but stops
 * around the tag's retirement (#98) — SEC ships that tell in the taxonomy label
 * it serves with the payload. A *current* tag produces the same shape with no
 * tell at all when the filer migrates to another element or stops disclosing the
 * line, so the fallback signal is the gap itself (#102).
 *
 * At most one caveat: the retirement stamp names the concrete cause and already
 * says the series can end years short, so restating that as an elapsed-time
 * measurement would be the same warning twice in different words.
 *
 * Returns an empty array for a current tag reporting through the reference,
 * which is the common case.
 */
export function seriesStalenessCaveats(
  tag: string,
  label: string,
  newest: FramedUnit | undefined,
  reference: StalenessReference,
): string[] {
  const retired = DEPRECATED_LABEL.exec(label);
  if (retired?.[1]) {
    return [
      `XBRL tag ${tag} was retired from the taxonomy on ${retired[1]} — SEC labels it "${label}". It matched only because every current tag ahead of it in this concept's priority list reports nothing for this filer, so the series can end years before the filer's latest report. Check secedgar_search_concepts for the concept's full tag list, or pass the tag this filer reports today.`,
    ];
  }
  if (!newest) return [];

  const gapDays = (Date.parse(reference.date) - Date.parse(newest.end)) / 86_400_000;
  if (!(gapDays >= STALE_AFTER_DAYS)) return [];

  /**
   * A `reported-period` reference means the caller already holds the filer's
   * whole profile and can see which lines are current, so pointing it back at
   * the snapshot would be pointing it at itself.
   */
  const fromReportedPeriod = reference.kind === 'reported-period';
  const behind = fromReportedPeriod
    ? `the newest period this filer reports (ending ${reference.date})`
    : `today (${reference.date})`;
  const next = fromReportedPeriod
    ? 'Check secedgar_search_concepts for this concept’s other tags and pass the one this filer reports today.'
    : 'Check secedgar_search_concepts for this concept’s other tags, or secedgar_get_snapshot for what this filer reports today.';
  return [
    `This series ends at ${newest.frame}, period ending ${newest.end} — ${(gapDays / 365.25).toFixed(1)} years before ${behind}. ${tag} is a current tag, so nothing in the payload marks the gap: a filer that migrates to a different XBRL element, or stops disclosing the line, leaves a series that looks complete and simply stops. ${next}`,
  ];
}

/**
 * Whether a frame belongs to the requested period type. `fp` reflects the source
 * filing rather than the data point, so the frame label is the only reliable
 * period key.
 */
export function matchesPeriodType(frame: string, periodType: PeriodType): boolean {
  if (periodType === 'annual') return ANNUAL_FRAME.test(frame);
  if (periodType === 'quarterly') return QUARTERLY_FRAME.test(frame);
  return true;
}

/** One concept resolved out of a companyfacts payload. */
export interface ConceptSeries {
  /** XBRL taxonomy description. Absent for company-extension and older tags. */
  description?: string;
  /** Human-readable label from the taxonomy. */
  label: string;
  /** Frame-aligned values, newest first. Empty when the tag reports no framed periods. */
  series: FramedUnit[];
  /** The tag that produced the values. */
  tag: string;
  /** Every tag attempted, in priority order. */
  tagsTried: string[];
  /** Taxonomy the values were read from. */
  taxonomy: string;
  /** Unit of measure key (e.g. `USD`, `USD/shares`, `shares`). */
  unit: string;
}

/**
 * Resolve one concept from a companyfacts payload, applying the same tag
 * selection and frame dedup as {@link resolveFrameSeries}. Returns `undefined`
 * when the filer reports none of the candidate tags under this taxonomy, which
 * the caller surfaces as a gap alongside the tags it tried.
 *
 * The reported `tag`, `label`, `description`, and `unit` come from the tag that
 * won for this filer, not from the first one present — under `coverage` those
 * differ, and describing the series by a tag that lost every frame would misname
 * the values.
 */
export function seriesFromCompanyFacts(
  facts: CompanyFactsResponse,
  taxonomy: string,
  tags: readonly string[],
  selection: TagSelection = 'priority',
): ConceptSeries | undefined {
  const namespace = facts.facts[taxonomy];
  if (!namespace) return;

  const units: TagPrioritizedUnit[] = [];
  const tagsTried: string[] = [];
  /** Keyed by tag position, in declared order, so the winner can be looked up. */
  const reported = new Map<
    number,
    { description?: string; label: string; tag: string; unit: string }
  >();

  for (const [tagIndex, tag] of tags.entries()) {
    tagsTried.push(tag);
    const concept = namespace[tag];
    if (!concept?.units) continue;
    for (const [unitKey, values] of Object.entries(concept.units)) {
      if (!reported.has(tagIndex)) {
        reported.set(tagIndex, {
          tag,
          label: concept.label ?? tag,
          unit: unitKey,
          ...(concept.description !== undefined ? { description: concept.description } : {}),
        });
      }
      for (const value of values) units.push({ ...value, tagIndex });
    }
  }
  const winner = preferredTagIndex(units, selection);
  /** Falls back to the first reporting tag when nothing carried a value to rank. */
  const resolved =
    (winner !== undefined ? reported.get(winner) : undefined) ?? [...reported.values()][0];
  if (!resolved) return;

  const series = [...resolveFrameSeries(units, selection).values()].sort((a, b) =>
    b.end.localeCompare(a.end),
  );
  return { ...resolved, series, tagsTried, taxonomy };
}
