/**
 * @fileoverview Find companies and retrieve entity info with optional recent filings.
 * Entry point for most SEC EDGAR workflows.
 * @module mcp-server/tools/definitions/company-search
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdown } from '@cyanheads/mcp-ts-core/utils';
import { ambiguousMatches, type MatchTotal } from '@/mcp-server/tools/ambiguous-matches.js';
import { datasetSchema } from '@/mcp-server/tools/dataset-schema.js';
import { normalizeFormFilter } from '@/mcp-server/tools/form-filter.js';
import {
  type LimitClampOptions,
  limitClamp,
  withLimitClamps,
} from '@/mcp-server/tools/limit-clamp.js';
import { resolvedAsField } from '@/mcp-server/tools/resolved-as.js';
import {
  EFTS_DEGRADED_ERROR,
  SEC_UPSTREAM_ERRORS,
} from '@/mcp-server/tools/sec-upstream-errors.js';
import {
  dataframeGuidance,
  getCanvasBridge,
  toDatasetField,
} from '@/services/canvas-bridge/canvas-bridge.js';
import { CallScope } from '@/services/edgar/call-scope.js';
import {
  type EntityNameMatch,
  type EntityNameResolution,
  getEdgarApiService,
  LAST_EXACT_TIER,
  NAME_WORD_CHAR,
  type NameTier,
  nameQuery,
  nameTier,
  type SubsidiaryParent,
  subsidiaryPhrase,
  suggestCompanies,
} from '@/services/edgar/edgar-api-service.js';
import { nonUsListingNote } from '@/services/edgar/listing-codes.js';
import { SubmissionsArchiveWalk } from '@/services/edgar/submissions-archive.js';
import type { CikMatch, FilingsRecent } from '@/services/edgar/types.js';

interface FilingEntry {
  accession_number: string;
  description?: string | undefined;
  filing_date: string;
  form: string;
  primary_document: string;
  report_date?: string | undefined;
}

/** Most filings the inline list holds; a larger `filing_limit` is served at this (#168). */
const INLINE_FILING_CAP = 50;

/**
 * Point a caller at the filings the inline list withheld when neither a dataframe nor a
 * larger `filing_limit` can reach them: a `secedgar_search_filings` call over the same
 * entity, forms, and dates, ending at the oldest filing shown (inclusive, so that day's
 * shown filings repeat and none is skipped). That tool has no `company` key, so the call
 * carries `cik:` scope, and it carries a lower bound even when the caller gave none. One
 * call serves one window of up to 100 filings, so the notice says
 * how to page on (#168). The call is a code span: the notice is authored Markdown, and
 * a caller's form types ride into it as typed, so outside code a CommonMark client
 * would consume their backslashes and Markdown punctuation (#220).
 */
function searchFilingsRecipe(args: {
  cik: string;
  filedAfter: string;
  filedBefore: string;
  forms: string[] | undefined;
}): string {
  const call = {
    query: `cik:${args.cik}`,
    ...(args.forms ? { forms: args.forms } : {}),
    filed_after: args.filedAfter,
    filed_before: args.filedBefore,
    limit: 100,
  };
  const amendments = args.forms ? ', and its forms filter also matches amendments' : '';
  return `The inline list holds at most ${INLINE_FILING_CAP}. Call secedgar_search_filings with ${markdown().inlineCode(JSON.stringify(call)).build()} — it also returns the filings shown here from ${args.filedBefore}${amendments}. Each call returns up to ${call.limit} filings; for older ones, repeat it with filed_before moved to the oldest filing_date it returns.`;
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

/** The `ambiguous_company` message, worded as every company-resolving tool words it (#228). */
function ambiguityMessage(query: string, list: string, showing: string): string {
  return `'${query}' matches multiple companies: ${list}. Retry with one of these tickers or 10-digit CIKs.${showing}`;
}

/**
 * The entity-index hits at the best name tier any of them reaches, in SEC's order, or
 * `undefined` when none reaches one (#236). The index matches a name's words in any order,
 * so a hit can reach no tier at all (`Schwab Charles R.` for `Charles Schwab`).
 */
function bestTierHits(
  query: string,
  hits: readonly EntityNameMatch[],
): { tier: NameTier; hits: EntityNameMatch[] } | undefined {
  const forms = nameQuery(query);
  let best: { tier: NameTier; hits: EntityNameMatch[] } | undefined;
  for (const hit of hits) {
    const tier = nameTier(hit.name, forms);
    if (tier === undefined || (best !== undefined && tier > best.tier)) continue;
    if (best?.tier === tier) best.hits.push(hit);
    else best = { tier, hits: [hit] };
  }
  return best;
}

/**
 * SEC's count of an entity-index answer that holds more hits than the 10 it returned —
 * `relation: 'gte'` makes it a floor — or `undefined` for a complete page, whose ambiguity
 * counts its own best-tier hits (#230).
 */
function partialIndexTotal({ matches, total }: EntityNameResolution): MatchTotal | undefined {
  if (total === undefined) return;
  const lowerBound = total.relation === 'gte';
  return lowerBound || total.value > matches.length
    ? { count: total.value, lowerBound }
    : undefined;
}

/** `resolvedAs` for a match the entity index made (#236). */
function entityIndexReading(query: string, hit: EntityNameMatch): string {
  return hit.ticker === undefined
    ? `'${query}' matched ${hit.name} (CIK ${hit.cik}) in EDGAR's entity index, with no listed ticker`
    : `'${query}' matched ${hit.name} (${hit.ticker}, CIK ${hit.cik}) in EDGAR's entity index`;
}

/** What the subsidiaries-exhibit search returned, or why it did not run (#236). */
type ParentSearch =
  | { ran: true; parents: SubsidiaryParent[] }
  | { ran: false; reason: string | undefined; retryAfter: number | undefined };

/** Codes for SEC failing a request, or refusing it during a rate-limit block. */
const SEC_UNAVAILABLE_CODES = new Set<number>([
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.Timeout,
  JsonRpcErrorCode.RateLimited,
]);

/**
 * Search 10-K subsidiaries exhibits for `query`, the miss path's last step (#236). The answer
 * is already `no_match`, and no request follows this one, so SEC failing it (no response, a
 * 5xx once retried, a search-backend failure, a 408 or 425) or refusing it during a
 * rate-limit block leaves that answer standing, saying the search did not run. The
 * caller's cancel and every other failure end the call.
 */
async function searchParents(
  api: ReturnType<typeof getEdgarApiService>,
  query: string,
  scope: CallScope,
): Promise<ParentSearch> {
  try {
    return { ran: true, parents: await api.findSubsidiaryParents(query, scope) };
  } catch (error) {
    const unavailable = error instanceof McpError && SEC_UNAVAILABLE_CODES.has(error.code);
    if (!unavailable || scope.signal.aborted) throw error;
    const reason = error.data?.reason;
    const retryAfter = error.data?.retryAfter;
    return {
      ran: false,
      reason: typeof reason === 'string' ? reason : undefined,
      retryAfter: typeof retryAfter === 'number' ? retryAfter : undefined,
    };
  }
}

/** The JSON arguments of the search call `no_match` names when no subsidiaries exhibit holds it. */
function mentionsSearchArgs(query: string): string {
  return JSON.stringify({ query: subsidiaryPhrase(query) });
}

/** The `no_match` sentence a subsidiaries-exhibit search adds, its leading space included. */
function parentSearchNote(query: string, search: ParentSearch): string {
  if (!search.ran) {
    const reason = search.reason === undefined ? '' : ` (${search.reason})`;
    const when =
      search.retryAfter === undefined ? 'in a minute' : `after ${search.retryAfter} seconds`;
    return ` The search for a 10-K subsidiaries exhibit (EX-21) naming it did not run${reason}; retry the call ${when} to run it.`;
  }
  const { parents } = search;
  if (parents.length === 0) {
    return ` No 10-K subsidiaries exhibit (EX-21) names it either; for filings that mention it, call secedgar_search_filings with ${mentionsSearchArgs(query)}.`;
  }
  const filers = parents
    .map((p) => {
      const id = `${p.ticker === undefined ? '' : `${p.ticker}, `}CIK ${p.cik}`;
      const filer = p.name === undefined ? id : `${p.name} (${id})`;
      return `${filer}, in its 10-K filed ${p.filingDate} (accession ${p.accessionNumber})`;
    })
    .join('; ');
  const whose = parents.length === 1 ? 'that filer' : 'one of these filers';
  return ` '${query}' appears in the subsidiaries exhibit (EX-21) of ${filers}, so it may be a subsidiary of ${whose}.`;
}

/** `filing_limit`: the inline list holds at most 50 filings (#168, #197). */
const filingLimitClamp = limitClamp({
  tool: 'secedgar_company_search',
  field: 'filing_limit',
  min: 1,
  cap: INLINE_FILING_CAP,
  bound: 1000,
  shape: (n) => n.default(10),
  description:
    'Maximum number of filings to return in the inline list; when more match, the notice names where the rest are.',
});

export const companySearchTool = tool('secedgar_company_search', {
  description:
    "Find companies and retrieve entity info with optional recent filings. Entry point for most EDGAR workflows — resolves tickers, names, or CIKs to entity details, with accession numbers in the result feeding secedgar_get_filing for document content. A name SEC's ticker file misses is looked up in EDGAR's entity index of every filer, then in 10-K subsidiaries exhibits, whose filers the not-found error names as possible parents. When a date or form filter carries the scan past the recent submissions window, the full filtered filing history is also staged as df_<id> — inspect it with secedgar_dataframe_describe, then analyze it with secedgar_dataframe_query.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  // Agent-facing context — notice for empty filings (e.g. filtered form types with
  // no matches) populated via ctx.enrich so it reaches both structuredContent and
  // content[] automatically; no format() entry needed.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no filings matched the forms filter, or when the inline list withheld some: the dataframe, a larger filing_limit, or a secedgar_search_filings call for the rest.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when more filings matched than the inline list holds.'),
    shown: z.number().optional().describe('Number of filings returned inline.'),
    cap: z.number().optional().describe('The inline limit applied: `filing_limit`, at most 50.'),
    resolvedAs: resolvedAsField,
  },

  enrichmentTrailer: {
    resolvedAs: { label: 'Resolved as' },
  },

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: "No company matches the query in SEC's ticker file, the former names it records, or EDGAR's entity index of every filer",
      recovery:
        'SEC\'s ticker index reflects the filer\'s own submissions record, which can differ from the exchange-listed symbol. ETFs and mutual funds resolve only by ticker (e.g. "VOO"); operating companies also resolve by full legal name or 10-digit CIK.',
    },
    {
      reason: 'ambiguous_company',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The company input resolves to multiple entities and the target is ambiguous',
      recovery: 'Use a ticker symbol or 10-digit CIK from the matches list for an exact match.',
    },
    ...SEC_UPSTREAM_ERRORS,
    EFTS_DEGRADED_ERROR,
  ],

  input: z.object({
    query: z
      .string()
      .trim()
      .min(1, 'Query cannot be blank')
      .describe(
        'Company ticker symbol (e.g., "AAPL", "VOO"), name (e.g., "Apple"), or CIK number (e.g., "320193"). Ticker is the fastest lookup and works for equities, ETFs, and mutual funds; a multi-class share ticker resolves in either form ("BRK-B" or "BRK.B"), and an uppercase ticker also resolves as market-data feeds write it: venue-coded ("UEC.N"), a preferred class run together ("CFGPH"), or a class root ("GLOP"). Name search matches current and former names, preferring a name the query matches exactly over one it only starts or appears in, and never matching from inside a word ("SY Bancorp" does not find "Embassy Bancorp"); an exact or starts-with match ignores commas, periods, apostrophes, extra spaces, and the spaces between single initials ("QXO Inc" finds "QXO, Inc."; "U.S. Bancorp" finds "US BANCORP"; "Macys" finds "Macy\'s, Inc."; "JM Smucker" finds "J M SMUCKER Co"). The corporate suffix (Inc, Corp, Co, Ltd, PLC, LLC, LP, N.V., S.A., AG, SE) can be left off ("Apple" finds "Apple Inc."; "Rio Tinto" lists both the Ltd and the PLC) or spelled out ("Beacon Financial Corporation" finds "Beacon Financial Corp"), but a suffix you include must match — Corp, Inc, Co, and Ltd stay distinct from each other, since separate registrants differ only by which one they use. A name with its words in another order also matches when nothing else does ("Charles Schwab" finds "SCHWAB CHARLES CORP"). A former ticker resolves to the company that last held it ("AMRK" finds Gold.com). A name SEC\'s ticker file misses is looked up in EDGAR\'s entity index, which also holds filers with no ticker ("Exxon Mobil" finds EXXON MOBIL CORP); a private company found only in a 10-K\'s subsidiaries exhibit fails as not found, naming the filer of that exhibit as its possible parent.',
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
    filing_limit: filingLimitClamp.schema(true),
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
      .describe(
        'Filings matching the filter across everything scanned; can exceed the inline list.',
      ),
    history_scanned_through: z
      .string()
      .optional()
      .describe(
        'Oldest filing date the scan examined (YYYY-MM-DD). Archive pages past the recent window (last year or 1,000 filings) are read only for a date filter or an under-filled forms filter. Absent when nothing was scanned.',
      ),
    dataset: datasetSchema
      .extend({
        truncated: z
          .boolean()
          .describe(
            'True when the archive scan hit its page cap, so older matching filings exist beyond the dataframe.',
          ),
      })
      .optional()
      .describe(
        'Dataframe of the full filtered history (recent window plus archive pages), staged only when the scan went past the recent window and the history outgrows the inline list.',
      ),
  }),

  async handler(input, ctx) {
    const api = getEdgarApiService();
    const scope = new CallScope(ctx.signal);
    const resolved = await api.resolveCik(input.query, scope);

    if (Array.isArray(resolved) && resolved.length > 1) {
      const { list, showing, data } = ambiguousMatches(resolved);
      throw ctx.fail('ambiguous_company', ambiguityMessage(input.query, list, showing), {
        query: input.query,
        ...data,
      });
    }

    let match: CikMatch | undefined = Array.isArray(resolved) ? resolved[0] : resolved;
    if (!match) {
      // Every local pass missed: EDGAR's entity index, then 10-K subsidiaries exhibits (#236).
      // Neither index holds a non-US listing code (`7203.T`), and a query with no letter or
      // digit names nothing, so neither is sent.
      const listingNote = nonUsListingNote(input.query);
      const index =
        listingNote || !NAME_WORD_CHAR.test(input.query)
          ? undefined
          : await api.resolveEntityByName(input.query, scope);
      const best = index && bestTierHits(input.query, index.matches);
      if (index && best && best.hits.length > 1) {
        const { list, showing, data } = ambiguousMatches(best.hits, {
          total: partialIndexTotal(index),
        });
        throw ctx.fail('ambiguous_company', ambiguityMessage(input.query, list, showing), {
          query: input.query,
          ...data,
        });
      }
      const [hit] = best?.hits ?? [];
      if (hit && best && best.tier <= LAST_EXACT_TIER) {
        match = {
          cik: hit.cik,
          name: hit.name,
          ...(hit.ticker !== undefined && { ticker: hit.ticker }),
          reading: entityIndexReading(input.query, hit),
        };
      } else {
        // A lone hit at the prefix or substring tier is a near match, never a resolution (#41);
        // only a name the index has no tiered hit for reaches the exhibits.
        const parentSearch =
          index && !hit ? await searchParents(api, input.query, scope) : undefined;
        const parents = parentSearch?.ran ? parentSearch.parents : [];
        const trigram = suggestCompanies(input.query, await api.getAllEntries(scope));
        const suggestions = hit ? [hit, ...trigram.filter((s) => s.cik !== hit.cik)] : trigram;
        const suggestionNote =
          suggestions.length > 0
            ? ` Near matches: ${suggestions.map((s) => `${s.name ?? s.cik}${s.ticker ? ` (${s.ticker})` : ''}`).join(', ')}.`
            : '';
        // The hint points only at the fields this throw attaches (#153).
        const hint = [
          ...(parents.length > 0
            ? ['Check `data.parents` for the filers whose 10-K subsidiaries exhibit names it.']
            : []),
          ...(suggestions.length > 0 ? ['Check `data.suggestions` for near matches.'] : []),
          ctx.recoveryFor('no_match').recovery.hint,
        ].join(' ');
        throw ctx.fail(
          'no_match',
          `No company found for '${input.query}'.${parentSearch ? parentSearchNote(input.query, parentSearch) : ''}${suggestionNote}${listingNote ? ` ${listingNote}` : ''}`,
          {
            ...(parents.length > 0 && {
              parents: parents.map((p) => ({
                cik: p.cik,
                name: p.name,
                ticker: p.ticker,
                filing_date: p.filingDate,
                accession_number: p.accessionNumber,
              })),
            }),
            ...(suggestions.length > 0 && { suggestions }),
            recovery: { hint },
          },
          // content[] prints the search arguments as code, unescaped, to be sent back as written.
          { literals: [mentionsSearchArgs(input.query)] },
        );
      }
    }
    if (match.reading) ctx.enrich({ resolvedAs: match.reading });

    // Bare-CIK fallback: resolveCik returns { cik } with no name/ticker when a numeric
    // query missed the ticker cache — getSubmissions 404s for non-existent CIKs (#55).
    // For cache-hit matches (name or ticker present), a 404 signals an EDGAR-side
    // problem and must propagate unchanged.
    const isBareCikFallback = !match.name && !match.ticker;
    let submissions: Awaited<ReturnType<typeof api.getSubmissions>>;
    try {
      submissions = await api.getSubmissions(match.cik, scope);
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
    // Oldest filing date among every match — the lower edge of what `total_filings` counted.
    let oldestMatched: string | undefined;

    // Every read of the limit takes the applied value, so a call above the cap answers
    // exactly as the same call at the cap does (#168).
    const filingLimit = filingLimitClamp.apply(input.filing_limit, ctx);
    const filedAfter = input.filed_after || undefined;
    const filedBefore = input.filed_before || undefined;
    // Blank elements are no filter: they must not trigger the under-fill archive walk (#194).
    const formTypes = normalizeFormFilter(input.forms);

    if (input.include_filings) {
      const hasDateFilter = Boolean(filedAfter || filedBefore);

      const matches = (f: FilingEntry) =>
        (!formTypes || formTypes.includes(f.form.toUpperCase())) &&
        (!filedAfter || f.filing_date >= filedAfter) &&
        (!filedBefore || f.filing_date <= filedBefore);

      const recentRows = zipFilings(submissions.filings.recent);
      const recentMatched = recentRows.filter(matches);

      // Walk the older archive pages when the caller targets a date range (which may
      // predate the recent window) or when a form filter under-fills that window (#78).
      const underFill = Boolean(formTypes) && recentMatched.length < filingLimit;
      const bridge = getCanvasBridge();

      const archiveMatched: FilingEntry[] = [];
      const walk = new SubmissionsArchiveWalk(
        api,
        submissions,
        { filedAfter, filedBefore, order: 'newest-first' },
        scope,
      );

      if (hasDateFilter || underFill) {
        for await (const { block } of walk) {
          archiveMatched.push(...zipFilings(block).filter(matches));

          // Under-fill fallback with no canvas: stop once the inline limit is filled —
          // there is no dataframe to complete, so deeper pages aren't worth fetching.
          // (With a canvas, the loop scans on to register the full filtered history.)
          if (
            !hasDateFilter &&
            !bridge &&
            recentMatched.length + archiveMatched.length >= filingLimit
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
      filings = fullMatched.slice(0, filingLimit);
      oldestMatched = fullMatched.at(-1)?.filing_date;

      // Register the full filtered history to the canvas when the scan reached beyond
      // the recent window and there is more than fits inline — a multi-decade history is
      // SQL shape (filings by form by year). Mirror the ownership tools' preview +
      // full-set pattern; the inline `filings` list stays capped at the applied limit.
      if (bridge && scannedBeyondRecent && fullMatched.length > filingLimit) {
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
            forms: formTypes,
            filed_after: filedAfter,
            filed_before: filedBefore,
          },
          truncated: archiveTruncated,
        });
        if (registered) dataset = { ...toDatasetField(registered), truncated: archiveTruncated };
      }
    }

    if (input.include_filings && formTypes && totalFilings === 0) {
      // The notice is authored Markdown, so the caller's form types are escaped.
      ctx.enrich.notice(
        `No filings matched form types [${escapeMarkdownInline(formTypes.join(', '))}] for this entity. Try different form types or remove the filter.`,
      );
    } else if (
      filings !== undefined &&
      totalFilings !== undefined &&
      totalFilings > filings.length
    ) {
      // The pointer only rides along when a dataframe was actually registered — it is
      // not, for a history that never left the recent window (#104). Without one, a
      // larger filing_limit reaches the rest only while they fit inline (#168).
      let route: string;
      if (dataset) {
        route = dataframeGuidance(dataset);
      } else if (totalFilings <= INLINE_FILING_CAP) {
        route = 'Raise filing_limit to see more inline.';
      } else {
        // Reaching here means filings exist, so the scan reached some date. A manifest
        // page can start a day after its own rows, so take the older of the two edges.
        const scannedFrom = [historyScannedThrough, oldestMatched]
          .filter((d): d is string => d !== undefined)
          .sort()[0] as string;
        route = searchFilingsRecipe({
          cik: match.cik,
          filedAfter: filedAfter ?? scannedFrom,
          filedBefore: (filings.at(-1) as FilingEntry).filing_date,
          forms: formTypes,
        });
      }
      ctx.enrich.truncated({
        shown: filings.length,
        cap: filingLimit,
        guidance: `Showing ${filings.length} of ${totalFilings} matching filings. ${route}`,
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
    // SEC's name, SIC title, and filing descriptions render through escapeMarkdownInline,
    // so content[] reads back the structuredContent value as text (#221).
    const lines = [
      `**${escapeMarkdownInline(result.name)}** (${result.tickers.join(', ') || 'no ticker'})`,
    ];
    // A filer found only in EDGAR's entity index often has no SIC on record (#236).
    const sicTitle = result.sic_description
      ? ` (${escapeMarkdownInline(result.sic_description)})`
      : '';
    const sic = result.sic ? ` | SIC: ${result.sic}${sicTitle}` : '';
    const exchange = result.exchanges.length ? ` | Exchange: ${result.exchanges.join(', ')}` : '';
    lines.push(`CIK: ${result.cik}${sic}${exchange}`);
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
        const desc = f.description ? ` — ${escapeMarkdownInline(f.description)}` : '';
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

/** `secedgar_company_search` as this deployment's `EDGAR_CLAMP_OVERSIZED_LIMITS` builds it. */
export function createCompanySearchTool(options: LimitClampOptions) {
  return withLimitClamps(companySearchTool, [filingLimitClamp], options);
}
