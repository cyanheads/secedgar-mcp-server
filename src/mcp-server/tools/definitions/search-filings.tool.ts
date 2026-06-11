/**
 * @fileoverview Full-text search across all EDGAR filing documents since 1993.
 * @module mcp-server/tools/definitions/search-filings
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import type { EftsHit } from '@/services/edgar/types.js';

function eftsHitToRow(hit: EftsHit) {
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
  };
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
 */
async function resolveEntityTargeting(
  query: string,
): Promise<{ query: string; entityCik?: string }> {
  const tickerMatch = query.match(/\bticker:(\S+)/i);
  if (tickerMatch?.[1]) {
    const resolved = await getEdgarApiService().resolveCik(tickerMatch[1]);
    const match = Array.isArray(resolved) ? resolved[0] : resolved;
    const cleaned = stripToken(query, tickerMatch[0]);
    return match?.cik ? { query: cleaned, entityCik: match.cik } : { query: cleaned };
  }

  const cikMatch = query.match(/\bcik:(\S+)/i);
  if (cikMatch?.[1]) {
    return { query: stripToken(query, cikMatch[0]), entityCik: cikMatch[1].padStart(10, '0') };
  }

  return { query };
}

export const searchFilingsTool = tool('secedgar_search_filings', {
  description:
    'Search the full-text index of EDGAR filings since 1993. Supports exact phrases, boolean operators, wildcards, and entity targeting (ticker:AAPL or cik:320193 in query).',
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
  ],

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Full-text search query. Supports: exact phrases ("material weakness"), boolean operators (revenue OR income), exclusion (-preliminary), wildcard suffix (account*), entity targeting (ticker:AAPL or cik:320193 in the query). Terms are AND\'d by default.',
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
        'Pagination offset. Increment by limit for the next page. EDGAR caps total accessible results at 10,000 — offsets past this return nothing. Under date sort, pagination is bounded to the first 100 hits.',
      ),
    sort: z
      .enum(['filing_date_desc', 'filing_date_asc', 'relevance'])
      .default('filing_date_desc')
      .describe(
        'Result ordering. "filing_date_desc" (default) returns most recent first. "filing_date_asc" returns oldest first. "relevance" returns SEC\'s native search-score order, which weights term match strength over recency. Date sorts re-order the top 100 hits returned by the search index — for broad queries with more than 100 matches and no entity targeting, date-newest filings may sit outside that window. Entity targeting (ticker:/cik:) or a narrower query keeps matches inside the window when absolute recency matters.',
      ),
  }),

  output: z.object({
    total: z
      .number()
      .describe(
        "Total matching filings (capped at 10,000). Entity targeting (ticker:/cik:) scopes server-side via the EFTS ciks param, so this is the entity's exact match count up to the cap.",
      ),
    total_is_exact: z.boolean().describe('False only when total hits the 10,000 cap.'),
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
                'Period the filing reports on (YYYY-MM-DD). Absent for filings without a reporting period (e.g., proxy statements, ownership reports).',
              ),
            company_name: z
              .string()
              .describe('Filing entity, with ticker/CIK parentheticals stripped.'),
            cik: z.string().describe('Filing entity CIK, zero-padded to 10 digits.'),
            ticker: z
              .string()
              .optional()
              .describe(
                'Primary ticker symbol parsed from the EFTS display name. Absent for private filers, foreign filers without a US listing, and filings whose display name omits the ticker parenthetical. For multi-class issuers (e.g., BRK-A / BRK-B), this is the first class listed.',
              ),
            file_description: z
              .string()
              .optional()
              .describe(
                'SEC-provided description of the matching document (e.g., "EX-99.1"). Absent when SEC published none.',
              ),
            sic: z
              .string()
              .optional()
              .describe(
                'SIC industry code for the filer. Absent for filers without a classification.',
              ),
            location: z
              .string()
              .optional()
              .describe(
                'Business location (state or country code). Absent when SEC has no location for this filer.',
              ),
          })
          .describe('One matching filing hit from the full-text search index.'),
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
            'True when EFTS reported more text matches than the window we already fetched — additional rows exist beyond the dataframe. Page further with `offset` for the inline view; the canvas dataframe is bounded by the single response window.',
          ),
      })
      .optional()
      .describe(
        'Canvas dataframe holding the hits already fetched for the inline response. Absent when total ≤ inline limit, canvas is unavailable, or materialization failed. The dataframe contains the raw EFTS results (entity-scoped server-side via the ciks param when ticker:/cik: was used) — query with secedgar_dataframe_query SQL.',
      ),
  }),

  async handler(input, ctx) {
    // Validate date range: both or neither
    if ((input.start_date && !input.end_date) || (!input.start_date && input.end_date)) {
      throw ctx.fail(
        'invalid_date_range',
        'Both start_date and end_date are required when filtering by date.',
        { ...ctx.recoveryFor('invalid_date_range') },
      );
    }

    // Resolve ticker:/cik: entity targeting → company name in query + CIK for filtering
    const { query, entityCik } = await resolveEntityTargeting(input.query);

    // EFTS scores by relevance and exposes no sort param. When the caller wants
    // a date sort (the default) or entity filtering, we over-fetch the EFTS
    // window and reorder/slice client-side. Pure relevance mode keeps the
    // existing pass-through behavior so callers paying for relevance get it.
    const wideFetch = entityCik !== undefined || input.sort !== 'relevance';
    const fetchFrom = wideFetch ? 0 : input.offset;
    const fetchSize = wideFetch ? 100 : input.limit;

    const api = getEdgarApiService();
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
      };
    });

    // Form distribution must reflect the same set as `total`.
    // When entity targeting or a forms filter is applied, the EFTS aggregation
    // reflects the pre-filter sample and would disagree with `total`. In either
    // case, recompute from the post-filter `hits` to keep the counts consistent.
    let formDistribution: Record<string, number> | undefined;
    if (entityCik || input.forms?.length) {
      const dist: Record<string, number> = {};
      for (const hit of hits) {
        const form = hit._source.form;
        if (form) dist[form] = (dist[form] ?? 0) + 1;
      }
      if (Object.keys(dist).length > 0) formDistribution = dist;
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
      : query;
    ctx.enrich.echo(effectiveQuery);
    if (results.length === 0) {
      ctx.enrich.notice(
        `No filings matched "${input.query}"${input.forms?.length ? ` with forms ${input.forms.join(', ')}` : ''}. Try broader terms, remove form filters, or check entity targeting syntax (ticker:AAPL).`,
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
    const exactness = result.total_is_exact ? 'exact' : 'capped at 10,000';
    const lines = [`Found ${result.total} filings (${exactness})`];
    for (const r of result.results) {
      const period = r.period_ending ? ` (period: ${r.period_ending})` : '';
      const desc = r.file_description ? ` — ${r.file_description}` : '';
      const sic = r.sic ? ` | SIC ${r.sic}` : '';
      const loc = r.location ? ` | ${r.location}` : '';
      const ident = r.ticker ? `${r.ticker}, CIK ${r.cik}` : `CIK ${r.cik}`;
      lines.push(
        `- ${r.form ?? 'N/A'} ${r.filing_date}${period} — ${r.company_name} (${ident})${sic}${loc}${desc} [${r.accession_number}]`,
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
        ? ' (truncated — more matches exist beyond the EFTS window)'
        : '';
      lines.push(
        `\nDataset: ${result.dataset.name} (${result.dataset.row_count} rows, expires ${result.dataset.expires_at})${truncatedNote} — query with secedgar_dataframe_query.`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
