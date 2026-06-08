/**
 * @fileoverview Fetch SEC XBRL frames for one concept × one period across all
 * reporting companies. Inline response returns the top N ranked companies;
 * when a canvas is available, the full upstream frames response (typically
 * 2k–10k rows depending on the concept) is materialized as `df_<id>` for
 * downstream SQL via `secedgar_dataframe_query`.
 *
 * @module mcp-server/tools/definitions/fetch-frames
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';
import { resolveConcept } from '@/services/edgar/concept-map.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';

/**
 * SEC XBRL reports fiscal Q4 as the 10-K residual, never as a discrete
 * quarterly fact, so any company whose fiscal year ends inside the queried
 * calendar quarter is silently absent from a `CY####Q[1-4]` frame. The
 * omission is invisible without domain knowledge — flag it so the caller knows
 * to cross-reference `secedgar_get_financials` with `period_type='annual'` for
 * those filers. Annual (`CY####`) and instant (`CY####Q#I`) periods are
 * unaffected.
 */
function fiscalQ4Caveats(period: string): string[] {
  const match = period.match(/^CY\d{4}Q([1-4])$/);
  if (!match) return [];
  const examples: Record<string, string> = {
    '1': 'WMT Jan-end, HD/TGT Feb-end',
    '2': 'MSFT Jun-end, ORCL May-end',
    '3': 'AAPL Sep-end, ACN Aug-end, CSCO Jul-end, COST early Sep',
    '4': 'most US filers (calendar fiscal year)',
  };
  const q = match[1] as keyof typeof examples;
  return [
    `Filers whose fiscal Q4 closes in calendar Q${q} are absent from this frame — SEC XBRL reports their fiscal Q4 as the 10-K residual rather than a discrete quarterly fact (e.g. ${examples[q]}). Use secedgar_get_financials with period_type='annual' for those filers.`,
  ];
}

export const fetchFramesTool = tool('secedgar_fetch_frames', {
  description:
    'Fetch SEC XBRL frames for one concept × one period across all reporting companies. Inline response returns the top N ranked companies; the full frames response (all reporters) is materialized as df_<id> when a canvas is available, queryable via secedgar_dataframe_query. Accepts friendly names like "revenue" or "assets" (discover via secedgar_search_concepts) or raw XBRL tags. One call hits one XBRL tag — when a friendly name maps to multiple same-meaning tags, the response\'s `unqueried_tags` lists the others; call again per tag and UNION/COALESCE in SQL with an analysis-specific priority (e.g. SalesRevenueGoodsNet is goods-only). The response\'s `related_tags` separately flags alternate-DEFINITION tags a meaningful share of filers use as their primary line (e.g. cash incl. restricted cash, equity incl. noncontrolling interest) — a whole-universe screen on the base tag silently omits those filers; query them separately, but do not blindly union (the semantics differ). Response includes `value_distribution` and `period_end_range` to flag XBRL scale-factor anomalies and fiscal-year mixing.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'unknown_concept',
      code: JsonRpcErrorCode.NotFound,
      when: 'The concept input does not match a friendly name and SEC frames returned no data',
      recovery: 'Use a friendly name from secedgar_search_concepts or a valid raw XBRL tag.',
    },
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Concept resolves but no companies report this metric for the requested period and unit',
      recovery: 'Check duration vs instant period, unit, and that the period exists post-CY2009.',
    },
  ],

  input: z.object({
    concept: z
      .string()
      .min(1)
      .describe(
        'Financial concept — same friendly names as secedgar_get_financials (e.g., "revenue", "assets", "eps_basic") or raw XBRL tag.',
      ),
    period: z
      .string()
      .min(1)
      .regex(/^CY\d{4}(Q[1-4]I?)?$/, 'Expected CY####, CY####Q#, or CY####Q#I')
      .describe(
        'Calendar period. Use duration periods (no I suffix) for income/cash-flow items: "CY2023" (full year), "CY2024Q2" (single quarter). Use instant periods (I suffix) for balance-sheet items: "CY2023Q4I" (snapshot at Q4 close).',
      ),
    unit: z
      .enum(['USD', 'USD-per-shares', 'USD/shares', 'shares', 'pure'])
      .default('USD')
      .describe(
        'Unit of measure. Use "USD-per-shares" (or equivalently "USD/shares") for EPS, "shares" for share counts, "pure" for ratios. Ignored when concept resolves to a friendly name with a known unit.',
      ),
    limit: z.number().int().min(1).max(100).default(25).describe('Number of companies to return.'),
    sort: z
      .enum(['desc', 'asc'])
      .default('desc')
      .describe(
        'Sort direction. "desc" for highest values first (typical for revenue, assets). "asc" for lowest values.',
      ),
  }),

  output: z.object({
    concept: z
      .string()
      .describe(
        'XBRL tag the data was actually fetched against (after resolving any friendly name).',
      ),
    period: z.string().describe('Calendar period the data was fetched for, echoed from input.'),
    unit: z
      .string()
      .describe(
        'Unit of measure used for the lookup (always normalized to dashed form, e.g. "USD-per-shares").',
      ),
    label: z.string().describe('Human-readable concept label.'),
    total_companies: z.number().describe('Total companies reporting this metric for this period.'),
    data: z
      .array(
        z
          .object({
            rank: z.number().describe('Rank in sorted order.'),
            company_name: z.string().describe('Entity name.'),
            cik: z.string().describe('Company CIK, zero-padded to 10 digits.'),
            ticker: z.string().optional().describe('Ticker symbol (if available).'),
            value: z.number().describe('Reported value.'),
            location: z
              .string()
              .optional()
              .describe(
                'Business location (state or country). Absent when SEC has no location for this filer.',
              ),
            period_end: z.string().describe('Period end date (YYYY-MM-DD).'),
            accession_number: z.string().describe('Source filing for secedgar_get_filing.'),
          })
          .describe("One company's reported value for this metric and period."),
      )
      .describe('Ranked companies for this metric.'),
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
        'Canvas dataframe handle holding the full frames response. Absent when canvas is unavailable or materialization failed.',
      ),
    unqueried_tags: z
      .array(z.string())
      .describe(
        'Other same-meaning XBRL tags in the friendly-name mapping that this call did NOT query (historical/variant spellings of the same metric). Empty for raw tags or single-tag concepts — for alternate-DEFINITION tags some filers use instead, see `related_tags`. For "revenue" this typically lists `Revenues`, `SalesRevenueNet`, `SalesRevenueGoodsNet` — filers reporting under legacy variants are absent from `data`; call again per tag and UNION/COALESCE in SQL to recover them.',
      ),
    related_tags: z
      .array(
        z
          .object({
            tag: z
              .string()
              .describe(
                'Alternate XBRL tag a meaningful share of filers report this metric under instead.',
              ),
            note: z.string().describe('How this tag differs in definition from the queried tag.'),
          })
          .describe('One alternate-definition tag and the reason it differs.'),
      )
      .describe(
        'Alternate-DEFINITION XBRL tags (distinct from same-meaning `unqueried_tags`) that a meaningful share of filers use as their primary line for this metric — e.g. `cash` filers reporting `CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents` (incl. restricted cash), `equity` filers reporting `StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest` (incl. noncontrolling interest). These filers are NOT in `data` or the dataframe, so a whole-universe screen on the base tag silently under-counts. To recover them, run a separate fetch_frames against the alternate tag — do NOT blindly UNION (definitions differ; you would mix or double-count). Empty when the concept has no known high-coverage alternate.',
      ),
    value_distribution: z
      .object({
        median: z.number().describe('Median reported value across all reporters in the frame.'),
        p95: z.number().describe('95th-percentile reported value.'),
        max: z.number().describe('Maximum reported value.'),
        max_to_p95_ratio: z
          .number()
          .describe(
            'Maximum value divided by 95th percentile. Robust to zero/negative bulk (unlike median-based ratios — many frames have median = 0 or negative, e.g. EPS with many loss-making filers). Typical heavy-tail frames sit in the 10–50× range (mega-caps over the rest); ratios above ~200× usually indicate a filer-side XBRL scale-factor error (wrong `decimals` attribute) — verify the topmost row(s) in `data` before trusting absolute rankings.',
          ),
      })
      .describe(
        'Distribution stats across the full frame, computed during materialization. Use `max_to_p95_ratio` as the primary outlier signal — it catches scale-factor anomalies even when median is 0 or negative.',
      ),
    period_end_range: z
      .object({
        min: z.string().describe('Earliest period_end across all rows (YYYY-MM-DD).'),
        max: z.string().describe('Latest period_end across all rows (YYYY-MM-DD).'),
      })
      .describe(
        'Range of period_end dates across the frame. SEC normalizes to calendar periods but filers report against their own fiscal year-ends, so a "CY2023" duration frame can contain period_ends from 2023-01-31 (January-FY filers like Walmart) to 2024-12-31 (calendar-FY filers reported late). Wide ranges mean cross-comparison mixes fiscal periods.',
      ),
    caveats: z
      .array(z.string())
      .describe(
        "Data-completeness warnings specific to this query. Currently populated for duration periods 'CY####Q[1-4]', where SEC XBRL omits filers' fiscal Q4 (reported only as the 10-K residual) — affected filers are silently absent from the frame. Empty for annual ('CY####') and instant ('CY####Q#I') periods, where the underlying facts exist and the frame is complete.",
      ),
  }),

  async handler(input, ctx) {
    const api = getEdgarApiService();

    const mapping = resolveConcept(input.concept);
    const tag = mapping?.tags[0] ?? input.concept;
    const taxonomy = mapping?.taxonomy ?? 'us-gaap';
    const label = mapping?.label ?? input.concept;
    const unit = (mapping?.unit ?? input.unit).replace('/', '-per-');

    const framesResponse = await api.tryGetFrames(taxonomy, tag, unit, input.period);
    if (!framesResponse) {
      if (!mapping) {
        throw ctx.fail('unknown_concept', `Unknown concept '${input.concept}'.`, {
          ...ctx.recoveryFor('unknown_concept'),
          concept: input.concept,
        });
      }
      throw ctx.fail('no_data', `No data for ${label}/${unit}/${input.period}.`, {
        recovery: {
          hint: 'Check duration vs. instant period (add "I" for balance sheet items), correct unit (USD-per-shares for EPS), and period exists (data starts ~CY2009).',
        },
        concept: tag,
        period: input.period,
        unit,
      });
    }

    const enriched = await Promise.all(
      framesResponse.data.map(async (entry) => {
        const cik = String(entry.cik).padStart(10, '0');
        const ticker = await api.cikToTicker(cik);
        return { entry, cik, ticker };
      }),
    );

    const sorted = [...enriched].sort((a, b) =>
      input.sort === 'desc' ? b.entry.val - a.entry.val : a.entry.val - b.entry.val,
    );

    const data = sorted.slice(0, input.limit).map(({ entry, cik, ticker }, i) => ({
      rank: i + 1,
      company_name: entry.entityName,
      cik,
      ticker: ticker || undefined,
      value: entry.val,
      location: entry.loc || undefined,
      period_end: entry.end,
      accession_number: entry.accn,
    }));

    let dataset: { name: string; row_count: number; expires_at: string } | undefined;
    const bridge = getCanvasBridge();
    if (bridge) {
      const allRows = enriched.map(({ entry, cik, ticker }) => ({
        cik,
        entity_name: entry.entityName,
        ticker: ticker ?? null,
        value: entry.val,
        location: entry.loc || null,
        period_start: entry.start ?? null,
        period_end: entry.end,
        accession_number: entry.accn,
      }));

      const registered = await bridge.registerDataframe(ctx, {
        rows: allRows,
        sourceTool: 'secedgar_fetch_frames',
        queryParams: {
          concept: tag,
          taxonomy,
          period: input.period,
          unit,
        },
      });
      if (registered) dataset = toDatasetField(registered);
    }

    const sortedValues = framesResponse.data.map((e) => e.val).sort((a, b) => a - b);
    const n = sortedValues.length;
    const median = n > 0 ? (sortedValues[Math.floor(n / 2)] ?? 0) : 0;
    const p95 = n > 0 ? (sortedValues[Math.floor(n * 0.95)] ?? 0) : 0;
    const maxVal = n > 0 ? (sortedValues[n - 1] ?? 0) : 0;
    const valueDistribution = {
      median,
      p95,
      max: maxVal,
      max_to_p95_ratio: p95 > 0 ? Math.round((maxVal / p95) * 10) / 10 : 0,
    };

    const sortedEnds = framesResponse.data.map((e) => e.end).sort();
    const periodEndRange = {
      min: sortedEnds[0] ?? '',
      max: sortedEnds[sortedEnds.length - 1] ?? '',
    };

    const unqueriedTags = mapping ? mapping.tags.slice(1) : [];
    const relatedTags = mapping?.relatedTags ?? [];
    const caveats = fiscalQ4Caveats(input.period);

    ctx.log.info('Frames fetched', {
      concept: tag,
      period: input.period,
      totalCompanies: framesResponse.pts,
      returned: data.length,
      datasetName: dataset?.name,
      maxToP95Ratio: valueDistribution.max_to_p95_ratio,
    });

    return {
      concept: tag,
      period: input.period,
      unit,
      label: framesResponse.label || label,
      total_companies: framesResponse.pts,
      data,
      dataset,
      unqueried_tags: unqueriedTags,
      related_tags: relatedTags,
      value_distribution: valueDistribution,
      period_end_range: periodEndRange,
      caveats,
    };
  },

  format: (result) => {
    const lines = [
      `**${result.label}** [XBRL: ${result.concept}] — ${result.period} (${result.unit}, ${result.total_companies} companies)`,
    ];
    for (const d of result.data) {
      const ticker = d.ticker ? ` (${d.ticker})` : '';
      const formatted =
        result.unit === 'USD'
          ? `$${(d.value / 1_000_000_000).toFixed(2)}B`
          : result.unit === 'USD-per-shares'
            ? `$${d.value.toFixed(2)}`
            : d.value.toLocaleString();
      const location = d.location ? ` | ${d.location}` : '';
      lines.push(
        `${d.rank}. ${d.company_name}${ticker} — CIK ${d.cik}: ${formatted} (raw ${d.value}) | period end ${d.period_end}${location} [${d.accession_number}]`,
      );
    }
    if (result.dataset) {
      lines.push(
        `\nDataset: ${result.dataset.name} (${result.dataset.row_count} rows, expires ${result.dataset.expires_at}) — query with secedgar_dataframe_query.`,
      );
    }

    const tagCount = result.unqueried_tags.length + 1;
    const alsoUnder =
      result.unqueried_tags.length > 0 ? ` — also: ${result.unqueried_tags.join(', ')}` : '';
    lines.push(`Coverage: 1 of ${tagCount} XBRL tags queried${alsoUnder}`);
    if (result.related_tags.length > 0) {
      const rel = result.related_tags.map((r) => `${r.tag} (${r.note})`).join('; ');
      lines.push(
        `Related tags (alternate definitions — not in data/df; query separately, don't blindly union): ${rel}`,
      );
    }
    lines.push(
      `Value dispersion: median ${result.value_distribution.median.toLocaleString()}, p95 ${result.value_distribution.p95.toLocaleString()}, max ${result.value_distribution.max.toLocaleString()}, max/p95 ${result.value_distribution.max_to_p95_ratio}×`,
    );
    lines.push(`Period ends: ${result.period_end_range.min} → ${result.period_end_range.max}`);
    for (const c of result.caveats) {
      lines.push(`\nCaveat: ${c}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
