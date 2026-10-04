/**
 * @fileoverview Find companies and retrieve entity info with optional recent filings.
 * Entry point for most SEC EDGAR workflows.
 * @module mcp-server/tools/definitions/company-search
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  dataframeGuidance,
  getCanvasBridge,
  toDatasetField,
} from '@/services/canvas-bridge/canvas-bridge.js';
import { getEdgarApiService, suggestCompanies } from '@/services/edgar/edgar-api-service.js';
import { SubmissionsArchiveWalk } from '@/services/edgar/submissions-archive.js';
import type { FilingsRecent } from '@/services/edgar/types.js';

interface FilingEntry {
  accession_number: string;
  description?: string | undefined;
  filing_date: string;
  form: string;
  primary_document: string;
  report_date?: string | undefined;
}

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
    'Find companies and retrieve entity info with optional recent filings. Entry point for most EDGAR workflows — resolves tickers, names, or CIKs to entity details, with accession numbers in the result feeding secedgar_get_filing for document content. When a date or form filter carries the scan past the recent submissions window, the full filtered filing history is also staged as df_<id> — inspect it with secedgar_dataframe_describe, then analyze it with secedgar_dataframe_query.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  // Agent-facing context — notice for empty filings (e.g. filtered form types with
  // no matches) populated via ctx.enrich so it reaches both structuredContent and
  // content[] automatically; no format() entry needed.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no filings matched the forms filter, or when filing_limit withheld some.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when more filings matched than `filing_limit` allowed into the inline list.'),
    shown: z.number().optional().describe('Number of filings returned inline.'),
    cap: z.number().optional().describe('The `filing_limit` that was applied.'),
  },

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No company matches the query',
      recovery:
        'SEC\'s ticker index reflects the filer\'s own submissions record, which can differ from the exchange-listed symbol. ETFs and mutual funds resolve only by ticker (e.g. "VOO"); operating companies also resolve by full legal name or 10-digit CIK.',
    },
    {
      reason: 'multiple_matches',
      code: JsonRpcErrorCode.NotFound,
      when: 'Query is ambiguous and matches several companies',
      recovery: 'Specify a ticker symbol for an exact match instead of a name fragment.',
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
    query: z
      .string()
      .trim()
      .min(1, 'Query cannot be blank')
      .describe(
        'Company ticker symbol (e.g., "AAPL", "VOO"), name (e.g., "Apple"), or CIK number (e.g., "320193"). Ticker is the fastest lookup and works for equities, ETFs, and mutual funds; a multi-class share ticker resolves in either form ("BRK-B" or "BRK.B"). Name search matches current and former names, preferring a name the query matches exactly over one it only starts or appears in. The corporate suffix (Inc, Corp, Co, Ltd, PLC, LLC, LP, N.V., S.A., AG, SE) can be left off ("Apple" finds "Apple Inc."; "Rio Tinto" lists both the Ltd and the PLC) or spelled out ("Beacon Financial Corporation" finds "Beacon Financial Corp"), but a suffix you include must match — Corp, Inc, Co, and Ltd stay distinct from each other, since separate registrants differ only by which one they use.',
      ),
    include_filings: z
      .boolean()
      .default(true)
      .describe(
        'Include recent filings in the response. Set to false for entity-info-only lookups.',
      ),
    forms: z
      .array(z.string())
      .optional()
      .describe(
        'Filter filings to specific form types (e.g., ["10-K", "10-Q", "8-K"]), matched exactly (case-insensitive) — list an amendment such as "10-K/A" to include it. Without this, returns all form types.',
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
        "Only include filings filed on or after this date (YYYY-MM-DD). A date filter routes the scan into the older submissions archive pages, so it reaches filings that predate the recent window — the last year or 1,000 filings, whichever holds more (e.g. a company's 2005 10-K).",
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
  // Other spellings of the form and filing-date parameters in use across tools (#115), and
  // the company-identifier keys other tools take — `query` is this tool's only company
  // input, so each maps one-to-one (#152).
  inputAliases: {
    company: 'query',
    ticker: 'query',
    cik: 'query',
    ticker_or_cik: 'query',
    name: 'query',
    search: 'query',
    form_types: 'forms',
    start_date: 'filed_after',
    date_from: 'filed_after',
    end_date: 'filed_before',
    date_to: 'filed_before',
  },

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
        'State of incorporation (US two-letter code, e.g. "DE"). Absent for many foreign filers and individuals.',
      ),
    fiscal_year_end: z
      .string()
      .optional()
      .describe(
        'Fiscal year end (MM-DD, e.g. "09-26"). Absent when SEC records none (e.g., private or pre-IPO entities).',
      ),
    series_id: z
      .string()
      .optional()
      .describe(
        'SEC fund series ID (e.g. "S000002839"), when the query resolved via a fund ticker (ETF or mutual fund).',
      ),
    class_id: z
      .string()
      .optional()
      .describe('SEC fund class ID (e.g. "C000092055"), present alongside series_id.'),
    filings: z
      .array(
        z
          .object({
            accession_number: z
              .string()
              .describe(
                'Accession number, dash format (e.g., 0000320193-23-000106). Pass to secedgar_get_filing.',
              ),
            form: z.string().describe('Form type (e.g., 10-K).'),
            filing_date: z.string().describe('Date the filing was submitted (YYYY-MM-DD).'),
            report_date: z
              .string()
              .optional()
              .describe(
                'Period of report (YYYY-MM-DD). Absent for forms without one (proxy statements, ownership reports).',
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
      .describe('Recent filings, filtered by forms if specified.'),
    total_filings: z
      .number()
      .optional()
      .describe('Filings matching the filter across everything scanned; can exceed filing_limit.'),
    history_scanned_through: z
      .string()
      .optional()
      .describe(
        'Oldest filing date the scan reached (YYYY-MM-DD); nothing older was examined. Archive pages past the recent window (last year or 1,000 filings) are read only for a date filter or an under-filled form filter. Absent when nothing was scanned.',
      ),
    dataset: z
      .object({
        name: z
          .string()
          .describe(
            'Dataframe handle (df_XXXXX_XXXXX) for secedgar_dataframe_describe, then secedgar_dataframe_query.',
          ),
        row_count: z.number().describe('Rows materialized in the dataframe.'),
        expires_at: z.string().describe('ISO 8601 expiry timestamp.'),
        truncated: z
          .boolean()
          .describe(
            'True when the archive scan hit its page cap, so older matching filings exist beyond the dataframe.',
          ),
      })
      .optional()
      .describe(
        'Dataframe of the full filtered history (recent window plus archive pages), staged only when the scan went past the recent window and the history exceeds filing_limit.',
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
        // Only this throw can attach suggestions, so only it points the caller at them (#153).
        throw ctx.fail(
          'no_match',
          `No company found for '${input.query}'.${suggestionNote}`,
          suggestions.length > 0
            ? {
                suggestions,
                recovery: {
                  hint: `Check \`data.suggestions\` for near matches. ${ctx.recoveryFor('no_match').recovery.hint}`,
                },
              }
            : ctx.recoveryFor('no_match'),
        );
      }
      if (resolved.length > 1) {
        const matches = resolved
          .map((m) => `${m.ticker ?? m.cik} (${m.name ?? 'Unknown'})`)
          .join(', ');
        throw ctx.fail('multiple_matches', `Multiple matches for '${input.query}': ${matches}.`, {
          query: input.query,
          matches: resolved.map((m) => ({ cik: m.cik, name: m.name, ticker: m.ticker })),
        });
      }
    }

    const match = Array.isArray(resolved) ? resolved[0] : resolved;
    if (!match) {
      throw ctx.fail('no_match', `No company found for '${input.query}'.`);
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
      const formTypes = input.forms?.length ? input.forms : undefined;

      const matches = (f: FilingEntry) =>
        (!formTypes || formTypes.some((ft) => f.form.toUpperCase() === ft.toUpperCase())) &&
        (!filedAfter || f.filing_date >= filedAfter) &&
        (!filedBefore || f.filing_date <= filedBefore);

      const recentRows = zipFilings(submissions.filings.recent);
      const recentMatched = recentRows.filter(matches);

      // Walk the older archive pages when the caller targets a date range (which may
      // predate the recent window) or when a form filter under-fills that window (#78).
      const underFill = Boolean(formTypes) && recentMatched.length < input.filing_limit;
      const bridge = getCanvasBridge();

      const archiveMatched: FilingEntry[] = [];
      const walk = new SubmissionsArchiveWalk(api, submissions, {
        filedAfter,
        filedBefore,
        order: 'newest-first',
      });

      if (hasDateFilter || underFill) {
        for await (const { block } of walk) {
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
      const scannedBeyondRecent = walk.pagesRead > 0;
      // Oldest date reached — the deepest archive page read, else the recent window's tail.
      historyScannedThrough = walk.scannedThrough ?? recentRows.at(-1)?.filing_date;
      const archiveTruncated = walk.truncated;

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
            forms: input.forms,
            filed_after: filedAfter,
            filed_before: filedBefore,
          },
          truncated: archiveTruncated,
        });
        if (registered) dataset = { ...toDatasetField(registered), truncated: archiveTruncated };
      }
    }

    if (input.include_filings && input.forms?.length && totalFilings === 0) {
      ctx.enrich.notice(
        `No filings matched form types [${input.forms.join(', ')}] for this entity. Try different form types or remove the filter.`,
      );
    } else if (
      filings !== undefined &&
      totalFilings !== undefined &&
      totalFilings > filings.length
    ) {
      ctx.enrich.truncated({
        shown: filings.length,
        cap: input.filing_limit,
        // The pointer only rides along when a dataframe was actually registered —
        // it is not, for a history that never left the recent window (#104).
        guidance: `Showing ${filings.length} of ${totalFilings} matching filings. ${
          dataset ? dataframeGuidance(dataset) : 'Raise filing_limit to see more inline.'
        }`,
      });
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
