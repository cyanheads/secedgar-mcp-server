/**
 * @fileoverview Get historical XBRL financial data for a company.
 * Handles friendly concept name resolution, multi-tag lookup, and automatic deduplication.
 * @module mcp-server/tools/definitions/get-financials
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';
import { resolveConcept } from '@/services/edgar/concept-map.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import type { CompanyConceptUnit } from '@/services/edgar/types.js';

export const getFinancialsTool = tool('secedgar_get_financials', {
  description:
    'Get historical XBRL financial data for a company. Accepts friendly concept names (e.g., "revenue", "net_income", "assets") or raw XBRL tags. Discover available friendly names with secedgar_search_concepts. Handles historical tag changes and deduplicates data automatically.',
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
                'Fiscal year of the source filing. Null when the source filing did not encode a fiscal year.',
              ),
            fiscal_period: z
              .string()
              .nullable()
              .describe(
                'Fiscal period of the source filing (FY, Q1, Q2, Q3, Q4). Null when the source filing did not encode a fiscal period.',
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
        'Canvas dataframe handle holding the same time series. Use for cross-company JOINs via secedgar_dataframe_query. Absent when canvas is unavailable.',
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
      throw ctx.fail('ambiguous_company', `'${input.company}' matches multiple companies.`, {
        ...ctx.recoveryFor('ambiguous_company'),
        matches: resolved.slice(0, 10).map((m) => ({
          cik: m.cik,
          name: m.name,
          ticker: m.ticker,
        })),
      });
    }
    const match = Array.isArray(resolved) ? resolved[0] : resolved;
    if (!match) {
      throw ctx.fail('company_not_found', `Company '${input.company}' not found.`, {
        ...ctx.recoveryFor('company_not_found'),
      });
    }

    // Resolve concept to XBRL tag(s)
    const mapping = resolveConcept(input.concept);

    // When the user overrides the default taxonomy, honor their choice;
    // otherwise fall back to the mapping's preferred taxonomy (e.g. `dei` for shares_outstanding).
    let taxonomy = input.taxonomy;
    if (mapping && input.taxonomy === 'us-gaap') {
      taxonomy = mapping.taxonomy as typeof input.taxonomy;
    }

    // Use IFRS-specific tags when the effective taxonomy is ifrs-full and the mapping
    // has confirmed IFRS variants; fall back to the standard tags otherwise.
    const tags = mapping
      ? taxonomy === 'ifrs-full' && mapping.ifrsTags?.length
        ? mapping.ifrsTags
        : mapping.tags
      : [input.concept];
    const label = mapping?.label ?? input.concept;

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
    const allUnits: Array<CompanyConceptUnit & { _tagIdx: number }> = [];

    for (const [tagIdx, tag] of tags.entries()) {
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
          allUnits.push({ ...u, _tagIdx: tagIdx });
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

    // Deduplicate: keep only entries with frame field (one per standard calendar period)
    const deduped = allUnits.filter(
      (u): u is CompanyConceptUnit & { frame: string; _tagIdx: number } => !!u.frame,
    );

    // If deduplication removed everything, the concept exists but has no frame-aligned entries
    if (deduped.length === 0) {
      throw ctx.fail(
        'no_frame_data',
        `'${conceptResponse.tag}' exists for this company but has no standard-period data.`,
        {
          ...ctx.recoveryFor('no_frame_data'),
          tag: conceptResponse.tag,
        },
      );
    }

    /**
     * Remove duplicates by frame value using tag-priority-aware selection (#44).
     *
     * When two facts share a frame, the one with the lower `_tagIdx` wins
     * (index 0 = preferred total, e.g. IFRS `Revenue` > `RevenueFromContractsWithCustomers`).
     * Ties within the same tag index are broken by latest `filed` to preserve
     * restatement handling (amended filing replaces the original).
     */
    const byFrame = new Map<string, CompanyConceptUnit & { frame: string; _tagIdx: number }>();
    for (const unit of deduped) {
      const existing = byFrame.get(unit.frame);
      if (!existing) {
        byFrame.set(unit.frame, unit);
      } else if (
        unit._tagIdx < existing._tagIdx ||
        (unit._tagIdx === existing._tagIdx && unit.filed > existing.filed)
      ) {
        byFrame.set(unit.frame, unit);
      }
    }

    // Strip the internal _tagIdx from results before further use
    const byFrameClean = new Map<string, CompanyConceptUnit & { frame: string }>();
    for (const [k, v] of byFrame) {
      const { _tagIdx: _, ...rest } = v;
      byFrameClean.set(k, rest as CompanyConceptUnit & { frame: string });
    }

    // Filter by period type using frame pattern (fp reflects the filing, not the data point)
    // resolvedPeriodType tracks the actual period type after the instant fallback (#48).
    let resolvedPeriodType = effectivePeriodType;
    let filtered = Array.from(byFrameClean.values());
    if (effectivePeriodType === 'annual') {
      filtered = filtered.filter((u) => /^CY\d{4}$/.test(u.frame));
    } else if (effectivePeriodType === 'quarterly') {
      filtered = filtered.filter((u) => /^CY\d{4}Q\d/.test(u.frame));
    }

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

    // Determine unit string
    const unitKey = Object.keys(conceptResponse.units)[0] ?? mapping?.unit ?? 'USD';

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
        fiscal_year: d.fiscal_year,
        fiscal_period: d.fiscal_period,
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
      // Slice the inline view only; the dataframe registered above holds the
      // full series, so older periods stay queryable via the dataframe handle (#32).
      data: input.limit ? data.slice(0, input.limit) : data,
      tags_tried: tagsTried.length > 1 ? tagsTried : undefined,
      dataset,
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
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
