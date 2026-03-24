/**
 * @fileoverview Rate-limited HTTP client for all SEC EDGAR API interactions.
 * Handles User-Agent compliance, rate limiting, retry with backoff, CIK resolution,
 * and ticker/entity caching.
 * @module services/edgar/edgar-api-service
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
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

  constructor() {
    const config = getServerConfig();
    this.minIntervalMs = Math.ceil(1000 / config.rateLimitRps);
  }

  /** Rate-limited, retried fetch with User-Agent header. */
  async fetch(url: string): Promise<Response> {
    const config = getServerConfig();

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await this.throttle();

      const response = await globalThis.fetch(url, {
        headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
      });

      if (response.ok) return response;

      if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES - 1) {
        const delay = BASE_BACKOFF_MS * 2 ** attempt;
        await sleep(delay);
        continue;
      }

      if (response.status === 404) return response;

      throw serviceUnavailable(
        `SEC EDGAR API returned ${response.status}: ${response.statusText}`,
        { url, status: response.status },
      );
    }

    throw serviceUnavailable('SEC EDGAR API request failed after retries', { url });
  }

  /** Fetch and parse JSON, throwing on non-OK responses. */
  async fetchJson<T>(url: string): Promise<T> {
    const response = await this.fetch(url);
    if (!response.ok) {
      throw serviceUnavailable(`SEC EDGAR API returned ${response.status} for ${url}`, {
        url,
        status: response.status,
      });
    }
    return response.json() as Promise<T>;
  }

  /** Fetch raw text content (HTML filing documents). */
  async fetchText(url: string): Promise<string> {
    await this.throttle();

    const config = getServerConfig();
    const response = await globalThis.fetch(url, {
      headers: { 'User-Agent': config.userAgent },
    });

    if (!response.ok) {
      throw serviceUnavailable(`SEC EDGAR returned ${response.status} for ${url}`, {
        url,
        status: response.status,
      });
    }
    return response.text();
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
      // Return a synthetic match — CIK may be valid even if not in tickers file
      return { cik: padded, name: '', ticker: '' };
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

  getFilingIndex(cik: string, accessionNumber: string): Promise<FilingIndex> {
    const padded = cik.padStart(10, '0');
    const noDashes = accessionNumber.replace(/-/g, '');
    return this.fetchJson<FilingIndex>(
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

  getCompanyConcept(cik: string, taxonomy: string, tag: string): Promise<CompanyConceptResponse> {
    const padded = cik.padStart(10, '0');
    return this.fetchJson<CompanyConceptResponse>(
      `https://data.sec.gov/api/xbrl/companyconcept/CIK${padded}/${taxonomy}/${tag}.json`,
    );
  }

  getFrames(taxonomy: string, tag: string, unit: string, period: string): Promise<FramesResponse> {
    return this.fetchJson<FramesResponse>(
      `https://data.sec.gov/api/xbrl/frames/${taxonomy}/${tag}/${unit}/${period}.json`,
    );
  }

  // --- Internals ---

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed);
    }
    this.lastRequestAt = Date.now();
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
