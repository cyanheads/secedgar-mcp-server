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
import {
  dataframeGuidance,
  getCanvasBridge,
  toDatasetField,
} from '@/services/canvas-bridge/canvas-bridge.js';
import {
  describeUnknownConcepts,
  findUnknownConcept,
  resolveConcept,
  resolveConceptTarget,
} from '@/services/edgar/concept-map.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { fiscalQ4Caveats } from '@/services/edgar/fiscal-periods.js';

/**
 * A frame row's business location, or `undefined` when SEC has none. SEC writes
 * `loc` as `<country>-<state>` and a bare `-` when it knows neither; the mirror
 * writes an empty string.
 */
function businessLocation(loc: string): string | undefined {
  return loc && loc !== '-' ? loc : undefined;
}

export const fetchFramesTool = tool('secedgar_fetch_frames', {
  description:
    'Fetch SEC XBRL frames for one concept × one period across all reporting companies. Inline response returns a page of the ranked companies — start at the top or pass offset/next_offset to walk further down the ranking; the full frames response (all reporters) is materialized as df_<id> when a canvas is available — inspect it with secedgar_dataframe_describe, then analyze it with secedgar_dataframe_query. Accepts friendly names like "revenue" or "assets" (discover via secedgar_search_concepts) or raw XBRL tags. One call hits one XBRL tag — when a friendly name maps to multiple same-meaning tags, the response\'s `unqueried_tags` lists the others; call again per tag and UNION/COALESCE in SQL with an analysis-specific priority (e.g. SalesRevenueGoodsNet is goods-only). The response\'s `related_tags` separately flags alternate-DEFINITION tags a meaningful share of filers use as their primary line (e.g. cash incl. restricted cash, equity incl. noncontrolling interest) — a whole-universe screen on the base tag silently omits those filers; query them separately, but do not blindly union (the semantics differ). Response includes `value_distribution` and `period_end_range` to flag XBRL scale-factor anomalies and fiscal-year mixing. SEC publishes frames for us-gaap and dei tags only, and `taxonomy` picks which of the two a raw tag is read from (dei for cover-page tags such as EntityCommonStockSharesOutstanding); a friendly name keeps its own mapped taxonomy. There are no ifrs-full frames, so IFRS (20-F) filers are absent from every frame; read them per company with secedgar_get_financials or secedgar_compare_companies under taxonomy ifrs-full.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when the requested offset lands past the end of the ranked list.'),
    truncated: z.boolean().optional().describe('True when the inline data[] was capped by limit.'),
    shown: z.number().optional().describe('Number of companies shown inline.'),
    cap: z.number().optional().describe('The limit cap applied.'),
  },

  errors: [
    {
      reason: 'unknown_concept',
      code: JsonRpcErrorCode.NotFound,
      when: 'The concept input is neither a supported friendly name nor shaped like an XBRL tag, so no request is sent',
      recovery: 'Use a friendly name from secedgar_search_concepts or a valid raw XBRL tag.',
    },
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Concept resolves but no companies report this metric for the requested period and unit',
      recovery: 'Check duration vs instant period, unit, and that the period exists post-CY2009.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "SEC is rate-limiting this server's IP — SEC answered 429, or the call was refused without being sent while the cool-down after one runs",
      recovery:
        'Wait the retryAfter seconds the error carries, then retry — SEC lifts the block only once requests stop for ten minutes.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  input: z.object({
    concept: z
      .string()
      .min(1)
      .describe(
        'Financial concept — same friendly names as secedgar_get_financials (e.g., "revenue", "assets", "eps_basic") or raw XBRL tag.',
      ),
    taxonomy: z
      .enum(['us-gaap', 'dei'])
      .default('us-gaap')
      .describe(
        'Frames namespace a raw XBRL tag is read from: us-gaap for financial-statement tags, dei for cover-page entity tags such as EntityCommonStockSharesOutstanding. SEC publishes frames for no other taxonomy. A friendly name keeps its own mapped taxonomy (shares_outstanding reads dei) unless dei is passed, which reads its tags from dei instead — the same rule as secedgar_get_financials.',
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
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Rank to start the page at, 0-based, over the sorted frame. Pass the next_offset from the previous response to read the next page — the ranked list is fetched whole and sliced, so paging is stable and gap-free. An offset at or past total_companies returns an empty page.',
      ),
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
    taxonomy: z
      .string()
      .describe(
        'Frames namespace the tag was read from (us-gaap or dei) — a friendly name mapped to dei reads dei under the us-gaap default.',
      ),
    period: z.string().describe('Calendar period the data was fetched for, echoed from input.'),
    unit: z
      .string()
      .describe(
        'Unit of measure used for the lookup (always normalized to dashed form, e.g. "USD-per-shares").',
      ),
    label: z.string().describe('Human-readable concept label.'),
    total_companies: z.number().describe('Total companies reporting this metric for this period.'),
    offset: z
      .number()
      .describe('Rank the returned page starts at, 0-based — the effective offset applied.'),
    next_offset: z
      .number()
      .optional()
      .describe(
        'Offset to pass on the next call to continue down the ranking. Absent on the last page (no companies remain past this one).',
      ),
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
          .describe(
            'Dataframe handle (df_XXXXX_XXXXX) — inspect its columns with secedgar_dataframe_describe, then query it with secedgar_dataframe_query.',
          ),
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
        "Data-completeness warnings specific to this query. Populated for duration periods 'CY####Q[1-4]', where SEC XBRL omits filers' fiscal Q4 (reported only as the 10-K residual) — affected filers are silently absent from the frame. Populated for annual ('CY####') NetIncomeLoss frames, where a filer's row can be its proxy statement's pay-versus-performance figure rather than the 10-K's. Populated for an annual frame whose calendar year is still open or inside its 10-K filing window, where a filer's row can be a trailing-twelve-month figure from a 10-Q rather than a fiscal year. Also flags a value distribution whose top rows look like split or scale-factor artifacts. Otherwise empty.",
      ),
  }),

  async handler(input, ctx) {
    /**
     * A name that is neither a catalog entry nor tag-shaped fails before the
     * frames request, which interpolates the tag into its path (#128). What
     * passes is a friendly name or a well-formed tag, so a 404 below is always
     * `no_data` — a deprecated or unreported tag, never a malformed one (#45).
     */
    const unknown = findUnknownConcept(input.concept);
    if (unknown) {
      const { message, hint } = describeUnknownConcepts([unknown]);
      throw ctx.fail('unknown_concept', message, {
        recovery: { hint },
        concept: unknown.concept,
        suggestions: unknown.suggestions,
        ...(unknown.derivation ? { derivation: unknown.derivation } : {}),
      });
    }

    const api = getEdgarApiService();

    const concept = input.concept.trim();
    const mapping = resolveConcept(concept);
    /**
     * The taxonomy rule `get_financials` applies: a catalog name keeps its own
     * mapped taxonomy under the `us-gaap` default (`dei` for shares_outstanding),
     * an explicit `dei` reads its tags from `dei`, and a raw tag reads from the
     * requested namespace (#143).
     */
    const target = resolveConceptTarget(concept, input.taxonomy);
    const tag = target.tags[0] ?? concept;
    const { label, taxonomy } = target;
    const unit = (target.unit ?? input.unit).replace('/', '-per-');

    const framesResponse = await api.tryGetFrames(taxonomy, tag, unit, input.period);
    if (!framesResponse) {
      /** A tag SEC frames only in the other namespace 404s here too, so say which one was read. */
      const namespaceNote = mapping
        ? mapping.taxonomy === taxonomy
          ? ''
          : ` '${concept}' maps to ${mapping.taxonomy} tags; omit taxonomy to read them from ${mapping.taxonomy}.`
        : taxonomy === 'dei'
          ? ' This read the dei frames; a financial-statement tag needs taxonomy: us-gaap.'
          : ' This read the us-gaap frames; a cover-page tag such as EntityCommonStockSharesOutstanding needs taxonomy: dei.';
      throw ctx.fail(
        'no_data',
        `No data for ${label}/${unit}/${input.period} in the ${taxonomy} frames.`,
        {
          recovery: {
            hint: `Check duration vs. instant period (add "I" for balance sheet items), correct unit (USD-per-shares for EPS), and period exists (data starts ~CY2009).${namespaceNote}`,
          },
          concept: tag,
          taxonomy,
          period: input.period,
          unit,
        },
      );
    }

    const enriched = await Promise.all(
      framesResponse.data.map(async (entry) => {
        const cik = String(entry.cik).padStart(10, '0');
        const ticker = await api.cikToTicker(cik);
        return { entry, cik, ticker, location: businessLocation(entry.loc) };
      }),
    );

    const sorted = [...enriched].sort((a, b) =>
      input.sort === 'desc' ? b.entry.val - a.entry.val : a.entry.val - b.entry.val,
    );

    // Offset paging over the whole sorted frame — the retrieval path for ranks past
    // `limit` when no canvas is available to hold the full set (#89). The frame is
    // fetched whole, so slicing it is contiguous and stable across pages.
    const pageEnd = input.offset + input.limit;
    const sliced = sorted.slice(input.offset, pageEnd);
    const nextOffset = pageEnd < sorted.length ? pageEnd : undefined;
    const data = sliced.map(({ entry, cik, ticker, location }, i) => ({
      rank: input.offset + i + 1,
      company_name: entry.entityName,
      cik,
      ticker: ticker || undefined,
      value: entry.val,
      location,
      period_end: entry.end,
      accession_number: entry.accn,
    }));

    let dataset: { name: string; row_count: number; expires_at: string } | undefined;
    const bridge = getCanvasBridge();
    if (bridge) {
      const allRows = enriched.map(({ entry, cik, ticker, location }) => ({
        cik,
        entity_name: entry.entityName,
        ticker: ticker ?? null,
        value: entry.val,
        location: location ?? null,
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

    // Emitted after registration so the pointer can name a table that exists —
    // `registerDataframe` returns undefined when the canvas is off or the row
    // set was empty (#104). `notice` is last-wins across notice/truncated, so
    // each arm composes one string.
    if (sliced.length === 0 && input.offset > 0) {
      ctx.enrich.notice(
        `Offset (${input.offset}) is at or past the ${sorted.length} companies reporting this concept for this period. Lower the offset to page back into the ranking.` +
          (dataset ? ` ${dataframeGuidance(dataset)}` : ''),
      );
    } else if (nextOffset !== undefined) {
      ctx.enrich.truncated({
        shown: sliced.length,
        cap: input.limit,
        ...(dataset && { guidance: dataframeGuidance(dataset) }),
      });
    } else if (dataset) {
      ctx.enrich.notice(dataframeGuidance(dataset));
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

    const unqueriedTags = target.tags.slice(1);
    const relatedTags = mapping?.relatedTags ?? [];
    const caveats = fiscalQ4Caveats(input.period);

    /**
     * SEC frames the latest-filed fact for a period, and since the
     * pay-versus-performance rule a DEF 14A re-tags five years of annual
     * `NetIncomeLoss` — so the frame row is often the proxy's figure, and the
     * frames API carries no form to detect it by. The mirror's assembly reads the
     * form and has already answered those rows with the 10-K (#123).
     */
    const annualYear = /^CY(\d{4})$/.exec(input.period)?.[1];
    if (tag === 'NetIncomeLoss' && annualYear && !framesResponse.holderFormsResolved) {
      caveats.push(
        "SEC assigns an annual NetIncomeLoss frame to the latest-filed fact for the period, and since the pay-versus-performance rule a filer's DEF 14A proxy statement re-tags five years of net income — so for many filers this frame row is the proxy's figure, often rounded and sometimes mis-scaled or sign-flipped, not the 10-K's. The frames endpoint does not say which form a row came from; check a company's value with secedgar_get_financials, which answers the period from the filer's own report, before relying on a ranking.",
      );
    }

    /**
     * SEC frames any year-long duration as `CY####`, including the
     * trailing-twelve-month figure a 10-Q discloses, and the frames API carries
     * no form to tell one apart. That row holds a filer's annual frame while its
     * fiscal year for the calendar year is still open — through the year itself
     * and the 10-K deadline after it (90 days, plus SEC's framing lag), so until
     * the end of April. Closed years are left alone: a TTM row survives there
     * only in rare non-statement tags, and a caveat on every annual frame would
     * drown the ones that matter. The mirror reads the form and drops those rows
     * itself (#142).
     */
    if (
      annualYear &&
      !framesResponse.holderFormsResolved &&
      new Date().toISOString().slice(0, 10) < `${Number(annualYear) + 1}-05-01`
    ) {
      caveats.push(
        `${input.period} has not closed for every filer: until a filer files its annual report for the calendar year, its row can be a trailing-twelve-month figure from a quarterly report (10-Q) rather than a fiscal year, and the frames endpoint does not say which. Check a company's annual value with secedgar_get_financials, which leaves a 10-Q trailing-twelve-month figure out of the annual series.`,
      );
    }

    /**
     * Artifact caveat (#49): when max/p95 ratio is suspiciously high, warn that
     * top values may be reverse-split or tiny-denominator artifacts. Use a lower
     * threshold for per-share units (USD-per-shares) where split artifacts are
     * especially common.
     */
    const artifactThreshold = unit === 'USD-per-shares' ? 50 : 200;
    if (valueDistribution.max_to_p95_ratio > artifactThreshold) {
      caveats.push(
        'Top values may be split/denominator artifacts — verify value_distribution before trusting absolute rankings.',
      );
    }

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
      taxonomy,
      period: input.period,
      unit,
      label: framesResponse.label || label,
      total_companies: framesResponse.pts,
      offset: input.offset,
      next_offset: nextOffset,
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
      `**${result.label}** [XBRL: ${result.taxonomy}:${result.concept}] — ${result.period} (${result.unit}, ${result.total_companies} companies)`,
    ];
    lines.push(`Page offset: ${result.offset} (${result.data.length} shown)`);
    if (result.next_offset !== undefined) {
      lines.push(`Next offset: ${result.next_offset} — pass as offset to read the next page.`);
    }
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
        `\nDataset: ${result.dataset.name} (${result.dataset.row_count} rows, expires ${result.dataset.expires_at}) — inspect with secedgar_dataframe_describe, then query with secedgar_dataframe_query.`,
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
