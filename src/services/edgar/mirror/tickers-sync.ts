/**
 * @fileoverview Ingester for the ticker/CIK layer. Downloads SEC's
 * `company_tickers.json` (operating companies) and `company_tickers_mf.json`
 * (ETFs and mutual funds), merges them, and yields one page of rows.
 * Upsert-only: the directory rarely drops entries and CIKs are permanent,
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

/** SEC mutual-fund ticker file format (columnar). */
interface MfTickerFile {
  data: Array<[number, string, string, string]>;
  fields: string[];
}

/** URL for SEC's mutual-fund / ETF ticker directory. */
const MF_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_mf.json';

/**
 * Build the ticker-layer ingester. The returned generator downloads both
 * company_tickers.json (operating companies) and company_tickers_mf.json
 * (ETFs and mutual funds), merges them into a single page, and yields it.
 * The files are small, so refresh simply re-downloads and re-upserts.
 *
 * Mirror schema carries only {ticker, cik, name} — no series/class columns.
 * Fund entries are ingested with an empty name (the name field is absent from
 * company_tickers_mf.json). They resolve by ticker on the mirror path just as
 * they do on the live path; seriesId/classId enrichment is live-path-only.
 */
export function makeTickersSync(opts: { userAgent: string }): SyncGenerator {
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

    // Operating-company tickers take precedence on a cross-file symbol collision (e.g. SPCX),
    // so a fund symbol is skipped when it duplicates an equity ticker already ingested above.
    const equityTickers = new Set(records.map((r) => r.ticker));

    // Fetch ETF/mutual-fund tickers — non-fatal on failure.
    try {
      const mfResponse = await fetch(MF_TICKERS_URL, { headers, signal: ctx.signal });
      if (mfResponse.ok) {
        const mfRaw = (await mfResponse.json()) as MfTickerFile;
        if (Array.isArray(mfRaw?.fields) && Array.isArray(mfRaw?.data)) {
          const symbolIdx = mfRaw.fields.indexOf('symbol');
          const cikIdx = mfRaw.fields.indexOf('cik');
          if (symbolIdx >= 0 && cikIdx >= 0) {
            for (const row of mfRaw.data) {
              const symbol = row[symbolIdx];
              if (!symbol) continue;
              const ticker = String(symbol).toUpperCase();
              if (equityTickers.has(ticker)) continue;
              records.push({
                ticker,
                cik: String(row[cikIdx]).padStart(10, '0'),
                name: '',
              });
            }
          }
        }
      }
    } catch {
      // Non-fatal — mirror will resolve operating companies; fund tickers will miss.
    }

    // Checkpoint must be lexicographically monotonic — store ISO 8601, not the raw HTTP-date.
    const checkpoint = lastModifiedToIso(response.headers.get('last-modified'));
    yield { records, checkpoint };
  };
}
