/**
 * @fileoverview Compare a financial metric across all reporting companies for a specific period.
 * @module mcp-server/tools/definitions/compare-metric
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { resolveConcept } from '@/services/edgar/concept-map.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';

export const compareMetricTool = tool('secedgar_compare_metric', {
  description:
    'Compare a financial metric across all reporting companies for a specific period. Uses the same friendly concept names as secedgar_get_financials (e.g., "revenue", "assets").',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    concept: z
      .string()
      .describe(
        'Financial concept — same friendly names as secedgar_get_financials (e.g., "revenue", "assets", "eps_basic") or raw XBRL tag.',
      ),
    period: z
      .string()
      .describe(
        'Calendar period. Formats:\n  "CY2023" — full year 2023 (duration, for income statement items)\n  "CY2024Q2" — Q2 2024 (duration, for quarterly income items)\n  "CY2023Q4I" — Q4 2023 instant (balance sheet items like assets, cash)\nUse duration periods (no I suffix) for income/cash flow items. Use instant periods (I suffix) for balance sheet items.',
      ),
    unit: z
      .enum(['USD', 'USD-per-shares', 'shares', 'pure'])
      .default('USD')
      .describe(
        'Unit of measure. Use "USD-per-shares" for EPS, "shares" for share counts, "pure" for ratios.',
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
    concept: z.string().describe('XBRL tag used.'),
    period: z.string().describe('Calendar period.'),
    unit: z.string().describe('Unit of measure.'),
    label: z.string().describe('Human-readable concept label.'),
    total_companies: z.number().describe('Total companies reporting this metric for this period.'),
    data: z
      .array(
        z.object({
          rank: z.number().describe('Rank in sorted order.'),
          company_name: z.string().describe('Entity name.'),
          cik: z.string().describe('Company CIK.'),
          ticker: z.string().optional().describe('Ticker symbol (if available).'),
          value: z.number().describe('Reported value.'),
          location: z.string().optional().describe('Business location.'),
          period_end: z.string().describe('Period end date.'),
          accession_number: z.string().describe('Source filing for secedgar_get_filing.'),
        }),
      )
      .describe('Ranked companies for this metric.'),
  }),

  async handler(input, ctx) {
    const api = getEdgarApiService();

    // Resolve concept
    const mapping = resolveConcept(input.concept);
    const tag = mapping?.tags[0] ?? input.concept;
    const taxonomy = mapping?.taxonomy ?? 'us-gaap';
    const label = mapping?.label ?? input.concept;
    const unit = mapping ? mapping.unit.replace('/', '-per-') : input.unit;

    // `tryGetFrames` returns null when no companies report this combination for this period.
    const framesResponse = await api.tryGetFrames(taxonomy, tag, unit, input.period);
    if (!framesResponse) {
      // Distinguish unknown concept (no mapping + 404) from valid concept with no data
      const hint = !mapping
        ? `Unknown concept '${input.concept}'. Use a friendly name (e.g., "revenue", "assets") or a valid XBRL tag.`
        : `No data for ${label}/${unit}/${input.period}. Check: duration vs. instant period (add "I" for balance sheet items), correct unit (USD-per-shares for EPS), and period exists (data starts ~CY2009).`;
      throw notFound(hint);
    }

    // Sort by value
    const sorted = [...framesResponse.data].sort((a, b) =>
      input.sort === 'desc' ? b.val - a.val : a.val - b.val,
    );

    // Slice to limit and enrich with tickers
    const sliced = sorted.slice(0, input.limit);
    const data = await Promise.all(
      sliced.map(async (entry, i) => {
        const cik = String(entry.cik).padStart(10, '0');
        const ticker: string | undefined = await api.cikToTicker(cik);
        return {
          rank: i + 1,
          company_name: entry.entityName,
          cik,
          ticker: ticker || undefined,
          value: entry.val,
          location: entry.loc || undefined,
          period_end: entry.end,
          accession_number: entry.accn,
        };
      }),
    );

    ctx.log.info('Metric comparison completed', {
      concept: tag,
      period: input.period,
      totalCompanies: framesResponse.pts,
      returned: data.length,
    });

    return {
      concept: tag,
      period: input.period,
      unit,
      label: framesResponse.label || label,
      total_companies: framesResponse.pts,
      data,
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
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
