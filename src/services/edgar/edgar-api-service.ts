/**
 * @fileoverview Rate-limited HTTP client for all SEC EDGAR API interactions.
 * Handles User-Agent compliance, request pacing, SEC's rate-limit block, retry
 * with backoff, CIK resolution, and ticker/entity caching.
 * @module services/edgar/edgar-api-service
 */

import { McpError, notFound, rateLimited, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  httpErrorFromResponse,
  logger,
  type Pacer,
  requestContextService,
  withExtra,
} from '@cyanheads/mcp-ts-core/utils';
import { parseDocument } from 'htmlparser2';
import { getServerConfig } from '@/config/server-config.js';
import { getEdgarMirror } from '@/services/edgar/mirror/index.js';
import { CALL_FAILURE_BUDGET_MS, CallScope } from './call-scope.js';
import formerNamesData from './data/former-names.json' with { type: 'json' };
import {
  type FilingHeaders,
  parseFilingHeaders,
  parseSubmissionHeader,
  type SubmissionHeader,
} from './filing-headers.js';
import { trigramSimilarity } from './trigram-similarity.js';
import type {
  CikMatch,
  CompanyConceptResponse,
  CompanyConceptUnit,
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
/**
 * Statuses worth a retry. 429 is deliberately absent: SEC holds a rate-limit block
 * until the request rate has stayed under the threshold for ten minutes, so the
 * ~3s retry budget cannot outlast it and every retry restarts the clock the caller
 * is waiting on (#112). An attempt that gets no HTTP response at all (#173), and
 * one whose body fails to read after its headers (#181), retry on the same ladder.
 */
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);

/**
 * How long one attempt may wait for response headers, counted from dispatch, before
 * it is aborted and retried as a no-response failure (#173). Bun applies no connect
 * timeout of its own — an unanswered connect waits out the OS TCP timeout, 75 s on
 * macOS — and neither runtime bounds a server that accepts and never answers, so one
 * attempt could outlast the MCP client's 60 s request timeout alone. Each wait is
 * also clamped to what is left of the call's {@link CALL_FAILURE_BUDGET_MS}, which
 * bounds a whole tool call's failure time (#179). The clock starts once the
 * pacer dispatches the request, so queue time never counts, and stops at headers;
 * the body is bounded only by {@link BODY_IDLE_TIMEOUT_MS}, so a multi-megabyte body
 * that keeps arriving is never cut off. SEC's slowest reads sampled send headers in
 * under 2 s.
 */
const ATTEMPT_HEADERS_TIMEOUT_MS = 15_000;

/**
 * How long a response body may go without a byte before the read is abandoned and
 * the attempt retried as a body-read failure (#181). Measured between reads, never
 * across the whole body, so a body still arriving, however slowly, is never cut.
 * Without it a stalled body holds the call until undici's 300 s body timeout on
 * Node, and indefinitely on Bun.
 */
const BODY_IDLE_TIMEOUT_MS = 15_000;

/**
 * `data.reason` once SEC gave no complete, readable answer: the last attempt got no
 * HTTP response (#173) or its body failed to read, or a 200 body was not JSON
 * (#181). Declared retryable on every tool that reaches SEC; set on `data.retryable`
 * here for the same reason as `rate_limited` (#122).
 */
const SEC_UNREACHABLE_REASON = 'sec_unreachable';

/**
 * One attempt's outcome: SEC's HTTP answer, whatever its status, or none at all — a
 * runtime `fetch` rejection (connection refused or reset, DNS failure, a connect
 * timeout) or no response headers within `capMs`, the lesser of
 * {@link ATTEMPT_HEADERS_TIMEOUT_MS} and the call's failure budget left (#179).
 * `waitedMs` runs from dispatch to headers or to the rejection — for a call that
 * counted a probe's attempt as its own, the time it waited on that probe.
 */
type Attempt =
  | { readonly kind: 'answered'; readonly response: Response; readonly waitedMs: number }
  | {
      readonly kind: 'unanswered';
      readonly capMs: number;
      readonly rejection: unknown;
      readonly timedOut: boolean;
      readonly waitedMs: number;
    };

type UnansweredAttempt = Extract<Attempt, { kind: 'unanswered' }>;

/** An attempt never sent because the call's failure budget was already spent (#179). */
interface BudgetSpent {
  readonly kind: 'budget_spent';
}

const BUDGET_SPENT: BudgetSpent = { kind: 'budget_spent' };

/**
 * An attempt SEC answered whose body then failed to read (#181): the read rejected —
 * the connection broke off, the chunk framing or the compression was invalid — or no
 * bytes arrived for `capMs` (`stalled`), the lesser of {@link BODY_IDLE_TIMEOUT_MS}
 * and the budget left. `waitedMs` is the failing read's own wait, never the time
 * earlier bytes took to arrive.
 */
interface BodyFailedAttempt {
  readonly capMs: number;
  readonly kind: 'body_failed';
  readonly rejection: unknown;
  readonly stalled: boolean;
  readonly waitedMs: number;
}

/** One attempt's body read: its text, or why it failed. */
type BodyRead = { readonly kind: 'read'; readonly text: string } | BodyFailedAttempt;

/** Where a head read stops: once `stopAt` appears in the text so far, or `maxBytes` have arrived. */
interface HeadCutoff {
  readonly maxBytes: number;
  readonly stopAt: string;
}

/**
 * Every way SEC gives no complete, readable answer — each ends as `sec_unreachable`,
 * including a request the call's spent failure budget kept from being sent (#179).
 */
type Unreadable =
  | UnansweredAttempt
  | BodyFailedAttempt
  | BudgetSpent
  | { readonly kind: 'not_json'; readonly rejection: unknown };

/**
 * How a request's retry ladder ended: on which attempt, and whether the call's
 * failure budget ended it — retries it stopped, or a last wait it cut short (#179).
 */
interface LadderEnd {
  readonly attempt: number;
  readonly budgetStopped: boolean;
}

/** A load several calls await: its promise and the scope it runs under. */
interface SharedLoad<T> {
  readonly promise: Promise<T>;
  readonly scope: CallScope;
  /**
   * Each waiting call's one wait on the load. A call that asks again while it waits —
   * `fetch_frames` resolves thousands of tickers at once — joins its own wait, so it
   * holds one abort listener and is charged the load's failure time once.
   */
  readonly waits: Map<CallScope, Promise<T>>;
}

/**
 * `data.reason` on every SEC rate-limit failure — the upstream 429 and a call
 * refused locally while the cool-down after one runs — so a caller branches the
 * same way on either (#116). Both also set `data.retryable: true`: the tools
 * declare the reason retryable, but only `ctx.fail` copies that onto `data`, so
 * a service-thrown error has to carry it itself (#122).
 */
const RATE_LIMITED_REASON = 'rate_limited';

/**
 * This server's view of SEC's rate-limit block (#116). SEC stops serving an IP
 * until its request rate has stayed under the limit for ten minutes, and every
 * request sent meanwhile restarts that clock, so after a 429 nothing may go out:
 * - `open` — send normally.
 * - `closed` — refuse every call locally until `reopensAt`; the first call after
 *   that instant becomes the probe.
 * - `probing` — the probe is in flight; every other call waits on `settled`, then
 *   re-reads the gate. `settled` carries the probe's attempt when it got no HTTP
 *   response, which every waiter counts as one of its own (#173). A probe whose own
 *   call is cancelled settles with nothing, so a waiter probes in its place (#179).
 */
type BlockGate =
  | { readonly state: 'open' }
  | { readonly state: 'closed'; readonly reopensAt: number }
  | { readonly state: 'probing'; readonly settled: Promise<UnansweredAttempt | undefined> };

const OPEN_GATE: BlockGate = { state: 'open' };

/** A call cleared to send: the gate it was admitted under, and — for the probe — how to settle it. */
interface Admission {
  gate: BlockGate;
  /**
   * Present on the probe only: the probe's attempt, or `undefined` when none was
   * made — it threw first, or its call was cancelled.
   */
  releaseProbe?: (outcome: Attempt | BudgetSpent | undefined) => void;
}

/**
 * Recovery hint for both the upstream 429 and the local refusal. The message
 * carries the seconds remaining too, so a client reading only `content[]` sees
 * the wait as well as one reading `data.retryAfter`.
 */
function rateLimitHint(retryAfterSeconds: number): string {
  return `SEC is rate-limiting this server's IP. It resumes serving an IP only after its request rate has stayed below 10 requests/second for 10 minutes, and any request sent meanwhile restarts that clock, so this server sends nothing to SEC until the cool-down ends — retry in ${retryAfterSeconds} seconds. A shared outbound IP can trigger the block even while this server stays under the limit.`;
}

/** URL for SEC's mutual-fund ticker file (ETFs and open-end funds). */
const MF_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_mf.json';

/**
 * How long a failed load of the fund-ticker file stands before one resolution
 * refetches it (#119). A window rather than every resolution: against a
 * persistent 5xx, a per-lookup retry would add three requests and ~3s of backoff
 * to each one. After a rate-limit failure the window stretches to the cool-down.
 */
const FUND_SLICE_RETRY_MS = 60_000;

/** Trigram similarity threshold — minimum Dice score to include a candidate suggestion. */
const TRIGRAM_THRESHOLD = 0.3;
/** Maximum number of near-match suggestions to include. */
const TRIGRAM_TOP_N = 3;

/** Raw entry from SEC's company_tickers_mf.json (columnar with a `fields` array). */
interface MfTickerFile {
  data: Array<[number, string, string, string]>;
  fields: string[];
}

/** An operating-company ticker, from company_tickers.json or a mirror row carrying a name. */
interface EquityRow {
  cik: string;
  kind: 'equity';
  name: string;
  ticker: string;
}

/**
 * An ETF or mutual-fund ticker. Its CIK is the registrant trust, which is 1:many
 * with the series it holds, so a fund row never maps the CIK back to one symbol.
 * The live fund file carries series and class; the mirror stores the bare ticker → CIK.
 */
interface FundRow {
  cik: string;
  classId?: string;
  kind: 'fund';
  seriesId?: string;
  ticker: string;
}

type TickerIndexRow = EquityRow | FundRow;

/**
 * The live fund-ticker file's contribution to the index. A failed load holds no
 * rows and a `retryAt` — the earliest instant a resolution refetches the file.
 */
interface FundSlice {
  retryAt: number | undefined;
  rows: FundRow[];
}

/** The fund slice where nothing is read live: strict mirror mode. */
const NO_LIVE_FUNDS: FundSlice = { retryAt: undefined, rows: [] };

/** Indexed ticker data for O(1) lookups. */
interface TickerCache {
  allEntries: CikMatch[];
  /** The rows the index was built from, bar the live fund slice — a fund-slice retry rebuilds on them without refetching. */
  baseRows: TickerIndexRow[];
  byCik: Map<string, CikMatch>;
  /** Fund series ID → registrant. Built from company_tickers_mf.json, so it covers only series with a listed share class. */
  bySeriesId: Map<string, CikMatch>;
  byTicker: Map<string, CikMatch>;
  /** Set while the live fund slice is missing after a failed load: when a resolution may refetch it (#119). */
  fundRetryAt: number | undefined;
  /** When `baseRows` loaded. The index expires a TTL after it; a fund-slice retry leaves it alone. */
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
// Corporate-suffix normalization
// ---------------------------------------------------------------------------

/**
 * Terminal corporate-suffix token → the canonical long form it compares as. Four
 * separate buckets, never merged: the registry carries real distinct registrants
 * that differ only in which suffix they use (`TORO CO` CIK 0000737758 vs
 * `TORO CORP.` CIK 0001941131), so one shared "has a suffix" marker would compare
 * two different companies equal.
 */
const SUFFIX_CANONICAL = new Map([
  ['corp', 'corporation'],
  ['corporation', 'corporation'],
  ['inc', 'incorporated'],
  ['incorporated', 'incorporated'],
  ['co', 'company'],
  ['company', 'company'],
  ['ltd', 'limited'],
  ['limited', 'limited'],
]);

/**
 * Expand a lowercased company name's trailing corporate-suffix token to its
 * canonical long form, so a query spelling the suffix out matches a registry title
 * abbreviating it (`beacon financial corporation` ↔ `beacon financial corp`) (#107).
 *
 * Only the terminal whitespace-delimited token is considered, and a trailing `.`
 * or `,` is stripped from it as part of recognizing it (`toro corp.`,
 * `society pass incorporated.`). Everything else is left byte-for-byte alone: the
 * long-form words also occur mid-name in titles ending in a different suffix
 * (`american water works company, inc.`), and a terminal token that only contains
 * a suffix (`ltd./adr`) is not one. Names with no recognized terminal suffix come
 * back unchanged, so the result is safe to compare against a raw lowercased name.
 */
export function normalizeCompanySuffix(name: string): string {
  const cut = name.lastIndexOf(' ');
  if (cut < 0) return name;
  const canonical = SUFFIX_CANONICAL.get(name.slice(cut + 1).replace(/[.,]$/, ''));
  return canonical ? `${name.slice(0, cut)} ${canonical}` : name;
}

/**
 * Every terminal token `stripCompanySuffix` drops: the four `SUFFIX_CANONICAL`
 * buckets plus the entity forms that have no bucket — `plc`, `llc`, the `lp` family,
 * `nv`, `sa`, `ag`, `se` — written with or without periods. Dropping only, never
 * normalizing: these forms stay out of `SUFFIX_CANONICAL`, so `lp` never folds into
 * `ltd` (#107). With them, `Rio Tinto` ties RIO TINTO LTD and RIO TINTO PLC instead
 * of silently picking the one whose suffix happens to sit in a bucket (#155).
 */
const DROPPABLE_SUFFIXES = new Set([
  ...SUFFIX_CANONICAL.keys(),
  'plc',
  'llc',
  'l.l.c',
  'lp',
  'l.p',
  'nv',
  'n.v',
  'sa',
  's.a',
  'ag',
  'se',
]);

/**
 * Drop a lowercased company name's terminal entity-suffix token, and a comma before
 * it (`itron, inc.` → `itron`), or return `undefined` when it has none. Applied to
 * registry names only — never to the query, whose own suffix must still match, so
 * `Toro Co` never meets `TORO CORP.` and `Rio Tinto plc` never meets RIO TINTO LTD (#155).
 */
function stripCompanySuffix(name: string): string | undefined {
  const cut = name.lastIndexOf(' ');
  if (cut < 0 || !DROPPABLE_SUFFIXES.has(name.slice(cut + 1).replace(/[.,]$/, ''))) return;
  return name.slice(0, cut).replace(/,$/, '').trimEnd();
}

/** Name-search tiers, strongest first: exact, prefix, substring. */
type NameTier = 0 | 1 | 2;
const NAME_TIERS: readonly NameTier[] = [0, 1, 2];

// ---------------------------------------------------------------------------
// Near-match company suggestions
// ---------------------------------------------------------------------------

/**
 * Run a trigram similarity scan over the in-memory entry set. Each entry is scored
 * on its name and on its ticker, and keeps the higher of the two — one ranked,
 * deduped, TRIGRAM_TOP_N-capped list rather than two disjoint ones, so a strong
 * ticker match can outrank a weak name match and vice versa (#111). An entry
 * missing either field is simply not scored on it: former-name entries carry a
 * name and no ticker. Returns up to TRIGRAM_TOP_N candidates whose Dice score
 * meets TRIGRAM_THRESHOLD, sorted descending.
 */
export function suggestCompanies(query: string, allEntries: CikMatch[]): CompanySuggestion[] {
  const q = query.toLowerCase();
  const scored: Array<{ score: number; entry: CikMatch }> = [];

  for (const entry of allEntries) {
    const score = Math.max(
      entry.name ? trigramSimilarity(q, entry.name.toLowerCase()) : 0,
      entry.ticker ? trigramSimilarity(q, entry.ticker.toLowerCase()) : 0,
    );
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
  /** One queue for every SEC request in the process, spacing starts at the configured rate. */
  private readonly pacer: Pacer;
  private readonly cooldownMs: number;
  private gate: BlockGate = OPEN_GATE;
  private tickerCache: TickerCache | undefined;
  private tickerCacheLoad: SharedLoad<TickerCache> | undefined;
  /** Per-CIK submissions doc cache, keyed by padded CIK (TTL = EDGAR_TICKER_CACHE_TTL). */
  private submissionsCache = new Map<string, { at: number; data: SubmissionsResponse }>();
  /** Per-page submissions archive cache, keyed by page name (TTL = EDGAR_TICKER_CACHE_TTL). */
  private archivePageCache = new Map<string, { at: number; data: FilingsRecent }>();
  /** Per-quarter full-index cache, keyed by `${year}Q${quarter}` (TTL = EDGAR_TICKER_CACHE_TTL). */
  private fullIndexCache = new Map<string, { at: number; data: FullIndexEntry[] }>();

  constructor() {
    const config = getServerConfig();
    this.cooldownMs = config.rateLimitCooldownSeconds * 1000;
    /**
     * Start spacing only. No concurrency cap, so a slow response never holds the
     * next start back; no wait budget, so an ordinary burst drains at the
     * configured rate instead of being shed; and no pacer cooldown — the pacer's
     * gate would hold queued calls until it reopened and then release them all,
     * where SEC's block needs local refusals and a single probe (the block gate).
     */
    this.pacer = createPacer({
      name: 'sec-edgar',
      minStartGapMs: Math.ceil(1000 / config.rateLimitRps),
    });
  }

  /**
   * Stop the pacer: queued requests reject with `RequestCancelled`, and so does
   * any request made afterwards. Requests already sent are left to finish.
   */
  dispose(): void {
    this.pacer.dispose();
  }

  /** Fetch and parse JSON, throwing on non-OK responses and on a body that is not JSON. */
  async fetchJson<T>(url: string, scope: CallScope): Promise<T> {
    const text = await this.rawFetch(url, true, scope);
    if (text === null) {
      throw notFound(`SEC EDGAR API returned 404 for ${url}`, { url, status: 404 });
    }
    return parseJson<T>(url, text);
  }

  /** Fetch JSON, returning `null` on 404 and throwing on other non-OK responses. */
  async tryFetchJson<T>(url: string, scope: CallScope): Promise<T | null> {
    const text = await this.rawFetch(url, true, scope);
    return text === null ? null : parseJson<T>(url, text);
  }

  /** Fetch raw text content (HTML filing documents). */
  async fetchText(url: string, scope: CallScope): Promise<string> {
    const text = await this.rawFetch(url, false, scope);
    if (text === null) {
      throw notFound(`SEC EDGAR returned 404 for ${url}`, { url, status: 404 });
    }
    return text;
  }

  /** Fetch raw text content, returning `null` on 404 and throwing on other failures. */
  tryFetchText(url: string, scope: CallScope): Promise<string | null> {
    return this.rawFetch(url, false, scope);
  }

  // --- CIK Resolution ---

  /**
   * Resolve a query (ticker, name, or CIK) to company match(es).
   * - Numeric input → direct CIK lookup
   * - 1-5 uppercase letters → ticker lookup (O(1))
   * - Otherwise → name search (exact, prefix, substring — resolved within the best
   *   tier a current name reaches), then the catch-all ticker lookup
   * Returns a single match, an array of multiple matches, or an empty array (no match).
   * On no-result name search, the returned empty array carries `suggestions` on
   * the thrown error at the handler layer — call `suggestCompanies` there.
   */
  async resolveCik(query: string, scope: CallScope): Promise<CikMatch | CikMatch[]> {
    const cache = await this.getTickerCache(scope);
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

    // Name search, tiered exact → prefix → substring. The exact tier also accepts a
    // suffix-normalized equality (#107) and the registry name minus its terminal suffix,
    // so `Apple` names `Apple Inc.` exactly (#155); the query's own suffix is never
    // dropped, so `Toro Co` never meets `TORO CORP.`.
    const lower = trimmed.toLowerCase();
    const lowerNormalized = normalizeCompanySuffix(lower);
    // A suffix-dropped name is a prefix of the full one, so the strip runs on prefix hits only.
    const tierOf = (name: string): NameTier | undefined => {
      if (name === lower || normalizeCompanySuffix(name) === lowerNormalized) return 0;
      if (name.startsWith(lower)) return stripCompanySuffix(name) === lower ? 0 : 1;
      return name.includes(lower) ? 2 : undefined;
    };

    // Current names are registry rows, which carry a ticker; former names (the committed
    // asset) carry none. Resolution runs within the best tier a current name reaches —
    // several CIKs there are the ambiguity, and the tiers below are not listed. A former
    // name joins at that tier or better but never outranks a current name, so a company
    // is never silently swapped for a former holder of its name; former names decide
    // alone only when no current name matches (#155).
    const current: Record<NameTier, CikMatch[]> = { 0: [], 1: [], 2: [] };
    const former: Record<NameTier, CikMatch[]> = { 0: [], 1: [], 2: [] };
    for (const entry of cache.allEntries) {
      if (!entry.name) continue;
      const tier = tierOf(entry.name.toLowerCase());
      if (tier === undefined) continue;
      (entry.ticker === undefined ? former : current)[tier].push(entry);
    }

    const bestCurrent = NAME_TIERS.find((tier) => current[tier].length > 0);
    const candidates =
      bestCurrent === undefined
        ? (NAME_TIERS.map((tier) => former[tier]).find((hits) => hits.length > 0) ?? [])
        : [
            ...current[bestCurrent],
            ...NAME_TIERS.filter((tier) => tier <= bestCurrent).flatMap((tier) => former[tier]),
          ];

    // Dedup by CIK (current + former names may match the same registrant).
    const seen = new Set<string>();
    const deduped: CikMatch[] = [];
    for (const entry of candidates) {
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
    // that bypassed the early ticker gate above). On a miss, retry a dotted symbol in
    // SEC's hyphenated share-class form — brokers and market-data sites write BRK.B where
    // company_tickers.json lists BRK-B, and no registrant has both forms on file (#110).
    const tickerMatch =
      cache.byTicker.get(upper) ??
      (upper.includes('.') ? cache.byTicker.get(upper.replaceAll('.', '-')) : undefined);
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
  async resolveEntityByName(name: string, scope: CallScope): Promise<EntityNameMatch[]> {
    const url = new URL('https://efts.sec.gov/LATEST/search-index');
    url.searchParams.set('keysTyped', name);
    const response = await this.fetchJson<EftsEntityAutocompleteResponse>(url.toString(), scope);

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
  async cikToTicker(cik: string, scope: CallScope): Promise<string | undefined> {
    const cache = await this.getTickerCache(scope);
    return cache.byCik.get(cik.padStart(10, '0'))?.ticker;
  }

  /**
   * Resolve a fund series ID (`S000002839`) to its registrant trust. Backed by
   * company_tickers_mf.json, which lists a series only once one of its share classes has a
   * ticker — a series with no listed class resolves to `undefined` rather than a wrong trust.
   */
  async resolveFundSeries(seriesId: string, scope: CallScope): Promise<CikMatch | undefined> {
    const cache = await this.getTickerCache(scope);
    return cache.bySeriesId.get(seriesId.toUpperCase());
  }

  /**
   * List a registrant's fund series, from the same company_tickers_mf.json index. A trust
   * files one NPORT-P per series per period, so this is what tells a caller holding only a
   * registrant CIK which series it must name. Covers series with at least one listed share
   * class only — a trust whose series carry no ticker returns an empty list, which is not
   * the same as having no series.
   */
  async listFundSeries(cik: string, scope: CallScope): Promise<FundSeriesEntry[]> {
    const cache = await this.getTickerCache(scope);
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
    scope: CallScope,
  ): Promise<SeriesFilingFeed> {
    const url = new URL('https://www.sec.gov/cgi-bin/browse-edgar');
    url.searchParams.set('action', 'getcompany');
    url.searchParams.set('CIK', seriesId);
    url.searchParams.set('type', formType);
    url.searchParams.set('owner', 'include');
    url.searchParams.set('count', String(count));
    url.searchParams.set('output', 'atom');
    return parseSeriesFilingFeed(await this.fetchText(url.toString(), scope));
  }

  /** Return the current in-memory entry list (used by the handler for trigram suggestions). */
  async getAllEntries(scope: CallScope): Promise<CikMatch[]> {
    const cache = await this.getTickerCache(scope);
    return cache.allEntries;
  }

  // --- SEC API Methods ---

  /**
   * Fetch a filer's submissions document (entity metadata + the `recent` window —
   * the last year or 1,000 filings, whichever holds more — + the `files[]`
   * archive-page manifest). Cached per CIK within
   * the ticker-cache TTL — the doc is large and re-read on every archive-paging
   * scan (#78). A 404 throws (uncached) so a bad CIK still surfaces. Like every
   * cache here, written only by a completed read — a cancelled one caches nothing.
   */
  async getSubmissions(cik: string, scope: CallScope): Promise<SubmissionsResponse> {
    const padded = cik.padStart(10, '0');
    const cached = this.submissionsCache.get(padded);
    if (cached && this.isFresh(cached.at)) return cached.data;
    const data = await this.fetchJson<SubmissionsResponse>(
      `https://data.sec.gov/submissions/CIK${padded}.json`,
      scope,
    );
    this.submissionsCache.set(padded, { at: Date.now(), data });
    return data;
  }

  /**
   * Fetch a submissions archive page (`filings.files[].name`, e.g.
   * `CIK0000320193-submissions-001.json`) — the older filings that don't fit the
   * `recent` window. Read through `SubmissionsArchiveWalk`. The page body is a flat parallel-array object
   * field-compatible with `FilingsRecent`. Cached per page within the ticker-cache
   * TTL (pages are large and effectively immutable once archived).
   */
  async fetchArchivePage(name: string, scope: CallScope): Promise<FilingsRecent> {
    const cached = this.archivePageCache.get(name);
    if (cached && this.isFresh(cached.at)) return cached.data;
    const data = await this.fetchJson<FilingsRecent>(
      `https://data.sec.gov/submissions/${name}`,
      scope,
    );
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
  async fetchFullIndexQuarter(
    year: number,
    quarter: number,
    scope: CallScope,
  ): Promise<FullIndexEntry[]> {
    const key = `${year}Q${quarter}`;
    const cached = this.fullIndexCache.get(key);
    if (cached && this.isFresh(cached.at)) return cached.data;
    const text = await this.fetchText(
      `https://www.sec.gov/Archives/edgar/full-index/${year}/QTR${quarter}/master.idx`,
      scope,
    );
    const data = parseMasterIndex(text);
    this.fullIndexCache.set(key, { at: Date.now(), data });
    return data;
  }

  /** True when a cache entry loaded at `at` is still within the ticker-cache TTL. */
  private isFresh(at: number): boolean {
    return Date.now() - at < getServerConfig().tickerCacheTtl * 1000;
  }

  async searchFilings(
    params: {
      query: string;
      forms?: string[] | undefined;
      ciks?: string[] | undefined;
      startDate?: string | undefined;
      endDate?: string | undefined;
      from?: number | undefined;
      size?: number | undefined;
    },
    scope: CallScope,
  ): Promise<EftsResponse> {
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

    const response = await this.fetchJson<EftsResponse>(url.toString(), scope);

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
  async findFilingCiks(accessionNumber: string, scope: CallScope): Promise<string[]> {
    const response = await this.searchFilings({ query: accessionNumber, size: 10 }, scope);
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
  tryGetFilingIndex(
    cik: string,
    accessionNumber: string,
    scope: CallScope,
  ): Promise<FilingIndex | null> {
    return this.tryFetchJson<FilingIndex>(
      filingArchiveUrl(cik, accessionNumber, 'index.json'),
      scope,
    );
  }

  /**
   * Fetch the SEC submission header page (`<accession>-index-headers.html`) and parse
   * it into the `filename → metadata` map plus the submission's own form, filing date,
   * and period. Returns `null` if the page is absent. The page exposes canonical SEC
   * document TYPE values (e.g. "EX-21.1") that the directory listing JSON does not.
   */
  async tryGetFilingHeaders(
    cik: string,
    accessionNumber: string,
    scope: CallScope,
  ): Promise<FilingHeaders | null> {
    const text = await this.tryFetchText(
      filingArchiveUrl(cik, accessionNumber, `${accessionNumber}-index-headers.html`),
      scope,
    );
    return text ? parseFilingHeaders(text) : null;
  }

  /**
   * Fetch the bare SGML submission header (`<accession>.hdr.sgml`, under 1 KB) and read
   * its form, filing date, and period. Returns `null` if the file is absent. The
   * fallback for filings whose index-headers page is missing — common among filings
   * made before 2014; it lists no documents.
   */
  async tryGetSubmissionHeader(
    cik: string,
    accessionNumber: string,
    scope: CallScope,
  ): Promise<SubmissionHeader | null> {
    const text = await this.tryFetchText(
      filingArchiveUrl(cik, accessionNumber, `${accessionNumber}.hdr.sgml`),
      scope,
    );
    return text ? parseSubmissionHeader(text) : null;
  }

  getFilingDocument(
    cik: string,
    accessionNumber: string,
    document: string,
    scope: CallScope,
  ): Promise<string> {
    return this.fetchText(filingArchiveUrl(cik, accessionNumber, document), scope);
  }

  /**
   * Fetch a filing document, returning `null` when the archive path exists but this document does not.
   */
  tryGetFilingDocument(
    cik: string,
    accessionNumber: string,
    document: string,
    scope: CallScope,
  ): Promise<string | null> {
    return this.tryFetchText(filingArchiveUrl(cik, accessionNumber, document), scope);
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
   * missing `stopAt` entirely from being read to the end. The head is read inside the
   * retry ladder like any other body, so a read that breaks off before the cutoff is
   * retried; stopping at the cutoff is not a failure (#181).
   */
  tryGetFilingDocumentHead(
    cik: string,
    accessionNumber: string,
    document: string,
    options: HeadCutoff,
    scope: CallScope,
  ): Promise<string | null> {
    return this.rawFetch(filingArchiveUrl(cik, accessionNumber, document), false, scope, options);
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
    scope: CallScope,
  ): Promise<
    Array<{
      accessionNumber: string;
      filingDate: string;
      primaryDocument: string;
      reportDate: string;
    }>
  > {
    const submissions = await this.getSubmissions(cik, scope);
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
   * lookup; the live API is the fallback. A concept unit that arrives as
   * anything but an array is dropped (#141).
   */
  async tryGetCompanyFacts(cik: string, scope: CallScope): Promise<CompanyFactsResponse | null> {
    const padded = cik.padStart(10, '0');
    const facts = await this.mirrorOrLive(
      (m) => m.companyFactsReady(),
      (m) => m.getCompanyFacts(cik),
      () =>
        this.tryFetchJson<CompanyFactsResponse>(
          `https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`,
          scope,
        ),
    );
    for (const namespace of Object.values(facts?.facts ?? {})) {
      for (const concept of Object.values(namespace)) concept.units = arrayUnits(concept.units);
    }
    return facts;
  }

  /**
   * Fetch XBRL data for a concept. Returns `null` if the company does not report this tag.
   * Served from the local mirror when enabled and synced; the live API is the
   * fallback (and covers filings newer than the last refresh when `mirrorFallbackLive`).
   * A payload whose every unit arrives malformed comes back with no units — the
   * tag is named but carries nothing (#141).
   */
  async tryGetCompanyConcept(
    cik: string,
    taxonomy: string,
    tag: string,
    scope: CallScope,
  ): Promise<CompanyConceptResponse | null> {
    const padded = cik.padStart(10, '0');
    const concept = await this.mirrorOrLive(
      (m) => m.companyFactsReady(),
      (m) => m.getCompanyConcept(cik, taxonomy, tag),
      () =>
        this.tryFetchJson<CompanyConceptResponse>(
          `https://data.sec.gov/api/xbrl/companyconcept/CIK${padded}/${taxonomy}/${tag}.json`,
          scope,
        ),
    );
    if (concept) concept.units = arrayUnits(concept.units);
    return concept;
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
    scope: CallScope,
  ): Promise<FramesResponse | null> {
    return this.mirrorOrLive(
      (m) => m.companyFactsComplete(),
      (m) => m.getFrames(taxonomy, tag, unit, period),
      () =>
        this.tryFetchJson<FramesResponse>(
          `https://data.sec.gov/api/xbrl/frames/${taxonomy}/${tag}/${unit}/${period}.json`,
          scope,
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
   * Paced fetch with retry/backoff. Returns the body's text on 2xx — only its head
   * when `cutoff` is given — and `null` on 404, whose body is left unread. The body
   * is read inside the ladder (#181): a 5xx, an attempt that got no HTTP response,
   * and a 2xx whose body failed to read all retry up to `MAX_RETRIES` attempts, and
   * then the last attempt decides — a 5xx throws its status-classified `McpError`,
   * the other two `sec_unreachable`. Other non-OK statuses throw at once, as does
   * the local refusal while SEC's rate-limit block is active, and the pacer's
   * `RequestCancelled` — those are `McpError`s from `send()`, never retried.
   *
   * Every failed attempt and every backoff is charged to the call's failure budget,
   * and the ladder ends early once the budget cannot cover another backoff and
   * attempt (#179). Once the caller's signal has fired, whatever rejects is rethrown
   * untouched — a queued request leaves the pacer unsent, and an attempt in flight,
   * a body read, or a backoff sleep ends at once — never retried or classified.
   */
  private async rawFetch(
    url: string,
    acceptJson: boolean,
    scope: CallScope,
    cutoff?: HeadCutoff,
  ): Promise<string | null> {
    scope.signal.throwIfAborted();
    const headers: Record<string, string> = { 'User-Agent': getServerConfig().userAgent };
    if (acceptJson) headers.Accept = 'application/json';

    /** The previous attempt's failure, which a request the budget stops before its next attempt ends with. */
    let failed: Attempt | BodyFailedAttempt | undefined;
    for (let attempt = 1; ; attempt++) {
      const outcome = scope.remainingMs > 0 ? await this.send(url, headers, scope) : BUDGET_SPENT;
      // An answer that lands as the caller cancels is not read.
      scope.signal.throwIfAborted();
      if (outcome.kind === 'budget_spent') {
        // Spent before this attempt could go out — by an earlier request, or by a
        // concurrent one while this retry waited for its slot.
        if (failed === undefined) throw secUnreachable(url, outcome);
        throw await this.ladderFailure(url, failed, { attempt: attempt - 1, budgetStopped: true });
      }

      let last: Attempt | BodyFailedAttempt = outcome;
      if (outcome.kind === 'answered') {
        const { response } = outcome;
        if (response.status === 404) return null;
        if (response.ok) {
          const body = await readBody(response, scope, cutoff);
          if (body.kind === 'read') return body.text;
          last = body;
        }
      }

      const transient = last.kind !== 'answered' || RETRYABLE_STATUSES.has(last.response.status);
      if (!transient) throw await this.ladderFailure(url, last, { attempt, budgetStopped: false });

      scope.charge(outcome.waitedMs + (last.kind === 'body_failed' ? last.waitedMs : 0));
      const backoffMs = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      if (attempt < MAX_RETRIES && scope.remainingMs > backoffMs) {
        scope.charge(backoffMs);
        await sleep(backoffMs, scope.signal);
        failed = last;
        continue;
      }
      throw await this.ladderFailure(url, last, {
        attempt,
        budgetStopped: attempt < MAX_RETRIES || cutByBudget(last),
      });
    }
  }

  /**
   * The error a request's last attempt earned: `sec_unreachable` for no response or
   * an unreadable body; for an HTTP answer, its status-classified `McpError`, with
   * the 403 and 429 hints. A 5xx ladder the failure budget stopped keeps its status
   * mapping and `data`, and its message says the budget stopped it (#179).
   */
  private async ladderFailure(
    url: string,
    last: Attempt | BodyFailedAttempt,
    end: LadderEnd,
  ): Promise<McpError> {
    if (last.kind !== 'answered') return secUnreachable(url, last, end);

    const { response } = last;
    const data: Record<string, unknown> = { url };
    if (response.status === 403) {
      const host = new URL(url).hostname;
      data.recovery = {
        hint: `${host} may be blocking requests. Check EDGAR_USER_AGENT format ("AppName contact@email.com") or retry later.`,
      };
    } else if (response.status === 429) {
      // send() closed the gate on this response, so the wait is the full cool-down.
      const retryAfter = this.cooldownSecondsRemaining();
      data.reason = RATE_LIMITED_REASON;
      data.retryable = true;
      data.retryAfter = retryAfter;
      data.recovery = { hint: rateLimitHint(retryAfter) };
    }
    const error = await httpErrorFromResponse(response, {
      service: 'SEC EDGAR',
      data,
      // SEC answers a rate-limit block with a full HTML page. The recovery hint
      // above carries everything actionable, so the markup is not forwarded (#112).
      captureBody: response.status !== 429,
    });
    if (!end.budgetStopped) return error;
    return new McpError(
      error.code,
      `SEC EDGAR returned HTTP ${response.status} on attempt ${end.attempt} of ${MAX_RETRIES}; ${BUDGET_STOP_TEXT}.`,
      error.data,
      { cause: error },
    );
  }

  /**
   * One attempt through the block gate and the pacer, under the caller's signal. A
   * 429 closes the gate before the response is handed back, so no call admitted
   * after it sends. A `fetch` rejection comes back as an unanswered attempt, and so
   * does a probe this call waited on that got no HTTP response; an attempt the spent
   * failure budget kept from going out comes back as `budget_spent`. The gate's
   * refusal and the pacer's `RequestCancelled` throw, and so does the caller's
   * cancel, with its own reason — then a probe settles as having got no answer.
   */
  private async send(
    url: string,
    headers: Record<string, string>,
    scope: CallScope,
  ): Promise<Attempt | BudgetSpent> {
    const admission = await this.admit(scope);
    if ('kind' in admission) return admission;
    let outcome: Attempt | BudgetSpent | undefined;
    try {
      outcome = await this.pacer.run(
        () => {
          // Re-read at dispatch: a 429 may have landed while this call waited for its
          // slot, and a call queued before the block must not go out inside it.
          if (this.gate !== admission.gate) throw this.cooldownRefusal();
          return fetchUntilHeaders(url, headers, scope);
        },
        { signal: scope.signal },
      );
      if (outcome.kind === 'answered' && outcome.response.status === 429) {
        this.gate = { state: 'closed', reopensAt: Date.now() + this.cooldownMs };
      }
      return outcome;
    } finally {
      admission.releaseProbe?.(outcome);
    }
  }

  /**
   * Wait until this call may send, or throw the local refusal while the
   * cool-down runs. The first call after the cool-down becomes the probe; every
   * call behind it waits for the probe to resolve and then reads the gate again —
   * unless the probe got no HTTP response, which each waiter takes as its own
   * unanswered attempt, its wait on the probe charged to its own budget. Otherwise
   * calls queued behind a silent SEC would probe one at a time, 15 s each, and the
   * last of N would wait about 45·N s (#173). A waiter whose call is cancelled
   * leaves with the caller's reason and leaves the gate as it found it (#179).
   */
  private async admit(scope: CallScope): Promise<Admission | UnansweredAttempt> {
    for (;;) {
      const gate = this.gate;
      if (gate.state === 'open') return { gate };
      if (gate.state === 'probing') {
        const waitedFrom = Date.now();
        const unanswered = await untilAborted(gate.settled, scope.signal);
        if (unanswered) return { ...unanswered, waitedMs: Date.now() - waitedFrom };
        continue;
      }
      if (gate.reopensAt > Date.now()) throw this.cooldownRefusal();

      const { promise: settled, resolve: settle } = Promise.withResolvers<
        UnansweredAttempt | undefined
      >();
      const probe: BlockGate = { state: 'probing', settled };
      this.gate = probe;
      return {
        gate: probe,
        releaseProbe: (outcome) => {
          /**
           * A probe 429 has already closed the gate for a full cool-down. Any other
           * reply means SEC is serving again, even when its body then fails to read —
           * the probe settles at headers, and only its own call retries the body
           * (#181). No reply at all (a network error, or no headers within the
           * per-attempt cap) proves nothing about the block, so the gate stays shut
           * for the next call to probe in its place. Nor does a probe whose own call
           * was cancelled, or never sent for a spent budget: it settles with nothing,
           * so no waiter counts it as one of its own attempts (#179).
           */
          if (this.gate === probe) {
            this.gate =
              outcome?.kind === 'answered' ? OPEN_GATE : { state: 'closed', reopensAt: Date.now() };
          }
          settle(outcome?.kind === 'unanswered' ? outcome : undefined);
        },
      };
    }
  }

  /** The error for a call made while the cool-down runs — nothing was sent. */
  private cooldownRefusal(): McpError {
    const retryAfter = this.cooldownSecondsRemaining();
    return rateLimited(
      `SEC EDGAR request not sent: SEC is rate-limiting this server's IP, and requests are held for another ${retryAfter}s so the block can clear.`,
      {
        reason: RATE_LIMITED_REASON,
        retryable: true,
        retryAfter,
        recovery: { hint: rateLimitHint(retryAfter) },
      },
    );
  }

  /** Whole seconds until the gate reopens — never below 1, since a caller told to wait 0s is refused again. */
  private cooldownSecondsRemaining(): number {
    const gate = this.gate;
    const remainingMs = gate.state === 'closed' ? gate.reopensAt - Date.now() : 0;
    return Math.max(1, Math.ceil(remainingMs / 1000));
  }

  private getTickerCache(scope: CallScope): Promise<TickerCache> {
    const cache = this.tickerCache;
    if (cache && this.isFresh(cache.loadedAt)) {
      if (cache.fundRetryAt === undefined || Date.now() < cache.fundRetryAt) {
        return Promise.resolve(cache);
      }
      // The live fund slice failed and its retry window has passed: refetch it
      // onto the cached base, which keeps its own load time and TTL (#119).
      return this.loadTickerCacheOnce(scope, (load) => this.reloadFundSlice(cache, load));
    }
    return this.loadTickerCacheOnce(scope, (load) => this.loadTickerCache(load));
  }

  /**
   * Singleflight: concurrent callers (e.g. fetch-frames enriching ~5k reporters
   * in parallel) share one in-flight load instead of each queuing its own SEC
   * fetch through the pacer. The load runs under a scope of its own — its own
   * failure budget, and no caller's signal — so one waiter's cancel ends only its
   * own wait while the load completes and caches for the rest; each waiter is
   * charged the failure time the load spent while it waited (#179). A call already
   * cancelled starts no load.
   */
  private async loadTickerCacheOnce(
    waiter: CallScope,
    load: (scope: CallScope) => Promise<TickerCache>,
  ): Promise<TickerCache> {
    waiter.signal.throwIfAborted();
    if (!this.tickerCacheLoad) {
      const scope = CallScope.unowned();
      const promise = load(scope).finally(() => {
        this.tickerCacheLoad = undefined;
      });
      this.tickerCacheLoad = { promise, scope, waits: new Map() };
    }
    return await awaitShared(this.tickerCacheLoad, waiter);
  }

  /** Load the whole ticker index: its base, then the live fund slice when the base calls for one. */
  private async loadTickerCache(scope: CallScope): Promise<TickerCache> {
    const base = await this.loadTickerBase(scope);
    const funds = base.liveFunds ? await this.loadMfTickers(scope) : NO_LIVE_FUNDS;
    return this.buildTickerCache(base.rows, funds, Date.now());
  }

  /** Refetch a failed live fund slice and rebuild the index on the cached base. */
  private async reloadFundSlice(cache: TickerCache, scope: CallScope): Promise<TickerCache> {
    return this.buildTickerCache(cache.baseRows, await this.loadMfTickers(scope), cache.loadedAt);
  }

  /**
   * Everything the ticker index holds but the live fund slice, preferring the local
   * mirror when it is enabled and synced; company_tickers.json is the cold-start /
   * not-ready fallback and the only source when the mirror is off. `liveFunds` says
   * whether company_tickers_mf.json supplements it: always on the live path, and on
   * the mirror path under `mirrorFallbackLive`, where it covers a mirror synced
   * before fund ingestion (#43) and is the only source of series and class IDs,
   * since the mirror stores a fund symbol as a bare ticker → CIK row. Strict mirror
   * mode reads nothing live, so the mirror's fund rows are its only fund tickers.
   */
  private async loadTickerBase(
    scope: CallScope,
  ): Promise<{ liveFunds: boolean; rows: TickerIndexRow[] }> {
    const mirror = getEdgarMirror();
    if (mirror && (await mirror.tickersReady())) {
      const rows = await mirror.getTickerRows();
      if (rows.length > 0) {
        return {
          liveFunds: getServerConfig().mirrorFallbackLive,
          rows: rows.map(mirrorIndexRow),
        };
      }
    } else if (mirror && !getServerConfig().mirrorFallbackLive) {
      throw serviceUnavailable(
        'EDGAR mirror enabled but the ticker layer is not synced; run `bun run mirror:init`',
        { layer: 'tickers' },
      );
    }

    const raw = await this.fetchJson<Record<string, TickerEntry>>(
      'https://www.sec.gov/files/company_tickers.json',
      scope,
    );
    return {
      liveFunds: true,
      rows: Object.values(raw).map(
        (entry): EquityRow => ({
          cik: String(entry.cik_str).padStart(10, '0'),
          kind: 'equity',
          name: entry.title,
          ticker: entry.ticker,
        }),
      ),
    };
  }

  /**
   * Fetch company_tickers_mf.json (ETFs and mutual funds) as fund rows carrying
   * series and class IDs. Never throws: operating-company resolution must not
   * depend on the fund file. A failed load — any HTTP failure, no HTTP response
   * at all (#173), a body that fails to read or is not JSON (#181), a malformed
   * body, or the block gate's local refusal — returns no rows and a `retryAt`, so
   * the index without funds stands for the retry
   * window rather than the whole TTL (#119). The window is at least the error's
   * `retryAfter`, so a load refused by the rate-limit gate is not retried until
   * the cool-down ends. It runs only inside the shared ticker load, whose scope no
   * caller can cancel, so a failure here is always SEC's — a spent failure budget
   * included (#179).
   */
  private async loadMfTickers(scope: CallScope): Promise<FundSlice> {
    let retryAfterMs = 0;
    let cause: Record<string, unknown> = { reason: 'malformed_body' };
    try {
      const rows = parseMfTickerFile(await this.fetchJson<MfTickerFile>(MF_TICKERS_URL, scope));
      if (rows) return { retryAt: undefined, rows };
    } catch (error) {
      const data = error instanceof McpError ? error.data : undefined;
      if (typeof data?.retryAfter === 'number') retryAfterMs = data.retryAfter * 1000;
      cause = {
        ...(typeof data?.status === 'number' && { status: data.status }),
        ...(typeof data?.reason === 'string' && { reason: data.reason }),
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const retryMs = Math.max(FUND_SLICE_RETRY_MS, retryAfterMs);
    // Background index maintenance with no request of its own to attach to, so the
    // global logger carries it (#43).
    logger.warning(
      'Fund-ticker file (company_tickers_mf.json) failed to load; ETF and mutual-fund tickers stay unresolved until it is retried.',
      withExtra(requestContextService.createRequestContext({ operation: 'loadMfTickers' }), {
        endpoint: 'company_tickers_mf',
        retryInSeconds: Math.ceil(retryMs / 1000),
        ...cause,
      }),
    );
    return { retryAt: Date.now() + retryMs, rows: [] };
  }

  /**
   * Build the in-memory index. Equity rows fill `byTicker`, `byCik`, and — when they
   * carry a name — `allEntries` for name search. Fund rows fill `byTicker` only,
   * never `byCik`, because a registrant trust (CIK 36405 = Vanguard Index Funds)
   * holds many series; live fund rows also fill `bySeriesId`. On a shared symbol the
   * first to claim it wins, in the order equity, live fund, mirror fund: a fund
   * symbol never overrides an operating-company ticker on the rare cross-file
   * collision (SPCX), and a live fund entry, carrying series and class, supersedes
   * the mirror's bare row for the same symbol (#135). Former names from the
   * committed asset go into `allEntries` only.
   */
  private buildTickerCache(
    baseRows: TickerIndexRow[],
    funds: FundSlice,
    loadedAt: number,
  ): TickerCache {
    const byTicker = new Map<string, CikMatch>();
    const byCik = new Map<string, CikMatch>();
    const bySeriesId = new Map<string, CikMatch>();
    const allEntries: CikMatch[] = [];
    const mirrorFunds: FundRow[] = [];

    for (const row of baseRows) {
      if (row.kind === 'fund') {
        mirrorFunds.push(row);
        continue;
      }
      const match: CikMatch = {
        cik: row.cik,
        ticker: row.ticker,
        ...(row.name ? { name: row.name } : {}),
      };
      byTicker.set(row.ticker.toUpperCase(), match);
      const existing = byCik.get(match.cik);
      byCik.set(match.cik, existing ? pickPreferredTicker(existing, match) : match);
      if (match.name) allEntries.push(match);
    }

    for (const row of [...funds.rows, ...mirrorFunds]) {
      const match: CikMatch = {
        cik: row.cik,
        ticker: row.ticker,
        ...(row.seriesId ? { seriesId: row.seriesId } : {}),
        ...(row.classId ? { classId: row.classId } : {}),
      };
      const tickerKey = row.ticker.toUpperCase();
      if (!byTicker.has(tickerKey)) byTicker.set(tickerKey, match);

      // A series has one row per listed share class, so the first class registers the
      // series; later classes of the same series would only re-point it at the same trust.
      const seriesKey = row.seriesId?.toUpperCase();
      if (seriesKey && !bySeriesId.has(seriesKey)) bySeriesId.set(seriesKey, match);
    }

    for (const former of buildFormerNameEntries()) {
      allEntries.push({ cik: former.cik, name: former.name });
    }

    this.tickerCache = {
      allEntries,
      baseRows,
      byCik,
      bySeriesId,
      byTicker,
      fundRetryAt: funds.retryAt,
      loadedAt,
    };
    return this.tickerCache;
  }
}

/**
 * The units of an XBRL concept, keeping only those whose value is an array.
 * SEC's companyconcept endpoint serves some filers' units as an empty object —
 * `"units":{"USD":{}}` for Visa's and Coca-Cola's NetIncomeLoss — and the mirror
 * stores payloads as served, while every reader iterates a unit as a list of
 * facts. Dropped here, at the edge, a malformed unit reads as one the filer
 * reported nothing under (#141).
 */
function arrayUnits(
  units: Record<string, unknown> | undefined,
): Record<string, CompanyConceptUnit[]> {
  const kept: Record<string, CompanyConceptUnit[]> = {};
  for (const [unit, values] of Object.entries(units ?? {})) {
    if (Array.isArray(values)) kept[unit] = values;
  }
  return kept;
}

/**
 * Classify a mirror ticker row. The mirror schema has no series or class column:
 * tickers-sync stores a fund symbol from company_tickers_mf.json with an empty
 * name, and every operating-company row with its registrant title, so the empty
 * name is what marks a fund (#135).
 */
function mirrorIndexRow(row: { cik: string; name: string; ticker: string }): TickerIndexRow {
  return row.name
    ? { cik: row.cik, kind: 'equity', name: row.name, ticker: row.ticker }
    : { cik: row.cik, kind: 'fund', ticker: row.ticker };
}

/**
 * Parse company_tickers_mf.json — columnar, with a `fields` header naming each
 * column — into fund rows. Returns `undefined` when the body lacks that shape or
 * the `cik` and `symbol` columns, which the caller treats as a failed load.
 */
function parseMfTickerFile(raw: MfTickerFile | null | undefined): FundRow[] | undefined {
  if (!Array.isArray(raw?.fields) || !Array.isArray(raw?.data)) return;
  const column = {
    cik: raw.fields.indexOf('cik'),
    classId: raw.fields.indexOf('classId'),
    seriesId: raw.fields.indexOf('seriesId'),
    symbol: raw.fields.indexOf('symbol'),
  };
  if (column.cik < 0 || column.symbol < 0) return;

  return raw.data
    .filter((row) => row[column.symbol])
    .map((row) => {
      const seriesId = column.seriesId >= 0 ? String(row[column.seriesId] ?? '') : '';
      const classId = column.classId >= 0 ? String(row[column.classId] ?? '') : '';
      return {
        cik: String(row[column.cik]).padStart(10, '0'),
        kind: 'fund',
        ticker: String(row[column.symbol]),
        ...(seriesId ? { seriesId } : {}),
        ...(classId ? { classId } : {}),
      };
    });
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
 * URL of a file in a filing's archive directory. The path carries the CIK with its
 * leading zeros stripped: SEC answers the zero-padded path with a 301 to the
 * unpadded one, which `fetch` follows inside the same pacer slot, so a padded URL
 * costs two requests (#156). Only the `data.sec.gov` APIs take the padded form.
 */
export function filingArchiveUrl(cik: string, accessionNumber: string, file: string): string {
  const unpadded = cik.replace(/^0+(?=\d)/, '');
  const noDashes = accessionNumber.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${unpadded}/${noDashes}/${file}`;
}

/**
 * Enumerate the calendar quarters overlapping the inclusive [startDate, endDate]
 * range (both YYYY-MM-DD), returned NEWEST-first like the archive-page walk's
 * default order — a capped scan then keeps the most recent quarters, consistent with the
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

/** Sleep `ms`, or until `signal` fires — then reject with its reason. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/**
 * `promise`, or the rejection `signal` fires with, whichever comes first. A wait on
 * work this call does not own — the block-gate probe, the shared ticker load —
 * leaves that work running when the caller cancels.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

/**
 * Wait on a shared load under the waiter's own signal, charging the waiter the
 * failure time the load spent while it waited — no more, so a call that joins a
 * load late is not billed for the failures before it asked (#179). One wait per
 * call: a call already waiting joins that wait.
 */
function awaitShared<T>(shared: SharedLoad<T>, waiter: CallScope): Promise<T> {
  let wait = shared.waits.get(waiter);
  if (!wait) {
    const spentBefore = shared.scope.spentMs;
    wait = untilAborted(shared.promise, waiter.signal).finally(() => {
      waiter.charge(shared.scope.spentMs - spentBefore);
    });
    shared.waits.set(waiter, wait);
  }
  return wait;
}

/**
 * One `fetch` under the caller's signal, aborted when no response headers arrive
 * within the lesser of {@link ATTEMPT_HEADERS_TIMEOUT_MS} and the call's failure
 * budget left (#179) — or, with no budget left, not sent at all. The timer is
 * cleared once `fetch` settles, so the body read is never bounded by it. `fetch`
 * rejects with whatever reason the signal carries, so the timeout is recognized by
 * the reason's identity; once the caller's signal has fired, the rejection is
 * rethrown as it came. A controller and `setTimeout` rather than
 * `AbortSignal.timeout()` or `AbortSignal.any()`, as the framework's
 * `fetchWithTimeout` does: those can fail on a realm mismatch under Bun.
 */
async function fetchUntilHeaders(
  url: string,
  headers: Record<string, string>,
  scope: CallScope,
): Promise<Attempt | BudgetSpent> {
  scope.signal.throwIfAborted();
  const capMs = Math.min(ATTEMPT_HEADERS_TIMEOUT_MS, scope.remainingMs);
  if (capMs <= 0) return BUDGET_SPENT;
  const controller = new AbortController();
  const deadline = new DOMException(`No response headers within ${capMs}ms.`, 'TimeoutError');
  const timer = setTimeout(() => controller.abort(deadline), capMs);
  const cancel = () => controller.abort(scope.signal.reason);
  scope.signal.addEventListener('abort', cancel, { once: true });
  const dispatchedAt = Date.now();
  try {
    const response = await globalThis.fetch(url, { headers, signal: controller.signal });
    return { kind: 'answered', response, waitedMs: Date.now() - dispatchedAt };
  } catch (rejection) {
    if (scope.signal.aborted) throw rejection;
    return {
      kind: 'unanswered',
      capMs,
      rejection,
      timedOut: controller.signal.reason === deadline,
      waitedMs: Date.now() - dispatchedAt,
    };
  } finally {
    clearTimeout(timer);
    scope.signal.removeEventListener('abort', cancel);
  }
}

/**
 * Read one attempt's body as text — whole, or up to `cutoff` — failing the read once
 * no bytes arrive for the lesser of {@link BODY_IDLE_TIMEOUT_MS} and the call's
 * failure budget left (#179). The one place an attempt's body is read (#181). The
 * body is cancelled once the read stops, so an early stop at the cutoff, a stall,
 * and the caller's cancel all release the connection without reading the rest; a
 * cancel that fails is not a body failure, since the body is being discarded either
 * way. Both cutoff checks run between reads, so neither can cut below one read
 * chunk. Once the caller's signal has fired, the read's rejection is rethrown as
 * it came, never a body failure.
 */
async function readBody(
  response: Response,
  scope: CallScope,
  cutoff?: HeadCutoff,
): Promise<BodyRead> {
  if (!response.body) return { kind: 'read', text: '' };
  const stalled = new DOMException("No body bytes within the read's idle limit.", 'TimeoutError');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let capMs = 0;
  let readFrom = 0;
  try {
    while (cutoff === undefined || bytes < cutoff.maxBytes) {
      capMs = Math.min(BODY_IDLE_TIMEOUT_MS, scope.remainingMs);
      readFrom = Date.now();
      const { done, value } = await nextChunk(reader, stalled, capMs, scope.signal);
      if (done) {
        text += decoder.decode();
        break;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (cutoff !== undefined && text.includes(cutoff.stopAt)) break;
    }
    return { kind: 'read', text };
  } catch (rejection) {
    if (scope.signal.aborted) throw rejection;
    // A stall is this read's own idle marker, recognized by identity.
    return {
      kind: 'body_failed',
      capMs,
      rejection,
      stalled: rejection === stalled,
      waitedMs: Date.now() - readFrom,
    };
  } finally {
    await reader.cancel().catch(() => {
      /* the body is being discarded; a cancel racing its end has nothing to report */
    });
  }
}

/**
 * The body's next read, rejecting with `stalled` once `capMs` pass with no bytes,
 * and with the signal's reason once it fires.
 */
async function nextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stalled: DOMException,
  capMs: number,
  signal: AbortSignal,
) {
  // Checked before the read: a chunk already buffered would otherwise win the race.
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const idle = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(stalled), capMs);
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * True when the failure budget cut the attempt's last wait short of its own cap —
 * headers or body bytes that might still have come (#179).
 */
function cutByBudget(last: Attempt | BodyFailedAttempt): boolean {
  switch (last.kind) {
    case 'answered':
      return false;
    case 'unanswered':
      return last.timedOut && last.capMs < ATTEMPT_HEADERS_TIMEOUT_MS;
    case 'body_failed':
      return last.stalled && last.capMs < BODY_IDLE_TIMEOUT_MS;
    default: {
      const unhandled: never = last;
      return unhandled;
    }
  }
}

/** How a failure the call's failure budget ended says so, in its message (#179). */
const BUDGET_STOP_TEXT = `retries stopped at this call's ${CALL_FAILURE_BUDGET_MS / 1000} s budget for SEC failures`;

/** A wait in seconds, to one decimal where it is not whole: `15`, `9.1`. */
function seconds(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

/**
 * Parse a 200's body as JSON. Every SEC route read as JSON serves JSON, so a body
 * that does not parse — an HTML error page served as a 200 — fails as
 * `sec_unreachable`, unretried since the body arrived whole; the parser's text,
 * which quotes the body, rides `cause` only (#181).
 */
function parseJson<T>(url: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (rejection) {
    throw secUnreachable(url, { kind: 'not_json', rejection });
  }
}

/**
 * The failure once SEC gave no complete, readable answer. For the two ladder cases
 * — no HTTP response (#173), a body that failed to read (#181) — the earlier
 * attempts may have drawn a 5xx or failed the other way, so the message claims only
 * the last. Message and `data` are composed here from the host, the attempt count,
 * and the last attempt's transport code or timeout: the runtime's own text is
 * developer-facing (Bun's advice to pass `verbose: true`, its "Is the computer able
 * to access the url?"), and Bun carries the full request URL on `path` and, for
 * some body failures, in its message. The rejection rides `cause`, which the log
 * records and the caller never sees. A ladder the call's failure budget ended
 * names the attempt it ended on and the budget (#179).
 */
function secUnreachable(url: string, last: Unreadable, end?: LadderEnd): McpError {
  const host = new URL(url).hostname;
  const { message, hint } = unreadableText(host, last, end);
  return serviceUnavailable(
    message,
    { reason: SEC_UNREACHABLE_REASON, retryable: true, url, recovery: { hint } },
    last.kind === 'budget_spent' ? undefined : { cause: last.rejection },
  );
}

/** The message and recovery hint for each way SEC's answer was unreadable. */
function unreadableText(
  host: string,
  last: Unreadable,
  end: LadderEnd | undefined,
): { hint: string; message: string } {
  const transportEnding = (rejection: unknown) =>
    `ended with ${transportCode(rejection) ?? 'a network error that carried no code'}`;
  const onAttempt = end?.budgetStopped
    ? `attempt ${end.attempt} of ${MAX_RETRIES}`
    : `the last of ${MAX_RETRIES} attempts`;
  const close = end?.budgetStopped ? `; ${BUDGET_STOP_TEXT}.` : '.';
  switch (last.kind) {
    case 'unanswered':
      return {
        message: `No HTTP response from SEC EDGAR (${host}) on ${onAttempt}, which ${last.timedOut ? `got no response headers within ${seconds(last.capMs)} s` : transportEnding(last.rejection)}${close}`,
        hint: `SEC EDGAR (${host}) sent no HTTP response to the last attempt — a network failure between this server and SEC, not a problem with the request. Retry the same call in a minute.`,
      };
    case 'body_failed':
      return {
        message: `The response body from SEC EDGAR (${host}) failed to read on ${onAttempt}, which ${last.stalled ? `got no body bytes for ${seconds(last.capMs)} s` : transportEnding(last.rejection)}${close}`,
        hint: `SEC EDGAR (${host}) answered the last attempt, but its response body broke off or stalled before it finished — a network failure between this server and SEC, not a problem with the request. Retry the same call in a minute.`,
      };
    case 'budget_spent':
      return {
        message: `No request sent to SEC EDGAR (${host}): ${BUDGET_STOP_TEXT}, which its earlier requests spent.`,
        hint: `SEC EDGAR (${host}) failed this call's earlier requests until its budget for SEC failures ran out — a network failure between this server and SEC, not a problem with the request. Retry the same call in a minute.`,
      };
    case 'not_json':
      return {
        message: `SEC EDGAR (${host}) answered, but its response body is not the JSON this request expects.`,
        hint: `SEC EDGAR (${host}) answered with something other than the JSON it serves for this request, such as a temporary error page — not a problem with the request. Retry the same call in a minute.`,
      };
    default: {
      const unhandled: never = last;
      return unhandled;
    }
  }
}

/** An identifier-shaped transport code: `ECONNRESET`, `EAI_AGAIN`, `UND_ERR_CONNECT_TIMEOUT`. */
const TRANSPORT_CODE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The transport code on a `fetch` or body-read rejection. Bun sets it on the
 * rejection itself (`code: 'ECONNRESET'`, `'InvalidHTTPResponse'`, `'ZlibError'`,
 * no `cause`); Node's undici rejects with `TypeError('fetch failed')` or, mid-body,
 * `TypeError('terminated')` and sets it on `cause` — when it has one: its
 * chunk-framing `HTTPParserError` carries none. Read from the field, never the
 * message, whose wording differs by runtime and version.
 */
function transportCode(rejection: unknown): string | undefined {
  const codeOf = (value: unknown) => {
    const code = typeof value === 'object' && value !== null && 'code' in value && value.code;
    return typeof code === 'string' && TRANSPORT_CODE.test(code) ? code : undefined;
  };
  return codeOf(rejection) ?? (rejection instanceof Error ? codeOf(rejection.cause) : undefined);
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

/** Stop the service's request pacer — wired through `createApp({ teardown })`. */
export function disposeEdgarApiService(): void {
  _service?.dispose();
}
