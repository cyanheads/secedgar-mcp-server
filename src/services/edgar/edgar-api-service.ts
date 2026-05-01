/**
 * @fileoverview Rate-limited HTTP client for all SEC EDGAR API interactions.
 * Handles User-Agent compliance, rate limiting, retry with backoff, CIK resolution,
 * and ticker/entity caching.
 * @module services/edgar/edgar-api-service
 */

import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
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

/** Indexed ticker data for O(1) lookups. */
interface TickerCache {
  allEntries: CikMatch[];
  byCik: Map<string, CikMatch>;
  byTicker: Map<string, CikMatch>;
  loadedAt: number;
}

class EdgarApiService {
  private lastRequestAt = 0;
  private minIntervalMs: number;
  private tickerCache: TickerCache | undefined;
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
   * - Otherwise → name search (prefix, then substring)
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

    // Short alphabetic → ticker
    const upper = trimmed.toUpperCase();
    if (/^[A-Z]{1,5}$/.test(upper)) {
      const match = cache.byTicker.get(upper);
      if (match) return match;
    }

    // Name search: exact → prefix → substring
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

    const results = [...exact, ...prefix, ...substring].slice(0, 5);
    if (results.length > 0) {
      return results.length === 1 ? (results[0] as CikMatch) : results;
    }

    // Also try as ticker if nothing matched
    const tickerMatch = cache.byTicker.get(upper);
    return tickerMatch ?? [];
  }

  /** Reverse lookup: CIK → ticker symbol. */
  async cikToTicker(cik: string): Promise<string | undefined> {
    const cache = await this.getTickerCache();
    return cache.byCik.get(cik.padStart(10, '0'))?.ticker;
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
    startDate?: string | undefined;
    endDate?: string | undefined;
    from?: number | undefined;
    size?: number | undefined;
  }): Promise<EftsResponse> {
    const url = new URL('https://efts.sec.gov/LATEST/search-index');
    url.searchParams.set('q', params.query);
    if (params.forms?.length) url.searchParams.set('forms', params.forms.join(','));
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

  /** Fetch XBRL data for a concept. Returns `null` if the company does not report this tag. */
  tryGetCompanyConcept(
    cik: string,
    taxonomy: string,
    tag: string,
  ): Promise<CompanyConceptResponse | null> {
    const padded = cik.padStart(10, '0');
    return this.tryFetchJson<CompanyConceptResponse>(
      `https://data.sec.gov/api/xbrl/companyconcept/CIK${padded}/${taxonomy}/${tag}.json`,
    );
  }

  /** Fetch cross-company frame data. Returns `null` if no companies report this combination. */
  tryGetFrames(
    taxonomy: string,
    tag: string,
    unit: string,
    period: string,
  ): Promise<FramesResponse | null> {
    return this.tryFetchJson<FramesResponse>(
      `https://data.sec.gov/api/xbrl/frames/${taxonomy}/${tag}/${unit}/${period}.json`,
    );
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

    const raw = await this.fetchJson<Record<string, TickerEntry>>(
      'https://www.sec.gov/files/company_tickers.json',
    );

    const byTicker = new Map<string, CikMatch>();
    const byCik = new Map<string, CikMatch>();
    const allEntries: CikMatch[] = [];

    for (const entry of Object.values(raw)) {
      const match: CikMatch = {
        cik: String(entry.cik_str).padStart(10, '0'),
        name: entry.title,
        ticker: entry.ticker,
      };
      byTicker.set(entry.ticker.toUpperCase(), match);
      byCik.set(match.cik, match);
      allEntries.push(match);
    }

    this.tickerCache = { byTicker, byCik, allEntries, loadedAt: now };
    return this.tickerCache;
  }
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
