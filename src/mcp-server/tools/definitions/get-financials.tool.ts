/**
 * @fileoverview Get historical XBRL financial data for a company.
 * Handles friendly concept name resolution, multi-tag lookup, and automatic deduplication.
 * @module mcp-server/tools/definitions/get-financials
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { resolveConcept } from '@/services/edgar/concept-map.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import type { CompanyConceptUnit } from '@/services/edgar/types.js';

export const getFinancialsTool = tool('secedgar_get_financials', {
  description:
    'Get historical XBRL financial data for a company. Accepts friendly concept names (e.g., "revenue", "net_income", "assets") or raw XBRL tags. Automatically handles historical tag changes and deduplicates data.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    company: z
      .string()
      .describe('Ticker symbol (e.g., "AAPL") or CIK number. Ticker is preferred.'),
    concept: z
      .string()
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
      .default('annual')
      .describe('Filter to annual (FY) or quarterly (Q1-Q4) data. "all" returns both.'),
  }),

  output: z.object({
    company: z.string().describe('Company name.'),
    cik: z.string().describe('Company CIK.'),
    concept: z.string().describe('XBRL tag name used.'),
    label: z.string().describe('Human-readable label for the concept.'),
    description: z.string().optional().describe('XBRL taxonomy description.'),
    unit: z.string().describe('Unit of measure (e.g., "USD", "shares", "USD/shares").'),
    data: z
      .array(
        z
          .object({
            period: z.string().describe('Calendar period label (e.g., "CY2023", "CY2023Q3").'),
            value: z.number().describe('Reported value.'),
            start: z.string().optional().describe('Period start date (duration items only).'),
            end: z.string().describe('Period end date.'),
            fiscal_year: z.number().nullable().describe('Fiscal year.'),
            fiscal_period: z.string().nullable().describe('Fiscal period (FY, Q1, Q2, Q3, Q4).'),
            form: z.string().describe('Source filing type (10-K, 10-Q, etc.).'),
            filed: z.string().describe('Date the source filing was submitted.'),
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
  }),

  async handler(input, ctx) {
    const api = getEdgarApiService();

    // Resolve company to CIK
    const resolved = await api.resolveCik(input.company);
    const match = Array.isArray(resolved) ? resolved[0] : resolved;
    if (!match || (Array.isArray(resolved) && resolved.length === 0)) {
      throw notFound(`Company '${input.company}' not found. Try a ticker symbol or CIK number.`);
    }

    // Resolve concept to XBRL tag(s)
    const mapping = resolveConcept(input.concept);
    const tags = mapping ? mapping.tags : [input.concept];
    const label = mapping?.label ?? input.concept;

    // When the user overrides the default taxonomy, honor their choice;
    // otherwise fall back to the mapping's preferred taxonomy (e.g. `dei` for shares_outstanding).
    let taxonomy = input.taxonomy;
    if (mapping && input.taxonomy === 'us-gaap') {
      taxonomy = mapping.taxonomy as typeof input.taxonomy;
    }

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
    const allUnits: CompanyConceptUnit[] = [];

    for (const tag of tags) {
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
        allUnits.push(...units);
      }
    }

    if (!conceptResponse || allUnits.length === 0) {
      const hint =
        taxonomy === 'ifrs-full'
          ? 'Try a raw XBRL tag instead of a friendly name, or check the company uses IFRS.'
          : "This company may use a different tag or taxonomy. Try 'ifrs-full' for foreign filers.";
      throw notFound(
        `No XBRL data for '${input.concept}' under ${taxonomy} for this company. ${hint}`,
      );
    }

    // Deduplicate: keep only entries with frame field (one per standard calendar period)
    const deduped = allUnits.filter((u): u is CompanyConceptUnit & { frame: string } => !!u.frame);

    // If deduplication removed everything, the concept exists but has no frame-aligned entries
    if (deduped.length === 0) {
      throw notFound(
        `'${conceptResponse.tag}' exists for this company but has no standard-period data. This typically means the company reports this item in a non-standard period or the data lacks frame alignment. Try a related concept.`,
      );
    }

    // Remove duplicates by frame value (keep latest filed)
    const byFrame = new Map<string, CompanyConceptUnit & { frame: string }>();
    for (const unit of deduped) {
      const existing = byFrame.get(unit.frame);
      if (!existing || unit.filed > existing.filed) {
        byFrame.set(unit.frame, unit);
      }
    }

    // Filter by period type using frame pattern (fp reflects the filing, not the data point)
    let filtered = Array.from(byFrame.values());
    if (input.period_type === 'annual') {
      filtered = filtered.filter((u) => /^CY\d{4}$/.test(u.frame));
    } else if (input.period_type === 'quarterly') {
      filtered = filtered.filter((u) => /^CY\d{4}Q\d/.test(u.frame));
    }

    // If period_type filter removed everything, suggest the right period type
    if (filtered.length === 0 && byFrame.size > 0) {
      const sample = byFrame.values().next().value;
      const hasInstant = sample && /I$/.test(sample.frame);
      const hint = hasInstant
        ? 'This is a balance sheet (instant) item — try period_type: "quarterly" or "all".'
        : input.period_type === 'annual'
          ? 'No annual data found — try period_type: "quarterly" or "all".'
          : 'No quarterly data found — try period_type: "annual" or "all".';
      throw notFound(`No ${input.period_type} data for '${conceptResponse.tag}'. ${hint}`);
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

    ctx.log.info('Financials retrieved', {
      company: match.cik,
      concept: conceptResponse.tag,
      dataPoints: data.length,
    });

    return {
      company: match.name || input.company,
      cik: match.cik,
      concept: conceptResponse.tag,
      label: conceptResponse.label || label,
      description: conceptResponse.description || undefined,
      unit: unitKey,
      data,
      tags_tried: tagsTried.length > 1 ? tagsTried : undefined,
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
      const fy = d.fiscal_year ?? '—';
      const fp = d.fiscal_period ?? '—';
      const range = d.start ? `${d.start} → ${d.end}` : d.end;
      lines.push(
        `${d.period} [FY${fy} ${fp}]: ${formatted} (raw ${d.value}) | ${range} | ${d.form} filed ${d.filed} [${d.accession_number}]`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
