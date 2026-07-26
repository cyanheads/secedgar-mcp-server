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

import type { CompanyConceptUnit, CompanyFactsResponse } from './types.js';

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

/** Annual duration frame — `CY2023`. */
const ANNUAL_FRAME = /^CY\d{4}$/;

/** Quarterly frame — `CY2023Q3` (duration) or `CY2023Q3I` (instant). */
const QUARTERLY_FRAME = /^CY\d{4}Q\d/;

/**
 * Collapse a company's reported values to one per standard calendar period.
 *
 * Values with no `frame` are non-standard periods and are dropped. When two
 * values share a frame, the one from the lower-priority-index tag wins (index 0
 * is the preferred total, e.g. IFRS `Revenue` over the
 * `RevenueFromContractsWithCustomers` sub-line); within one tag, the later
 * `filed` date wins so an amended filing replaces the original. Returns an empty
 * map when nothing carried a frame — the caller distinguishes that from "the
 * concept is not reported at all".
 */
export function resolveFrameSeries(units: readonly TagPrioritizedUnit[]): Map<string, FramedUnit> {
  const byFrame = new Map<string, TagPrioritizedUnit & FramedUnit>();
  for (const unit of units) {
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
 * priority and frame dedup as {@link resolveFrameSeries}. Returns `undefined`
 * when the filer reports none of the candidate tags under this taxonomy, which
 * the caller surfaces as a gap alongside the tags it tried.
 */
export function seriesFromCompanyFacts(
  facts: CompanyFactsResponse,
  taxonomy: string,
  tags: readonly string[],
): ConceptSeries | undefined {
  const namespace = facts.facts[taxonomy];
  if (!namespace) return;

  const units: TagPrioritizedUnit[] = [];
  const tagsTried: string[] = [];
  let resolved: { description?: string; label: string; tag: string; unit: string } | undefined;

  for (const [tagIndex, tag] of tags.entries()) {
    tagsTried.push(tag);
    const concept = namespace[tag];
    if (!concept?.units) continue;
    for (const [unitKey, values] of Object.entries(concept.units)) {
      resolved ??= {
        tag,
        label: concept.label ?? tag,
        unit: unitKey,
        ...(concept.description !== undefined ? { description: concept.description } : {}),
      };
      for (const value of values) units.push({ ...value, tagIndex });
    }
  }
  if (!resolved) return;

  const series = [...resolveFrameSeries(units).values()].sort((a, b) => b.end.localeCompare(a.end));
  return { ...resolved, series, tagsTried, taxonomy };
}
