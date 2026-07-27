/**
 * @fileoverview A company's 8-K filing history with item codes decoded and
 * filterable — the only surface that can scope material events by what the event
 * actually was (earnings, officer departure, non-reliance) rather than by form.
 * @module mcp-server/tools/definitions/get-material-events
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';
import {
  getEdgarApiService,
  selectArchivePages,
  suggestCompanies,
} from '@/services/edgar/edgar-api-service.js';
import {
  type DecodedEightKItem,
  decodeEightKItem,
  EIGHT_K_ITEM_CODES,
  EIGHT_K_RENUMBERING_DATE,
  parseEightKItems,
} from '@/services/edgar/eight-k-items.js';
import type { FilingsRecent } from '@/services/edgar/types.js';

/**
 * Cap on submissions archive pages fetched in one call — bounds latency and the
 * rate-limited request budget. Mirrors the same constant in company-search and
 * search-filings; hitting it sets `dataset.truncated` and is disclosed by
 * `history_scanned_through`.
 */
const ARCHIVE_PAGE_SCAN_CAP = 10;

/** One 8-K filing with its item codes decoded. */
interface EventRow {
  accession_number: string;
  description: string | undefined;
  filing_date: string;
  form: string;
  item_codes: string[];
  items: DecodedEightKItem[];
  primary_document: string | undefined;
  report_date: string | undefined;
}

/** True for 8-K and its amendments (8-K/A), excluding the 8-K12B-family registration forms. */
function isMaterialEventForm(form: string): boolean {
  const upper = form.toUpperCase();
  return upper === '8-K' || upper.startsWith('8-K/');
}

/** Zip a submissions parallel-array block into 8-K rows with items decoded. */
function zipEightKs(block: FilingsRecent): EventRow[] {
  const rows: EventRow[] = [];
  for (let i = 0; i < block.accessionNumber.length; i++) {
    const form = block.form[i] ?? '';
    if (!isMaterialEventForm(form)) continue;
    const codes = parseEightKItems(block.items?.[i]);
    rows.push({
      accession_number: block.accessionNumber[i] ?? '',
      form,
      filing_date: block.filingDate[i] ?? '',
      report_date: block.reportDate[i] || undefined,
      primary_document: block.primaryDocument[i] || undefined,
      description: block.primaryDocDescription[i] || undefined,
      item_codes: codes,
      items: codes.map(decodeEightKItem),
    });
  }
  return rows;
}

export const getMaterialEventsTool = tool('secedgar_get_material_events', {
  title: 'Get Material Events',
  description:
    "Retrieve a company's 8-K filings with their item codes decoded, optionally filtered to specific items. 8-K item codes are how material events are actually scoped — 1.01 material agreements, 2.02 results of operations, 4.02 non-reliance on previously issued financials, 5.02 officer and director departures — and filtering by them is narrower than any form-level filter in secedgar_search_filings or secedgar_company_search, neither of which can see items. Each row carries the accession number and primary document for secedgar_get_filing; press releases usually ride as EX-99 exhibits rather than in the primary document. Two numbering regimes exist: filings from 2004-08-23 onward use the x.xx codes, earlier ones use single integers (12 was the old results-of-operations item, 9 the old Regulation FD item), and both are accepted as filters and decoded in the response. A date window reaches filings older than the recent submissions window by paging into the archive. The full filtered set is materialized as a dataframe for item-distribution analysis over time.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No company matches the query',
      recovery:
        'Use a ticker symbol or 10-digit CIK for an exact match, or find the company with secedgar_company_search.',
    },
    {
      reason: 'multiple_matches',
      code: JsonRpcErrorCode.NotFound,
      when: 'The query is ambiguous and matches several companies',
      recovery: 'Retry with a ticker symbol or the 10-digit CIK from the matches list.',
    },
  ],

  input: z.object({
    company: z
      .string()
      .trim()
      .min(1, 'Company cannot be blank')
      .describe(
        'Company ticker symbol (e.g. "AAPL"), name (e.g. "Apple"), or CIK number (e.g. "320193"). Ticker is the exact lookup; name search matches current and former names.',
      ),
    items: z
      .array(z.enum(EIGHT_K_ITEM_CODES))
      .max(20)
      .optional()
      .describe(
        'Item codes to filter to; a filing matches when it reports any of them. Omit to return every 8-K. Current-regime codes are dotted ("2.02"), pre-2004-08-23 codes are bare integers ("12"), and the two vocabularies do not overlap — filtering on "2.02" alone returns nothing from a pre-2004 window, so pair them ("2.02", "12") when the window spans the changeover. Full decode table: the secedgar://filing-types resource.',
      ),
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
        'Only include filings filed on or after this date (YYYY-MM-DD). A date filter routes the scan into the older submissions archive pages, so it reaches 8-K filings that predate the ~1000-filing recent window.',
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
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe(
        'Filings returned inline, newest first. The full filtered set is materialized as a dataframe when it exceeds this and a canvas is available. Default 20.',
      ),
  }),

  output: z.object({
    cik: z
      .string()
      .describe('Central Index Key of the resolved company, zero-padded to 10 digits.'),
    company_name: z.string().describe('SEC-conformed company name.'),
    items_filter: z
      .array(z.string())
      .optional()
      .describe('The item codes filtered on, echoed. Absent when no filter was applied.'),
    total_matched: z
      .number()
      .describe(
        'Filings matching every applied filter across the whole scan, which may exceed limit and the inline list.',
      ),
    total_8k_scanned: z
      .number()
      .describe(
        '8-K filings inside the date window before the items filter — compare against total_matched to see how much the items filter removed.',
      ),
    item_distribution: z
      .record(z.string(), z.number())
      .describe(
        'Count of the 8-K filings scanned in the date window carrying each item code, before the items filter. Empty when no 8-K filings were scanned.',
      ),
    history_scanned_through: z
      .string()
      .optional()
      .describe(
        'Oldest filing date reached by the scan (YYYY-MM-DD). Older filings were not examined: the recent window caps at ~1000 filings, and archive pages are fetched only when a date filter or an under-filled result requires them. Absent when no filings were scanned.',
      ),
    filings: z
      .array(
        z
          .object({
            accession_number: z
              .string()
              .describe(
                'Filing accession number, dash format. Pass to secedgar_get_filing for the document text.',
              ),
            form: z.string().describe('Form type — "8-K", or "8-K/A" for an amendment.'),
            filing_date: z.string().describe('Date the filing was submitted (YYYY-MM-DD).'),
            report_date: z
              .string()
              .optional()
              .describe(
                'Date of the reported event (YYYY-MM-DD), which usually precedes the filing date. Absent when SEC records none.',
              ),
            primary_document: z
              .string()
              .optional()
              .describe(
                "Primary document filename — pass as `document` to secedgar_get_filing. Press releases are usually separate EX-99 exhibits, listed in that tool's document catalog. Absent on older filings, which EDGAR records without one; secedgar_get_filing still resolves them from the accession number alone.",
              ),
            description: z
              .string()
              .optional()
              .describe('SEC-provided filing description. Absent when SEC published none.'),
            items: z
              .array(
                z
                  .object({
                    code: z.string().describe('Item code exactly as EDGAR reported it.'),
                    label: z
                      .string()
                      .optional()
                      .describe(
                        'Item title from Form 8-K. Absent for a code neither numbering regime defines, so the raw code is never given a guessed meaning.',
                      ),
                    regime: z
                      .enum(['current', 'legacy'])
                      .optional()
                      .describe(
                        `Which numbering the code belongs to: "current" for the dotted scheme in force since ${EIGHT_K_RENUMBERING_DATE}, "legacy" for the single-integer scheme before it. Absent for an unrecognized code shape.`,
                      ),
                  })
                  .describe('One reported 8-K item.'),
              )
              .describe(
                'Items this filing reports, decoded. Empty when EDGAR records no items for the filing, which happens on some older filings.',
              ),
          })
          .describe('One 8-K filing.'),
      )
      .describe('Matching filings, newest first, capped at limit.'),
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
            'True when the archive scan hit its page cap before exhausting the history — older matching filings exist beyond the dataframe.',
          ),
      })
      .optional()
      .describe(
        "Canvas dataframe holding the full filtered 8-K set. Item codes ride as a comma-separated `item_codes` column, so item-frequency-over-time queries split it (`unnest(string_split(item_codes, ','))`). Absent when the result fits inline, canvas is unavailable, or materialization failed.",
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing matched — distinguishes an empty date window from an items filter that excluded everything.',
      ),
    truncated: z.boolean().optional().describe('True when the inline filings list was capped.'),
    shown: z.number().optional().describe('Number of filings shown inline.'),
    cap: z.number().optional().describe('The limit cap applied.'),
  },

  async handler(input, ctx) {
    const api = getEdgarApiService();
    const resolved = await api.resolveCik(input.company);

    if (Array.isArray(resolved)) {
      if (resolved.length === 0) {
        const suggestions = suggestCompanies(input.company, await api.getAllEntries());
        const suggestionNote =
          suggestions.length > 0
            ? ` Near matches: ${suggestions.map((s) => `${s.name ?? s.cik}${s.ticker ? ` (${s.ticker})` : ''}`).join(', ')}.`
            : '';
        throw ctx.fail('no_match', `No company found for '${input.company}'.${suggestionNote}`, {
          ...ctx.recoveryFor('no_match'),
          ...(suggestions.length > 0 ? { suggestions } : {}),
        });
      }
      if (resolved.length > 1) {
        const matches = resolved
          .map((m) => `${m.ticker ?? m.cik} (${m.name ?? 'Unknown'})`)
          .join(', ');
        throw ctx.fail('multiple_matches', `Multiple matches for '${input.company}': ${matches}.`, {
          ...ctx.recoveryFor('multiple_matches'),
          matches: resolved.map((m) => ({ cik: m.cik, name: m.name, ticker: m.ticker })),
        });
      }
    }

    const match = Array.isArray(resolved) ? resolved[0] : resolved;
    if (!match) {
      throw ctx.fail('no_match', `No company found for '${input.company}'.`, {
        ...ctx.recoveryFor('no_match'),
      });
    }

    // A numeric query that missed the ticker cache resolves to a bare CIK; only
    // that shape converts a submissions 404 into a no-match. A cache-hit match
    // that 404s is an EDGAR-side problem and propagates (#55).
    const isBareCikFallback = !match.name && !match.ticker;
    let submissions: Awaited<ReturnType<typeof api.getSubmissions>>;
    try {
      submissions = await api.getSubmissions(match.cik);
    } catch (err) {
      if (isBareCikFallback && err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        ctx.log.debug('CIK not found in EDGAR submissions', { cik: match.cik });
        throw ctx.fail('no_match', `No company found for '${input.company}'.`, {
          ...ctx.recoveryFor('no_match'),
        });
      }
      throw err;
    }

    const filedAfter = input.filed_after || undefined;
    const filedBefore = input.filed_before || undefined;
    const hasDateFilter = Boolean(filedAfter || filedBefore);
    const itemsFilter = input.items?.length ? input.items : undefined;
    const inWindow = (row: EventRow) =>
      (!filedAfter || row.filing_date >= filedAfter) &&
      (!filedBefore || row.filing_date <= filedBefore);

    const scanned: EventRow[] = zipEightKs(submissions.filings.recent).filter(inWindow);
    // Oldest date scanned so far — the recent window's tail (newest-first, so last).
    let historyScannedThrough = submissions.filings.recent.filingDate.at(-1);

    // Page into the older archive when the caller targets a date range that may
    // predate the recent window, or when that window under-fills the inline list.
    const files = submissions.filings.files;
    const underFill = scanned.length < input.limit;
    let archiveTruncated = false;
    if (files.length > 0 && (hasDateFilter || underFill)) {
      const pages = selectArchivePages(files, filedAfter, filedBefore);
      const pageLimit = Math.min(pages.length, ARCHIVE_PAGE_SCAN_CAP);
      archiveTruncated = pages.length > pageLimit;
      for (let i = 0; i < pageLimit; i++) {
        const page = pages[i];
        if (!page) break;
        const block = await api.fetchArchivePage(page.name);
        historyScannedThrough = page.filingFrom;
        scanned.push(...zipEightKs(block).filter(inWindow));
      }
    }

    scanned.sort((a, b) => b.filing_date.localeCompare(a.filing_date));

    const itemDistribution: Record<string, number> = {};
    for (const row of scanned) {
      for (const code of row.item_codes) {
        itemDistribution[code] = (itemDistribution[code] ?? 0) + 1;
      }
    }

    const matched = itemsFilter
      ? scanned.filter((row) => row.item_codes.some((code) => itemsFilter.includes(code)))
      : scanned;

    let dataset:
      | { name: string; row_count: number; expires_at: string; truncated: boolean }
      | undefined;
    const bridge = getCanvasBridge();
    if (bridge && matched.length > input.limit) {
      const registered = await bridge.registerDataframe(ctx, {
        rows: matched.map((row) => ({
          cik: match.cik,
          company_name: submissions.name,
          accession_number: row.accession_number,
          form: row.form,
          filing_date: row.filing_date,
          report_date: row.report_date ?? null,
          primary_document: row.primary_document,
          description: row.description ?? null,
          item_codes: row.item_codes.join(','),
          item_labels: row.items.map((item) => item.label ?? item.code).join(' | '),
          item_regime: row.items[0]?.regime ?? null,
        })),
        sourceTool: 'secedgar_get_material_events',
        queryParams: {
          cik: match.cik,
          items: input.items,
          filed_after: filedAfter,
          filed_before: filedBefore,
        },
        truncated: archiveTruncated,
      });
      if (registered) dataset = { ...toDatasetField(registered), truncated: archiveTruncated };
    }

    const windowText =
      filedAfter && filedBefore
        ? `between ${filedAfter} and ${filedBefore}`
        : filedAfter
          ? `on or after ${filedAfter}`
          : filedBefore
            ? `on or before ${filedBefore}`
            : 'in the scanned history';

    if (scanned.length === 0) {
      ctx.enrich.notice(
        `${submissions.name} filed no 8-K ${windowText}. Widen the date range, or list every form type with secedgar_company_search.`,
      );
    } else if (matched.length === 0) {
      const present = Object.keys(itemDistribution).sort().join(', ');
      ctx.enrich.notice(
        `${scanned.length} 8-K filings found ${windowText}, none reporting items [${(itemsFilter ?? []).join(', ')}]. Items actually reported in this window: ${present}. Filings before ${EIGHT_K_RENUMBERING_DATE} use single-integer item codes, so a dotted filter never matches them.`,
      );
    } else if (matched.length > input.limit) {
      ctx.enrich.truncated({
        shown: input.limit,
        cap: input.limit,
        guidance: dataset
          ? 'Query the full filtered set with secedgar_dataframe_query, or narrow the date range.'
          : 'Narrow the date range or the items filter to see the rest.',
      });
    }

    ctx.log.info('Material events retrieved', {
      cik: match.cik,
      scanned: scanned.length,
      matched: matched.length,
      items: input.items,
      datasetName: dataset?.name,
    });

    return {
      cik: match.cik,
      company_name: submissions.name,
      items_filter: itemsFilter ? [...itemsFilter] : undefined,
      total_matched: matched.length,
      total_8k_scanned: scanned.length,
      item_distribution: itemDistribution,
      history_scanned_through: historyScannedThrough,
      filings: matched.slice(0, input.limit),
      dataset,
    };
  },

  format: (result) => {
    const filterText = result.items_filter?.length
      ? ` | items [${result.items_filter.join(', ')}]`
      : '';
    const lines = [
      `**8-K material events** — ${result.company_name} (CIK ${result.cik})${filterText}`,
      `${result.total_matched} matching of ${result.total_8k_scanned} 8-K filings scanned; showing ${result.filings.length}`,
    ];

    for (const f of result.filings) {
      const reported = f.report_date ? ` (event: ${f.report_date})` : '';
      const desc = f.description ? ` — ${f.description}` : '';
      const doc = f.primary_document ? ` — ${f.primary_document}` : '';
      lines.push('');
      lines.push(`**${f.form} ${f.filing_date}**${reported}${desc}${doc} [${f.accession_number}]`);
      if (f.items.length === 0) {
        lines.push('- no items recorded');
      }
      for (const item of f.items) {
        lines.push(
          `- ${item.code} ${item.label ?? '(code not in the Form 8-K item list)'} [${item.regime ?? 'unrecognized numbering'}]`,
        );
      }
    }

    const dist = Object.entries(result.item_distribution)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, count]) => `${code}: ${count}`)
      .join(', ');
    if (dist) {
      lines.push(`\nItem distribution across the scanned window: ${dist}`);
    }
    if (result.history_scanned_through) {
      lines.push(
        `History scanned through: ${result.history_scanned_through} (older filings not examined).`,
      );
    }
    if (result.dataset) {
      const truncatedNote = result.dataset.truncated
        ? ' (truncated — older filings exist beyond the scanned pages)'
        : '';
      lines.push(
        `Dataset: ${result.dataset.name} (${result.dataset.row_count} rows, expires ${result.dataset.expires_at})${truncatedNote} — query with secedgar_dataframe_query.`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
