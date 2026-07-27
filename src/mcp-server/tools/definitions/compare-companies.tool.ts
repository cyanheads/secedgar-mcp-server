/**
 * @fileoverview Period-aligned comparison of several named companies across
 * several XBRL concepts. Sits between `secedgar_get_financials` (one company ×
 * one concept over time) and `secedgar_fetch_frames` (one concept × one period
 * across the whole market). Reads one companyfacts payload per company and
 * resolves values through the shared frame dedup, so numbers match
 * `secedgar_get_financials` for the same concept.
 * @module mcp-server/tools/definitions/compare-companies
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';
import { resolveConceptTarget } from '@/services/edgar/concept-map.js';
import {
  type FramedUnit,
  newestReportedPeriod,
  seriesFromCompanyFacts,
  seriesStalenessCaveats,
} from '@/services/edgar/concept-series.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { missingQuarterCaveats } from '@/services/edgar/fiscal-periods.js';
import type { CikMatch } from '@/services/edgar/types.js';

/** Full-year duration frame — `CY2024`. */
const ANNUAL_FRAME = /^CY(\d{4})$/;
/** Single-quarter duration frame — `CY2024Q2`. */
const QUARTER_FRAME = /^CY(\d{4}Q[1-4])$/;
/** Point-in-time frame — `CY2024Q2I`. */
const INSTANT_FRAME = /^CY(\d{4})(Q[1-4])I$/;

/**
 * Ceiling on inline matrix cells. The bounds multiply out to 10 companies x 8
 * concepts x 12 periods, a payload no caller can read in one response, so the
 * inline window drops older periods until it fits. The dataframe still carries
 * the full aligned series, and the drop is disclosed through the truncation
 * enrichment.
 */
const MAX_INLINE_CELLS = 120;

/**
 * Map a frame to the calendar period key the matrix aligns on, or undefined when
 * the frame does not belong in this period type.
 *
 * Duration frames key on themselves. Instant frames (balance-sheet and
 * entity-info concepts, which are only ever filed as point-in-time values) key
 * on the calendar year for an annual comparison and on the calendar quarter for
 * a quarterly one — so `assets` lines up with `revenue` in the same matrix
 * instead of dropping out of it.
 */
function periodKey(frame: string, periodType: 'annual' | 'quarterly'): string | undefined {
  if (periodType === 'annual') {
    const annual = ANNUAL_FRAME.exec(frame);
    if (annual) return frame;
    const instant = INSTANT_FRAME.exec(frame);
    return instant?.[1] ? `CY${instant[1]}` : undefined;
  }
  const quarter = QUARTER_FRAME.exec(frame);
  if (quarter) return frame;
  const instant = INSTANT_FRAME.exec(frame);
  return instant?.[1] && instant[2] ? `CY${instant[1]}${instant[2]}` : undefined;
}

/** One aligned value in the comparison matrix. */
interface Cell {
  accession_number: string;
  cik: string;
  company: string;
  concept: string;
  form: string;
  frame: string;
  period: string;
  period_end: string;
  tag: string;
  taxonomy: string;
  unit: string;
  value: number;
}

export const compareCompaniesTool = tool('secedgar_compare_companies', {
  description:
    'Compare 2-10 named companies across 1-8 XBRL concepts, aligned on calendar periods. This is the middle shape between secedgar_get_financials (one company, one concept, full history) and secedgar_fetch_frames (one concept, one period, every reporting company) — reach for it when the question names the companies. One companyfacts read per company, resolved through the same frame dedup and tag priority as secedgar_get_financials so the numbers agree. Balance-sheet and entity-info concepts are filed as point-in-time values and align on the calendar year (annual) or quarter (quarterly) their snapshot falls in, so they sit in the same matrix as income-statement lines. The inline matrix covers the most recent periods up to `periods`, trimmed further when companies x concepts x periods is too large to return in one response; the full aligned series is materialized as df_<id> for growth rates and spreads via secedgar_dataframe_query. A company that fails to resolve is reported in failed_companies and the comparison proceeds with the rest, and a company that does not report a concept is reported in gaps with the tags that were tried — never interpolated or zero-filled. Off-calendar filers and unit mismatches are surfaced in caveats rather than silently mixed.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when the aligned series has more periods than the inline matrix shows.'),
    shown: z.number().optional().describe('Number of periods shown inline.'),
    cap: z.number().optional().describe('The periods cap applied.'),
  },

  errors: [
    {
      reason: 'no_companies_resolved',
      code: JsonRpcErrorCode.NotFound,
      when: 'None of the supplied company inputs resolved to a CIK',
      recovery: 'Use ticker symbols or 10-digit CIK numbers for exact matches.',
    },
    {
      reason: 'no_comparable_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Companies resolved but not one of them reports any of the requested concepts for the requested period type',
      recovery:
        'Switch period_type, or discover reported concept names with secedgar_search_concepts.',
    },
  ],

  input: z.object({
    companies: z
      .array(z.string().min(1).describe('Ticker symbol or CIK number.'))
      .min(2)
      .max(10)
      .describe(
        'Companies to compare, as ticker symbols (preferred) or CIK numbers. A company that does not resolve is reported in failed_companies and the rest of the comparison still runs.',
      ),
    concepts: z
      .array(z.string().min(1).describe('Friendly concept name or raw XBRL tag.'))
      .min(1)
      .max(8)
      .describe(
        'Concepts to compare — friendly names like "revenue" or "net_income" (discover them with secedgar_search_concepts) or raw XBRL tags.',
      ),
    taxonomy: z
      .enum(['us-gaap', 'ifrs-full'])
      .default('us-gaap')
      .describe(
        'XBRL taxonomy to resolve concepts under. Use ifrs-full only when every company in the list reports under IFRS; mixing IFRS and US GAAP filers in one call resolves them all under the same taxonomy.',
      ),
    period_type: z
      .enum(['annual', 'quarterly'])
      .default('annual')
      .describe(
        'Align on full calendar years (annual) or calendar quarters (quarterly). Quarterly comparisons of off-calendar filers are missing at least one calendar quarter per year — see caveats.',
      ),
    periods: z
      .number()
      .int()
      .min(1)
      .max(12)
      .default(4)
      .describe(
        'Upper bound on how many recent periods the inline matrix covers, newest first — not a guarantee. The matrix is companies x concepts x periods cells, and the inline window drops further older periods when that product is too large to return in one response. The full aligned series is always registered to the dataframe, so dropped periods stay queryable via secedgar_dataframe_query.',
      ),
  }),

  output: z.object({
    period_type: z.string().describe('Period alignment used, echoed from input.'),
    taxonomy: z.string().describe('Taxonomy the concepts were resolved under, echoed from input.'),
    periods: z
      .array(z.string())
      .describe(
        'Calendar period keys covered by the inline matrix, newest first. Shorter than the requested periods when the cell count forced the window to shrink — the enrichment trailer reports the drop.',
      ),
    companies: z
      .array(
        z
          .object({
            input: z.string().describe('The company string as supplied.'),
            cik: z.string().describe('Resolved CIK, zero-padded to 10 digits.'),
            name: z.string().describe('Resolved entity name (SEC-conformed).'),
            ticker: z.string().optional().describe('Ticker symbol when SEC lists one.'),
          })
          .describe('One company that resolved and contributed to the matrix.'),
      )
      .describe('Companies included in the comparison.'),
    failed_companies: z
      .array(
        z
          .object({
            input: z.string().describe('The company string as supplied.'),
            reason: z
              .enum(['not_found', 'ambiguous', 'no_company_facts'])
              .describe(
                'Machine-readable failure. not_found: the input matched no CIK. ambiguous: it matched several, and the message lists them. no_company_facts: it resolved but the filer reports no XBRL. Match on this rather than the message.',
              ),
            message: z.string().describe('What went wrong and how to fix this one input.'),
          })
          .describe('One company that could not be included, with a machine-readable reason.'),
      )
      .describe(
        'Companies excluded from the matrix. The comparison proceeds with the rest rather than failing the whole call.',
      ),
    concepts: z
      .array(
        z
          .object({
            concept: z.string().describe('Concept as supplied — friendly name or raw XBRL tag.'),
            label: z.string().describe('Human-readable concept label.'),
            units: z
              .array(z.string())
              .describe(
                'Distinct units this concept resolved to across the companies. More than one means the values are not directly comparable — see caveats.',
              ),
          })
          .describe('One requested concept and the units it resolved to.'),
      )
      .describe('Concepts covered, in the order supplied.'),
    cells: z
      .array(
        z
          .object({
            cik: z.string().describe('Company CIK, zero-padded to 10 digits.'),
            company: z.string().describe('Company name.'),
            concept: z.string().describe('Concept the value belongs to.'),
            period: z.string().describe('Aligned calendar period key (e.g. "CY2024", "CY2024Q2").'),
            value: z.number().describe('Reported value.'),
            unit: z.string().describe('Unit of measure for this value.'),
            taxonomy: z.string().describe('Taxonomy the value was read from.'),
            tag: z.string().describe('XBRL tag that produced the value.'),
            frame: z
              .string()
              .describe(
                'Underlying XBRL frame, which differs from period for point-in-time concepts (e.g. frame CY2024Q3I under period CY2024).',
              ),
            period_end: z
              .string()
              .describe(
                'Period end date (YYYY-MM-DD). Differs across off-calendar filers within one aligned period.',
              ),
            form: z.string().describe('Source filing type (10-K, 10-Q, 20-F).'),
            accession_number: z
              .string()
              .describe('Source filing accession number — pass to secedgar_get_filing.'),
          })
          .describe('One company-concept-period value.'),
      )
      .describe('Inline matrix values, covering the periods listed in periods[].'),
    gaps: z
      .array(
        z
          .object({
            cik: z.string().describe('Company CIK that reports nothing for this concept.'),
            company: z.string().describe('Company name.'),
            concept: z.string().describe('Concept with no value for this company.'),
            tags_tried: z
              .array(z.string())
              .describe('XBRL tags attempted, in priority order, before giving up.'),
          })
          .describe('One company-concept pair with no reported value.'),
      )
      .describe(
        'Company-concept pairs with no data. Deliberately explicit — a missing value is never interpolated or zero-filled.',
      ),
    caveats: z
      .array(z.string())
      .describe(
        "Comparability warnings: a filer missing one or two calendar quarters from the frame-tagged series, a concept whose values stop at least two full years behind the rest of that company's reporting (either an XBRL tag SEC has retired, or a current tag the filer stopped using), period ends that differ inside one aligned period, and concepts whose unit differs across companies. Company-specific warnings are prefixed with the company name. Empty when nothing needs flagging.",
      ),
    dataset: z
      .object({
        name: z
          .string()
          .describe('Dataframe handle (df_XXXXX_XXXXX) — pass to secedgar_dataframe_query.'),
        row_count: z.number().describe('Rows materialized in the dataframe.'),
        expires_at: z.string().describe('ISO 8601 expiry timestamp.'),
      })
      .optional()
      .describe(
        'Canvas dataframe holding the full aligned series across every period, not just the inline window. Columns match cells[]. Absent when canvas is unavailable.',
      ),
  }),

  async handler(input, ctx) {
    const api = getEdgarApiService();

    const resolvedCompanies: Array<CikMatch & { input: string }> = [];
    const failed: Array<{
      input: string;
      reason: 'not_found' | 'ambiguous' | 'no_company_facts';
      message: string;
    }> = [];

    for (const supplied of input.companies) {
      const resolved = await api.resolveCik(supplied);
      if (Array.isArray(resolved) && resolved.length === 0) {
        failed.push({
          input: supplied,
          reason: 'not_found',
          message: `'${supplied}' did not resolve to a CIK. Use a ticker symbol or 10-digit CIK.`,
        });
        continue;
      }
      if (Array.isArray(resolved) && resolved.length > 1) {
        const list = resolved
          .slice(0, 5)
          .map((m) => `${m.cik} ${m.name ?? 'Unknown'}${m.ticker ? ` (${m.ticker})` : ''}`)
          .join(', ');
        failed.push({
          input: supplied,
          reason: 'ambiguous',
          message: `'${supplied}' matches multiple companies: ${list}. Retry with one of these tickers or 10-digit CIKs.`,
        });
        continue;
      }
      const match = Array.isArray(resolved) ? resolved[0] : resolved;
      if (match) resolvedCompanies.push({ ...match, input: supplied });
    }

    if (resolvedCompanies.length === 0) {
      throw ctx.fail(
        'no_companies_resolved',
        `None of the ${input.companies.length} supplied companies resolved to a CIK.`,
        { ...ctx.recoveryFor('no_companies_resolved'), failed_companies: failed },
      );
    }

    const targets = input.concepts.map((concept) => ({
      concept,
      target: resolveConceptTarget(concept, input.taxonomy),
    }));

    const cells: Cell[] = [];
    const gaps: Array<{ cik: string; company: string; concept: string; tags_tried: string[] }> = [];
    const included: Array<{ input: string; cik: string; name: string; ticker?: string }> = [];
    const unitsByConcept = new Map<string, Set<string>>();
    /** Deduped so a caveat shared by several concepts is stated once. */
    const caveatSet = new Set<string>();

    for (const company of resolvedCompanies) {
      const facts = await api.tryGetCompanyFacts(company.cik);
      const name = company.name || company.input;
      if (!facts || Object.keys(facts.facts).length === 0) {
        failed.push({
          input: company.input,
          reason: 'no_company_facts',
          message: `'${company.input}' (CIK ${company.cik}) has no XBRL facts on file. Read its filings directly with secedgar_search_filings.`,
        });
        continue;
      }
      included.push({
        input: company.input,
        cik: company.cik,
        name,
        ...(company.ticker ? { ticker: company.ticker } : {}),
      });

      const quarterFrames: string[] = [];
      /** Held until this company's concepts are all read — see the reference below. */
      const resolvedLines: Array<{
        concept: string;
        tag: string;
        label: string;
        newest: FramedUnit;
      }> = [];
      for (const { concept, target } of targets) {
        const series = seriesFromCompanyFacts(
          facts,
          target.taxonomy,
          target.tags,
          target.tagSelection,
        );
        if (!series || series.series.length === 0) {
          gaps.push({
            cik: company.cik,
            company: name,
            concept,
            tags_tried: series?.tagsTried ?? target.tags,
          });
          continue;
        }

        /**
         * Series is newest-first, so the first frame mapping to a period key wins
         * and later (older) frames for the same key are skipped — the year-end
         * instant beats an interim snapshot inside the same calendar year.
         */
        const seen = new Set<string>();
        for (const unit of series.series) {
          if (QUARTER_FRAME.test(unit.frame)) quarterFrames.push(unit.frame);
          const period = periodKey(unit.frame, input.period_type);
          if (!period || seen.has(period)) continue;
          seen.add(period);
          cells.push({
            cik: company.cik,
            company: name,
            concept,
            period,
            value: unit.val,
            unit: series.unit || target.unit || '',
            taxonomy: series.taxonomy,
            tag: series.tag,
            frame: unit.frame,
            period_end: unit.end,
            form: unit.form,
            accession_number: unit.accn,
          });
        }

        if (seen.size === 0) {
          gaps.push({
            cik: company.cik,
            company: name,
            concept,
            tags_tried: series.tagsTried,
          });
          continue;
        }
        const units = unitsByConcept.get(concept) ?? new Set<string>();
        units.add(series.unit || target.unit || '');
        unitsByConcept.set(concept, units);

        // series[] is sorted newest-first by period end.
        const newest = series.series[0];
        if (newest) resolvedLines.push({ concept, tag: series.tag, label: series.label, newest });
      }

      /**
       * A concept whose series stops years back for this filer alone sits next to
       * current values from the other companies, and the spread reads as a
       * business fact unless the gap is named — whether the cause is a retired tag
       * (#98) or a current one the filer stopped tagging (#102). Measured against
       * this company's own newest reported period, so a filer that is simply
       * behind on everything is not flagged concept by concept.
       */
      const reference = newestReportedPeriod(facts, input.taxonomy);
      for (const line of resolvedLines) {
        for (const caveat of seriesStalenessCaveats(line.tag, line.label, line.newest, {
          date: reference,
          kind: 'reported-period',
        })) {
          caveatSet.add(`${name} / ${line.concept}: ${caveat}`);
        }
      }

      /**
       * Prefixed per company: the missing quarter is a property of that filer's
       * fiscal calendar, not of the comparison as a whole. Annual alignment never
       * surfaces it — the gap is invisible once quarters roll up to a year.
       */
      if (input.period_type === 'quarterly') {
        for (const caveat of missingQuarterCaveats(quarterFrames)) {
          caveatSet.add(`${name}: ${caveat}`);
        }
      }
    }

    if (cells.length === 0) {
      throw ctx.fail(
        'no_comparable_data',
        `None of the ${included.length} resolved companies report any of the requested concepts for ${input.period_type} periods.`,
        { ...ctx.recoveryFor('no_comparable_data'), gaps },
      );
    }

    const allPeriods = [...new Set(cells.map((c) => c.period))].sort((a, b) => b.localeCompare(a));
    const cellsPerPeriod = new Map<string, number>();
    for (const cell of cells) {
      cellsPerPeriod.set(cell.period, (cellsPerPeriod.get(cell.period) ?? 0) + 1);
    }
    /** Newest-first, stopping when the next period would breach the cell ceiling. */
    const inlinePeriods: string[] = [];
    let budget = MAX_INLINE_CELLS;
    for (const period of allPeriods.slice(0, input.periods)) {
      const count = cellsPerPeriod.get(period) ?? 0;
      if (inlinePeriods.length > 0 && count > budget) break;
      inlinePeriods.push(period);
      budget -= count;
    }
    const inlineSet = new Set(inlinePeriods);
    const inlineCells = cells.filter((c) => inlineSet.has(c.period));
    if (allPeriods.length > inlinePeriods.length) {
      ctx.enrich.truncated({ shown: inlinePeriods.length, cap: input.periods });
    }

    /**
     * Period ends inside ONE aligned period, not fiscal year ends: the alignment
     * key is a calendar year or quarter, so filers on different fiscal calendars
     * land in it with cut-off dates weeks apart. Read from the newest inline
     * period so every company is compared on the same key — a company's newest
     * cell overall can sit in a period the others have not reached.
     */
    const endsInNewestPeriod = new Map<string, { company: string; end: string }>();
    for (const cell of inlineCells) {
      if (cell.period !== inlinePeriods[0] || endsInNewestPeriod.has(cell.cik)) continue;
      endsInNewestPeriod.set(cell.cik, { company: cell.company, end: cell.period_end });
    }
    const endMonths = new Set([...endsInNewestPeriod.values()].map((e) => e.end.slice(0, 7)));
    if (endMonths.size > 1) {
      const spread = [...endsInNewestPeriod.values()]
        .map((e) => `${e.company} ends ${e.end}`)
        .join(', ');
      caveatSet.add(
        `Period ends differ inside ${inlinePeriods[0]} — ${spread}. Filers on different fiscal calendars land in the same aligned period with cut-off dates weeks apart, so the comparison is approximate; each cell carries its own period_end.`,
      );
    }
    for (const [concept, units] of unitsByConcept) {
      if (units.size > 1) {
        caveatSet.add(
          `Concept '${concept}' resolved to more than one unit across these companies (${[...units].join(', ')}). Values in different units are not directly comparable — each cell carries its own unit.`,
        );
      }
    }

    let dataset: { name: string; row_count: number; expires_at: string } | undefined;
    const bridge = getCanvasBridge();
    if (bridge) {
      const registered = await bridge.registerDataframe(ctx, {
        rows: cells.map((c) => ({ ...c })),
        sourceTool: 'secedgar_compare_companies',
        queryParams: {
          companies: included.map((c) => c.cik),
          concepts: input.concepts,
          taxonomy: input.taxonomy,
          period_type: input.period_type,
        },
      });
      if (registered) dataset = toDatasetField(registered);
    }

    ctx.log.info('Comparison built', {
      companies: included.length,
      failed: failed.length,
      cells: cells.length,
      datasetName: dataset?.name,
    });

    return {
      period_type: input.period_type,
      taxonomy: input.taxonomy,
      periods: inlinePeriods,
      companies: included,
      failed_companies: failed,
      concepts: targets.map(({ concept, target }) => ({
        concept,
        label: target.label,
        units: [...(unitsByConcept.get(concept) ?? [])],
      })),
      cells: inlineCells,
      gaps,
      caveats: [...caveatSet],
      dataset,
    };
  },

  format: (result) => {
    const out = [
      `**Company comparison** — ${result.companies.length} companies x ${result.concepts.length} concepts (${result.taxonomy}, ${result.period_type})`,
      `Periods: ${result.periods.join(', ')}`,
      `Companies: ${result.companies.map((c) => `${c.name} [${c.input} → CIK ${c.cik}${c.ticker ? `, ${c.ticker}` : ''}]`).join('; ')}`,
    ];

    for (const failure of result.failed_companies) {
      out.push(`Excluded: ${failure.input} (${failure.reason}) — ${failure.message}`);
    }

    for (const concept of result.concepts) {
      out.push(
        `Concept: ${concept.label} [${concept.concept}] — units: ${concept.units.join(', ') || 'none'}`,
      );
    }

    // Cells are rendered as a flat, sorted list rather than a lookup grid: every
    // value carries its own provenance, and a company-concept-period with no
    // value is already accounted for under gaps.
    const ordered = [...result.cells].sort(
      (a, b) =>
        a.concept.localeCompare(b.concept) ||
        a.company.localeCompare(b.company) ||
        b.period.localeCompare(a.period),
    );
    out.push('', '### Values');
    for (const cell of ordered) {
      out.push(
        `- ${cell.concept} | ${cell.company} (CIK ${cell.cik}) | ${cell.period} = ${cell.value} ${cell.unit} | ${cell.taxonomy}:${cell.tag} | frame ${cell.frame} | ends ${cell.period_end} | ${cell.form} [${cell.accession_number}]`,
      );
    }

    if (result.gaps.length > 0) {
      out.push('', `### Not reported (${result.gaps.length})`);
      for (const gap of result.gaps) {
        out.push(
          `- ${gap.company} (CIK ${gap.cik}) reports no ${gap.concept} — tried: ${gap.tags_tried.join(', ')}`,
        );
      }
    }

    if (result.dataset) {
      out.push(
        '',
        `Dataset: ${result.dataset.name} (${result.dataset.row_count} rows, expires ${result.dataset.expires_at}) — full aligned series, query with secedgar_dataframe_query.`,
      );
    }

    for (const caveat of result.caveats) out.push('', `Caveat: ${caveat}`);

    return [{ type: 'text', text: out.join('\n') }];
  },
});
