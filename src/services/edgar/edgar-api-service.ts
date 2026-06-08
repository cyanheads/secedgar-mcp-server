/**
 * @fileoverview Rate-limited HTTP client for all SEC EDGAR API interactions.
 * Handles User-Agent compliance, rate limiting, retry with backoff, CIK resolution,
 * and ticker/entity caching.
 * @module services/edgar/edgar-api-service
 */

import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { getEdgarMirror } from '@/services/edgar/mirror/index.js';
import formerNamesData from './data/former-names.json' with { type: 'json' };
import { type FilingDocumentHeader, parseFilingHeaders } from './filing-headers.js';
import type {
  CikMatch,
  CompanyConceptResponse,
  EftsResponse,
  FilingIndex,
  FramesResponse,
  SubmissionsResponse,
  TickerEntry,
} from './types.js';

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
  byTicker: Map<string, CikMatch>;
  loadedAt: number;
}

/** A candidate suggestion from the trigram scan on no-result name search. */
export interface CompanySuggestion {
  cik: string;
  name?: string;
  ticker?: string;
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

  /** Reverse lookup: CIK → ticker symbol. */
  async cikToTicker(cik: string): Promise<string | undefined> {
    const cache = await this.getTickerCache();
    return cache.byCik.get(cik.padStart(10, '0'))?.ticker;
  }

  /** Return the current in-memory entry list (used by the handler for trigram suggestions). */
  async getAllEntries(): Promise<CikMatch[]> {
    const cache = await this.getTickerCache();
    return cache.allEntries;
  }

  // --- SEC API Methods ---

  getSubmissions(cik: string): Promise<SubmissionsResponse> {
    const padded = cik.padStart(10, '0');
    return this.fetchJson<SubmissionsResponse>(
      `https://data.sec.gov/submissions/CIK${padded}.json`,
    );
  }

  searchFilings(params: {
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

    return this.fetchJson<EftsResponse>(url.toString());
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
   * Fetch all XBRL facts for a company. Returns `null` on 404.
   * Used on the no-data error path to surface which namespaces and tags a filer actually uses.
   */
  tryGetCompanyFacts(
    cik: string,
  ): Promise<{ facts: Record<string, Record<string, unknown>> } | null> {
    const padded = cik.padStart(10, '0');
    return this.tryFetchJson<{ facts: Record<string, Record<string, unknown>> }>(
      `https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`,
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

  private async getTickerCache(): Promise<TickerCache> {
    const config = getServerConfig();
    const now = Date.now();

    if (this.tickerCache && now - this.tickerCache.loadedAt < config.tickerCacheTtl * 1000) {
      return this.tickerCache;
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

    this.tickerCache = { byTicker, byCik, allEntries, loadedAt: Date.now() };
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
