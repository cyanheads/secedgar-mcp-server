/**
 * @fileoverview Full-text search across all EDGAR filing documents since 1993.
 * @module mcp-server/tools/definitions/search-filings
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';

export const searchFilingsTool = tool('secedgar_search_filings', {
  description:
    'Full-text search across all EDGAR filing documents since 1993. ' +
    'Supports exact phrases, boolean operators, wildcards, and entity targeting (cik: or ticker: in query).',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .describe(
        'Full-text search query. Supports: exact phrases ("material weakness"), ' +
          'boolean operators (revenue OR income), exclusion (-preliminary), ' +
          'wildcard suffix (account*), entity targeting (cik:320193 or ticker:AAPL within the query string). ' +
          "Terms are AND'd by default.",
      ),
    forms: z
      .array(z.string())
      .optional()
      .describe(
        'Filter to specific form types (e.g., ["10-K", "10-Q", "8-K"]). Without this, searches all form types.',
      ),
    start_date: z
      .string()
      .optional()
      .describe(
        'Start of date range (YYYY-MM-DD). Both start_date and end_date must be provided for date filtering.',
      ),
    end_date: z
      .string()
      .optional()
      .describe(
        'End of date range (YYYY-MM-DD). Both start_date and end_date must be provided for date filtering.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Results per page. Max 100. Default 20 to keep responses concise.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Pagination offset. Increment by limit for next page. Hard cap at 10,000 total results.',
      ),
  }),

  output: z.object({
    total: z.number().describe('Total matching filings (capped at 10,000).'),
    total_is_exact: z.boolean().describe('False when total hits the 10,000 cap.'),
    results: z
      .array(
        z.object({
          accession_number: z
            .string()
            .describe('Use with secedgar_get_filing to retrieve content.'),
          form: z.string().optional().describe('Form type.'),
          filing_date: z.string().describe('Date filed.'),
          period_ending: z.string().optional().describe('Period of report.'),
          company_name: z.string().describe('Filing entity name.'),
          cik: z.string().describe('Company CIK.'),
          file_description: z.string().optional().describe('Document description.'),
          sic: z.string().optional().describe('SIC code.'),
          location: z.string().optional().describe('Business location.'),
        }),
      )
      .describe('Matching filings.'),
    form_distribution: z
      .record(z.string(), z.number())
      .optional()
      .describe('Count of results by form type. Helps narrow follow-up searches.'),
  }),

  async handler(input, ctx) {
    const api = getEdgarApiService();

    const response = await api.searchFilings({
      query: input.query,
      forms: input.forms,
      startDate: input.start_date,
      endDate: input.end_date,
      from: input.offset,
      size: input.limit,
    });

    const total = response.hits.total.value;
    const totalIsExact = response.hits.total.relation === 'eq';

    // search-index endpoint ignores size/from params (always returns up to 100),
    // so apply client-side slicing to respect the requested limit
    const sliced = response.hits.hits.slice(0, input.limit);

    const results = sliced.map((hit) => {
      const accessionNumber = hit._source.adsh || hit._id.split(':')[0] || hit._id;

      return {
        accession_number: accessionNumber,
        form: hit._source.form ?? undefined,
        filing_date: hit._source.file_date,
        period_ending: hit._source.period_ending ?? undefined,
        company_name: hit._source.display_names?.[0] || '',
        cik: hit._source.ciks?.[0] || '',
        file_description: hit._source.file_description ?? undefined,
        sic: hit._source.sics?.[0] ?? undefined,
        location: hit._source.biz_locations?.[0] ?? undefined,
      };
    });

    // Extract form distribution from aggregations
    let formDistribution: Record<string, number> | undefined;
    if (response.aggregations?.form_filter?.buckets) {
      formDistribution = {};
      for (const bucket of response.aggregations.form_filter.buckets) {
        formDistribution[bucket.key] = bucket.doc_count;
      }
    }

    ctx.log.info('Filing search completed', {
      query: input.query,
      total,
      resultCount: results.length,
    });

    return { total, total_is_exact: totalIsExact, results, form_distribution: formDistribution };
  },

  format: (result) => {
    const lines = [`Found ${result.total}${result.total_is_exact ? '' : '+'} filings`];
    for (const r of result.results) {
      lines.push(`- ${r.form ?? 'N/A'} ${r.filing_date} — ${r.company_name} [${r.accession_number}]`);
    }
    if (result.form_distribution) {
      const dist = Object.entries(result.form_distribution)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      lines.push(`\nForm distribution: ${dist}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
