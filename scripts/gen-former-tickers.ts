/**
 * @fileoverview Offline generator for the former-tickers.json asset.
 * Reads the Wayback Machine's monthly captures of SEC's company_tickers.json and the
 * current file, and emits src/services/edgar/data/former-tickers.json: every ticker → CIK
 * pair a capture lists that the current file does not, as
 * [TICKER, zeroPaddedCIK, "YYYY-MM", title] tuples — the latest capture month listing the
 * pair (a capture date, not a delisting date) and the pair's title in that capture.
 *
 * Captures: one CDX index request (the first capture of each month), then each capture,
 * strictly sequential, at least 5 s between request starts. Captures sharing a CDX digest
 * carry the same bytes, so each digest is downloaded once. A capture repeating any digest but
 * the newest one seen so far is a stale copy SEC's CDN served again (2019-08 repeats
 * 2017-08's file byte for byte), so it adds no month. Downloads are cached
 * decoded under the cache directory, so a rerun re-reads them instead of re-fetching. A body
 * sent gzip-encoded despite `id_` is decoded; one that does not parse as the ticker file is
 * skipped and named. A 429, any other non-200 answer but a 404, or a connection failure
 * stops the run — nothing is retried; a rerun resumes from the cache.
 *
 * Runtime: ~8 min for ~80 distinct captures at the 5 s pace (seconds from a warm cache).
 * This is an offline tool — do NOT run as part of the build step.
 *
 * Usage:
 *   bun run gen:former-tickers [--cache-dir <dir>]
 *
 * Env vars:
 *   EDGAR_USER_AGENT   required — "AppName contact@email.com", sent to SEC only
 *
 * @module scripts/gen-former-tickers
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = join(ROOT_DIR, 'src/services/edgar/data/former-tickers.json');

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const CDX_URL = `https://web.archive.org/cdx/search/cdx?${new URLSearchParams({
  url: 'www.sec.gov/files/company_tickers.json',
  output: 'json',
  collapse: 'timestamp:6',
  filter: 'statuscode:200',
  fl: 'timestamp,digest',
})}`;
const captureUrl = (timestamp: string) =>
  `https://web.archive.org/web/${timestamp}id_/https://www.sec.gov/files/company_tickers.json`;

/** Spacing between Wayback request starts. */
const WAYBACK_INTERVAL_MS = 5000;
/** Redirect hops followed per capture, each paced like a request. */
const MAX_REDIRECTS = 2;
/** Biome's line width for the asset, which it formats as part of `src/**`. */
const LINE_WIDTH = 100;

const USER_AGENT = process.env.EDGAR_USER_AGENT;
if (!USER_AGENT) {
  console.error('EDGAR_USER_AGENT env var is required. Format: "AppName contact@email.com"');
  process.exit(1);
}

const cacheFlag = process.argv.indexOf('--cache-dir');
const CACHE_DIR =
  cacheFlag >= 0 ? process.argv[cacheFlag + 1] : join(tmpdir(), 'gen-former-tickers');
if (!CACHE_DIR) {
  console.error('--cache-dir needs a directory');
  process.exit(1);
}

/** One ticker-file row, normalized: uppercase symbol, padded CIK. */
interface TickerRow {
  cik: string;
  ticker: string;
  title: string;
}

/** A failure that ends the run: Wayback refused or could not be reached. */
class StopError extends Error {
  override name = 'StopError';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let lastWaybackStart = Number.NEGATIVE_INFINITY;
let waybackRequests = 0;

/** One paced Wayback request, redirects followed by hand so each hop is paced and counted. */
async function waybackFetch(url: string): Promise<Response> {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const wait = lastWaybackStart + WAYBACK_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastWaybackStart = Date.now();
    waybackRequests++;
    let response: Response;
    try {
      response = await fetch(target, { redirect: 'manual' });
    } catch (error) {
      throw new StopError(`Wayback request failed (${target}): ${String(error)}`, { cause: error });
    }
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      target = new URL(location, target).toString();
      continue;
    }
    if (response.status === 429) {
      await response.body?.cancel();
      throw new StopError(`Wayback answered 429 for ${target}; stopping without retrying.`);
    }
    return response;
  }
  throw new StopError(`Wayback redirected more than ${MAX_REDIRECTS} times for ${url}.`);
}

/** A response body's text, gunzipped when it arrives as raw gzip bytes despite `id_`. */
async function bodyText(response: Response): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

/** company_tickers.json's rows, or `undefined` when the text is not that file. */
function parseTickerFile(text: string): TickerRow[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
  const rows: TickerRow[] = [];
  for (const entry of Object.values(raw)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { cik_str: cik, ticker, title } = entry as Record<string, unknown>;
    if (typeof ticker !== 'string' || typeof title !== 'string' || ticker.trim() === '') continue;
    if (typeof cik !== 'number' && typeof cik !== 'string') continue;
    rows.push({ cik: String(cik).padStart(10, '0'), ticker: ticker.trim().toUpperCase(), title });
  }
  return rows.length > 0 ? rows : undefined;
}

/** The monthly captures CDX lists: `[timestamp, digest]`, oldest first. */
async function listCaptures(): Promise<Array<{ digest: string; timestamp: string }>> {
  const response = await waybackFetch(CDX_URL);
  if (!response.ok) throw new StopError(`Wayback CDX answered HTTP ${response.status}.`);
  const rows = JSON.parse(await bodyText(response)) as string[][];
  return rows
    .slice(1)
    .filter(
      (row): row is [string, string] => typeof row[0] === 'string' && typeof row[1] === 'string',
    )
    .map(([timestamp, digest]) => ({ digest, timestamp }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** A capture's decoded text, from the cache or Wayback; `undefined` on a 404. */
async function captureText(timestamp: string): Promise<string | undefined> {
  const cached = join(CACHE_DIR as string, `${timestamp}.json`);
  if (existsSync(cached)) return readFileSync(cached, 'utf-8');
  const response = await waybackFetch(captureUrl(timestamp));
  if (response.status === 404) {
    await response.body?.cancel();
    return;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new StopError(`Wayback answered HTTP ${response.status} for capture ${timestamp}.`);
  }
  const text = await bodyText(response);
  writeFileSync(cached, text, 'utf-8');
  return text;
}

/** One tuple as Biome formats it: inline when it fits the line width, else one value a line. */
function formatTuple(tuple: string[]): string {
  const inline = `  [${tuple.map((value) => JSON.stringify(value)).join(', ')}]`;
  if (inline.length + 1 <= LINE_WIDTH) return inline;
  return `  [\n${tuple.map((value) => `    ${JSON.stringify(value)}`).join(',\n')}\n  ]`;
}

async function main(): Promise<void> {
  mkdirSync(CACHE_DIR as string, { recursive: true });

  console.log('gen:former-tickers — fetching the current company_tickers.json from SEC...');
  const current = await fetch(TICKERS_URL, {
    headers: { 'User-Agent': USER_AGENT as string, Accept: 'application/json' },
  });
  if (!current.ok) {
    console.error(`Failed to fetch company_tickers.json: HTTP ${current.status}`);
    process.exit(1);
  }
  const currentRows = parseTickerFile(await current.text());
  if (!currentRows) {
    console.error('company_tickers.json did not parse as the ticker file');
    process.exit(1);
  }
  const currentPairs = new Set(currentRows.map((row) => `${row.ticker} ${row.cik}`));
  console.log(`  ${currentRows.length} current rows`);

  console.log('Listing Wayback captures...');
  const captures = await listCaptures();
  console.log(
    `  ${captures.length} monthly captures, ${captures[0]?.timestamp} to ${captures.at(-1)?.timestamp}`,
  );

  /** Rows per digest, so a digest is read once. */
  const rowsByDigest = new Map<string, TickerRow[] | undefined>();
  /** (TICKER CIK) → the latest month listing the pair and its title then. */
  const latest = new Map<string, { month: string; title: string }>();
  const skipped: string[] = [];
  const stale: string[] = [];
  let used = 0;
  /** The digest most recently seen for the first time: the newest file the captures hold so far. */
  let newestDigest: string | undefined;

  for (const { digest, timestamp } of captures) {
    const repeat = rowsByDigest.has(digest);
    // A repeat of anything but the newest file is a stale copy, not a listing that month.
    if (repeat && digest !== newestDigest) {
      stale.push(timestamp);
      continue;
    }
    if (!repeat) {
      newestDigest = digest;
      const text = await captureText(timestamp);
      const rows = text === undefined ? undefined : parseTickerFile(text);
      rowsByDigest.set(digest, rows);
      if (!rows) skipped.push(timestamp);
      console.log(`  ${timestamp}: ${rows ? `${rows.length} rows` : 'skipped (did not parse)'}`);
    }
    const rows = rowsByDigest.get(digest);
    if (!rows) continue;
    used++;
    const month = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}`;
    for (const row of rows) latest.set(`${row.ticker} ${row.cik}`, { month, title: row.title });
  }

  const tuples = [...latest]
    .filter(([pair]) => !currentPairs.has(pair))
    .map(([pair, { month, title }]) => {
      const [ticker, cik] = pair.split(' ') as [string, string];
      return [ticker, cik, month, title];
    })
    .sort((a, b) => {
      const [ta, ca, ma] = a as [string, string, string];
      const [tb, cb, mb] = b as [string, string, string];
      if (ta !== tb) return ta < tb ? -1 : 1;
      if (ma !== mb) return ma < mb ? 1 : -1;
      return ca < cb ? -1 : ca > cb ? 1 : 0;
    });

  writeFileSync(OUT_FILE, `[\n${tuples.map(formatTuple).join(',\n')}\n]\n`, 'utf-8');

  console.log(`\nDone. ${tuples.length} former ticker pairs written to ${OUT_FILE}`);
  console.log(
    `  captures used: ${used} of ${captures.length}; Wayback requests: ${waybackRequests}`,
  );
  if (stale.length > 0) console.log(`  stale repeats left out: ${stale.join(', ')}`);
  if (skipped.length > 0) console.log(`  skipped (did not parse or 404): ${skipped.join(', ')}`);
}

main().catch((err) => {
  console.error('gen:former-tickers failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
