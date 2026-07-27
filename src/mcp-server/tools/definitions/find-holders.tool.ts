/**
 * @fileoverview Reverse 13F lookup — which institutions reported holding an issuer.
 * Searches the EDGAR full-text index scoped to 13F-HR within one quarter's filing
 * window and returns the filer list, each row chaining into
 * secedgar_get_institutional_holdings for the actual position.
 * @module mcp-server/tools/definitions/find-holders
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';
import { cleanDisplayName, getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import type { EftsHit } from '@/services/edgar/types.js';

/**
 * Hits returned by one EFTS request. The endpoint ignores the `size` parameter
 * and always answers with a full page, so paging is done with `from` alone.
 */
const EFTS_PAGE_SIZE = 100;

/**
 * Pages fetched in one call — 500 filer rows. Measured against the Q1 2026
 * filing window (2026-04-01 → 2026-06-30): Apple (CUSIP 037833100) draws 6,652
 * 13F-HR filings, so the budget returns a 500-row sample with the exact total
 * still reported and `dataset.truncated` set; Liberty Live Holdings (530909100)
 * draws 246 and Louisiana-Pacific (546347105) 451, both complete. Five requests
 * at ~0.4s each keeps a call around two seconds and well inside SEC's 10 req/s
 * limit, and the list is unranked either way — a deeper sample buys no ordering
 * the caller can use.
 */
const FETCH_PAGE_BUDGET = 5;

/** Days after a quarter end by which a 13F-HR is due. */
const FILING_DEADLINE_DAYS = 45;

const QUARTER_END_SUFFIX = ['03-31', '06-30', '09-30', '12-31'] as const;

/** One filer row as returned inline and materialized on the canvas. */
interface HolderRow {
  accession_number: string;
  filer_cik: string;
  filer_name: string;
  filing_date: string;
  form: string | undefined;
  period_ending: string | undefined;
}

/** Shift a YYYY-MM-DD date by whole days, staying in UTC. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Calendar quarter-end date (YYYY-MM-DD) for a `YYYY-QN` string. */
function quarterEndDate(quarter: string): string {
  const [year, q] = quarter.split('-Q');
  return `${year}-${QUARTER_END_SUFFIX[Number(q) - 1]}`;
}

/** End date of the quarter after `quarter` — the close of its filing window. */
function nextQuarterEndDate(quarter: string): string {
  const [year, q] = quarter.split('-Q');
  const n = Number(q);
  return n === 4 ? `${Number(year) + 1}-03-31` : `${year}-${QUARTER_END_SUFFIX[n]}`;
}

/**
 * Newest reporting quarter whose 13F-HR deadline has already passed as of
 * `today` — the default target, so an unqualified call returns a quarter that
 * institutions have actually filed for rather than an empty in-flight one.
 */
function latestClosedQuarter(today: string): string {
  const cutoff = addDays(today, -FILING_DEADLINE_DAYS);
  const year = Number(cutoff.slice(0, 4));
  // Suffixes ascend, so the last one at or before the cutoff is the newest closed quarter.
  const quarter = QUARTER_END_SUFFIX.findLastIndex((suffix) => `${year}-${suffix}` <= cutoff) + 1;
  return quarter > 0 ? `${year}-Q${quarter}` : `${year - 1}-Q4`;
}

function hitToHolder(hit: EftsHit): HolderRow {
  const displayName = hit._source.display_names?.[0] ?? '';
  return {
    accession_number: hit._source.adsh || hit._id.split(':')[0] || hit._id,
    filer_cik: hit._source.ciks?.[0] ?? '',
    filer_name: cleanDisplayName(displayName),
    filing_date: hit._source.file_date,
    form: hit._source.form ?? undefined,
    period_ending: hit._source.period_ending ?? undefined,
  };
}

export const findHoldersTool = tool('secedgar_find_holders', {
  title: 'Find Holders',
  description:
    'Find which institutional managers reported holding an issuer, by searching 13F-HR information tables for one reporting quarter. This is the reverse direction of secedgar_get_institutional_holdings: that tool takes a manager and returns its portfolio, this one takes an issuer and returns its managers — pass a returned filer_cik plus the same quarter to read the actual position. Searching by cusip is the precise path, matching the identifier the information table itself carries; without it the issuer name is matched as a phrase against the filing text, which both over-matches (unrelated issuers sharing a word) and under-matches (managers writing the name differently), so prefer cusip whenever one is known. A CUSIP cannot be derived from a ticker here — read one off any 13F information table returned by secedgar_get_institutional_holdings. The returned list is unranked: the search index scores by text relevance, which carries no signal about position size, and no ordering by shares or market value is available without opening each filing. Managers holding under $100M in 13(f) securities are exempt from filing at all.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'issuer_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No cusip was given and the issuer does not resolve to a known EDGAR company',
      recovery:
        'Confirm the issuer with secedgar_company_search, or pass the cusip parameter to search the information tables directly.',
    },
    {
      reason: 'ambiguous_issuer',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The issuer name matches several EDGAR companies and no cusip was given',
      recovery:
        'Retry with the ticker or the 10-digit CIK of the intended issuer from the matches list.',
    },
  ],

  input: z.object({
    issuer: z
      .string()
      .trim()
      .min(1, 'Issuer cannot be blank')
      .describe(
        'The portfolio company whose holders you want — a ticker ("AAPL"), a 10-digit CIK ("0000320193"), or a company name. Without cusip, this resolves to the company\'s EDGAR-conformed name and that name is phrase-matched against 13F information tables, so it must identify one company. With cusip supplied, it is used only to label the result.',
      ),
    cusip: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^[0-9A-Za-z]{9}$/, 'Expected a 9-character CUSIP or CINS identifier')
          .describe('9-character CUSIP/CINS'),
      ])
      .optional()
      .describe(
        'The issuer\'s 9-character CUSIP (e.g. "037833100" for Apple common stock; foreign issuers use a CINS starting with a letter, e.g. "H1467J104"). The precise match key — information tables identify every position by CUSIP, so this avoids the name-phrase misses. Each share class has its own CUSIP, so a multi-class issuer needs one call per class. Read a CUSIP off the holdings returned by secedgar_get_institutional_holdings.',
      ),
    quarter: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{4}-Q[1-4]$/, 'Expected YYYY-QN, e.g. 2026-Q1')
          .describe('YYYY-QN'),
      ])
      .optional()
      .describe(
        'Reporting quarter to search, "YYYY-QN" (e.g. "2026-Q1"). Omit for the newest quarter whose 45-day filing deadline has passed — the applied quarter and its filing window are echoed in the response. A quarter still inside its deadline returns nothing, because the filings do not exist yet.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe(
        'Filer rows returned inline. The full fetched set (up to 500 rows) is materialized as a dataframe when a canvas is available. Default 20.',
      ),
  }),

  output: z.object({
    issuer: z.string().describe('The issuer input, echoed.'),
    resolved_issuer_name: z
      .string()
      .optional()
      .describe(
        'EDGAR-conformed company name the issuer resolved to, and the phrase that was searched. Absent when cusip was supplied (no company lookup runs).',
      ),
    resolved_issuer_cik: z
      .string()
      .optional()
      .describe(
        'CIK of the resolved issuer, zero-padded to 10 digits. Absent when cusip was supplied.',
      ),
    search_mode: z
      .enum(['cusip', 'name'])
      .describe(
        'Which key matched the information tables. "cusip" matches the identifier the table itself carries; "name" phrase-matches the filing text and is looser in both directions.',
      ),
    search_key: z.string().describe('The exact term searched — the CUSIP, or the quoted phrase.'),
    quarter: z
      .string()
      .describe(
        'Reporting quarter searched, "YYYY-QN" — the requested one, or the applied default.',
      ),
    filed_from: z.string().describe('Start of the filing window searched (YYYY-MM-DD).'),
    filed_to: z.string().describe('End of the filing window searched (YYYY-MM-DD).'),
    total_filings: z
      .number()
      .describe(
        "Total 13F-HR filings matching the search key inside the filing window, as reported by the index. A slight over-count of this quarter's holders on two counts, both of which the returned rows correct for: a few percent are amendments restating an older quarter, and a few more are managers amending their own report for this quarter, which puts them in the window twice.",
      ),
    total_is_exact: z
      .boolean()
      .describe('False when total_filings is a lower bound (the index capped the count).'),
    fetched: z
      .number()
      .describe(
        'Filings retrieved from the index, capped by the fetch budget of 500. Equals total_filings when the whole window fit inside the budget.',
      ),
    holders_in_quarter: z
      .number()
      .describe(
        'Distinct managers among the fetched filings reporting this quarter as their period — the set paged by limit and materialized on the dataframe. Lower than fetched by the filings dropped as amendments restating other quarters, and by managers that amended this quarter (kept once, at their latest filing).',
      ),
    holders: z
      .array(
        z
          .object({
            filer_name: z
              .string()
              .describe(
                'Institutional manager that filed, with ticker/CIK parentheticals stripped.',
              ),
            filer_cik: z
              .string()
              .describe(
                "Filer CIK, zero-padded to 10 digits. Pass as ticker_or_cik to secedgar_get_institutional_holdings for this manager's positions.",
              ),
            accession_number: z
              .string()
              .describe('Accession number of the 13F-HR — pass to secedgar_get_filing.'),
            filing_date: z.string().describe('Date the 13F-HR was submitted (YYYY-MM-DD).'),
            form: z
              .string()
              .optional()
              .describe(
                'Form type, "13F-HR" or "13F-HR/A" for an amendment. Absent when the index carries no form tag.',
              ),
          })
          .describe('One institutional manager reporting a position in this issuer.'),
      )
      .describe(
        'One page of filers, capped at limit. Order carries no position-size meaning — see the ordering note.',
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
            'True when more filers exist beyond the fetch budget — total_filings exceeds fetched.',
          ),
      })
      .optional()
      .describe(
        'Canvas dataframe holding every fetched filer row, each carrying the issuer key and quarter so it joins across issuers and quarters. Absent when the result fits inline, canvas is unavailable, or materialization failed. Query with secedgar_dataframe_query.',
      ),
  }),

  enrichment: {
    ordering: z
      .string()
      .describe('How the holder list is ordered, and what that ordering does not mean.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when the search returned no filers — names the likely cause.'),
    truncated: z.boolean().optional().describe('True when the inline holders list was capped.'),
    shown: z.number().optional().describe('Number of filers shown inline.'),
    cap: z.number().optional().describe('The limit cap applied.'),
  },

  async handler(input, ctx) {
    const api = getEdgarApiService();
    const cusip = input.cusip?.toUpperCase() || undefined;

    // With a CUSIP in hand the information tables are matched directly, so no
    // company lookup runs and the issuer input is carried through as a label.
    let resolvedName: string | undefined;
    let resolvedCik: string | undefined;
    if (!cusip) {
      const resolved = await api.resolveCik(input.issuer);
      const candidates = Array.isArray(resolved) ? resolved : [resolved];
      if (candidates.length > 1) {
        const shown = candidates.slice(0, 10);
        const list = shown.map((c) => `${c.ticker ?? c.cik} (${c.name ?? 'Unknown'})`).join(', ');
        throw ctx.fail(
          'ambiguous_issuer',
          `'${input.issuer}' matches multiple EDGAR companies: ${list}.`,
          {
            ...ctx.recoveryFor('ambiguous_issuer'),
            matches: shown.map((c) => ({ cik: c.cik, name: c.name, ticker: c.ticker })),
          },
        );
      }
      const match = candidates[0];
      // A bare numeric CIK absent from the ticker cache resolves without a name,
      // leaving nothing to phrase-match — that is a miss, not a silent broadening.
      if (!match?.name) {
        throw ctx.fail(
          'issuer_not_found',
          `No EDGAR company name found for issuer '${input.issuer}', so there is nothing to match against 13F information tables.`,
          { ...ctx.recoveryFor('issuer_not_found') },
        );
      }
      resolvedName = match.name;
      resolvedCik = match.cik;
    }

    const quarter = input.quarter || latestClosedQuarter(new Date().toISOString().slice(0, 10));
    const quarterEnd = quarterEndDate(quarter);
    // The window runs from the day after the reporting quarter to the end of the
    // next one. It covers the 45-day deadline with room for late filers, and stops
    // before the following quarter's originals start arriving — those report a
    // different period and would otherwise be counted as this quarter's holders.
    const filedFrom = addDays(quarterEnd, 1);
    const filedTo = nextQuarterEndDate(quarter);

    const searchKey = cusip ?? `"${resolvedName}"`;
    const searchMode = cusip ? ('cusip' as const) : ('name' as const);

    // EFTS answers with a full page regardless of the requested size, so the
    // budget is expressed in pages and `from` walks the window.
    /**
     * One row per manager, keyed by filer CIK. A manager that amended its report
     * for this same quarter files twice inside one window — 7 of Cracker Barrel's
     * 256 Q1 2026 filings — and listing it twice would inflate a holder count by
     * a few percent. The later filing wins: the amendment supersedes the original
     * and its accession is the one worth reading.
     */
    const byFiler = new Map<string, HolderRow>();
    const seen = new Set<string>();
    let total = 0;
    let totalIsExact = true;
    let hitsFetched = 0;
    for (let page = 0; page < FETCH_PAGE_BUDGET; page++) {
      const response = await api.searchFilings({
        query: searchKey,
        forms: ['13F-HR'],
        startDate: filedFrom,
        endDate: filedTo,
        from: page * EFTS_PAGE_SIZE,
        size: EFTS_PAGE_SIZE,
      });
      if (page === 0) {
        total = response.hits.total.value;
        totalIsExact = response.hits.total.relation === 'eq';
      }
      const hits = response.hits.hits;
      hitsFetched += hits.length;
      for (const hit of hits) {
        const row = hitToHolder(hit);
        // One filing can match on several documents; the filer is listed once.
        if (seen.has(row.accession_number)) continue;
        seen.add(row.accession_number);
        // Amendments to older quarters keep arriving inside any filing window —
        // roughly 6% of the Q1 2026 window — so the reported period is what
        // decides membership, not the filing date.
        if (row.period_ending !== quarterEnd) continue;
        const existing = byFiler.get(row.filer_cik);
        if (!existing || row.filing_date > existing.filing_date) {
          byFiler.set(row.filer_cik, row);
        }
      }
      if (hits.length < EFTS_PAGE_SIZE || hitsFetched >= total) break;
    }
    const rows = [...byFiler.values()];

    const truncated = hitsFetched < total;

    let dataset:
      | { name: string; row_count: number; expires_at: string; truncated: boolean }
      | undefined;
    const bridge = getCanvasBridge();
    if (bridge && rows.length > input.limit) {
      const registered = await bridge.registerDataframe(ctx, {
        rows: rows.map((row) => ({
          issuer: input.issuer,
          issuer_cusip: cusip ?? null,
          issuer_cik: resolvedCik ?? null,
          quarter,
          reporting_period: quarterEnd,
          filer_name: row.filer_name,
          filer_cik: row.filer_cik,
          accession_number: row.accession_number,
          filing_date: row.filing_date,
          form: row.form ?? null,
        })),
        sourceTool: 'secedgar_find_holders',
        queryParams: {
          issuer: input.issuer,
          cusip,
          quarter,
          filed_from: filedFrom,
          filed_to: filedTo,
          search_mode: searchMode,
        },
        truncated,
      });
      if (registered) dataset = { ...toDatasetField(registered), truncated };
    }

    /**
     * The budget slices the window in relevance order, so once it binds the
     * result is a sample rather than a short list — an aggregate over it is an
     * aggregate over that sample, which is worth saying before someone counts it.
     */
    const sampleNote = truncated
      ? ` The fetch budget stopped at ${hitsFetched} of ${total} matching filings, and the index served them in that same relevance order, so this is a sample of the holders rather than the first ones by any measure.`
      : '';
    ctx.enrich({
      ordering: `Filers are listed in EDGAR search-relevance order, which reflects text match strength only — it is not a ranking by shares held or market value.${sampleNote} Read a manager's actual position with secedgar_get_institutional_holdings using its filer_cik and quarter "${quarter}".`,
    });

    const searchedTerm = searchMode === 'cusip' ? `CUSIP ${searchKey}` : `the phrase ${searchKey}`;
    if (total === 0) {
      const deadline = addDays(quarterEnd, FILING_DEADLINE_DAYS);
      const cause =
        deadline > new Date().toISOString().slice(0, 10)
          ? `13F-HR filings for ${quarter} are not due until ${deadline}, so few or none exist yet — search an earlier quarter.`
          : searchMode === 'cusip'
            ? 'Verify the CUSIP identifies a 13(f)-reportable security and covers the intended share class, or drop cusip to phrase-match the issuer name instead.'
            : 'The issuer name is phrase-matched against filing text and managers may write it differently — pass cusip for an exact match, read one off any secedgar_get_institutional_holdings result.';
      ctx.enrich.notice(
        `No 13F-HR filings matched ${searchedTerm} filed ${filedFrom} to ${filedTo}. ${cause}`,
      );
    } else if (rows.length === 0) {
      ctx.enrich.notice(
        `${total} 13F-HR filings matched ${searchedTerm} in the ${filedFrom} to ${filedTo} window, but none of the ${hitsFetched} fetched report ${quarter} (period ending ${quarterEnd}) — they are amendments restating other quarters. Search the quarter those amendments cover, or a later one.`,
      );
    } else if (rows.length > input.limit) {
      ctx.enrich.truncated({
        shown: input.limit,
        cap: input.limit,
        guidance: truncated
          ? `${total} filings matched in the window; the fetch budget of ${FETCH_PAGE_BUDGET * EFTS_PAGE_SIZE} retrieved ${hitsFetched}, resolving to ${rows.length} managers reporting ${quarter}. Query that set with secedgar_dataframe_query, or narrow to a single share class with cusip.`
          : 'Query the full matched set with secedgar_dataframe_query.',
      });
    }

    ctx.log.info('Holder search completed', {
      issuer: input.issuer,
      searchMode,
      quarter,
      total,
      fetched: hitsFetched,
      inQuarter: rows.length,
      datasetName: dataset?.name,
    });

    return {
      issuer: input.issuer,
      resolved_issuer_name: resolvedName,
      resolved_issuer_cik: resolvedCik,
      search_mode: searchMode,
      search_key: searchKey,
      quarter,
      filed_from: filedFrom,
      filed_to: filedTo,
      total_filings: total,
      total_is_exact: totalIsExact,
      fetched: hitsFetched,
      holders_in_quarter: rows.length,
      holders: rows.slice(0, input.limit),
      dataset,
    };
  },

  format: (result) => {
    const lines = [
      `**13F holders of ${result.issuer}** — ${result.quarter}, filed ${result.filed_from} to ${result.filed_to}`,
    ];
    if (result.resolved_issuer_name) {
      lines.push(
        `Resolved issuer: ${result.resolved_issuer_name} (CIK ${result.resolved_issuer_cik})`,
      );
    }
    lines.push(
      `Matched by ${result.search_mode}: ${result.search_key}`,
      `${result.total_filings} filings in the window (${result.total_is_exact ? 'exact count' : 'lower bound'}); ${result.fetched} fetched, ${result.holders_in_quarter} managers reporting ${result.quarter}, ${result.holders.length} shown`,
    );

    for (const h of result.holders) {
      lines.push(
        `- ${h.filer_name} (CIK ${h.filer_cik}) — ${h.form ?? '13F-HR'} ${h.filing_date} [${h.accession_number}]`,
      );
    }

    if (result.dataset) {
      const truncatedNote = result.dataset.truncated
        ? ' (truncated — more filers exist beyond the fetch budget)'
        : '';
      lines.push(
        `\nDataset: ${result.dataset.name} (${result.dataset.row_count} rows, expires ${result.dataset.expires_at})${truncatedNote} — query with secedgar_dataframe_query.`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
