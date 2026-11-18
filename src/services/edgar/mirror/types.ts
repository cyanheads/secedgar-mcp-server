/**
 * @fileoverview Constants and row shapes for the EDGAR local mirror — the two
 * bounded SEC reference layers (ticker/CIK resolution and XBRL company-facts)
 * mirrored into embedded SQLite via the framework `MirrorService` — and the
 * company_tickers.json parser the live ticker index and the mirror's ticker
 * sync share.
 * @module services/edgar/mirror/types
 */

import { isRecord } from '@cyanheads/mcp-ts-core/utils';

/** SEC ticker→CIK directory (direct-download JSON, about 800 KB: 796,507 bytes on 2026-11-08). */
export const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

/** SEC mutual-fund / ETF ticker directory. */
export const MF_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_mf.json';

/** SEC bulk XBRL company-facts archive, recompiled nightly (~1.3 GB). */
export const COMPANY_FACTS_ZIP_URL =
  'https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip';

/** Primary table for the ticker/CIK layer. */
export const TICKERS_TABLE = 'tickers';

/** Primary table for the XBRL company-facts layer (one row per cik×taxonomy×tag). */
export const COMPANY_CONCEPTS_TABLE = 'company_concepts';

/** SQLite filenames inside the mirror directory (`EDGAR_MIRROR_PATH`). */
export const TICKERS_DB_FILE = 'tickers.sqlite';
export const COMPANY_FACTS_DB_FILE = 'companyfacts.sqlite';

/**
 * Convert an HTTP `Last-Modified` value to a lexicographically-monotonic ISO 8601
 * checkpoint string, falling back to the current timestamp when absent or unparseable.
 */
export function lastModifiedToIso(httpDate: string | null | undefined): string {
  if (httpDate) {
    const t = Date.parse(httpDate);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

/** One row of the `tickers` table — a single entry from company_tickers.json or company_tickers_mf.json. */
export interface TickerRow {
  /** Zero-padded 10-digit CIK. */
  cik: string;
  /**
   * SEC-conformed entity name (the `title` field). Empty for a fund symbol from
   * company_tickers_mf.json, which carries none — the one marker in this schema
   * that tells a fund row from an operating company's.
   */
  name: string;
  /** Uppercased ticker symbol — primary key (e.g. "AAPL", "BRK-A"). */
  ticker: string;
}

/**
 * Parse company_tickers.json — `{ cik_str, ticker, title }` entries keyed by index — into
 * rows with a zero-padded CIK, skipping any entry without that shape. The ticker stays as
 * written: the live index keys it uppercased and the mirror stores it so. `undefined` when
 * no entry has the shape: the live index fails such a 200 like any unreadable answer
 * (#234), and the mirror's ticker sync refuses it rather than read it as every symbol
 * dropped (#247).
 */
export function parseTickerFile(raw: unknown): TickerRow[] | undefined {
  if (!isRecord(raw)) return;
  const rows: TickerRow[] = [];
  for (const entry of Object.values(raw)) {
    if (!isRecord(entry) || typeof entry.title !== 'string') continue;
    if (typeof entry.ticker !== 'string' || !entry.ticker) continue;
    if (typeof entry.cik_str !== 'number' && typeof entry.cik_str !== 'string') continue;
    rows.push({
      cik: String(entry.cik_str).padStart(10, '0'),
      name: entry.title,
      ticker: entry.ticker,
    });
  }
  return rows.length > 0 ? rows : undefined;
}

/**
 * One row of the `company_concepts` table — a single (cik, taxonomy, tag) concept
 * from a company's `companyfacts` entry. The full `units` map is stored verbatim
 * as a JSON blob so a point read reconstructs the `companyconcept` API shape and a
 * `taxonomy+tag` scan reconstructs the `frames` API shape, both off one table.
 */
export interface CompanyConceptRow {
  /** Zero-padded 10-digit CIK. */
  cik: string;
  /** Taxonomy description; null when the source omits it. */
  description: string | null;
  /** SEC-conformed entity name. */
  entity_name: string;
  /** `${cik}|${taxonomy}|${tag}` — primary key. */
  id: string;
  /** Concept label. */
  label: string;
  /** XBRL tag (e.g. "Revenues"). */
  tag: string;
  /** XBRL taxonomy (e.g. "us-gaap", "ifrs-full", "dei"). */
  taxonomy: string;
  /** `JSON.stringify` of the concept's `units` map (`{ [unit]: CompanyConceptUnit[] }`). */
  units_json: string;
}
