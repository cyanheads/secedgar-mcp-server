/**
 * @fileoverview Constants and row shapes for the EDGAR local mirror — the two
 * bounded SEC reference layers (ticker/CIK resolution and XBRL company-facts)
 * mirrored into embedded SQLite via the framework `MirrorService`.
 * @module services/edgar/mirror/types
 */

/** SEC ticker→CIK directory (small direct-download JSON, ~200 KB). */
export const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

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

/** One row of the `tickers` table — a single entry from company_tickers.json. */
export interface TickerRow {
  /** Zero-padded 10-digit CIK. */
  cik: string;
  /** SEC-conformed entity name (the `title` field). */
  name: string;
  /** Uppercased ticker symbol — primary key (e.g. "AAPL", "BRK-A"). */
  ticker: string;
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
