/**
 * @fileoverview Ingester for the ticker/CIK layer. Downloads SEC's
 * `company_tickers.json` (small direct-download JSON) and yields one page of
 * rows. Upsert-only: the directory rarely drops entries and CIKs are permanent,
 * so a delisted ticker lingering with its historical CIK is low-harm.
 * @module services/edgar/mirror/tickers-sync
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type {
  MirrorRow,
  SyncContext,
  SyncGenerator,
  SyncPage,
} from '@cyanheads/mcp-ts-core/mirror';
import { lastModifiedToIso, TICKERS_URL } from './types.js';

/** Raw entry from company_tickers.json (object keyed by arbitrary integer index). */
interface RawTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

/**
 * Build the ticker-layer ingester. The returned generator downloads the full
 * directory and yields it as a single page; the file is tiny, so refresh simply
 * re-downloads and re-upserts.
 */
export function makeTickersSync(opts: { userAgent: string }): SyncGenerator {
  return async function* tickersSync(ctx: SyncContext): AsyncGenerator<SyncPage> {
    const response = await fetch(TICKERS_URL, {
      headers: { 'User-Agent': opts.userAgent, Accept: 'application/json' },
      signal: ctx.signal,
    });
    if (!response.ok) {
      throw serviceUnavailable(
        `SEC company_tickers.json download failed (HTTP ${response.status})`,
        {
          url: TICKERS_URL,
          status: response.status,
        },
      );
    }

    const raw = (await response.json()) as Record<string, RawTickerEntry>;
    const records: MirrorRow[] = [];
    for (const entry of Object.values(raw)) {
      if (!entry?.ticker) continue;
      records.push({
        ticker: entry.ticker.toUpperCase(),
        cik: String(entry.cik_str).padStart(10, '0'),
        name: entry.title ?? '',
      });
    }

    // Checkpoint must be lexicographically monotonic — store ISO 8601, not the raw HTTP-date.
    const checkpoint = lastModifiedToIso(response.headers.get('last-modified'));
    yield { records, checkpoint };
  };
}
