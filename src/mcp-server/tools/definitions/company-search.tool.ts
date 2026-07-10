/**
 * @fileoverview Find companies and retrieve entity info with optional recent filings.
 * Entry point for most SEC EDGAR workflows.
 * @module mcp-server/tools/definitions/company-search
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';
import {
  getEdgarApiService,
  selectArchivePages,
  suggestCompanies,
} from '@/services/edgar/edgar-api-service.js';
import type { FilingsRecent } from '@/services/edgar/types.js';

interface FilingEntry {
  accession_number: string;
  description?: string | undefined;
  filing_date: string;
  form: string;
  primary_document: string;
  report_date?: string | undefined;
}

/**
 * Cap on submissions archive pages fetched in one call — bounds latency and the
 * rate-limited request budget for prolific multi-decade filers. Hitting the cap
 * sets the dataframe's `truncated` flag (#78). Most filers have 0–3 archive pages,
 * so the cap rarely binds.
 */
const ARCHIVE_PAGE_SCAN_CAP = 10;

/** Format SEC's MMDD fiscal year end string as MM-DD (e.g., "0926" → "09-26"). */
function formatFiscalYearEnd(raw: string): string {
  if (/^\d{4}$/.test(raw)) {
    return `${raw.slice(0, 2)}-${raw.slice(2)}`;
  }
  return raw;
}

/** Zip a submissions parallel-array block (recent window or archive page) into filing rows. */
function zipFilings(block: FilingsRecent): FilingEntry[] {
  const rows: FilingEntry[] = [];
  for (let i = 0; i < block.accessionNumber.length; i++) {
    rows.push({
      accession_number: block.accessionNumber[i] ?? '',
      form: block.form[i] ?? '',
      filing_date: block.filingDate[i] ?? '',
      report_date: block.reportDate[i] || undefined,
      primary_document: block.primaryDocument[i] ?? '',
      description: block.primaryDocDescription[i] || undefined,
    });
  }
  return rows;
}

export const companySearchTool = tool('secedgar_company_search', {
  description:
    'Find companies and retrieve entity info with optional recent filings. Entry point for most EDGAR workflows — resolves tickers, names, or CIKs to entity details, with accession numbers in the result feeding secedgar_get_filing for document content.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  // Agent-facing context — notice for empty filings (e.g. filtered form types with
  // no matches) populated via ctx.enrich so it reaches both structuredContent and
  // content[] automatically; no format() entry needed.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when include_filings=true but no filings matched the form_types filter.'),
  },

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No company matches the query',
      recovery:
        'Use a ticker symbol for ETFs, mutual funds, and equities (e.g. "VOO", "AAPL"), or try the full legal company name or a 10-digit CIK.',
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
      .trim()
      .min(1, 'Query cannot be blank')
      .describe(
        'Company ticker symbol (e.g., "AAPL", "VOO"), name (e.g., "Apple"), or CIK number (e.g., "320193"). Ticker is the fastest lookup and works for equities, ETFs, and mutual funds. Name search matches current and former names.',
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
      .describe('Maximum number of filings to return in the inline list.'),
    filed_after: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
          .describe('YYYY-MM-DD'),
      ])
      .optional()
      .describe(
        "Only include filings filed on or after this date (YYYY-MM-DD). A date filter routes the scan into the older submissions archive pages, so it reaches filings that predate the ~1000-filing recent window (e.g. a company's 2005 10-K).",
      ),
    filed_before: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
          .describe('YYYY-MM-DD'),
      ])
      .optional()
      .describe(
        'Only include filings filed on or before this date (YYYY-MM-DD). Use alone or with filed_after; together they bound the archive-page scan.',
      ),
  }),

  output: z.object({
    cik: z.string().describe('Central Index Key, zero-padded to 10 digits.'),
    name: z.string().describe('SEC-conformed company name.'),
    tickers: z.array(z.string()).describe('Associated ticker symbols.'),
    exchanges: z.array(z.string()).describe('Exchanges where listed.'),
    sic: z.string().describe('SIC industry code.'),
    sic_description: z.string().describe('Human-readable SIC description.'),
    state_of_incorporation: z
      .string()
      .optional()
      .describe(
        'State of incorporation (US two-letter code, e.g. "DE"). Omitted for some entities, including many foreign filers and individuals.',
      ),
    fiscal_year_end: z
      .string()
      .optional()
      .describe(
        'Fiscal year end (MM-DD format, e.g., "09-26"). Absent for filers SEC records no fiscal year end for (e.g. private or pre-IPO entities).',
      ),
    series_id: z
      .string()
      .optional()
      .describe(
        'SEC fund series ID (e.g. "S000002839"). Present when the query resolved via a fund ticker (ETF or mutual fund).',
      ),
    class_id: z
      .string()
      .optional()
      .describe(
        'SEC fund class ID (e.g. "C000092055"). Present when the query resolved via a fund ticker (ETF or mutual fund).',
      ),
    filings: z
      .array(
        z
          .object({
            accession_number: z
              .string()
              .describe(
                'Filing accession number, dash format (e.g., 0000320193-23-000106). Pass to secedgar_get_filing.',
              ),
            form: z.string().describe('Form type (e.g., 10-K).'),
            filing_date: z.string().describe('Date the filing was submitted (YYYY-MM-DD).'),
            report_date: z
              .string()
              .optional()
              .describe(
                'Period of report (YYYY-MM-DD). Absent for filings without a reporting period (proxy statements, ownership reports).',
              ),
            primary_document: z.string().describe('Primary document filename.'),
            description: z
              .string()
              .optional()
              .describe('SEC-provided filing description. Absent when SEC published none.'),
          })
          .describe('One filing record with form type, dates, and primary document.'),
      )
      .optional()
      .describe('Recent filings, filtered by form_types if specified.'),
    total_filings: z
      .number()
      .optional()
      .describe(
        'Total filings matching the filter across everything scanned (recent window + any archive pages), which may exceed filing_limit and the inline list.',
      ),
    history_scanned_through: z
      .string()
      .optional()
      .describe(
        'Oldest filing date reached by the scan (YYYY-MM-DD). Filings older than this were not examined: the recent window caps at ~1000 filings, and older filings live in archive pages fetched only when a date filter or an under-filled form filter requires them. Absent when no filings were scanned.',
      ),
    dataset: z
      .object({
        name: z
          .string()
          .describe('Dataframe handle (df_XXXXX_XXXXX) — pass to secedgar_dataframe_query.'),
        row_count: z.number().describe('Rows materialized in the dataframe.'),
        expires_at: z.string().describe('ISO 8601 expiry timestamp.'),
        truncated: z
          .boolean()
          .describe(
            'True when the archive scan hit its page cap before exhausting the manifest — older matching filings exist beyond the dataframe.',
          ),
      })
      .optional()
      .describe(
        'Canvas dataframe holding the full filtered filing history (recent + archive pages), registered only when the scan reached beyond the recent window and the history exceeds filing_limit. Query the complete history — filings by form by year — with secedgar_dataframe_query; the inline `filings` list stays capped at filing_limit.',
      ),
  }),

  async handler(input, ctx) {
    const api = getEdgarApiService();
    const resolved = await api.resolveCik(input.query);

    if (Array.isArray(resolved)) {
      if (resolved.length === 0) {
        // Run trigram suggestions on the zero-hit name-search path.
        const allEntries = await api.getAllEntries();
        const suggestions = suggestCompanies(input.query, allEntries);
        const suggestionNote =
          suggestions.length > 0
            ? ` Near matches: ${suggestions.map((s) => `${s.name ?? s.cik}${s.ticker ? ` (${s.ticker})` : ''}`).join(', ')}.`
            : '';
        throw ctx.fail('no_match', `No company found for '${input.query}'.${suggestionNote}`, {
          ...ctx.recoveryFor('no_match'),
          ...(suggestions.length > 0 ? { suggestions } : {}),
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

    // Bare-CIK fallback: resolveCik returns { cik } with no name/ticker when a numeric
    // query missed the ticker cache — getSubmissions 404s for non-existent CIKs (#55).
    // For cache-hit matches (name or ticker present), a 404 signals an EDGAR-side
    // problem and must propagate unchanged.
    const isBareCikFallback = !match.name && !match.ticker;
    let submissions: Awaited<ReturnType<typeof api.getSubmissions>>;
    try {
      submissions = await api.getSubmissions(match.cik);
    } catch (err) {
      if (isBareCikFallback && err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        ctx.log.debug('CIK not found in EDGAR submissions', {
          cik: match.cik,
          query: input.query,
        });
        throw ctx.fail('no_match', `No company found for '${input.query}'.`, {
          ...ctx.recoveryFor('no_match'),
        });
      }
      throw err;
    }

    ctx.log.info('Company resolved', {
      query: input.query,
      cik: match.cik,
      name: submissions.name,
    });

    let filings: FilingEntry[] | undefined;
    let totalFilings: number | undefined;
    let historyScannedThrough: string | undefined;
    let dataset:
      | { name: string; row_count: number; expires_at: string; truncated: boolean }
      | undefined;

    if (input.include_filings) {
      const filedAfter = input.filed_after || undefined;
      const filedBefore = input.filed_before || undefined;
      const hasDateFilter = Boolean(filedAfter || filedBefore);
      const formTypes = input.form_types?.length ? input.form_types : undefined;

      const matches = (f: FilingEntry) =>
        (!formTypes || formTypes.some((ft) => f.form.toUpperCase() === ft.toUpperCase())) &&
        (!filedAfter || f.filing_date >= filedAfter) &&
        (!filedBefore || f.filing_date <= filedBefore);

      const recentRows = zipFilings(submissions.filings.recent);
      const recentMatched = recentRows.filter(matches);
      // Oldest date scanned so far — the recent window's tail (newest-first, so last).
      historyScannedThrough = recentRows.at(-1)?.filing_date;

      // Walk the older archive pages when the caller targets a date range (which may
      // predate the recent window) or when a form filter under-fills that window (#78).
      const files = submissions.filings.files;
      const underFill = Boolean(formTypes) && recentMatched.length < input.filing_limit;
      const bridge = getCanvasBridge();

      const archiveMatched: FilingEntry[] = [];
      let scannedBeyondRecent = false;
      let archiveTruncated = false;

      if (files.length > 0 && (hasDateFilter || underFill)) {
        const pages = selectArchivePages(files, filedAfter, filedBefore);
        const pageLimit = Math.min(pages.length, ARCHIVE_PAGE_SCAN_CAP);
        archiveTruncated = pages.length > pageLimit;

        for (let i = 0; i < pageLimit; i++) {
          const page = pages[i];
          if (!page) break;
          const block = await api.fetchArchivePage(page.name);
          scannedBeyondRecent = true;
          historyScannedThrough = page.filingFrom;
          archiveMatched.push(...zipFilings(block).filter(matches));

          // Under-fill fallback with no canvas: stop once the inline limit is filled —
          // there is no dataframe to complete, so deeper pages aren't worth fetching.
          // (With a canvas, the loop scans on to register the full filtered history.)
          if (
            !hasDateFilter &&
            !bridge &&
            recentMatched.length + archiveMatched.length >= input.filing_limit
          ) {
            break;
          }
        }
      }

      const fullMatched = [...recentMatched, ...archiveMatched].sort((a, b) =>
        b.filing_date.localeCompare(a.filing_date),
      );

      totalFilings = fullMatched.length;
      filings = fullMatched.slice(0, input.filing_limit);

      // Register the full filtered history to the canvas when the scan reached beyond
      // the recent window and there is more than fits inline — a multi-decade history is
      // SQL shape (filings by form by year). Mirror the ownership tools' preview +
      // full-set pattern; the inline `filings` list stays capped at filing_limit.
      if (bridge && scannedBeyondRecent && fullMatched.length > input.filing_limit) {
        const registered = await bridge.registerDataframe(ctx, {
          rows: fullMatched.map((f) => ({
            accession_number: f.accession_number,
            form: f.form,
            filing_date: f.filing_date,
            report_date: f.report_date ?? null,
            primary_document: f.primary_document,
            description: f.description ?? null,
          })),
          sourceTool: 'secedgar_company_search',
          queryParams: {
            cik: match.cik,
            form_types: input.form_types,
            filed_after: filedAfter,
            filed_before: filedBefore,
          },
          truncated: archiveTruncated,
        });
        if (registered) dataset = { ...toDatasetField(registered), truncated: archiveTruncated };
      }
    }

    if (input.include_filings && input.form_types?.length && totalFilings === 0) {
      ctx.enrich.notice(
        `No filings matched form types [${input.form_types.join(', ')}] for this entity. Try different form types or remove the filter.`,
      );
    }

    return {
      cik: match.cik,
      name: submissions.name,
      tickers: submissions.tickers,
      exchanges: submissions.exchanges.filter((e): e is string => e !== null),
      sic: submissions.sic,
      sic_description: submissions.sicDescription,
      state_of_incorporation: submissions.stateOfIncorporation || undefined,
      fiscal_year_end: submissions.fiscalYearEnd
        ? formatFiscalYearEnd(submissions.fiscalYearEnd)
        : undefined,
      series_id: match.seriesId,
      class_id: match.classId,
      filings,
      total_filings: totalFilings,
      history_scanned_through: historyScannedThrough,
      dataset,
    };
  },

  format: (result) => {
    const lines = [`**${result.name}** (${result.tickers.join(', ') || 'no ticker'})`];
    const exchange = result.exchanges.length ? ` | Exchange: ${result.exchanges.join(', ')}` : '';
    lines.push(`CIK: ${result.cik} | SIC: ${result.sic} (${result.sic_description})${exchange}`);
    if (result.fiscal_year_end) {
      lines.push(`Fiscal year end: ${result.fiscal_year_end}`);
    }
    if (result.state_of_incorporation) {
      lines.push(`State of incorporation: ${result.state_of_incorporation}`);
    }
    if (result.series_id) {
      lines.push(
        `Series ID: ${result.series_id}${result.class_id ? ` | Class ID: ${result.class_id}` : ''}`,
      );
    }
    if (result.filings?.length) {
      lines.push(`\nFilings (${result.filings.length} of ${result.total_filings}):`);
      for (const f of result.filings) {
        const reportDate = f.report_date ? ` (period: ${f.report_date})` : '';
        const desc = f.description ? ` — ${f.description}` : '';
        lines.push(
          `- ${f.form} ${f.filing_date}${reportDate}${desc} — ${f.primary_document} [${f.accession_number}]`,
        );
      }
    }
    if (result.history_scanned_through) {
      lines.push(
        `\nHistory scanned through: ${result.history_scanned_through} (older filings not examined).`,
      );
    }
    if (result.dataset) {
      const truncatedNote = result.dataset.truncated
        ? ' (truncated — older filings exist beyond the scanned pages)'
        : '';
      lines.push(
        `Dataset: ${result.dataset.name} (${result.dataset.row_count} rows, expires ${result.dataset.expires_at})${truncatedNote} — full filtered history, query with secedgar_dataframe_query.`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
