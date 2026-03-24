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
    'Get historical XBRL financial data for a company. Accepts friendly concept names ' +
    '(e.g., "revenue", "net_income", "assets") or raw XBRL tags. Automatically handles ' +
    'historical tag changes and deduplicates data. See secedgar://concepts for available names.',
  annotations: { readOnlyHint: true },

  input: z.object({
    company: z
      .string()
      .describe('Ticker symbol (e.g., "AAPL") or CIK number. Ticker is preferred.'),
    concept: z
      .string()
      .describe(
        'Financial concept — friendly name (e.g., "revenue", "net_income", "assets", "eps_diluted") ' +
          'or raw XBRL tag (e.g., "AccountsPayableCurrent"). ' +
          'Friendly names auto-resolve to the correct XBRL tags and handle historical tag changes. ' +
          'See secedgar://concepts for the full list of supported names and mappings.',
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
        z.object({
          period: z.string().describe('Calendar period label (e.g., "CY2023", "CY2023Q3").'),
          value: z.number().describe('Reported value.'),
          start: z.string().optional().describe('Period start date (duration items only).'),
          end: z.string().describe('Period end date.'),
          fiscal_year: z.number().describe('Fiscal year.'),
          fiscal_period: z.string().describe('Fiscal period (FY, Q1, Q2, Q3, Q4).'),
          form: z.string().describe('Source filing type (10-K, 10-Q, etc.).'),
          filed: z.string().describe('Date the source filing was submitted.'),
          accession_number: z
            .string()
            .describe('Source filing accession number for secedgar_get_filing.'),
        }),
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
    const taxonomy = mapping ? mapping.taxonomy : input.taxonomy;
    const label = mapping?.label ?? input.concept;

    // Try each tag until we get data
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
      try {
        const resp = await api.getCompanyConcept(match.cik, taxonomy, tag);
        if (!conceptResponse) {
          conceptResponse = {
            units: resp.units,
            label: resp.label,
            description: resp.description ?? undefined,
            tag: resp.tag,
          };
        }
        // Merge units from all matching tags
        for (const units of Object.values(resp.units)) {
          allUnits.push(...units);
        }
      } catch {}
    }

    if (!conceptResponse || allUnits.length === 0) {
      throw notFound(
        `No XBRL data for '${input.concept}' under ${taxonomy} for this company. ` +
          "This company may use a different tag or taxonomy. Try 'ifrs-full' for foreign filers.",
      );
    }

    // Deduplicate: keep only entries with frame field (one per standard calendar period)
    const deduped = allUnits.filter((u): u is CompanyConceptUnit & { frame: string } => !!u.frame);

    // Remove duplicates by frame value (keep latest filed)
    const byFrame = new Map<string, CompanyConceptUnit & { frame: string }>();
    for (const unit of deduped) {
      const existing = byFrame.get(unit.frame);
      if (!existing || unit.filed > existing.filed) {
        byFrame.set(unit.frame, unit);
      }
    }

    // Filter by period type
    let filtered = Array.from(byFrame.values());
    if (input.period_type === 'annual') {
      filtered = filtered.filter((u) => u.fp === 'FY');
    } else if (input.period_type === 'quarterly') {
      filtered = filtered.filter((u) => u.fp.startsWith('Q'));
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
    const lines = [`**${result.label}** — ${result.company} (${result.unit})`];
    for (const d of result.data) {
      const formatted =
        result.unit === 'USD'
          ? `$${(d.value / 1_000_000).toFixed(1)}M`
          : result.unit === 'USD/shares'
            ? `$${d.value.toFixed(2)}`
            : d.value.toLocaleString();
      lines.push(`${d.period}: ${formatted} (${d.form} filed ${d.filed})`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
