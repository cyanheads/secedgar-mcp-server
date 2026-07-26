/**
 * @fileoverview Get historical XBRL financial data for a company.
 * Handles friendly concept name resolution, multi-tag lookup, and automatic deduplication.
 * @module mcp-server/tools/definitions/get-financials
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';
import { resolveConceptTarget } from '@/services/edgar/concept-map.js';
import {
  matchesPeriodType,
  resolveFrameSeries,
  type TagPrioritizedUnit,
} from '@/services/edgar/concept-series.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { missingQuarterCaveats } from '@/services/edgar/fiscal-periods.js';
import type { CompanyConceptUnit } from '@/services/edgar/types.js';

export const getFinancialsTool = tool('secedgar_get_financials', {
  description:
    'Get historical XBRL financial data for a company. Accepts friendly concept names (e.g., "revenue", "net_income", "assets") or raw XBRL tags. Discover available friendly names with secedgar_search_concepts. Handles historical tag changes and deduplicates data automatically.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  enrichment: {
    truncated: z.boolean().optional().describe('True when the inline data[] was capped by limit.'),
    shown: z.number().optional().describe('Number of periods shown inline.'),
    cap: z.number().optional().describe('The limit cap applied.'),
  },

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
      reason: 'no_concept_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'The company does not report any XBRL data for the resolved concept and taxonomy',
      recovery: 'Try a raw XBRL tag, switch taxonomy to ifrs-full, or use a related concept.',
    },
    {
      reason: 'no_frame_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Concept exists but has no frame-aligned (standard calendar period) entries',
      recovery: 'Try a related concept that reports against standard calendar periods.',
    },
    {
      reason: 'no_period_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Concept has data but the period_type filter excluded all of it',
      recovery: 'Switch period_type to "quarterly" or "all" for balance sheet items.',
    },
  ],

  input: z.object({
    company: z
      .string()
      .min(1)
      .describe('Ticker symbol (e.g., "AAPL") or CIK number. Ticker is preferred.'),
    concept: z
      .string()
      .min(1)
      .describe(
        'Financial concept — friendly name (e.g., "revenue", "net_income", "assets", "eps_diluted") or raw XBRL tag (e.g., "AccountsPayableCurrent"). Friendly names auto-resolve to the correct XBRL tags and handle historical tag changes.',
      ),
    taxonomy: z
      .enum(['us-gaap', 'ifrs-full', 'dei'])
      .default('us-gaap')
      .describe(
        'XBRL taxonomy. us-gaap for US companies, ifrs-full for foreign filers, dei for entity info (shares outstanding).',
      ),
    period_type: z
      .enum(['annual', 'quarterly', 'all'])
      .optional()
      .describe(
        'Filter to annual (FY) or quarterly (Q1-Q4) data. "all" returns both. When omitted, defaults to "annual"; instant (balance-sheet) concepts automatically fall back to returning the full series on the first call when the annual filter yields nothing (#48).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Cap the inline data[] to the most-recent N periods (the series is newest-first). The full series is always registered to the dataframe, so older periods stay queryable via secedgar_dataframe_query. Omit to return every period inline.',
      ),
  }),

  output: z.object({
    company: z.string().describe('Resolved entity name (SEC-conformed).'),
    cik: z.string().describe('Resolved CIK, zero-padded to 10 digits.'),
    concept: z.string().describe('XBRL tag name used.'),
    label: z.string().describe('Human-readable label for the concept.'),
    description: z
      .string()
      .optional()
      .describe(
        'XBRL taxonomy description for this concept. Often absent for company-extension tags or older concepts.',
      ),
    unit: z.string().describe('Unit of measure (e.g., "USD", "shares", "USD/shares").'),
    data: z
      .array(
        z
          .object({
            period: z.string().describe('Calendar period label (e.g., "CY2023", "CY2023Q3").'),
            value: z.number().describe('Reported value.'),
            start: z
              .string()
              .optional()
              .describe('Period start date (YYYY-MM-DD). Duration items only.'),
            end: z.string().describe('Period end date (YYYY-MM-DD).'),
            fiscal_year: z
              .number()
              .nullable()
              .describe(
                "Fiscal year of the source filing, not the data period — every comparative period restated in the same filing carries that filing's fiscal year, so use end (or period) as the time key. Null when the source filing did not encode a fiscal year.",
              ),
            fiscal_period: z
              .string()
              .nullable()
              .describe(
                'Fiscal period of the source filing (FY, Q1, Q2, Q3, Q4), not the data period. Null when the source filing did not encode a fiscal period.',
              ),
            form: z.string().describe('Source filing type (10-K, 10-Q, etc.).'),
            filed: z.string().describe('Date the source filing was submitted (YYYY-MM-DD).'),
            accession_number: z
              .string()
              .describe('Source filing accession number for secedgar_get_filing.'),
          })
          .describe('One reported value with its period, fiscal context, and source filing.'),
      )
      .describe('Deduplicated time series, newest first.'),
    tags_tried: z
      .array(z.string())
      .optional()
      .describe(
        'XBRL tags that were attempted (shown when using friendly names that map to multiple tags).',
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
        'Canvas dataframe handle holding the same time series. Use for cross-company JOINs via secedgar_dataframe_query. The source-filing fiscal keys are materialized as source_filing_fy/source_filing_fp — order, group, and window by period_end, not by those columns. Absent when canvas is unavailable.',
      ),
    caveats: z
      .array(z.string())
      .optional()
      .describe(
        "Data-completeness warnings about the returned series. Populated on quarterly results when one calendar quarter is absent from every recent fully-reported year — SEC reports a filer's fiscal Q4 as the 10-K residual rather than a discrete quarterly fact, so the calendar quarter that fiscal Q4 spans has no frame-tagged value. Applies to calendar-year filers (no discrete Q4) as much as to off-calendar ones. Absent when the series has nothing to flag.",
      ),
  }),

  async handler(input, ctx) {
    const api = getEdgarApiService();

    // Resolve company to CIK
    const resolved = await api.resolveCik(input.company);
    if (Array.isArray(resolved) && resolved.length === 0) {
      throw ctx.fail('company_not_found', `Company '${input.company}' not found.`, {
        ...ctx.recoveryFor('company_not_found'),
      });
    }
    if (Array.isArray(resolved) && resolved.length > 1) {
      // Render the candidates into the message itself, not just structured data —
      // clients that read only content[] otherwise get a "pick from the matches
      // list" instruction with no list to pick from (#90). Same shape the
      // company_search and get_institutional_holdings ambiguity paths already ship.
      const shown = resolved.slice(0, 10);
      const list = shown
        .map((m) => `${m.cik} ${m.name ?? 'Unknown'}${m.ticker ? ` (${m.ticker})` : ''}`)
        .join(', ');
      throw ctx.fail(
        'ambiguous_company',
        `'${input.company}' matches multiple companies: ${list}. Retry with one of these tickers or 10-digit CIKs.`,
        {
          ...ctx.recoveryFor('ambiguous_company'),
          matches: shown.map((m) => ({
            cik: m.cik,
            name: m.name,
            ticker: m.ticker,
          })),
        },
      );
    }
    const match = Array.isArray(resolved) ? resolved[0] : resolved;
    if (!match) {
      throw ctx.fail('company_not_found', `Company '${input.company}' not found.`, {
        ...ctx.recoveryFor('company_not_found'),
      });
    }

    // Resolve concept to taxonomy + XBRL tag(s). The mapping's own taxonomy wins
    // over the `us-gaap` default (e.g. `dei` for shares_outstanding); ifrs-full
    // uses the confirmed IFRS variants when the mapping has them.
    const {
      label,
      tags,
      taxonomy,
      unit: mappedUnit,
    } = resolveConceptTarget(input.concept, input.taxonomy);

    // Default to "annual" for unset period_type; post-fetch fallback handles instant concepts (#48).
    const effectivePeriodType = input.period_type ?? 'annual';

    // Try each tag until we get data. `tryGetCompanyConcept` returns null for 404
    // (tag not reported by this company); other errors propagate.
    let conceptResponse:
      | {
          units: Record<string, CompanyConceptUnit[]>;
          label: string;
          description: string | undefined;
          tag: string;
        }
      | undefined;
    const tagsTried: string[] = [];
    /**
     * Each unit is augmented with its source-tag index so the frame dedup can
     * resolve collisions by tag priority (#44). Index 0 = preferred total.
     */
    const allUnits: TagPrioritizedUnit[] = [];

    for (const [tagIndex, tag] of tags.entries()) {
      tagsTried.push(tag);
      const resp = await api.tryGetCompanyConcept(match.cik, taxonomy, tag);
      if (!resp) continue;
      if (!conceptResponse) {
        conceptResponse = {
          units: resp.units,
          label: resp.label,
          description: resp.description ?? undefined,
          tag: resp.tag,
        };
      }
      for (const units of Object.values(resp.units)) {
        for (const u of units) {
          allUnits.push({ ...u, tagIndex });
        }
      }
    }

    if (!conceptResponse || allUnits.length === 0) {
      // Probe companyfacts to discover what namespaces and tags this filer actually reports.
      // Only on the error path — one extra request, never on the happy path.
      const facts = await api.tryGetCompanyFacts(match.cik);
      const availableNamespaces = facts ? Object.keys(facts.facts) : [];

      let hint: string;
      if (facts && availableNamespaces.length > 0) {
        const namespaceSummary = availableNamespaces
          .map((ns) => {
            const nsTags = Object.keys(facts.facts[ns] ?? {});
            const searchTerm = tagsTried[0]?.toLowerCase().replace(/_/g, '') ?? '';
            // Surface a few matching tags when the requested concept overlaps with this namespace
            const matchingTags = searchTerm
              ? nsTags.filter((t) => t.toLowerCase().includes(searchTerm)).slice(0, 3)
              : [];
            return matchingTags.length > 0
              ? `${ns} (${nsTags.length} tags, e.g. ${matchingTags.join(', ')})`
              : `${ns} (${nsTags.length} tags)`;
          })
          .join('; ');
        hint = `This filer reports under: ${namespaceSummary}. Try a raw XBRL tag from one of these namespaces, or switch taxonomy to match.`;
      } else {
        hint =
          taxonomy === 'ifrs-full'
            ? 'Try a raw XBRL tag instead of a friendly name, or check the company uses IFRS.'
            : "This company may use a different tag or taxonomy. Try 'ifrs-full' for foreign filers.";
      }

      throw ctx.fail(
        'no_concept_data',
        `No XBRL data for '${input.concept}' under ${taxonomy} for this company.`,
        {
          recovery: { hint },
          concept: input.concept,
          taxonomy,
          tags_tried: tagsTried,
          available_namespaces: availableNamespaces.length > 0 ? availableNamespaces : undefined,
        },
      );
    }

    /**
     * Collapse to one value per standard calendar period — frame-bearing entries
     * only, same-frame collisions resolved by tag priority then latest `filed`
     * (#44). An empty map means the concept exists but has no frame-aligned entries.
     */
    const byFrameClean = resolveFrameSeries(allUnits);
    if (byFrameClean.size === 0) {
      throw ctx.fail(
        'no_frame_data',
        `'${conceptResponse.tag}' exists for this company but has no standard-period data.`,
        {
          ...ctx.recoveryFor('no_frame_data'),
          tag: conceptResponse.tag,
        },
      );
    }

    // Filter by period type using frame pattern (fp reflects the filing, not the data point)
    // resolvedPeriodType tracks the actual period type after the instant fallback (#48).
    let resolvedPeriodType = effectivePeriodType;
    let filtered = Array.from(byFrameClean.values()).filter((u) =>
      matchesPeriodType(u.frame, effectivePeriodType),
    );

    // If period_type filter removed everything, check for instant-concept fallback (#48)
    if (filtered.length === 0 && byFrameClean.size > 0) {
      const sample = byFrameClean.values().next().value;
      const hasInstant = sample && /I$/.test(sample.frame);

      /**
       * Post-fetch instant fallback (#48): when `period_type` was NOT explicitly set
       * and the annual filter emptied a non-empty series whose frames are all instant
       * (CY####Q#I), return the full set. The caller asked for the concept's default
       * period — the right answer is the series that actually exists, not an error.
       */
      if (hasInstant && input.period_type === undefined) {
        filtered = Array.from(byFrameClean.values());
        resolvedPeriodType = 'all';
      } else {
        const hint = hasInstant
          ? 'This is a balance sheet (instant) item — try period_type: "quarterly" or "all".'
          : effectivePeriodType === 'annual'
            ? 'No annual data found — try period_type: "quarterly" or "all".'
            : 'No quarterly data found — try period_type: "annual" or "all".';
        throw ctx.fail(
          'no_period_data',
          `No ${effectivePeriodType} data for '${conceptResponse.tag}'.`,
          {
            recovery: { hint },
            tag: conceptResponse.tag,
            period_type: effectivePeriodType,
          },
        );
      }
    }

    // Sort newest first
    filtered.sort((a, b) => b.end.localeCompare(a.end));

    /**
     * Off-calendar filers lose a whole calendar quarter from the frame-tagged
     * series — SEC reports fiscal Q4 as the 10-K residual, never as a discrete
     * quarterly fact — so a caller sees a gap with no way to tell "did not
     * report" from "frame tagging does not expose it". `fetch_frames` already
     * flags the same hazard from the period side; this names the specific
     * quarter for this filer (#95). Detection reads the resolved frames, so it
     * runs over the full deduped set rather than the period-filtered slice.
     */
    const caveats =
      resolvedPeriodType === 'annual' ? [] : missingQuarterCaveats(byFrameClean.keys());

    // Determine unit string
    const unitKey = Object.keys(conceptResponse.units)[0] ?? mappedUnit ?? 'USD';

    const data = filtered.map((u) => ({
      period: u.frame,
      value: u.val,
      start: u.start || undefined,
      end: u.end,
      fiscal_year: u.fy,
      fiscal_period: u.fp,
      form: u.form,
      filed: u.filed,
      accession_number: u.accn,
    }));

    let dataset: { name: string; row_count: number; expires_at: string } | undefined;
    const bridge = getCanvasBridge();
    if (bridge && data.length > 0) {
      const rows = data.map((d) => ({
        cik: match.cik,
        entity_name: match.name ?? null,
        concept: conceptResponse.tag,
        taxonomy,
        unit: unitKey,
        period: d.period,
        value: d.value,
        period_start: d.start ?? null,
        period_end: d.end,
        // Named for what they are — the SOURCE FILING's fy/fp, not the data
        // period. Bare fiscal_year/fiscal_period invited ORDER BY/GROUP BY
        // against the wrong key; period_end is the time key (#72).
        source_filing_fy: d.fiscal_year,
        source_filing_fp: d.fiscal_period,
        form: d.form,
        filed: d.filed,
        accession_number: d.accession_number,
      }));
      const registered = await bridge.registerDataframe(ctx, {
        rows,
        sourceTool: 'secedgar_get_financials',
        queryParams: {
          company: input.company,
          cik: match.cik,
          concept: conceptResponse.tag,
          taxonomy,
          period_type: resolvedPeriodType,
        },
      });
      if (registered) dataset = toDatasetField(registered);
    }

    // Slice inline view when a limit was requested; the dataframe holds the
    // full series, so older periods stay queryable via the dataframe handle (#32).
    const inlineData = input.limit ? data.slice(0, input.limit) : data;
    if (input.limit && data.length > input.limit) {
      ctx.enrich.truncated({ shown: input.limit, cap: input.limit });
    }

    ctx.log.info('Financials retrieved', {
      company: match.cik,
      concept: conceptResponse.tag,
      dataPoints: data.length,
      datasetName: dataset?.name,
    });

    return {
      company: match.name || input.company,
      cik: match.cik,
      concept: conceptResponse.tag,
      label: conceptResponse.label || label,
      description: conceptResponse.description || undefined,
      unit: unitKey,
      data: inlineData,
      tags_tried: tagsTried.length > 1 ? tagsTried : undefined,
      dataset,
      caveats: caveats.length > 0 ? caveats : undefined,
    };
  },

  format: (result) => {
    const lines = [`**${result.label}** — ${result.company} (CIK ${result.cik}, ${result.unit})`];
    lines.push(`XBRL tag: ${result.concept}`);
    if (result.description) lines.push(result.description);
    if (result.tags_tried?.length) {
      lines.push(`Tags tried: ${result.tags_tried.join(', ')}`);
    }
    lines.push('');
    for (const d of result.data) {
      const formatted =
        result.unit === 'USD'
          ? `$${(d.value / 1_000_000).toFixed(1)}M`
          : result.unit === 'USD/shares'
            ? `$${d.value.toFixed(2)}`
            : d.value.toLocaleString();
      const fy = d.fiscal_year != null ? `FY${d.fiscal_year}` : null;
      const fp = d.fiscal_period ?? null;
      const fiscalCtx = [fy, fp].filter(Boolean).join(' ');
      const range = d.start ? `${d.start} → ${d.end}` : d.end;
      const filingCtx = fiscalCtx
        ? `${d.form} (${fiscalCtx}) filed ${d.filed} [${d.accession_number}]`
        : `${d.form} filed ${d.filed} [${d.accession_number}]`;
      lines.push(`${d.period}: ${formatted} (raw ${d.value}) | ${range} | ${filingCtx}`);
    }
    if (result.dataset) {
      const sliceNote =
        result.dataset.row_count > result.data.length
          ? ` — showing the ${result.data.length} most-recent of ${result.dataset.row_count} periods inline; full series on the dataframe`
          : '';
      lines.push(
        `\nDataset: ${result.dataset.name} (${result.dataset.row_count} rows, expires ${result.dataset.expires_at})${sliceNote} — query with secedgar_dataframe_query.`,
      );
    }
    for (const caveat of result.caveats ?? []) {
      lines.push(`\nCaveat: ${caveat}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
