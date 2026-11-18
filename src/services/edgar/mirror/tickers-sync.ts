/**
 * @fileoverview Ingester for the ticker/CIK layer. Downloads SEC's
 * `company_tickers.json` (operating companies) and `company_tickers_mf.json`
 * (ETFs and mutual funds), merges them, and yields one page that makes the
 * store list what the files list: their rows upserted, and every stored symbol
 * the page does not write deleted in the same transaction (#247). A symbol that
 * left the files then reads as it does live, as a former ticker from the
 * committed asset or no match. Fund rows are deleted only when the fund file
 * loaded; a company_tickers.json listing no ticker fails the sync, and so does
 * a refresh that would delete more than a quarter of either kind's stored rows,
 * leaving the store as it was; `init` applies such a drop.
 * @module services/edgar/mirror/tickers-sync
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type {
  MirrorLogger,
  MirrorRow,
  SyncContext,
  SyncGenerator,
  SyncMode,
  SyncPage,
} from '@cyanheads/mcp-ts-core/mirror';
import {
  lastModifiedToIso,
  MF_TICKERS_URL,
  parseTickerFile,
  TICKERS_URL,
  type TickerRow,
} from './types.js';

/**
 * The most of either kind's stored rows one refresh may delete. A month's churn in
 * SEC's ticker file stays far below it, so a file dropping more is likelier truncated
 * or stale than current; `init` applies such a drop.
 */
const MAX_REFRESH_DELETION_SHARE = 0.25;

/** SEC mutual-fund ticker file format (columnar). */
interface MfTickerFile {
  data: Array<[number, string, string, string]>;
  fields: string[];
}

/**
 * Build the ticker-layer ingester. The returned generator downloads both
 * company_tickers.json (operating companies) and company_tickers_mf.json
 * (ETFs and mutual funds), merges them into a single page, and yields it with
 * the stored symbols the page does not write as its tombstones. The files are
 * small, so every sync re-downloads them whole.
 *
 * Mirror schema carries only {ticker, cik, name} — no series/class columns.
 * Fund entries are ingested with an empty name (the name field is absent from
 * company_tickers_mf.json), which is how the ticker index and the deletion
 * bound tell them from operating companies. They resolve by ticker to their
 * registrant CIK; seriesId and classId come only from the live fund file,
 * which supersedes these rows when `EDGAR_MIRROR_FALLBACK_LIVE` merges it in.
 */
export function makeTickersSync(opts: {
  log?: MirrorLogger;
  /** Every stored row, read as the page is built: the rows a sync may delete. */
  storedRows: () => Promise<TickerRow[]>;
  userAgent: string;
}): SyncGenerator {
  return async function* tickersSync(ctx: SyncContext): AsyncGenerator<SyncPage> {
    const headers = { 'User-Agent': opts.userAgent, Accept: 'application/json' };

    // Fetch operating-company tickers
    const response = await fetch(TICKERS_URL, { headers, signal: ctx.signal });
    if (!response.ok) {
      throw serviceUnavailable(
        `SEC company_tickers.json download failed (HTTP ${response.status})`,
        { url: TICKERS_URL, status: response.status },
      );
    }
    const equity = parseTickerFile(await response.json());
    if (!equity) {
      throw serviceUnavailable(
        'SEC company_tickers.json listed no ticker, so the ticker sync wrote nothing and the stored rows stand. Sync again once SEC serves the whole file.',
        { url: TICKERS_URL },
      );
    }
    const records: MirrorRow[] = equity.map((row) => ({
      ticker: row.ticker.toUpperCase(),
      cik: row.cik,
      name: row.name,
    }));

    // Operating-company tickers take precedence on a cross-file symbol collision (e.g. SPCX),
    // so a fund symbol is skipped when it duplicates an equity ticker already ingested above.
    const equityTickers = new Set(records.map((r) => r.ticker));
    const funds = await fetchFundRows(headers, ctx.signal);
    if (funds) {
      for (const row of funds) if (!equityTickers.has(row.ticker)) records.push(row);
    } else {
      opts.log?.warning?.(
        'company_tickers_mf.json did not load, so this ticker sync keeps every stored fund symbol as it was.',
        { url: MF_TICKERS_URL },
      );
    }

    const tombstones = droppedSymbols(
      await opts.storedRows(),
      new Set(records.map((r) => r.ticker)),
      ctx.mode,
      funds !== undefined,
    );
    // Checkpoint must be lexicographically monotonic — store ISO 8601, not the raw HTTP-date.
    const checkpoint = lastModifiedToIso(response.headers.get('last-modified'));
    yield { records, tombstones, checkpoint };
  };
}

/**
 * company_tickers_mf.json as fund rows (an empty name, the schema's fund marker), or
 * `undefined` when it fails to load or lacks the `cik` and `symbol` columns. Its failure
 * never fails the sync — operating-company rows sync without it — but the caller's
 * cancel rethrows.
 */
async function fetchFundRows(
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<MirrorRow[] | undefined> {
  try {
    const response = await fetch(MF_TICKERS_URL, { headers, signal });
    if (!response.ok) return;
    const raw = (await response.json()) as MfTickerFile;
    if (!Array.isArray(raw?.fields) || !Array.isArray(raw?.data)) return;
    const symbolIdx = raw.fields.indexOf('symbol');
    const cikIdx = raw.fields.indexOf('cik');
    if (symbolIdx < 0 || cikIdx < 0) return;
    const rows: MirrorRow[] = [];
    for (const row of raw.data) {
      const symbol = row[symbolIdx];
      if (!symbol) continue;
      rows.push({
        ticker: String(symbol).toUpperCase(),
        cik: String(row[cikIdx]).padStart(10, '0'),
        name: '',
      });
    }
    return rows;
  } catch {
    signal.throwIfAborted();
    return;
  }
}

/**
 * The stored symbols the page does not write, which it deletes. A symbol that moved
 * from one file to the other is written, so never deleted, and a fund row is deleted
 * only when the fund file loaded. A refresh that would delete more than
 * {@link MAX_REFRESH_DELETION_SHARE} of either kind's stored rows throws instead,
 * before the page is yielded, so it writes nothing; an `init` deletes them.
 */
function droppedSymbols(
  stored: readonly TickerRow[],
  written: ReadonlySet<unknown>,
  mode: SyncMode,
  fundsLoaded: boolean,
): string[] {
  const kinds = {
    equity: { file: 'company_tickers.json', url: TICKERS_URL, stored: 0, dropped: [] as string[] },
    fund: {
      file: 'company_tickers_mf.json',
      url: MF_TICKERS_URL,
      stored: 0,
      dropped: [] as string[],
    },
  };
  for (const row of stored) {
    const kind = row.name ? kinds.equity : kinds.fund;
    kind.stored += 1;
    if (written.has(row.ticker) || (kind === kinds.fund && !fundsLoaded)) continue;
    kind.dropped.push(row.ticker);
  }
  if (mode === 'refresh') {
    for (const { dropped, file, stored: count, url } of Object.values(kinds)) {
      if (dropped.length <= count * MAX_REFRESH_DELETION_SHARE) continue;
      throw serviceUnavailable(
        `The ticker refresh would delete ${dropped.length} of the ${count} stored ${file} symbols, more than a quarter, so it wrote nothing and the stored rows stand. A drop that large is likelier a truncated or stale file than SEC's current one; if SEC's file did drop them, \`bun run mirror:init\` applies the drop, re-ingesting companyfacts.zip as well.`,
        { url },
      );
    }
  }
  return [...kinds.equity.dropped, ...kinds.fund.dropped];
}
