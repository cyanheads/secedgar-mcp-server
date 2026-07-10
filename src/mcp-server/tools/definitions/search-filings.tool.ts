/**
 * @fileoverview Search EDGAR filings since 1993 — EFTS full-text for 2001-present,
 * archive-backed browse (submissions history + quarterly full-index) for pre-2001
 * date ranges.
 * @module mcp-server/tools/definitions/search-filings
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';
import {
  getEdgarApiService,
  quartersInRange,
  selectArchivePages,
} from '@/services/edgar/edgar-api-service.js';
import type { EftsHit, FilingSource, FilingsRecent } from '@/services/edgar/types.js';

/**
 * The EFTS full-text index only covers filings from this date onward, even
 * though the archives reach 1993. A date range entirely before this floor is
 * routed to the archive-backed paths; a range straddling it is rejected (#77).
 */
const EFTS_FULLTEXT_FLOOR = '2001-01-01';

/**
 * Cap on submissions archive pages fetched in one call (pre-2001 entity-scoped
 * arm) — bounds latency and the rate-limited request budget. Mirrors the same
 * constant in company-search.tool.ts. Pre-2001 pages are a filer's oldest, so
 * the cap rarely binds; when it does, `dataset.truncated` discloses it.
 */
const ARCHIVE_PAGE_SCAN_CAP = 10;

/**
 * Cap on quarterly full-index files fetched in one unscoped pre-2001 browse.
 * Each `master.idx` is a multi-MB whole-quarter download and is not
 * form-filterable server-side, so this arm is the heaviest — the cap bounds it
 * hard, and `dataset.truncated` discloses when older quarters went unscanned.
 */
const FULL_INDEX_QUARTER_SCAN_CAP = 8;

/**
 * Canonical, fully-keyed row for a filing hit — one shape across all three
 * sources (efts, submissions, full-index) so the canvas schema is stable and a
 * `source` column is always present. Absent fields are `null`; the inline
 * result mapper drops nulls to `undefined` for the optional output fields.
 */
type SearchRow = {
  accession_number: string;
  form: string | null;
  filing_date: string;
  period_ending: string | null;
  company_name: string;
  cik: string | null;
  ticker: string | null;
  file_description: string | null;
  sic: string | null;
  location: string | null;
  source: FilingSource;
};

/**
 * The tool's domain return shape — shared by the EFTS and archive-backed paths.
 * Optionals carry an explicit `| undefined` to match `z.infer` of the output
 * schema under `exactOptionalPropertyTypes` (the EFTS mapping emits present-but-
 * undefined optional fields).
 */
type SearchFilingsResult = {
  total: number;
  total_is_exact: boolean;
  results: Array<{
    accession_number: string;
    form?: string | undefined;
    filing_date: string;
    period_ending?: string | undefined;
    company_name: string;
    cik: string;
    ticker?: string | undefined;
    file_description?: string | undefined;
    sic?: string | undefined;
    location?: string | undefined;
    source?: FilingSource | undefined;
  }>;
  form_distribution?: Record<string, number> | undefined;
  dataset?: { name: string; row_count: number; expires_at: string; truncated: boolean } | undefined;
};

function eftsHitToRow(hit: EftsHit): SearchRow {
  const displayName = hit._source.display_names?.[0] || '';
  return {
    accession_number: hit._source.adsh || hit._id.split(':')[0] || hit._id,
    form: hit._source.form ?? null,
    filing_date: hit._source.file_date,
    period_ending: hit._source.period_ending ?? null,
    company_name: cleanCompanyName(displayName),
    cik: hit._source.ciks?.[0] ?? null,
    ticker: extractTicker(displayName),
    file_description: hit._source.file_description ?? null,
    sic: hit._source.sics?.[0] ?? null,
    location: hit._source.biz_locations?.[0] ?? null,
    source: 'efts',
  };
}

/** Map a fully-keyed {@link SearchRow} to an inline output row (nulls → omitted optionals). */
function toInlineResult(row: SearchRow): SearchFilingsResult['results'][number] {
  return {
    accession_number: row.accession_number,
    ...(row.form != null && { form: row.form }),
    filing_date: row.filing_date,
    ...(row.period_ending != null && { period_ending: row.period_ending }),
    company_name: row.company_name,
    cik: row.cik ?? '',
    ...(row.ticker != null && { ticker: row.ticker }),
    ...(row.file_description != null && { file_description: row.file_description }),
    ...(row.sic != null && { sic: row.sic }),
    ...(row.location != null && { location: row.location }),
    source: row.source,
  };
}

/**
 * True when a filing's form matches a requested form, counting amendments
 * (requested "10-K" matches "10-K" and "10-K/A"), mirroring EFTS forms
 * semantics so the archive-backed arms honor the same forms contract as the
 * post-2001 full-text path.
 */
function formMatches(filingForm: string, requestedForms: string[]): boolean {
  const f = filingForm.toUpperCase();
  return requestedForms.some((req) => {
    const r = req.toUpperCase();
    return f === r || f.startsWith(`${r}/`);
  });
}

/** Count filings by form, dropping the field when nothing carried a form. */
function buildFormDistribution(
  forms: Iterable<string | null | undefined>,
): Record<string, number> | undefined {
  const dist: Record<string, number> = {};
  for (const form of forms) {
    if (form) dist[form] = (dist[form] ?? 0) + 1;
  }
  return Object.keys(dist).length > 0 ? dist : undefined;
}

/**
 * EDGAR's `display_names[0]` embeds the ticker(s) and CIK in trailing parentheticals
 * (e.g., "Apple Inc.  (AAPL)  (CIK 0000320193)"). Strip them so consumers see a clean
 * company name — ticker and CIK are already surfaced as their own fields.
 */
function cleanCompanyName(displayName: string): string {
  return displayName
    .replace(/\s*\(CIK\s*\d+\)/gi, '')
    .replace(/\s*\([A-Z0-9,\s.-]+\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull the primary ticker out of `display_names[0]`. Strips the CIK parenthetical
 * first, then captures the trailing parens iff they look like ticker symbols
 * (uppercase letters, digits, dots, hyphens — optionally a comma-separated list
 * for multi-class issuers like BRK-A/BRK-B). Returns null when no ticker
 * parenthetical is present (private filers, foreign filers, filings with no
 * exchange listing).
 */
function extractTicker(displayName: string): string | null {
  const withoutCik = displayName.replace(/\s*\(CIK\s*\d+\)/gi, '');
  const match = withoutCik.match(/\(([A-Z][A-Z0-9.-]*(?:,\s*[A-Z][A-Z0-9.-]*)*)\)\s*$/);
  if (!match?.[1]) return null;
  const first = match[1].split(',')[0]?.trim();
  return first ? first : null;
}

/** Strip an entity-targeting token from the query and collapse whitespace. */
function stripToken(query: string, token: string): string {
  return query.replace(token, '').replace(/\s+/g, ' ').trim();
}

/**
 * Extract entity targeting (cik: or ticker:) from a query string and resolve it
 * to a CIK. Returns the free-text query with the token stripped (no company name
 * injected) plus the resolved CIK — the caller applies the CIK to EFTS's
 * server-side `ciks` param, so the scope is independent of the document's name
 * text and filings made under a former company name (same CIK) are matched (#35).
 *
 * An unresolved `ticker:` or non-numeric `cik:` token fails with a typed
 * validation error instead of stripping the token and proceeding unscoped —
 * a silently-broadened search misleads, and a stripped token can leave EFTS
 * with a blank query it rejects (#61).
 */
async function resolveEntityTargeting(
  query: string,
  ctx: Context,
): Promise<{ query: string; entityCik?: string }> {
  const tickerMatch = query.match(/\bticker:(\S+)/i);
  if (tickerMatch?.[1]) {
    const resolved = await getEdgarApiService().resolveCik(tickerMatch[1]);
    const match = Array.isArray(resolved) ? resolved[0] : resolved;
    if (!match?.cik) {
      throw validationError(
        `Entity targeting token 'ticker:${tickerMatch[1]}' does not resolve to a known company.`,
        { reason: 'unresolved_ticker', ...ctx.recoveryFor('unresolved_ticker') },
      );
    }
    return { query: stripToken(query, tickerMatch[0]), entityCik: match.cik };
  }

  const cikMatch = query.match(/\bcik:(\S+)/i);
  if (cikMatch?.[1]) {
    if (!/^\d{1,10}$/.test(cikMatch[1])) {
      throw validationError(
        `Entity targeting token 'cik:${cikMatch[1]}' is not a valid CIK — expected 1-10 digits.`,
        { reason: 'invalid_cik', ...ctx.recoveryFor('invalid_cik') },
      );
    }
    return { query: stripToken(query, cikMatch[0]), entityCik: cikMatch[1].padStart(10, '0') };
  }

  return { query };
}

/**
 * Shared tail for the archive-backed arms: sort the fully-matched rows, slice
 * the inline window, recompute the form distribution, register the full set to
 * the canvas (source-tagged), and emit the query echo / boundary notices.
 * `scanTruncated` (a scan cap bound before the range was exhausted) drives both
 * `total_is_exact` and the dataframe `truncated` flag.
 */
async function finishArchiveResult(
  ctx: Context,
  args: {
    matched: SearchRow[];
    sort: 'filing_date_desc' | 'filing_date_asc' | 'relevance';
    limit: number;
    offset: number;
    scanTruncated: boolean;
    queryParams: Record<string, unknown>;
    effectiveQuery: string;
    coverageNote: string;
    zeroHitCriteria: string;
  },
): Promise<SearchFilingsResult> {
  // Full-index and submissions have no relevance score, so relevance collapses
  // to date-descending; only an explicit ascending request reorders.
  const sorted = [...args.matched].sort((a, b) =>
    args.sort === 'filing_date_asc'
      ? a.filing_date.localeCompare(b.filing_date)
      : b.filing_date.localeCompare(a.filing_date),
  );

  const total = sorted.length;
  const totalIsExact = !args.scanTruncated;
  const sliced = sorted.slice(args.offset, args.offset + args.limit);
  const results = sliced.map(toInlineResult);

  const formDistribution = buildFormDistribution(sorted.map((row) => row.form));

  let dataset:
    | { name: string; row_count: number; expires_at: string; truncated: boolean }
    | undefined;
  const bridge = getCanvasBridge();
  if (bridge && sorted.length > args.limit) {
    const registered = await bridge.registerDataframe(ctx, {
      rows: sorted,
      sourceTool: 'secedgar_search_filings',
      queryParams: args.queryParams,
      truncated: args.scanTruncated,
    });
    if (registered) dataset = { ...toDatasetField(registered), truncated: args.scanTruncated };
  }

  ctx.enrich.echo(args.effectiveQuery);
  if (total === 0) {
    ctx.enrich.notice(`No filings matched ${args.zeroHitCriteria}. ${args.coverageNote}`);
  } else if (results.length === 0 && args.offset >= sorted.length) {
    ctx.enrich.notice(
      `Offset (${args.offset}) exceeds the ${sorted.length} matched filings. ${total} filings matched — lower the offset or query the full set via secedgar_dataframe_query.`,
    );
  } else if (total > results.length) {
    ctx.enrich.truncated({
      shown: results.length,
      cap: args.limit,
      guidance: args.scanTruncated
        ? `${args.coverageNote} The scan hit its cap before exhausting the range — older filings may exist beyond the scanned window. Narrow the range, or query the dataframe.`
        : `${args.coverageNote} Query the full matched set via secedgar_dataframe_query, or page with offset.`,
    });
  }

  return {
    total,
    total_is_exact: totalIsExact,
    results,
    form_distribution: formDistribution,
    dataset,
  };
}

/**
 * Pre-2001 entity-scoped arm: resolve the CIK's full submissions history (the
 * `recent` window plus the `filings.files[]` archive pages reused from #78) and
 * filter by form + date. Reuses `getSubmissions`/`selectArchivePages`/
 * `fetchArchivePage` as-is. Rows are tagged `source: 'submissions'`; the
 * EFTS-only fields (period_ending, ticker, file_description, sic, location) are
 * left null for a uniform archive-row shape.
 */
async function serveSubmissionsArchive(
  ctx: Context,
  args: {
    entityCik: string;
    forms: string[] | undefined;
    startDate: string;
    endDate: string;
    sort: 'filing_date_desc' | 'filing_date_asc' | 'relevance';
    limit: number;
    offset: number;
  },
): Promise<SearchFilingsResult> {
  const api = getEdgarApiService();
  const submissions = await api.getSubmissions(args.entityCik);
  const companyName = submissions.name;
  const forms = args.forms?.length ? args.forms : undefined;

  const rows: SearchRow[] = [];
  const pushBlock = (block: FilingsRecent) => {
    for (let i = 0; i < block.accessionNumber.length; i++) {
      const form = block.form[i] ?? '';
      const filingDate = block.filingDate[i] ?? '';
      if (filingDate < args.startDate || filingDate > args.endDate) continue;
      if (forms && !formMatches(form, forms)) continue;
      rows.push({
        accession_number: block.accessionNumber[i] ?? '',
        form: form || null,
        filing_date: filingDate,
        period_ending: null,
        company_name: companyName,
        cik: args.entityCik,
        ticker: null,
        file_description: null,
        sic: null,
        location: null,
        source: 'submissions',
      });
    }
  };

  pushBlock(submissions.filings.recent);

  // Older filings live in the archive pages covering the requested pre-2001 range.
  const pages = selectArchivePages(submissions.filings.files, args.startDate, args.endDate);
  const pageLimit = Math.min(pages.length, ARCHIVE_PAGE_SCAN_CAP);
  const scanTruncated = pages.length > pageLimit;
  for (let i = 0; i < pageLimit; i++) {
    const page = pages[i];
    if (!page) break;
    pushBlock(await api.fetchArchivePage(page.name));
  }

  const formsNote = forms ? `, forms ${forms.join(', ')}` : '';
  return finishArchiveResult(ctx, {
    matched: rows,
    sort: args.sort,
    limit: args.limit,
    offset: args.offset,
    scanTruncated,
    queryParams: {
      entity_cik: args.entityCik,
      forms: args.forms,
      start_date: args.startDate,
      end_date: args.endDate,
      source: 'submissions',
    },
    effectiveQuery: `(pre-2001 archive: CIK ${args.entityCik}${formsNote}, ${args.startDate} to ${args.endDate})`,
    coverageNote:
      'Served from the entity submissions history — full-text search covers 2001-present only.',
    zeroHitCriteria: `CIK ${args.entityCik}${forms ? `, forms [${forms.join(', ')}]` : ''}, dates ${args.startDate} to ${args.endDate}`,
  });
}

/**
 * Pre-2001 unscoped browse arm: fetch the quarterly full-index (`master.idx`)
 * files spanning the range and filter by form + date client-side (the index is
 * not form-filterable server-side). Bounded by FULL_INDEX_QUARTER_SCAN_CAP —
 * the heaviest arm. Rows are tagged `source: 'full-index'`.
 */
async function serveFullIndexBrowse(
  ctx: Context,
  args: {
    forms: string[];
    startDate: string;
    endDate: string;
    sort: 'filing_date_desc' | 'filing_date_asc' | 'relevance';
    limit: number;
    offset: number;
  },
): Promise<SearchFilingsResult> {
  const api = getEdgarApiService();
  const quarters = quartersInRange(args.startDate, args.endDate);
  const quarterLimit = Math.min(quarters.length, FULL_INDEX_QUARTER_SCAN_CAP);
  const scanTruncated = quarters.length > quarterLimit;

  const rows: SearchRow[] = [];
  for (let i = 0; i < quarterLimit; i++) {
    const quarter = quarters[i];
    if (!quarter) break;
    const entries = await api.fetchFullIndexQuarter(quarter.year, quarter.quarter);
    for (const entry of entries) {
      if (entry.filingDate < args.startDate || entry.filingDate > args.endDate) continue;
      if (!formMatches(entry.form, args.forms)) continue;
      rows.push({
        accession_number: entry.accessionNumber,
        form: entry.form || null,
        filing_date: entry.filingDate,
        period_ending: null,
        company_name: entry.companyName,
        cik: entry.cik,
        ticker: null,
        file_description: null,
        sic: null,
        location: null,
        source: 'full-index',
      });
    }
  }

  return finishArchiveResult(ctx, {
    matched: rows,
    sort: args.sort,
    limit: args.limit,
    offset: args.offset,
    scanTruncated,
    queryParams: {
      forms: args.forms,
      start_date: args.startDate,
      end_date: args.endDate,
      source: 'full-index',
    },
    effectiveQuery: `(pre-2001 full-index browse: forms ${args.forms.join(', ')}, ${args.startDate} to ${args.endDate})`,
    coverageNote:
      'Served from the quarterly EDGAR full-index — full-text search covers 2001-present only.',
    zeroHitCriteria: `forms [${args.forms.join(', ')}], dates ${args.startDate} to ${args.endDate}`,
  });
}

export const searchFilingsTool = tool('secedgar_search_filings', {
  description:
    'Search EDGAR filings since 1993. Full-text search covers 2001-present (the EFTS index floor); pre-2001 date ranges (to 1993) are served from the archives by form and entity/date — pre-2001 full-text matching requires entity scope (ticker:/cik:). Supports exact phrases, boolean operators, wildcards, and entity targeting (ticker:AAPL or cik:320193 in query).',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  // Agent-facing context for the success path — the query as EDGAR executed it and
  // an optional notice for empty results. Populated via ctx.enrich so it reaches
  // both structuredContent and content[]; kept out of the domain return.
  enrichment: {
    effectiveQuery: z
      .string()
      .describe(
        'The query as executed against EDGAR (ticker/cik: tokens resolved to entity names).',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no results were returned — echoes the query and suggests how to broaden.',
      ),
    truncated: z.boolean().optional().describe('True when results were capped by limit.'),
    shown: z.number().optional().describe('Number of results shown inline.'),
    cap: z.number().optional().describe('The limit cap applied.'),
  },

  errors: [
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Only one of start_date or end_date was provided',
      recovery: 'Provide both start_date and end_date, or omit both to search all dates.',
    },
    {
      reason: 'unresolved_ticker',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A ticker: targeting token in the query does not resolve to a known company',
      recovery:
        'Verify the symbol with secedgar_company_search, or target by CIK with cik:<number> instead.',
    },
    {
      reason: 'invalid_cik',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A cik: targeting token in the query is not a 1-10 digit number',
      recovery:
        'Pass a numeric CIK such as cik:320193 — find it with secedgar_company_search if unknown.',
    },
    {
      reason: 'missing_criteria',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither a full-text query nor a forms filter was provided (a date range cannot stand alone)',
      recovery:
        'Provide search terms, or browse by form type (forms: ["S-1"]) or entity (ticker:AAPL / cik:320193 in the query) — optionally narrowed by date.',
    },
    {
      reason: 'straddling_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The date range crosses 2001-01-01, spanning both the EFTS full-text era and the pre-2001 archives',
      recovery:
        'Split at 2001-01-01: run one search for the ≥2001 side and another for the <2001 side, then combine the results.',
    },
    {
      reason: 'pre2001_full_text_unscoped',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A pre-2001 date range carries free-text terms with no entity scope — no pre-2001 full-text index exists',
      recovery:
        'Add ticker: or cik: entity scope to the query, or drop the text terms to browse pre-2001 filings by form and date.',
    },
    {
      reason: 'pre2001_full_text_scoped',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A pre-2001 date range carries free-text terms alongside entity scope — local document matching is not yet supported',
      recovery: "Drop the text terms to browse this entity's pre-2001 filings by form and date.",
    },
  ],

  input: z.object({
    query: z
      .union([
        z.literal(''),
        z
          .string()
          .trim()
          .min(1, 'Query cannot be blank')
          .describe(
            'Full-text search query. Supports: exact phrases ("material weakness"), boolean operators (revenue OR income), exclusion (-preliminary), wildcard suffix (account*), entity targeting (ticker:AAPL or cik:320193 in the query). Terms are AND\'d by default.',
          ),
      ])
      .optional()
      .describe(
        'Full-text search query. Optional — omit (or pass "") to browse by form type and/or entity instead, e.g. every S-1 in a date window, or a company\'s filings via ticker:/cik:. A date range alone is not a valid search; pair it with forms or entity targeting. Full-text terms match only filings from 2001 onward (the EFTS index floor); for a pre-2001 date range, drop the text terms (browse by form/date) or add ticker:/cik: entity scope. When present, supports exact phrases ("material weakness"), boolean operators (revenue OR income), exclusion (-preliminary), wildcard suffix (account*), and entity targeting (ticker:AAPL or cik:320193 in the query); terms are AND\'d by default.',
      ),
    forms: z
      .array(z.string())
      .optional()
      .describe(
        'Filter to specific form types (e.g., ["10-K", "10-Q", "8-K"]). Without this, searches all form types. Note: "10-K" also matches amendments filed as 10-K/A. Ownership forms (3, 4, 5) are indexed by the reporting person (e.g., "LEVINSON ARTHUR D"), not the issuer — rows carry no transaction code, share count, or price. Use secedgar_get_insider_transactions to retrieve parsed ownership XML with person, relationship, transaction code, shares, and price.',
      ),
    start_date: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
          .describe('YYYY-MM-DD'),
      ])
      .optional()
      .describe(
        'Start of date range (YYYY-MM-DD). Both start_date and end_date must be provided for date filtering.',
      ),
    end_date: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
          .describe('YYYY-MM-DD'),
      ])
      .optional()
      .describe(
        'End of date range (YYYY-MM-DD). Both start_date and end_date must be provided for date filtering.',
      ),
    limit: z.number().int().min(1).max(100).default(20).describe('Results per page. Max 100.'),
    offset: z
      .number()
      .int()
      .min(0)
      .max(9999)
      .default(0)
      .describe(
        'Pagination offset. For sort=relevance, EDGAR pages server-side up to its 10,000-result cap. For date sorts (the default) and entity targeting, the tool fetches a single 100-row window and slices it client-side — offsets at or past the window return nothing; switch to sort=relevance for deep pagination, or narrow the search (forms, dates, entity targeting).',
      ),
    sort: z
      .enum(['filing_date_desc', 'filing_date_asc', 'relevance'])
      .default('filing_date_desc')
      .describe(
        'Result ordering. "filing_date_desc" (default) returns most recent first. "filing_date_asc" returns oldest first. "relevance" returns SEC\'s native search-score order, which weights term match strength over recency. Date sorts re-order the top 100 hits returned by the search index — for broad queries with more than 100 matches and no entity targeting, date-newest filings may sit outside that window. Entity targeting (ticker:/cik:) or a narrower query keeps matches inside the window when absolute recency matters. On the no-query browse path (forms/entity only), EFTS has no relevance signal — every hit scores null — and returns filings in natural date-descending order, so all sort modes effectively yield newest-first. Pre-2001 archive results carry no relevance score either, so relevance collapses to date-descending there.',
      ),
  }),

  output: z.object({
    total: z
      .number()
      .describe(
        "Total matching filings. On the full-text (2001+) path this is capped at 10,000; entity targeting (ticker:/cik:) scopes server-side via the EFTS ciks param, so it is the entity's exact match count up to the cap. On a pre-2001 archive path it is the exact count within the scanned window (see total_is_exact).",
      ),
    total_is_exact: z
      .boolean()
      .describe(
        'False when total is a lower bound — the full-text path hit its 10,000 cap, or a pre-2001 archive scan hit its page/quarter cap before exhausting the range.',
      ),
    results: z
      .array(
        z
          .object({
            accession_number: z
              .string()
              .describe(
                'Filing accession number. Pass to secedgar_get_filing to retrieve the document text.',
              ),
            form: z
              .string()
              .optional()
              .describe(
                'Form type (e.g. "10-K"). Absent for hits where the index lacks a form tag.',
              ),
            filing_date: z.string().describe('Date the filing was submitted (YYYY-MM-DD).'),
            period_ending: z
              .string()
              .optional()
              .describe(
                'Period the filing reports on (YYYY-MM-DD). Absent for filings without a reporting period (e.g., proxy statements, ownership reports) and for all pre-2001 archive-sourced rows (source submissions/full-index), which carry no period field.',
              ),
            company_name: z
              .string()
              .describe('Filing entity, with ticker/CIK parentheticals stripped.'),
            cik: z.string().describe('Filing entity CIK, zero-padded to 10 digits.'),
            ticker: z
              .string()
              .optional()
              .describe(
                'Primary ticker symbol parsed from the EFTS display name. Absent for private filers, foreign filers without a US listing, filings whose display name omits the ticker parenthetical, and all pre-2001 archive-sourced rows. For multi-class issuers (e.g., BRK-A / BRK-B), this is the first class listed.',
              ),
            file_description: z
              .string()
              .optional()
              .describe(
                'SEC-provided description of the matching document (e.g., "EX-99.1"). Absent when SEC published none, and for pre-2001 archive-sourced rows.',
              ),
            sic: z
              .string()
              .optional()
              .describe(
                'SIC industry code for the filer. Absent for filers without a classification, and for pre-2001 archive-sourced rows.',
              ),
            location: z
              .string()
              .optional()
              .describe(
                'Business location (state or country code). Absent when SEC has no location for this filer, and for pre-2001 archive-sourced rows.',
              ),
            source: z
              .enum(['efts', 'submissions', 'full-index'])
              .optional()
              .describe(
                'Which EDGAR backend served this row: "efts" (2001+ full-text index), "submissions" (a pre-2001 entity-scoped filing history), or "full-index" (a pre-2001 unscoped quarterly index browse). Provenance is carried into the canvas dataframe as a `source` column.',
              ),
          })
          .describe('One matching filing hit.'),
      )
      .describe('Matching filings.'),
    form_distribution: z
      .record(z.string(), z.number())
      .optional()
      .describe('Count of results by form type. Helps narrow follow-up searches.'),
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
            'True when more matches exist beyond the materialized set — the full-text window was exceeded, or a pre-2001 archive scan hit its cap. Each row carries a `source` column so provenance survives into secedgar_dataframe_query.',
          ),
      })
      .optional()
      .describe(
        'Canvas dataframe holding the fetched hits (full-text window, or the full pre-2001 archive match set), each tagged with its `source`. Absent when total ≤ inline limit, canvas is unavailable, or materialization failed. Query with secedgar_dataframe_query SQL.',
      ),
  }),

  async handler(input, ctx): Promise<SearchFilingsResult> {
    // Validate date range: both or neither
    if ((input.start_date && !input.end_date) || (!input.start_date && input.end_date)) {
      throw ctx.fail(
        'invalid_date_range',
        'Both start_date and end_date are required when filtering by date.',
        { ...ctx.recoveryFor('invalid_date_range') },
      );
    }

    // Browse mode (#79): EFTS accepts a forms-only or entity-scoped request with no
    // full-text term, but rejects one with neither ("Blank search not valid"). Guard
    // the both-absent shape here — checked against the RAW query/forms (before the
    // entity token is stripped), so a bare cik:/ticker: query still passes (it has raw
    // content even though it strips to blank). A date range does not stand alone.
    if (!input.query?.trim() && !input.forms?.length) {
      throw ctx.fail(
        'missing_criteria',
        'A full-text query or a forms filter is required — a date range alone is not a valid search.',
        { ...ctx.recoveryFor('missing_criteria') },
      );
    }

    // Resolve ticker:/cik: entity targeting → stripped query + CIK for the
    // server-side ciks param. Throws typed validation errors on bad tokens (#61).
    // Default to '' so a browse request (undefined query) resolves cleanly.
    const { query, entityCik } = await resolveEntityTargeting(input.query ?? '', ctx);

    const api = getEdgarApiService();

    // Date-based routing at the EFTS full-text floor (2001-01-01). EFTS only
    // indexes filings from 2001; a range entirely before it is served from the
    // archives, a range crossing it is rejected with a split instruction (#77).
    const startDate = input.start_date || undefined;
    const endDate = input.end_date || undefined;
    if (startDate && endDate && endDate < EFTS_FULLTEXT_FLOOR) {
      const hasFreeText = query.trim().length > 0;
      if (hasFreeText) {
        // No pre-2001 full-text index exists. Reject honestly rather than silently
        // dropping the text terms; bounded local matching is a deferred follow-up.
        if (entityCik) {
          throw ctx.fail(
            'pre2001_full_text_scoped',
            "Full-text matching of pre-2001 filings is not yet supported. Drop the text terms to browse this entity's pre-2001 filings by form and date.",
            { ...ctx.recoveryFor('pre2001_full_text_scoped') },
          );
        }
        throw ctx.fail(
          'pre2001_full_text_unscoped',
          'Full-text search is unavailable before 2001 (the EFTS index starts at 2001-01-01). For pre-2001 filings, add ticker:/cik: entity scope, or drop the text terms to browse by form and date.',
          { ...ctx.recoveryFor('pre2001_full_text_unscoped') },
        );
      }
      if (entityCik) {
        return await serveSubmissionsArchive(ctx, {
          entityCik,
          forms: input.forms,
          startDate,
          endDate,
          sort: input.sort,
          limit: input.limit,
          offset: input.offset,
        });
      }
      // Unscoped + no free text → forms are guaranteed present by the missing_criteria guard.
      return await serveFullIndexBrowse(ctx, {
        forms: input.forms ?? [],
        startDate,
        endDate,
        sort: input.sort,
        limit: input.limit,
        offset: input.offset,
      });
    }
    if (startDate && endDate && startDate < EFTS_FULLTEXT_FLOOR) {
      // endDate ≥ 2001 (handled above) but startDate < 2001 → straddling. Reject
      // with a split instruction; merged straddling output is a deferred follow-up.
      throw ctx.fail(
        'straddling_date_range',
        `The date range ${startDate}..${endDate} crosses 2001-01-01. Full-text search covers 2001-present; pre-2001 filings are served from the archives. Search the two eras separately: ${EFTS_FULLTEXT_FLOOR} onward, and before ${EFTS_FULLTEXT_FLOOR}.`,
        { ...ctx.recoveryFor('straddling_date_range') },
      );
    }

    // EFTS scores by relevance and exposes no sort param. When the caller wants
    // a date sort (the default) or entity filtering, we over-fetch the EFTS
    // window and reorder/slice client-side. Pure relevance mode keeps the
    // existing pass-through behavior so callers paying for relevance get it.
    const wideFetch = entityCik !== undefined || input.sort !== 'relevance';
    const fetchFrom = wideFetch ? 0 : input.offset;
    const fetchSize = wideFetch ? 100 : input.limit;

    const response = await api.searchFilings({
      query,
      forms: input.forms,
      ciks: entityCik ? [entityCik] : undefined,
      startDate: input.start_date,
      endDate: input.end_date,
      from: fetchFrom,
      size: fetchSize,
    });

    // EFTS scopes by the server-side `ciks` param (set above when entity
    // targeting was used), so total/total_is_exact come straight from the
    // response: no client-side CIK post-filter, and the count is the entity's
    // true match total (up to the 10k cap), not a sampled-window lower bound.
    const total = response.hits.total.value;
    const totalIsExact = response.hits.total.relation === 'eq';

    let hits = response.hits.hits;

    if (input.sort === 'filing_date_desc') {
      hits = [...hits].sort((a, b) => b._source.file_date.localeCompare(a._source.file_date));
    } else if (input.sort === 'filing_date_asc') {
      hits = [...hits].sort((a, b) => a._source.file_date.localeCompare(b._source.file_date));
    }

    const startIdx = wideFetch ? input.offset : 0;
    const sliced = hits.slice(startIdx, startIdx + input.limit);

    const results = sliced.map((hit) => {
      const accessionNumber = hit._source.adsh || hit._id.split(':')[0] || hit._id;
      const displayName = hit._source.display_names?.[0] || '';
      const ticker = extractTicker(displayName);

      return {
        accession_number: accessionNumber,
        form: hit._source.form ?? undefined,
        filing_date: hit._source.file_date,
        period_ending: hit._source.period_ending ?? undefined,
        company_name: cleanCompanyName(displayName),
        cik: hit._source.ciks?.[0] || '',
        ...(ticker !== null && { ticker }),
        file_description: hit._source.file_description ?? undefined,
        sic: hit._source.sics?.[0] ?? undefined,
        location: hit._source.biz_locations?.[0] ?? undefined,
        source: 'efts' as const,
      };
    });

    // Form distribution must reflect the same set as `total`.
    // When entity targeting or a forms filter is applied, the EFTS aggregation
    // reflects the pre-filter sample and would disagree with `total`. In either
    // case, recompute from the post-filter `hits` to keep the counts consistent.
    let formDistribution: Record<string, number> | undefined;
    if (entityCik || input.forms?.length) {
      formDistribution = buildFormDistribution(hits.map((hit) => hit._source.form));
    } else if (response.aggregations?.form_filter?.buckets) {
      formDistribution = {};
      for (const bucket of response.aggregations.form_filter.buckets) {
        formDistribution[bucket.key] = bucket.doc_count;
      }
    }

    let dataset:
      | { name: string; row_count: number; expires_at: string; truncated: boolean }
      | undefined;
    const bridge = getCanvasBridge();
    const eftsTotal = response.hits.total.value;
    // Materialize the hits we already fetched — no additional EFTS calls.
    // `hits` is already entity-filtered (and sorted, where applicable) above.
    // Skip when the response fits inline or when there's no canvas.
    if (bridge && hits.length > input.limit) {
      // Truncated when EFTS reported more text matches than the window we
      // fetched. Under entity targeting, additional entity hits may exist
      // beyond the window we sampled; under no targeting, more text matches
      // exist past the window. Either way, the dataframe is a sample.
      const truncated = eftsTotal > response.hits.hits.length;
      const registered = await bridge.registerDataframe(ctx, {
        rows: hits.map(eftsHitToRow),
        sourceTool: 'secedgar_search_filings',
        queryParams: {
          query,
          forms: input.forms,
          start_date: input.start_date,
          end_date: input.end_date,
          entity_cik: entityCik,
          source: 'efts',
        },
        truncated,
      });
      if (registered) dataset = { ...toDatasetField(registered), truncated };
    }

    ctx.log.info('Filing search completed', {
      query: input.query,
      total,
      resultCount: results.length,
      datasetName: dataset?.name,
    });

    const effectiveQuery = entityCik
      ? `${query ? `${query} ` : ''}(entity scope: CIK ${entityCik})`
      : query || (input.forms?.length ? `(browse: forms ${input.forms.join(', ')})` : '');
    ctx.enrich.echo(effectiveQuery);
    if (total === 0) {
      // Genuine no-match — EFTS returned zero hits. Echo all active criteria; on the
      // browse path (no query text) lead with the form/entity criteria instead of an
      // empty quoted query.
      const criteria: string[] = [];
      if (query) criteria.push(`"${query}"`);
      if (entityCik) criteria.push(`entity CIK ${entityCik}`);
      if (input.forms?.length) criteria.push(`forms [${input.forms.join(', ')}]`);
      if (input.start_date && input.end_date) {
        criteria.push(`dates ${input.start_date} to ${input.end_date}`);
      }
      const criteriaText = criteria.length > 0 ? criteria.join(', ') : 'the given criteria';
      ctx.enrich.notice(
        `No filings matched ${criteriaText}. Broaden the query, remove the form filter, or widen the date range.`,
      );
    } else if (results.length === 0 && wideFetch && input.offset >= hits.length) {
      // The offset exceeded the client-side window (wideFetch fetches 100 rows max).
      // There are results — the caller just paged past the available window. The
      // materialized dataframe holds the same window, so SQL paging reaches no further.
      // Entity targeting forces wideFetch regardless of sort (see `wideFetch` above),
      // so switching to sort=relevance does NOT unlock deeper EDGAR-side pagination on
      // that path — only the non-entity path pages server-side via relevance.
      const deeperPaging = entityCik
        ? 'narrow the search with forms or dates, or query the full window via secedgar_dataframe_query'
        : 'switch to sort=relevance for EDGAR-side pagination up to 10,000 results, or narrow the search with forms, dates, or entity targeting';
      ctx.enrich.notice(
        `Offset (${input.offset}) exceeds the fetched window (${hits.length} rows — date sorts and entity targeting fetch a single window). ${total} filings matched: ${deeperPaging}.`,
      );
    } else if (total > results.length) {
      ctx.enrich.truncated({ shown: results.length, cap: input.limit });
    }

    return {
      total,
      total_is_exact: totalIsExact,
      results,
      form_distribution: formDistribution,
      dataset,
    };
  },

  format: (result) => {
    const source = result.results[0]?.source;
    const exactness = result.total_is_exact
      ? 'exact'
      : source === 'submissions' || source === 'full-index'
        ? 'partial — scan cap reached, more may exist'
        : 'capped at 10,000';
    const lines = [`Found ${result.total} filings (${exactness})`];
    for (const r of result.results) {
      const period = r.period_ending ? ` (period: ${r.period_ending})` : '';
      const desc = r.file_description ? ` — ${r.file_description}` : '';
      const sic = r.sic ? ` | SIC ${r.sic}` : '';
      const loc = r.location ? ` | ${r.location}` : '';
      const src = r.source ? ` | source: ${r.source}` : '';
      const ident = r.ticker ? `${r.ticker}, CIK ${r.cik}` : `CIK ${r.cik}`;
      lines.push(
        `- ${r.form ?? 'N/A'} ${r.filing_date}${period} — ${r.company_name} (${ident})${sic}${loc}${desc}${src} [${r.accession_number}]`,
      );
    }
    if (result.form_distribution) {
      const dist = Object.entries(result.form_distribution)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      lines.push(`\nForm distribution: ${dist}`);
    }
    if (result.dataset) {
      const truncatedNote = result.dataset.truncated
        ? ' (truncated — more matches exist beyond the materialized set)'
        : '';
      lines.push(
        `\nDataset: ${result.dataset.name} (${result.dataset.row_count} rows, expires ${result.dataset.expires_at})${truncatedNote} — query with secedgar_dataframe_query.`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
