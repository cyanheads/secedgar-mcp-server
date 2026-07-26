/**
 * @fileoverview One-call financial profile for a company. Reads the filer's
 * whole XBRL fact set once and resolves every mapped friendly concept against
 * it, instead of one upstream request per concept. Values come from the same
 * frame dedup and tag priority `secedgar_get_financials` uses, so the two agree
 * for any concept they both report.
 * @module mcp-server/tools/definitions/get-snapshot
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { listConcepts, resolveConceptTarget } from '@/services/edgar/concept-map.js';
import { type FramedUnit, seriesFromCompanyFacts } from '@/services/edgar/concept-series.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { missingQuarterCaveats } from '@/services/edgar/fiscal-periods.js';

/** Full-year duration frame — `CY2024`. */
const ANNUAL = /^CY\d{4}$/;
/** Single-quarter duration frame — `CY2024Q2`. Excludes instants. */
const QUARTER = /^CY\d{4}Q[1-4]$/;
/** Point-in-time frame — `CY2024Q2I`. Balance-sheet and entity-info concepts. */
const INSTANT = /^CY\d{4}Q[1-4]I$/;

/** One reported value, trimmed to what a profile line needs. */
const pointSchema = z
  .object({
    period: z.string().describe('Calendar period label (e.g. "CY2024", "CY2025Q2", "CY2025Q2I").'),
    value: z.number().describe("Reported value, in the line's unit."),
    period_end: z.string().describe('Period end date (YYYY-MM-DD).'),
    form: z.string().describe('Source filing type (10-K, 10-Q, 20-F).'),
    accession_number: z
      .string()
      .describe('Source filing accession number — pass to secedgar_get_filing.'),
  })
  .describe('One reported value with its period and source filing.');

/** Most recent value whose frame matches `pattern`, or undefined when none does. */
function latest(series: readonly FramedUnit[], pattern: RegExp) {
  const hit = series.find((u) => pattern.test(u.frame));
  return hit
    ? {
        period: hit.frame,
        value: hit.val,
        period_end: hit.end,
        form: hit.form,
        accession_number: hit.accn,
      }
    : undefined;
}

export const getSnapshotTool = tool('secedgar_get_snapshot', {
  description:
    'Build a company financial profile in one call: the latest value of every supported XBRL concept, grouped by statement. Reads the filer\'s complete companyfacts payload once rather than one request per concept, so it replaces a run of secedgar_get_financials calls when the question is "what do this company\'s financials look like right now". Values use the same frame dedup and tag priority as secedgar_get_financials, so the two agree for any concept they both cover. Duration concepts (income statement, cash flow, per-share) report their latest full year and latest single quarter; balance-sheet and entity-info concepts report their latest point-in-time value, since that is the only form they are filed in. A concept the filer does not report is listed under gaps with the XBRL tags that were tried — never zero-filled or interpolated. Use secedgar_get_financials for a full time series of one concept, and secedgar_compare_companies to put several companies side by side.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'company_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The company input does not resolve to a CIK',
      recovery: 'Use a ticker symbol or 10-digit CIK number for an exact match.',
    },
    {
      reason: 'ambiguous_company',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The company input resolves to multiple entities and the target is ambiguous',
      recovery: 'Use a ticker symbol or 10-digit CIK from the matches list for an exact match.',
    },
    {
      reason: 'no_company_facts',
      code: JsonRpcErrorCode.NotFound,
      when: 'The filer has no XBRL facts at all — pre-XBRL, foreign private issuer, or a non-operating registrant',
      recovery:
        'Check the filer files XBRL financial statements, or read the filings directly with secedgar_search_filings.',
    },
  ],

  input: z.object({
    company: z
      .string()
      .min(1)
      .describe('Ticker symbol (e.g. "AAPL") or CIK number. Ticker is preferred.'),
    taxonomy: z
      .enum(['us-gaap', 'ifrs-full'])
      .default('us-gaap')
      .describe(
        'XBRL taxonomy to resolve concepts under. Every concept is looked up in this one taxonomy, so ifrs-full covers only the concepts with confirmed IFRS tag variants and the rest — including the dei entity-info concepts — come back under gaps. Leave at us-gaap for domestic filers, where each concept uses its own preferred taxonomy.',
      ),
    period_type: z
      .enum(['annual', 'quarterly', 'both'])
      .default('both')
      .describe(
        'Which duration periods to report per concept: the latest full year, the latest single quarter, or both (default). Balance-sheet and entity-info concepts are point-in-time and always report their latest instant value regardless of this setting.',
      ),
  }),

  output: z.object({
    company: z.string().describe('Resolved entity name (SEC-conformed).'),
    cik: z.string().describe('Resolved CIK, zero-padded to 10 digits.'),
    taxonomy: z.string().describe('Taxonomy the concepts were resolved under, echoed from input.'),
    period_type: z.string().describe('Duration periods reported, echoed from input.'),
    concepts_resolved: z.number().describe('Concepts that produced at least one value.'),
    concepts_total: z.number().describe('Concepts in the supported catalog that were attempted.'),
    lines: z
      .array(
        z
          .object({
            concept: z.string().describe('Friendly concept name (e.g. "revenue").'),
            label: z.string().describe('Human-readable concept label.'),
            group: z
              .string()
              .describe(
                'Statement group: income_statement, balance_sheet, cash_flow, per_share, or entity_info.',
              ),
            taxonomy: z.string().describe('Taxonomy the value was read from.'),
            tag: z.string().describe('XBRL tag that produced the value.'),
            unit: z.string().describe('Unit of measure (e.g. "USD", "USD/shares", "shares").'),
            annual: pointSchema
              .optional()
              .describe(
                'Latest full-year (CY####) value. Absent for point-in-time concepts and when period_type excludes it.',
              ),
            quarterly: pointSchema
              .optional()
              .describe(
                'Latest single-quarter (CY####Q#) value. Absent for point-in-time concepts and when period_type excludes it.',
              ),
            instant: pointSchema
              .optional()
              .describe(
                'Latest point-in-time (CY####Q#I) value. Present for balance-sheet and entity-info concepts.',
              ),
          })
          .describe('One resolved concept with its latest value per period kind.'),
      )
      .describe('Resolved concepts, ordered by statement group then concept name.'),
    gaps: z
      .array(
        z
          .object({
            concept: z.string().describe('Friendly concept name that produced no value.'),
            label: z.string().describe('Human-readable concept label.'),
            group: z.string().describe('Statement group the concept belongs to.'),
            tags_tried: z
              .array(z.string())
              .describe('XBRL tags attempted, in priority order, before giving up.'),
          })
          .describe('One concept the filer does not report, with the tags that were tried.'),
      )
      .describe(
        'Concepts with no value for this filer. Deliberately explicit — a missing concept is never zero-filled or interpolated.',
      ),
    caveats: z
      .array(z.string())
      .describe(
        "Data-completeness warnings about the quarterly values. Populated when one calendar quarter is absent from every recent fully-reported year, because SEC reports a filer's fiscal Q4 as the 10-K residual rather than a discrete quarterly fact — this applies to calendar-year filers (no discrete Q4) as much as to off-calendar ones. Empty when nothing needs flagging.",
      ),
  }),

  async handler(input, ctx) {
    const api = getEdgarApiService();

    const resolved = await api.resolveCik(input.company);
    if (Array.isArray(resolved) && resolved.length === 0) {
      throw ctx.fail('company_not_found', `Company '${input.company}' not found.`, {
        ...ctx.recoveryFor('company_not_found'),
      });
    }
    if (Array.isArray(resolved) && resolved.length > 1) {
      const shown = resolved.slice(0, 10);
      const list = shown
        .map((m) => `${m.cik} ${m.name ?? 'Unknown'}${m.ticker ? ` (${m.ticker})` : ''}`)
        .join(', ');
      throw ctx.fail(
        'ambiguous_company',
        `'${input.company}' matches multiple companies: ${list}. Retry with one of these tickers or 10-digit CIKs.`,
        {
          ...ctx.recoveryFor('ambiguous_company'),
          matches: shown.map((m) => ({ cik: m.cik, name: m.name, ticker: m.ticker })),
        },
      );
    }
    const match = Array.isArray(resolved) ? resolved[0] : resolved;
    if (!match) {
      throw ctx.fail('company_not_found', `Company '${input.company}' not found.`, {
        ...ctx.recoveryFor('company_not_found'),
      });
    }

    const facts = await api.tryGetCompanyFacts(match.cik);
    if (!facts || Object.keys(facts.facts).length === 0) {
      throw ctx.fail('no_company_facts', `No XBRL facts on file for CIK ${match.cik}.`, {
        ...ctx.recoveryFor('no_company_facts'),
        cik: match.cik,
      });
    }

    const wantAnnual = input.period_type !== 'quarterly';
    const wantQuarterly = input.period_type !== 'annual';

    const lines: Array<{
      concept: string;
      label: string;
      group: string;
      taxonomy: string;
      tag: string;
      unit: string;
      annual?: ReturnType<typeof latest>;
      quarterly?: ReturnType<typeof latest>;
      instant?: ReturnType<typeof latest>;
    }> = [];
    const gaps: Array<{ concept: string; label: string; group: string; tags_tried: string[] }> = [];
    const quarterFrames: string[] = [];

    for (const entry of listConcepts()) {
      const target = resolveConceptTarget(entry.name, input.taxonomy);
      const series = seriesFromCompanyFacts(facts, target.taxonomy, target.tags);

      if (!series) {
        gaps.push({
          concept: entry.name,
          label: target.label,
          group: entry.group,
          tags_tried: target.tags,
        });
        continue;
      }

      const annual = wantAnnual ? latest(series.series, ANNUAL) : undefined;
      const quarterly = wantQuarterly ? latest(series.series, QUARTER) : undefined;
      const instant = latest(series.series, INSTANT);
      if (!annual && !quarterly && !instant) {
        gaps.push({
          concept: entry.name,
          label: target.label,
          group: entry.group,
          tags_tried: series.tagsTried,
        });
        continue;
      }

      for (const unit of series.series) {
        if (QUARTER.test(unit.frame)) quarterFrames.push(unit.frame);
      }

      lines.push({
        concept: entry.name,
        label: series.label || target.label,
        group: entry.group,
        taxonomy: series.taxonomy,
        tag: series.tag,
        unit: series.unit || target.unit || '',
        ...(annual ? { annual } : {}),
        ...(quarterly ? { quarterly } : {}),
        ...(instant ? { instant } : {}),
      });
    }

    const caveats = wantQuarterly ? missingQuarterCaveats(quarterFrames) : [];

    ctx.log.info('Snapshot built', {
      company: match.cik,
      resolved: lines.length,
      gaps: gaps.length,
    });

    return {
      company: match.name || input.company,
      cik: match.cik,
      taxonomy: input.taxonomy,
      period_type: input.period_type,
      concepts_resolved: lines.length,
      concepts_total: lines.length + gaps.length,
      lines,
      gaps,
      caveats,
    };
  },

  format: (result) => {
    const out = [
      `**Financial snapshot** — ${result.company} (CIK ${result.cik}, ${result.taxonomy}, periods: ${result.period_type})`,
      `${result.concepts_resolved} of ${result.concepts_total} concepts resolved`,
    ];

    const point = (kind: string, p: NonNullable<ReturnType<typeof latest>>) =>
      `  ${kind} ${p.period} = ${p.value} | ends ${p.period_end} | ${p.form} [${p.accession_number}]`;

    let group = '';
    for (const line of result.lines) {
      if (line.group !== group) {
        group = line.group;
        out.push('', `### ${group}`);
      }
      out.push(`- ${line.label} [${line.concept} → ${line.taxonomy}:${line.tag}, ${line.unit}]`);
      if (line.annual) out.push(point('annual', line.annual));
      if (line.quarterly) out.push(point('quarterly', line.quarterly));
      if (line.instant) out.push(point('instant', line.instant));
    }

    if (result.gaps.length > 0) {
      out.push('', `### Not reported (${result.gaps.length})`);
      for (const gap of result.gaps) {
        out.push(
          `- ${gap.label} [${gap.concept}, ${gap.group}] — tried: ${gap.tags_tried.join(', ')}`,
        );
      }
    }

    for (const caveat of result.caveats) out.push('', `Caveat: ${caveat}`);

    return [{ type: 'text', text: out.join('\n') }];
  },
});
