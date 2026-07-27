/**
 * @fileoverview Rate-limited HTTP client for all SEC EDGAR API interactions.
 * Handles User-Agent compliance, rate limiting, retry with backoff, CIK resolution,
 * and ticker/entity caching.
 * @module services/edgar/edgar-api-service
 */

import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';
import { parseDocument } from 'htmlparser2';
import { getServerConfig } from '@/config/server-config.js';
import { getEdgarMirror } from '@/services/edgar/mirror/index.js';
import formerNamesData from './data/former-names.json' with { type: 'json' };
import { type FilingDocumentHeader, parseFilingHeaders } from './filing-headers.js';
import type {
  CikMatch,
  CompanyConceptResponse,
  CompanyFactsResponse,
  EftsEntityAutocompleteResponse,
  EftsResponse,
  FilingIndex,
  FilingsRecent,
  FramesResponse,
  FullIndexEntry,
  SubmissionsResponse,
  TickerEntry,
} from './types.js';
import { childText, findTag, findTags } from './xml-nodes.js';

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** URL for SEC's mutual-fund ticker file (ETFs and open-end funds). */
const MF_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_mf.json';

/** Trigram similarity threshold — minimum Dice score to include a candidate suggestion. */
const TRIGRAM_THRESHOLD = 0.3;
/** Maximum number of near-match suggestions to include. */
const TRIGRAM_TOP_N = 3;

/** Raw entry from SEC's company_tickers_mf.json (columnar with a `fields` array). */
interface MfTickerFile {
  data: Array<[number, string, string, string]>;
  fields: string[];
}

/** Indexed ticker data for O(1) lookups. */
interface TickerCache {
  allEntries: CikMatch[];
  byCik: Map<string, CikMatch>;
  /** Fund series ID → registrant. Built from company_tickers_mf.json, so it covers only series with a listed share class. */
  bySeriesId: Map<string, CikMatch>;
  byTicker: Map<string, CikMatch>;
  loadedAt: number;
}

/** A candidate suggestion from the trigram scan on no-result name search. */
export interface CompanySuggestion {
  cik: string;
  name?: string;
  ticker?: string;
}

/** A resolved candidate from EFTS entity-autocomplete (`resolveEntityByName`). */
export interface EntityNameMatch {
  cik: string;
  name: string;
}

/** One fund series of a registrant, as listed in company_tickers_mf.json. */
export interface FundSeriesEntry {
  seriesId: string;
  /** Ticker of the first listed share class of the series. */
  ticker: string | undefined;
}

/** A registrant's filings of one form type, scoped to a single fund series. */
export interface SeriesFilingFeed {
  filings: Array<{ accessionNumber: string; filingDate: string; form: string }>;
  /** Registrant trust the series belongs to. Absent when the series is unknown to EDGAR. */
  registrantCik: string | undefined;
  registrantName: string | undefined;
}

// ---------------------------------------------------------------------------
// Trigram (Dice-coefficient) similarity
// ---------------------------------------------------------------------------

/**
 * Build the set of trigrams for a string.
 * Pads with two spaces on each side so edge characters are covered.
 */
function trigramSet(s: string): Set<string> {
  const padded = `  ${s}  `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) {
    grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

/**
 * Dice-coefficient trigram similarity between two strings.
 * Returns a value in [0, 1]; 1 means identical.
 */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const ga = trigramSet(a);
  const gb = trigramSet(b);
  if (ga.size === 0 && gb.size === 0) return 1;
  if (ga.size === 0 || gb.size === 0) return 0;
  let intersection = 0;
  for (const g of ga) {
    if (gb.has(g)) intersection++;
  }
  return (2 * intersection) / (ga.size + gb.size);
}

/**
 * Run a trigram similarity scan over the in-memory entry set.
 * Only entries with a name are considered. Returns up to TRIGRAM_TOP_N
 * candidates whose Dice score meets TRIGRAM_THRESHOLD, sorted descending.
 */
export function suggestCompanies(query: string, allEntries: CikMatch[]): CompanySuggestion[] {
  const q = query.toLowerCase();
  const scored: Array<{ score: number; entry: CikMatch }> = [];

  for (const entry of allEntries) {
    if (!entry.name) continue;
    const score = trigramSimilarity(q, entry.name.toLowerCase());
    if (score >= TRIGRAM_THRESHOLD) {
      scored.push({ score, entry });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, TRIGRAM_TOP_N);

  // Dedup by CIK — keep the highest-scored entry per CIK.
  const seen = new Set<string>();
  const suggestions: CompanySuggestion[] = [];
  for (const { entry } of top) {
    if (!seen.has(entry.cik)) {
      seen.add(entry.cik);
      suggestions.push({
        cik: entry.cik,
        ...(entry.name !== undefined ? { name: entry.name } : {}),
        ...(entry.ticker !== undefined ? { ticker: entry.ticker } : {}),
      });
    }
  }
  return suggestions;
}

class EdgarApiService {
  private lastRequestAt = 0;
  private minIntervalMs: number;
  private tickerCache: TickerCache | undefined;
  private tickerCacheLoad: Promise<TickerCache> | undefined;
  private throttleQueue: Promise<void> = Promise.resolve();
  /** Per-CIK submissions doc cache, keyed by padded CIK (TTL = EDGAR_TICKER_CACHE_TTL). */
  private submissionsCache = new Map<string, { at: number; data: SubmissionsResponse }>();
  /** Per-page submissions archive cache, keyed by page name (TTL = EDGAR_TICKER_CACHE_TTL). */
  private archivePageCache = new Map<string, { at: number; data: FilingsRecent }>();
  /** Per-quarter full-index cache, keyed by `${year}Q${quarter}` (TTL = EDGAR_TICKER_CACHE_TTL). */
  private fullIndexCache = new Map<string, { at: number; data: FullIndexEntry[] }>();

  constructor() {
    const config = getServerConfig();
    this.minIntervalMs = Math.ceil(1000 / config.rateLimitRps);
  }

  /** Fetch and parse JSON, throwing on non-OK responses. */
  async fetchJson<T>(url: string): Promise<T> {
    const response = await this.rawFetch(url, true);
    if (response.status === 404) {
      throw notFound(`SEC EDGAR API returned 404 for ${url}`, { url, status: 404 });
    }
    return response.json() as Promise<T>;
  }

  /** Fetch JSON, returning `null` on 404 and throwing on other non-OK responses. */
  async tryFetchJson<T>(url: string): Promise<T | null> {
    const response = await this.rawFetch(url, true);
    return response.status === 404 ? null : (response.json() as Promise<T>);
  }

  /** Fetch raw text content (HTML filing documents). */
  async fetchText(url: string): Promise<string> {
    const response = await this.rawFetch(url, false);
    if (response.status === 404) {
      throw notFound(`SEC EDGAR returned 404 for ${url}`, { url, status: 404 });
    }
    return response.text();
  }

  /** Fetch raw text content, returning `null` on 404 and throwing on other failures. */
  async tryFetchText(url: string): Promise<string | null> {
    const response = await this.rawFetch(url, false);
    return response.status === 404 ? null : response.text();
  }

  // --- CIK Resolution ---

  /**
   * Resolve a query (ticker, name, or CIK) to company match(es).
   * - Numeric input → direct CIK lookup
   * - 1-5 uppercase letters → ticker lookup (O(1))
   * - Otherwise → name search (prefix, then substring, then trigram suggestions)
   * Returns a single match, an array of multiple matches, or an empty array (no match).
   * On no-result name search, the returned empty array carries `suggestions` on
   * the thrown error at the handler layer — call `suggestCompanies` there.
   */
  async resolveCik(query: string): Promise<CikMatch | CikMatch[]> {
    const cache = await this.getTickerCache();
    const trimmed = query.trim();

    // Numeric → CIK
    if (/^\d+$/.test(trimmed)) {
      const padded = trimmed.padStart(10, '0');
      const match = cache.byCik.get(padded);
      if (match) return match;
      // CIK may be valid even if absent from the tickers file (e.g. individual filers) —
      // return a CIK-only match and let the caller resolve identity from submissions.
      return { cik: padded };
    }

    // Short alphabetic → ticker (includes ETF/MF tickers from company_tickers_mf.json)
    const upper = trimmed.toUpperCase();
    if (/^[A-Z]{1,5}$/.test(upper)) {
      const match = cache.byTicker.get(upper);
      if (match) return match;
    }

    // Name search: exact → prefix → substring (current names + former names)
    const lower = trimmed.toLowerCase();
    const exact: CikMatch[] = [];
    const prefix: CikMatch[] = [];
    const substring: CikMatch[] = [];

    for (const entry of cache.allEntries) {
      if (!entry.name) continue;
      const name = entry.name.toLowerCase();
      if (name === lower) {
        exact.push(entry);
      } else if (name.startsWith(lower)) {
        prefix.push(entry);
      } else if (name.includes(lower)) {
        substring.push(entry);
      }
    }

    const combined = [...exact, ...prefix, ...substring];

    // Dedup by CIK (current + former names may match the same registrant).
    const seen = new Set<string>();
    const deduped: CikMatch[] = [];
    for (const entry of combined) {
      if (!seen.has(entry.cik)) {
        seen.add(entry.cik);
        deduped.push(entry);
      }
    }

    const results = deduped.slice(0, 5);
    if (results.length > 0) {
      return results.length === 1 ? (results[0] as CikMatch) : results;
    }

    // Also try as ticker if nothing matched (handles >5-char and digit-containing symbols
    // that bypassed the early ticker gate above)
    const tickerMatch = cache.byTicker.get(upper);
    return tickerMatch ?? [];
  }

  /**
   * Resolve an entity name to CIK candidates via EFTS entity-autocomplete
   * (`search-index?keysTyped=`). Covers any EDGAR filer — institutional managers,
   * trusts, individuals — that `company_tickers.json` (ticker-backed registrants only)
   * can never contain, so it's the name-resolution fallback for a ticker-cache miss.
   * Returns candidates in SEC relevance order, deduped by CIK. Two entities can share
   * a legal name under different CIKs (e.g. "VANGUARD GROUP INC" = a transfer agent and
   * the 13F filer), so callers must disambiguate rather than auto-pick the top hit (#73).
   * Distinct from `searchFilings`: same URL path, different query param (`keysTyped`)
   * and response shape (`_source.entity`, not the filing-document `_source`).
   */
  async resolveEntityByName(name: string): Promise<EntityNameMatch[]> {
    const url = new URL('https://efts.sec.gov/LATEST/search-index');
    url.searchParams.set('keysTyped', name);
    const response = await this.fetchJson<EftsEntityAutocompleteResponse>(url.toString());

    const hits = response?.hits?.hits;
    if (!Array.isArray(hits)) return [];

    const seen = new Set<string>();
    const matches: EntityNameMatch[] = [];
    for (const hit of hits) {
      const cik = hit._id?.padStart(10, '0');
      const entity = hit._source?.entity;
      if (!cik || !entity || seen.has(cik)) continue;
      seen.add(cik);
      matches.push({ cik, name: entity });
    }
    return matches;
  }

  /** Reverse lookup: CIK → ticker symbol. */
  async cikToTicker(cik: string): Promise<string | undefined> {
    const cache = await this.getTickerCache();
    return cache.byCik.get(cik.padStart(10, '0'))?.ticker;
  }

  /**
   * Resolve a fund series ID (`S000002839`) to its registrant trust. Backed by
   * company_tickers_mf.json, which lists a series only once one of its share classes has a
   * ticker — a series with no listed class resolves to `undefined` rather than a wrong trust.
   */
  async resolveFundSeries(seriesId: string): Promise<CikMatch | undefined> {
    const cache = await this.getTickerCache();
    return cache.bySeriesId.get(seriesId.toUpperCase());
  }

  /**
   * List a registrant's fund series, from the same company_tickers_mf.json index. A trust
   * files one NPORT-P per series per period, so this is what tells a caller holding only a
   * registrant CIK which series it must name. Covers series with at least one listed share
   * class only — a trust whose series carry no ticker returns an empty list, which is not
   * the same as having no series.
   */
  async listFundSeries(cik: string): Promise<FundSeriesEntry[]> {
    const cache = await this.getTickerCache();
    const padded = cik.padStart(10, '0');
    const out: FundSeriesEntry[] = [];
    for (const [seriesId, match] of cache.bySeriesId) {
      if (match.cik === padded) out.push({ seriesId, ticker: match.ticker });
    }
    return out;
  }

  /**
   * List a fund series' own filings of one form type. EDGAR's company browse accepts a
   * series ID (`S000002839`) in place of a CIK and answers with just that series' filings,
   * which is the only SEC surface that maps a series to its accession numbers — the
   * submissions feed and the full-text index both report a fund filing under the registrant
   * trust with no series field, and a trust files one report per series per period. The
   * response also names the registrant, so a bare series ID resolves without a second call.
   * Entries come back newest-filed first and include amendments of the form.
   */
  async getFundSeriesFilings(
    seriesId: string,
    formType: string,
    count: number,
  ): Promise<SeriesFilingFeed> {
    const url = new URL('https://www.sec.gov/cgi-bin/browse-edgar');
    url.searchParams.set('action', 'getcompany');
    url.searchParams.set('CIK', seriesId);
    url.searchParams.set('type', formType);
    url.searchParams.set('owner', 'include');
    url.searchParams.set('count', String(count));
    url.searchParams.set('output', 'atom');
    return parseSeriesFilingFeed(await this.fetchText(url.toString()));
  }

  /** Return the current in-memory entry list (used by the handler for trigram suggestions). */
  async getAllEntries(): Promise<CikMatch[]> {
    const cache = await this.getTickerCache();
    return cache.allEntries;
  }

  // --- SEC API Methods ---

  /**
   * Fetch a filer's submissions document (entity metadata + the ~1000-filing
   * `recent` window + the `files[]` archive-page manifest). Cached per CIK within
   * the ticker-cache TTL — the doc is large and re-read on every archive-paging
   * scan (#78). A 404 throws (uncached) so a bad CIK still surfaces.
   */
  async getSubmissions(cik: string): Promise<SubmissionsResponse> {
    const padded = cik.padStart(10, '0');
    const cached = this.submissionsCache.get(padded);
    if (cached && this.isFresh(cached.at)) return cached.data;
    const data = await this.fetchJson<SubmissionsResponse>(
      `https://data.sec.gov/submissions/CIK${padded}.json`,
    );
    this.submissionsCache.set(padded, { at: Date.now(), data });
    return data;
  }

  /**
   * Fetch a submissions archive page (`filings.files[].name`, e.g.
   * `CIK0000320193-submissions-001.json`) — the older filings that don't fit the
   * ~1000-entry `recent` window. The page body is a flat parallel-array object
   * field-compatible with `FilingsRecent`. Cached per page within the ticker-cache
   * TTL (pages are large and effectively immutable once archived).
   */
  async fetchArchivePage(name: string): Promise<FilingsRecent> {
    const cached = this.archivePageCache.get(name);
    if (cached && this.isFresh(cached.at)) return cached.data;
    const data = await this.fetchJson<FilingsRecent>(`https://data.sec.gov/submissions/${name}`);
    this.archivePageCache.set(name, { at: Date.now(), data });
    return data;
  }

  /**
   * Fetch and parse a quarterly EDGAR full-index (`master.idx`) — the
   * pipe-delimited manifest of every filing accepted that quarter, available
   * back to 1993 QTR1. This is the pre-2001 unscoped browse source: EFTS
   * full-text only reaches 2001, but the quarterly indexes reach 1993. The file
   * is not form-filterable server-side (a whole-quarter download), so callers
   * bound how many quarters they scan and filter client-side (#77). Cached per
   * quarter within the ticker-cache TTL — an archived quarter is immutable.
   */
  async fetchFullIndexQuarter(year: number, quarter: number): Promise<FullIndexEntry[]> {
    const key = `${year}Q${quarter}`;
    const cached = this.fullIndexCache.get(key);
    if (cached && this.isFresh(cached.at)) return cached.data;
    const text = await this.fetchText(
      `https://www.sec.gov/Archives/edgar/full-index/${year}/QTR${quarter}/master.idx`,
    );
    const data = parseMasterIndex(text);
    this.fullIndexCache.set(key, { at: Date.now(), data });
    return data;
  }

  /** True when a cache entry loaded at `at` is still within the ticker-cache TTL. */
  private isFresh(at: number): boolean {
    return Date.now() - at < getServerConfig().tickerCacheTtl * 1000;
  }

  async searchFilings(params: {
    query: string;
    forms?: string[] | undefined;
    ciks?: string[] | undefined;
    startDate?: string | undefined;
    endDate?: string | undefined;
    from?: number | undefined;
    size?: number | undefined;
  }): Promise<EftsResponse> {
    const url = new URL('https://efts.sec.gov/LATEST/search-index');
    // `q` is optional — EFTS honors `ciks` for pure entity scope with no
    // full-text query, so a bare cik:/ticker: search sends no `q`.
    if (params.query) url.searchParams.set('q', params.query);
    if (params.forms?.length) url.searchParams.set('forms', params.forms.join(','));
    // Server-side entity scope by CIK, independent of the document's name text —
    // includes filings made under a former company name sharing the same CIK.
    if (params.ciks?.length) url.searchParams.set('ciks', params.ciks.join(','));
    if (params.startDate && params.endDate) {
      url.searchParams.set('dateRange', 'custom');
      url.searchParams.set('startdt', params.startDate);
      url.searchParams.set('enddt', params.endDate);
    }
    url.searchParams.set('from', String(params.from ?? 0));
    url.searchParams.set('size', String(params.size ?? 20));

    const response = await this.fetchJson<EftsResponse>(url.toString());

    // Shape guard: EFTS can return a 2xx whose body omits `hits.total` (degraded
    // payload, or a rejected request echoed as `{ error: ... }` with 200). A genuine
    // zero-hit response is still well-formed (`hits.total.value: 0`, empty
    // `hits.hits`) and passes. Without this, `response.hits.total.value` throws a
    // raw TypeError that leaks to the client (#61).
    if (!Array.isArray(response?.hits?.hits) || typeof response.hits.total?.value !== 'number') {
      const upstreamError = (response as { error?: unknown } | null)?.error;
      throw serviceUnavailable(
        'SEC EDGAR full-text search returned an unexpected response without hits — the service may be degraded.',
        {
          reason: 'efts_degraded_response',
          ...(typeof upstreamError === 'string' && { upstreamError }),
          recovery: {
            hint: 'Retry the search in a few minutes — EDGAR full-text search returned an incomplete response.',
          },
        },
      );
    }

    return response;
  }

  /**
   * Resolve likely company CIKs for a filing accession number using SEC search metadata.
   * Returns zero or more padded 10-digit CIKs in SEC-provided order.
   */
  async findFilingCiks(accessionNumber: string): Promise<string[]> {
    const response = await this.searchFilings({ query: accessionNumber, size: 10 });
    const normalizedAccession = accessionNumber.replace(/[^0-9]/g, '');
    const ciks = new Set<string>();

    for (const hit of response.hits.hits) {
      const hitAccession = (hit._source.adsh || hit._id.split(':')[0] || hit._id).replace(
        /[^0-9]/g,
        '',
      );
      if (hitAccession !== normalizedAccession) continue;

      for (const cik of hit._source.ciks ?? []) {
        ciks.add(cik.padStart(10, '0'));
      }
    }

    return [...ciks];
  }

  /** Fetch a filing's document index. Returns `null` if the filing does not exist. */
  tryGetFilingIndex(cik: string, accessionNumber: string): Promise<FilingIndex | null> {
    const padded = cik.padStart(10, '0');
    const noDashes = accessionNumber.replace(/-/g, '');
    return this.tryFetchJson<FilingIndex>(
      `https://www.sec.gov/Archives/edgar/data/${padded}/${noDashes}/index.json`,
    );
  }

  /**
   * Fetch the SEC submission header (`<accession>-index-headers.html`) and parse
   * it into a `filename → metadata` map. Returns `null` if the file is absent.
   * The header page exposes canonical SEC document TYPE values (e.g. "EX-21.1")
   * that the directory listing JSON does not.
   */
  async tryGetFilingHeaders(
    cik: string,
    accessionNumber: string,
  ): Promise<Map<string, FilingDocumentHeader> | null> {
    const padded = cik.padStart(10, '0');
    const noDashes = accessionNumber.replace(/-/g, '');
    const text = await this.tryFetchText(
      `https://www.sec.gov/Archives/edgar/data/${padded}/${noDashes}/${accessionNumber}-index-headers.html`,
    );
    return text ? parseFilingHeaders(text) : null;
  }

  getFilingDocument(cik: string, accessionNumber: string, document: string): Promise<string> {
    const padded = cik.padStart(10, '0');
    const noDashes = accessionNumber.replace(/-/g, '');
    return this.fetchText(
      `https://www.sec.gov/Archives/edgar/data/${padded}/${noDashes}/${document}`,
    );
  }

  /**
   * Fetch a filing document, returning `null` when the archive path exists but this document does not.
   */
  tryGetFilingDocument(
    cik: string,
    accessionNumber: string,
    document: string,
  ): Promise<string | null> {
    const padded = cik.padStart(10, '0');
    const noDashes = accessionNumber.replace(/-/g, '');
    return this.tryFetchText(
      `https://www.sec.gov/Archives/edgar/data/${padded}/${noDashes}/${document}`,
    );
  }

  /**
   * Fetch the leading bytes of a filing document, stopping as soon as `stopAt` appears in
   * the decoded text or `maxBytes` have arrived. Returns `null` on 404, and the whole
   * document when it is shorter than the cutoff.
   *
   * SEC's archive host ignores `Range` — a ranged request answers 200 with the full body —
   * so there is no server-side partial fetch. The saving here is client-side: the response
   * body is cancelled mid-stream, so a routing scan that inspects a multi-megabyte report's
   * header pays for the leading part of it instead of the whole file. Neither cutoff can cut
   * below one read chunk, because both checks run between reads and the runtime picks the
   * boundary — Bun hands SEC archive documents back in 262,144-byte reads, so a `stopAt` that
   * appears 1.5 KB in still costs 256 KB, and a `maxBytes` below that costs the same. Treat
   * both as "one chunk, not the file" rather than as a byte budget; `maxBytes` binds only on
   * a document long enough to arrive in several chunks, which is what stops a document
   * missing `stopAt` entirely from being read to the end. A runtime that hands back no
   * readable body (a stubbed fetch, for one) falls through to reading it whole, which costs
   * bandwidth but returns the same text.
   */
  async tryGetFilingDocumentHead(
    cik: string,
    accessionNumber: string,
    document: string,
    options: { maxBytes: number; stopAt: string },
  ): Promise<string | null> {
    const padded = cik.padStart(10, '0');
    const noDashes = accessionNumber.replace(/-/g, '');
    const response = await this.rawFetch(
      `https://www.sec.gov/Archives/edgar/data/${padded}/${noDashes}/${document}`,
      false,
    );
    if (response.status === 404) return null;
    if (!response.body) return response.text();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let read = 0;
    try {
      while (read < options.maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        read += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (text.includes(options.stopAt)) break;
      }
    } finally {
      await reader.cancel().catch(() => {
        /* the body is being discarded; a cancel race has nothing left to report */
      });
    }
    return text;
  }

  /**
   * Search EDGAR submissions for recent filings of specified form types, newest first.
   * Returns up to `limit` matches from the submissions recent-filings window. Each carries
   * `reportDate` (the period-of-report end date) for callers that target a specific period.
   */
  async getRecentFilingsByForm(
    cik: string,
    formTypes: string[],
    limit: number,
  ): Promise<
    Array<{
      accessionNumber: string;
      filingDate: string;
      primaryDocument: string;
      reportDate: string;
    }>
  > {
    const submissions = await this.getSubmissions(cik);
    const recent = submissions.filings.recent;
    const results: Array<{
      accessionNumber: string;
      filingDate: string;
      primaryDocument: string;
      reportDate: string;
    }> = [];

    for (let i = 0; i < recent.form.length && results.length < limit; i++) {
      if (formTypes.includes(recent.form[i] ?? '')) {
        results.push({
          accessionNumber: recent.accessionNumber[i] ?? '',
          filingDate: recent.filingDate[i] ?? '',
          primaryDocument: recent.primaryDocument[i] ?? '',
          reportDate: recent.reportDate[i] ?? '',
        });
      }
    }

    return results;
  }

  /**
   * Fetch every XBRL fact a company has reported. Returns `null` on 404.
   * Backs the whole-company reads (`get_snapshot`, `compare_companies`) and the
   * no-data error path, which surfaces the namespaces and tags a filer uses.
   * Served from the local mirror when enabled and synced — the mirror stores one
   * row per (cik, taxonomy, tag) and reassembles the API shape off a `cik` point
   * lookup; the live API is the fallback.
   */
  tryGetCompanyFacts(cik: string): Promise<CompanyFactsResponse | null> {
    const padded = cik.padStart(10, '0');
    return this.mirrorOrLive(
      (m) => m.companyFactsReady(),
      (m) => m.getCompanyFacts(cik),
      () =>
        this.tryFetchJson<CompanyFactsResponse>(
          `https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`,
        ),
    );
  }

  /**
   * Fetch XBRL data for a concept. Returns `null` if the company does not report this tag.
   * Served from the local mirror when enabled and synced; the live API is the
   * fallback (and covers filings newer than the last refresh when `mirrorFallbackLive`).
   */
  tryGetCompanyConcept(
    cik: string,
    taxonomy: string,
    tag: string,
  ): Promise<CompanyConceptResponse | null> {
    const padded = cik.padStart(10, '0');
    return this.mirrorOrLive(
      (m) => m.companyFactsReady(),
      (m) => m.getCompanyConcept(cik, taxonomy, tag),
      () =>
        this.tryFetchJson<CompanyConceptResponse>(
          `https://data.sec.gov/api/xbrl/companyconcept/CIK${padded}/${taxonomy}/${tag}.json`,
        ),
    );
  }

  /**
   * Fetch cross-company frame data. Returns `null` if no companies report this combination.
   * A frame is a full scan of the company-facts store, so it is served from the
   * mirror only when that layer is fully synced (`companyFactsComplete()`) — a
   * partial or mid-sync store would yield a silently-incomplete frame, so frames
   * fall back to the live API until the mirror is complete. The live API is also
   * the fallback on a genuine miss.
   */
  tryGetFrames(
    taxonomy: string,
    tag: string,
    unit: string,
    period: string,
  ): Promise<FramesResponse | null> {
    return this.mirrorOrLive(
      (m) => m.companyFactsComplete(),
      (m) => m.getFrames(taxonomy, tag, unit, period),
      () =>
        this.tryFetchJson<FramesResponse>(
          `https://data.sec.gov/api/xbrl/frames/${taxonomy}/${tag}/${unit}/${period}.json`,
        ),
    );
  }

  /**
   * Route a company-facts query through the local mirror when ready, with live-API
   * fallback. The `ready` predicate is the caller's readiness gate — point lookups
   * pass `companyFactsReady()` (tolerant of an in-progress refresh); the frames
   * aggregation passes the stricter `companyFactsComplete()` so a partial or
   * mid-sync store never yields an incomplete frame. Paths:
   * - Mirror ready + hit → return mirror result
   * - Mirror ready + miss + fallbackLive → fall through to live()
   * - Mirror ready + miss + strict → return null
   * - Mirror not ready + fallbackLive → fall through to live()
   * - Mirror not ready + strict → throw ServiceUnavailable
   * - No mirror → fall through to live()
   */
  private async mirrorOrLive<T>(
    ready: (mirror: NonNullable<ReturnType<typeof getEdgarMirror>>) => Promise<boolean>,
    mirrorRead: (mirror: NonNullable<ReturnType<typeof getEdgarMirror>>) => Promise<T | null>,
    live: () => Promise<T | null>,
  ): Promise<T | null> {
    const mirror = getEdgarMirror();
    if (mirror) {
      if (await ready(mirror)) {
        const hit = await mirrorRead(mirror);
        if (hit != null) return hit;
        if (!getServerConfig().mirrorFallbackLive) return null;
      } else if (!getServerConfig().mirrorFallbackLive) {
        throw serviceUnavailable(
          'EDGAR mirror enabled but the company-facts layer is not synced; run `bun run mirror:init`',
          { layer: 'companyfacts' },
        );
      }
    }
    return live();
  }

  // --- Internals ---

  /**
   * Rate-limited fetch with retry/backoff. Returns the response on 2xx or 404;
   * throws a status-classified `McpError` on other non-OK statuses after retries are exhausted.
   */
  private async rawFetch(url: string, acceptJson: boolean): Promise<Response> {
    const headers: Record<string, string> = { 'User-Agent': getServerConfig().userAgent };
    if (acceptJson) headers.Accept = 'application/json';

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await this.throttle();
      const response = await globalThis.fetch(url, { headers });

      if (response.ok || response.status === 404) return response;

      if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES - 1) {
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }

      const data: Record<string, unknown> = { url };
      if (response.status === 403) {
        const host = new URL(url).hostname;
        data.recovery = {
          hint: `${host} may be blocking requests. Check EDGAR_USER_AGENT format ("AppName contact@email.com") or retry later.`,
        };
      }
      throw await httpErrorFromResponse(response, { service: 'SEC EDGAR', data });
    }

    throw serviceUnavailable('SEC EDGAR API request failed after retries', { url });
  }

  /**
   * Serialize throttle checks through a promise chain so concurrent callers
   * can't observe a stale `lastRequestAt` and fire in parallel within one window.
   */
  private throttle(): Promise<void> {
    const next = this.throttleQueue.then(async () => {
      const elapsed = Date.now() - this.lastRequestAt;
      if (elapsed < this.minIntervalMs) {
        await sleep(this.minIntervalMs - elapsed);
      }
      this.lastRequestAt = Date.now();
    });
    this.throttleQueue = next.catch(() => {
      /* swallow: errors propagate to the caller's awaited chain, not the queue */
    });
    return next;
  }

  private getTickerCache(): Promise<TickerCache> {
    const config = getServerConfig();
    const now = Date.now();

    if (this.tickerCache && now - this.tickerCache.loadedAt < config.tickerCacheTtl * 1000) {
      return Promise.resolve(this.tickerCache);
    }

    // Singleflight: concurrent first-time callers (e.g. fetch-frames enriching
    // ~5k reporters in parallel) share one in-flight load instead of each
    // queuing their own SEC fetch through the 10 req/s throttle.
    this.tickerCacheLoad ??= this.loadTickerCache().finally(() => {
      this.tickerCacheLoad = undefined;
    });
    return this.tickerCacheLoad;
  }

  /**
   * Load the ticker index, preferring the local mirror when enabled and synced.
   * The live directory is the cold-start / not-ready fallback (and the only path
   * when the mirror is off).
   *
   * In addition to company_tickers.json (operating companies), also loads
   * company_tickers_mf.json (ETFs and mutual funds) and merges fund symbols into
   * the byTicker index so fund tickers like VOO, SCHD, and JEPI resolve correctly.
   *
   * Mirror path (#43): when `mirrorFallbackLive` is true, a live MF fetch is merged
   * into the mirror-served equity base so fund tickers resolve even if the mirror
   * was synced before MF ingestion was added. When `mirrorFallbackLive` is false
   * (strict offline), the mirror's own MF rows are the sole source.
   */
  private async loadTickerCache(): Promise<TickerCache> {
    const mirror = getEdgarMirror();
    if (mirror && (await mirror.tickersReady())) {
      const rows = await mirror.getTickerRows();
      if (rows.length > 0) {
        const config = getServerConfig();
        const allEntries: Array<{
          cik: string;
          name: string;
          ticker: string;
          seriesId?: string;
          classId?: string;
        }> = [...rows];

        // When mirrorFallbackLive is enabled, supplement with a live MF fetch so
        // fund tickers (VOO, SCHD, JEPI…) resolve even if the mirror predates MF
        // ingestion. Failure is non-fatal — equity resolution still works.
        if (config.mirrorFallbackLive) {
          const mfEntries = await this.loadMfTickers();
          allEntries.push(...mfEntries);
        }
        return this.buildTickerCache(allEntries, buildFormerNameEntries());
      }
    } else if (mirror && !getServerConfig().mirrorFallbackLive) {
      throw serviceUnavailable(
        'EDGAR mirror enabled but the ticker layer is not synced; run `bun run mirror:init`',
        { layer: 'tickers' },
      );
    }

    // Fetch operating-company tickers (company_tickers.json)
    const raw = await this.fetchJson<Record<string, TickerEntry>>(
      'https://www.sec.gov/files/company_tickers.json',
    );
    const entries: Array<{ cik: string; name: string; ticker: string }> = Object.values(raw).map(
      (entry) => ({
        cik: String(entry.cik_str).padStart(10, '0'),
        name: entry.title,
        ticker: entry.ticker,
      }),
    );

    // Fetch ETF/mutual-fund tickers (company_tickers_mf.json).
    // 404 or any error is non-fatal — degrade gracefully with operating-company-only index.
    const mfEntries = await this.loadMfTickers();
    entries.push(...mfEntries);

    // Merge the committed former-names asset.
    const formerEntries = buildFormerNameEntries();

    return this.buildTickerCache(entries, formerEntries);
  }

  /**
   * Fetch and parse company_tickers_mf.json. Returns an empty array on failure
   * so a SEC file outage does not break company resolution entirely.
   * Entries are MF-only: they carry seriesId/classId and no `name` field.
   * These merge into byTicker only (not byCik) since one registrant trust
   * holds many fund series.
   */
  private async loadMfTickers(): Promise<
    Array<{ cik: string; name: string; ticker: string; seriesId: string; classId: string }>
  > {
    try {
      const mfRaw = await this.fetchJson<MfTickerFile>(MF_TICKERS_URL);
      if (!Array.isArray(mfRaw?.fields) || !Array.isArray(mfRaw?.data)) return [];

      const fieldIdx = {
        cik: mfRaw.fields.indexOf('cik'),
        seriesId: mfRaw.fields.indexOf('seriesId'),
        classId: mfRaw.fields.indexOf('classId'),
        symbol: mfRaw.fields.indexOf('symbol'),
      };
      if (fieldIdx.cik < 0 || fieldIdx.symbol < 0) return [];

      return mfRaw.data
        .filter((row) => row[fieldIdx.symbol])
        .map((row) => ({
          cik: String(row[fieldIdx.cik]).padStart(10, '0'),
          name: '',
          ticker: String(row[fieldIdx.symbol]),
          seriesId: fieldIdx.seriesId >= 0 ? String(row[fieldIdx.seriesId]) : '',
          classId: fieldIdx.classId >= 0 ? String(row[fieldIdx.classId]) : '',
        }));
    } catch {
      // Degrade gracefully — fund tickers won't resolve, but operating companies still work.
      // Note: no service-layer logger is available here; a request-scoped ctx.log would require
      // plumbing ctx through the ticker-cache lifecycle. The failure is visible via no fund
      // resolution rather than a silent cache poison (#43).
      return [];
    }
  }

  /**
   * Build the in-memory CIK index from normalized entries (live JSON or mirror rows).
   * MF entries (with seriesId/classId) go into byTicker only — not byCik — because
   * a registrant trust (e.g. CIK 36405 = Vanguard Index Funds) holds many series.
   * Former-name entries go into allEntries only (name search only, no ticker/CIK index).
   */
  private buildTickerCache(
    entries: Array<{
      cik: string;
      name: string;
      ticker: string;
      seriesId?: string;
      classId?: string;
    }>,
    formerEntries: Array<{ cik: string; name: string }> = [],
  ): TickerCache {
    const byTicker = new Map<string, CikMatch>();
    const byCik = new Map<string, CikMatch>();
    const bySeriesId = new Map<string, CikMatch>();
    const allEntries: CikMatch[] = [];

    for (const entry of entries) {
      const isMf = Boolean(entry.seriesId !== undefined && entry.seriesId !== '');
      const hasName = Boolean(entry.name);
      const match: CikMatch = {
        cik: entry.cik,
        ticker: entry.ticker,
        ...(hasName ? { name: entry.name } : {}),
        ...(isMf && entry.seriesId ? { seriesId: entry.seriesId } : {}),
        ...(isMf && entry.classId ? { classId: entry.classId } : {}),
      };

      // Operating-company tickers take precedence: a fund symbol must not override an
      // existing equity ticker on the rare cross-file symbol collision (e.g. SPCX).
      const tickerKey = entry.ticker.toUpperCase();
      if (!isMf || !byTicker.has(tickerKey)) {
        byTicker.set(tickerKey, match);
      }

      // A series has one entry per listed share class, so the first class registers the
      // series; later classes of the same series would only re-point it at the same trust.
      if (isMf && entry.seriesId && !bySeriesId.has(entry.seriesId.toUpperCase())) {
        bySeriesId.set(entry.seriesId.toUpperCase(), match);
      }

      // MF entries must not overwrite byCik — the trust CIK is 1:many with fund series.
      if (!isMf) {
        const existing = byCik.get(match.cik);
        byCik.set(match.cik, existing ? pickPreferredTicker(existing, match) : match);
      }

      // Only push to allEntries if the entry has a name (for name search).
      // MF entries have no name, so they're ticker-only.
      if (match.name) {
        allEntries.push(match);
      }
    }

    // Former-name entries: allEntries only (name search + trigram), no ticker/CIK index.
    for (const fn of formerEntries) {
      allEntries.push({ cik: fn.cik, name: fn.name });
    }

    this.tickerCache = { byTicker, byCik, bySeriesId, allEntries, loadedAt: Date.now() };
    return this.tickerCache;
  }
}

/**
 * Build former-name entries from the committed static asset.
 * Each tuple is [lowercasedName, zeroPaddedCIK].
 */
function buildFormerNameEntries(): Array<{ cik: string; name: string }> {
  return (formerNamesData as Array<[string, string]>).map(([name, cik]) => ({ cik, name }));
}

/**
 * EDGAR's EFTS `display_names[0]` embeds the ticker(s) and CIK in trailing
 * parentheticals (e.g. "Apple Inc.  (AAPL)  (CIK 0000320193)"). Strip them so
 * consumers see a clean entity name — ticker and CIK are already surfaced as
 * their own fields.
 */
export function cleanDisplayName(displayName: string): string {
  return displayName
    .replace(/\s*\(CIK\s*\d+\)/gi, '')
    .replace(/\s*\([A-Z0-9,\s.-]+\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Range-based selection of submissions archive-page manifest entries (`filings.files[]`),
 * returned newest-first (by `filingTo` descending). A page's [filingFrom, filingTo]
 * window is kept unless it lies entirely before `filedAfter` or entirely after
 * `filedBefore`; with no bounds, every page is returned. Routes company_search's
 * older-filings scan directly to the pages covering a requested date range, or walks
 * all pages newest-first when a form filter under-fills the recent window (#78).
 */
export function selectArchivePages(
  files: SubmissionsResponse['filings']['files'],
  filedAfter?: string,
  filedBefore?: string,
): SubmissionsResponse['filings']['files'] {
  return files
    .filter((page) => {
      if (filedAfter && page.filingTo < filedAfter) return false;
      if (filedBefore && page.filingFrom > filedBefore) return false;
      return true;
    })
    .sort((a, b) => b.filingTo.localeCompare(a.filingTo));
}

/**
 * Parse a quarterly EDGAR `master.idx` into filing rows. The file is a short
 * metadata preamble, then a `CIK|Company Name|Form Type|Date Filed|Filename`
 * header, a dashed separator line, then one pipe-delimited row per filing. Data
 * parsing begins after the separator; malformed rows (wrong field count,
 * non-numeric CIK) are skipped. The accession number is the filename basename
 * with the `.txt` suffix removed (`edgar/data/320193/0000320193-97-000010.txt`
 * → `0000320193-97-000010`). Exported for direct unit testing.
 */
export function parseMasterIndex(text: string): FullIndexEntry[] {
  const entries: FullIndexEntry[] = [];
  let inData = false;
  for (const line of text.split(/\r?\n/)) {
    if (!inData) {
      // The dashed separator line marks the boundary between preamble and data.
      if (line.startsWith('----')) inData = true;
      continue;
    }
    const parts = line.split('|');
    if (parts.length !== 5) continue;
    const [cik, companyName, form, filingDate, filename] = parts;
    if (!cik || !/^\d+$/.test(cik) || !filename) continue;
    const base = filename.slice(filename.lastIndexOf('/') + 1).replace(/\.txt$/i, '');
    entries.push({
      cik: cik.padStart(10, '0'),
      companyName: companyName ?? '',
      form: form ?? '',
      filingDate: filingDate ?? '',
      accessionNumber: base,
    });
  }
  return entries;
}

/**
 * Parse EDGAR's company-browse Atom feed into the registrant identity plus one row per
 * filing. A series ID EDGAR does not know answers 200 with its HTML no-match page rather
 * than a feed, which carries neither `company-info` nor entries and so parses to an empty
 * result — the caller's cue that the series is unknown. Exported for direct unit testing.
 */
export function parseSeriesFilingFeed(xml: string): SeriesFilingFeed {
  const doc = parseDocument(xml, { xmlMode: true, decodeEntities: true });
  const info = findTag(doc.children, 'company-info');
  const filings: SeriesFilingFeed['filings'] = [];
  for (const entry of findTags(doc.children, 'entry')) {
    const content = findTag(entry.children, 'content');
    const accessionNumber = childText(content, 'accession-number');
    if (!accessionNumber) continue;
    filings.push({
      accessionNumber,
      filingDate: childText(content, 'filing-date') ?? '',
      form: childText(content, 'filing-type') ?? '',
    });
  }
  return {
    registrantCik: childText(info, 'cik')?.padStart(10, '0'),
    registrantName: childText(info, 'conformed-name'),
    filings,
  };
}

/**
 * Name of the raw XML document inside a filing's archive directory. The submissions feed
 * points at the human-readable rendering (`xslSCHEDULE_13D_X02/primary_doc.xml`,
 * `xslFormNPORT-P_X01/primary_doc.xml`); the raw document is the same basename at the root
 * of that directory. Idempotent, and answers the conventional default name for a filing
 * whose primary document the feed does not name.
 */
export function rawDocumentName(primaryDocument: string | undefined): string {
  const base = primaryDocument?.slice(primaryDocument.lastIndexOf('/') + 1);
  return base || 'primary_doc.xml';
}

/**
 * Enumerate the calendar quarters overlapping the inclusive [startDate, endDate]
 * range (both YYYY-MM-DD), returned NEWEST-first to mirror `selectArchivePages`
 * — a capped scan then keeps the most recent quarters, consistent with the
 * default filing-date-descending sort. Routes search_filings' pre-2001
 * full-index browse to the `master.idx` files it must fetch (#77).
 */
export function quartersInRange(
  startDate: string,
  endDate: string,
): Array<{ year: number; quarter: number }> {
  const quarterOf = (date: string) => Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1;
  const startYear = Number(startDate.slice(0, 4));
  const endYear = Number(endDate.slice(0, 4));
  const startQuarter = quarterOf(startDate);
  const endQuarter = quarterOf(endDate);
  const quarters: Array<{ year: number; quarter: number }> = [];
  for (let year = endYear; year >= startYear; year--) {
    const hi = year === endYear ? endQuarter : 4;
    const lo = year === startYear ? startQuarter : 1;
    for (let quarter = hi; quarter >= lo; quarter--) quarters.push({ year, quarter });
  }
  return quarters;
}

/**
 * Pick the better of two ticker entries sharing a CIK. SEC's
 * `company_tickers.json` lists every class, preferred-share, and debt-security
 * ticker against the same CIK (e.g. JPM + JPM-PA/JPM-PB/…, PRU + PFH/PRH/PRS).
 * Rules, in order:
 *
 * 1. **Tickers without a hyphen win over hyphenated.** Common stock has no
 *    class suffix (`JPM`, `BAC`, `C`); preferred shares carry hyphenated
 *    suffixes (`JPM-PA`, `BAC-PS`, `C-PR`).
 * 2. **Otherwise, the incumbent (first-seen) wins.** SEC lists common stock as
 *    the primary entry per CIK, with debt/note securities and additional share
 *    classes appended later (Prudential's PRU precedes PFH/PRH/PRS; Berkshire's
 *    BRK-A precedes BRK-B). The `byCik` build iterates `Object.values()` in
 *    insertion order, so the earliest match — typically the common stock —
 *    stays in the index unless rule 1 displaces it.
 *
 * Missing tickers (defensive — `CikMatch.ticker` is optional in the type but
 * always set by `loadTickerCache`) lose to defined ones.
 */
export function pickPreferredTicker(a: CikMatch, b: CikMatch): CikMatch {
  if (!a.ticker) return b;
  if (!b.ticker) return a;
  const aHyphen = a.ticker.includes('-');
  const bHyphen = b.ticker.includes('-');
  if (aHyphen !== bHyphen) return aHyphen ? b : a;
  return a;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Init/accessor pattern
let _service: EdgarApiService | undefined;

export function initEdgarApiService(): void {
  _service = new EdgarApiService();
}

export function getEdgarApiService(): EdgarApiService {
  if (!_service)
    throw new Error('EdgarApiService not initialized — call initEdgarApiService() in setup()');
  return _service;
}
