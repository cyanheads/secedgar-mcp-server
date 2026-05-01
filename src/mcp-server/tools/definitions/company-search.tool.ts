/**
 * @fileoverview Find companies and retrieve entity info with optional recent filings.
 * Entry point for most SEC EDGAR workflows.
 * @module mcp-server/tools/definitions/company-search
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';

interface FilingEntry {
  accession_number: string;
  description?: string | undefined;
  filing_date: string;
  form: string;
  primary_document: string;
  report_date?: string | undefined;
}

export const companySearchTool = tool('secedgar_company_search', {
  description:
    'Find companies and retrieve entity info with optional recent filings. Entry point for most EDGAR workflows — resolve tickers, names, or CIKs to entity details.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No company matches the query',
      recovery: 'Try a ticker symbol, full company name, or 10-digit CIK.',
    },
    {
      reason: 'multiple_matches',
      code: JsonRpcErrorCode.NotFound,
      when: 'Query is ambiguous and matches several companies',
      recovery: 'Specify a ticker symbol for an exact match instead of a name fragment.',
    },
  ],

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Company ticker symbol (e.g., "AAPL"), name (e.g., "Apple"), or CIK number (e.g., "320193"). Ticker is the fastest lookup. Name search does fuzzy matching.',
      ),
    include_filings: z
      .boolean()
      .default(true)
      .describe(
        'Include recent filings in the response. Set to false for entity-info-only lookups.',
      ),
    form_types: z
      .array(z.string())
      .optional()
      .describe(
        'Filter filings to specific form types (e.g., ["10-K", "10-Q", "8-K"]). Without this, returns all form types.',
      ),
    filing_limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum number of filings to return.'),
  }),

  output: z.object({
    cik: z.string().describe('Central Index Key, zero-padded to 10 digits.'),
    name: z.string().describe('SEC-conformed company name.'),
    tickers: z.array(z.string()).describe('Associated ticker symbols.'),
    exchanges: z.array(z.string()).describe('Exchanges where listed.'),
    sic: z.string().describe('SIC industry code.'),
    sic_description: z.string().describe('Human-readable SIC description.'),
    state_of_incorporation: z.string().optional().describe('State of incorporation.'),
    fiscal_year_end: z.string().describe('Fiscal year end (MMDD format).'),
    filings: z
      .array(
        z
          .object({
            accession_number: z.string().describe('Filing accession number.'),
            form: z.string().describe('Form type (e.g., 10-K).'),
            filing_date: z.string().describe('Date filed.'),
            report_date: z.string().optional().describe('Period of report.'),
            primary_document: z.string().describe('Primary document filename.'),
            description: z.string().optional().describe('Filing description.'),
          })
          .describe('One filing record with form type, dates, and primary document.'),
      )
      .optional()
      .describe('Recent filings, filtered by form_types if specified.'),
    total_filings: z
      .number()
      .optional()
      .describe('Total filings matching the filter (may exceed filing_limit).'),
  }),

  async handler(input, ctx) {
    const api = getEdgarApiService();
    const resolved = await api.resolveCik(input.query);

    if (Array.isArray(resolved)) {
      if (resolved.length === 0) {
        throw ctx.fail('no_match', `No company found for '${input.query}'.`, {
          ...ctx.recoveryFor('no_match'),
        });
      }
      if (resolved.length > 1) {
        const matches = resolved
          .map((m) => `${m.ticker ?? m.cik} (${m.name ?? 'Unknown'})`)
          .join(', ');
        throw ctx.fail('multiple_matches', `Multiple matches for '${input.query}': ${matches}.`, {
          ...ctx.recoveryFor('multiple_matches'),
          query: input.query,
          matches: resolved.map((m) => ({ cik: m.cik, name: m.name, ticker: m.ticker })),
        });
      }
    }

    const match = Array.isArray(resolved) ? resolved[0] : resolved;
    if (!match) {
      throw ctx.fail('no_match', `No company found for '${input.query}'.`, {
        ...ctx.recoveryFor('no_match'),
      });
    }
    const submissions = await api.getSubmissions(match.cik);
    ctx.log.info('Company resolved', {
      query: input.query,
      cik: match.cik,
      name: submissions.name,
    });

    let filings: FilingEntry[] | undefined;
    let totalFilings: number | undefined;

    if (input.include_filings) {
      const recent = submissions.filings.recent;
      const count = recent.accessionNumber.length;

      // Zip parallel arrays into objects
      const all: FilingEntry[] = [];
      for (let i = 0; i < count; i++) {
        all.push({
          accession_number: recent.accessionNumber[i] ?? '',
          form: recent.form[i] ?? '',
          filing_date: recent.filingDate[i] ?? '',
          report_date: recent.reportDate[i] || undefined,
          primary_document: recent.primaryDocument[i] ?? '',
          description: recent.primaryDocDescription[i] || undefined,
        });
      }

      const filtered = input.form_types
        ? all.filter((f) =>
            input.form_types?.some((ft) => f.form.toUpperCase() === ft.toUpperCase()),
          )
        : all;

      totalFilings = filtered.length;
      filings = filtered.slice(0, input.filing_limit);
    }

    return {
      cik: match.cik,
      name: submissions.name,
      tickers: submissions.tickers,
      exchanges: submissions.exchanges,
      sic: submissions.sic,
      sic_description: submissions.sicDescription,
      state_of_incorporation: submissions.stateOfIncorporation || undefined,
      fiscal_year_end: submissions.fiscalYearEnd,
      filings,
      total_filings: totalFilings,
    };
  },

  format: (result) => {
    const lines = [`**${result.name}** (${result.tickers.join(', ') || 'no ticker'})`];
    const exchange = result.exchanges.length ? ` | Exchange: ${result.exchanges.join(', ')}` : '';
    lines.push(`CIK: ${result.cik} | SIC: ${result.sic} (${result.sic_description})${exchange}`);
    lines.push(`Fiscal year end: ${result.fiscal_year_end}`);
    if (result.state_of_incorporation) {
      lines.push(`State of incorporation: ${result.state_of_incorporation}`);
    }
    if (result.filings?.length) {
      lines.push(`\nRecent filings (${result.filings.length} of ${result.total_filings}):`);
      for (const f of result.filings) {
        const reportDate = f.report_date ? ` (period: ${f.report_date})` : '';
        const desc = f.description ? ` — ${f.description}` : '';
        lines.push(
          `- ${f.form} ${f.filing_date}${reportDate}${desc} — ${f.primary_document} [${f.accession_number}]`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
