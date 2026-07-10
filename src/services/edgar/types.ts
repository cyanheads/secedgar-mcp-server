/**
 * @fileoverview Domain types for SEC EDGAR API responses and internal data structures.
 * @module services/edgar/types
 */

/** CIK resolution result from company_tickers.json lookup. */
export interface CikMatch {
  cik: string;
  /** SEC fund class ID (e.g. "C000092055"). Present only for ETF/mutual-fund tickers resolved via company_tickers_mf.json. */
  classId?: string;
  exchange?: string;
  name?: string;
  /** SEC fund series ID (e.g. "S000002839"). Present only for ETF/mutual-fund tickers resolved via company_tickers_mf.json. */
  seriesId?: string;
  ticker?: string;
}

/** Raw entry from SEC's company_tickers.json. */
export interface TickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

/** Submissions API response (data.sec.gov/submissions/CIK*.json). */
export interface SubmissionsResponse {
  cik: string;
  entityType: string;
  /** Listed exchanges. SEC returns `null` elements for entities with no listed exchange (e.g. private or pre-IPO filers). */
  exchanges: Array<string | null>;
  filings: {
    recent: FilingsRecent;
    files: Array<{ name: string; filingCount: number; filingFrom: string; filingTo: string }>;
  };
  /** Fiscal year end (MMDD). `null` for filers SEC records no fiscal year end for. */
  fiscalYearEnd: string | null;
  name: string;
  sic: string;
  sicDescription: string;
  stateOfIncorporation?: string;
  tickers: string[];
}

/**
 * Parallel arrays from the submissions API filings — both the inline `recent`
 * window and the older archive pages (`filings.files[].name`, e.g.
 * `CIK0000320193-submissions-001.json`). An archive page is a flat parallel-array
 * object at the JSON root, field-compatible with `recent` plus the extra columns
 * below (present on archive pages, absent from `recent`). Only the first six arrays
 * are consumed; the rest document the real archive-page shape.
 */
export interface FilingsRecent {
  acceptanceDateTime?: string[];
  accessionNumber: string[];
  act?: string[];
  core_type?: string[];
  fileNumber?: string[];
  filingDate: string[];
  filmNumber?: string[];
  form: string[];
  isInlineXBRL?: number[];
  isXBRL?: number[];
  isXBRLNumeric?: number[];
  items?: string[];
  primaryDocDescription: string[];
  primaryDocument: string[];
  reportDate: string[];
  size?: number[];
}

/**
 * Provenance of a `secedgar_search_filings` result row — which EDGAR backend
 * served it. `efts` is the full-text index (2001-present); `submissions` and
 * `full-index` are the pre-2001 archive paths (#77).
 */
export type FilingSource = 'efts' | 'submissions' | 'full-index';

/**
 * One filing row parsed from a quarterly EDGAR full-index `master.idx`
 * (`edgar/full-index/{year}/QTR{n}/master.idx`) — the pipe-delimited
 * `CIK|Company Name|Form Type|Date Filed|Filename` manifest of every filing
 * accepted that quarter, available back to 1993 QTR1. This is the pre-2001
 * unscoped browse source: the EFTS full-text index only reaches 2001, but the
 * quarterly indexes reach 1993.
 */
export interface FullIndexEntry {
  /** Dashed accession number, derived from the manifest filename. */
  accessionNumber: string;
  /** Zero-padded 10-digit CIK. */
  cik: string;
  companyName: string;
  /** Filing date, YYYY-MM-DD. */
  filingDate: string;
  form: string;
}

/** EFTS full-text search response. */
export interface EftsResponse {
  aggregations?: {
    form_filter?: { buckets: Array<{ key: string; doc_count: number }> };
  };
  hits: {
    hits: EftsHit[];
    total: { value: number; relation: string };
  };
  query: { from: number; size: number; query: string };
}

export interface EftsHit {
  _id: string;
  _source: {
    adsh: string;
    ciks?: string[];
    display_names?: string[];
    file_date: string;
    file_description?: string;
    file_num?: string[];
    file_type?: string;
    film_num?: string[];
    form?: string;
    biz_locations?: string[];
    inc_states?: string[];
    items?: string[];
    period_ending?: string | null;
    root_forms?: string[];
    sequence?: number;
    sics?: string[];
    xsl?: string | null;
  };
}

/**
 * EFTS entity-autocomplete response (`search-index?keysTyped=`). Distinct from
 * `EftsResponse`: it resolves a typed name to filer ENTITIES (any EDGAR filer, not
 * just ticker-backed registrants), so each hit's `_id` is the bare CIK and `_source`
 * carries the entity display name and a prominence `rank` — not a filing document.
 */
export interface EftsEntityAutocompleteResponse {
  hits: {
    hits: EftsEntityHit[];
    total?: { value: number; relation: string };
  };
}

export interface EftsEntityHit {
  /** Bare (non-zero-padded) CIK of the matched entity. */
  _id: string;
  _source: {
    /** Entity display name (e.g. "VANGUARD GROUP INC"). */
    entity: string;
    /** SEC prominence weight. Deliberately NOT used to auto-select a match — two entities can share a legal name under different CIKs. */
    rank?: number;
  };
}

/** Filing index JSON response. */
export interface FilingIndex {
  directory: {
    name: string;
    item: Array<{ name: string; type: string; size: string; 'last-modified': string }>;
  };
}

/** XBRL companyconcept API response. */
export interface CompanyConceptResponse {
  cik: number;
  description?: string;
  entityName: string;
  label: string;
  tag: string;
  taxonomy: string;
  units: Record<string, CompanyConceptUnit[]>;
}

export interface CompanyConceptUnit {
  accn: string;
  end: string;
  filed: string;
  form: string;
  fp: string;
  frame?: string;
  fy: number;
  start?: string;
  val: number;
}

/** XBRL frames API response. */
export interface FramesResponse {
  ccp: string;
  data: FrameEntry[];
  description?: string;
  label: string;
  pts: number;
  tag: string;
  taxonomy: string;
  uom: string;
}

export interface FrameEntry {
  accn: string;
  cik: number;
  end: string;
  entityName: string;
  loc: string;
  /** Period start date — present for duration frames, absent for instant frames. */
  start?: string;
  val: number;
}

/** Financial statement grouping for XBRL concepts. */
export type ConceptGroup =
  | 'income_statement'
  | 'balance_sheet'
  | 'cash_flow'
  | 'per_share'
  | 'entity_info';

/** XBRL taxonomy a concept belongs to. */
export type ConceptTaxonomy = 'us-gaap' | 'ifrs-full' | 'dei';

/** An alternate-semantics XBRL tag related to a concept, with the reason it differs. */
export interface RelatedTag {
  /** How this tag differs semantically from the mapped tag (e.g. "includes restricted cash"). */
  note: string;
  /** XBRL tag a meaningful share of filers report this metric under instead. */
  tag: string;
}

/** Friendly concept name mapping. */
export interface ConceptMapping {
  group: ConceptGroup;
  /**
   * IFRS tag variants for this concept (used when taxonomy === 'ifrs-full').
   * When present, these replace `tags` for IFRS lookups so friendly names resolve
   * correctly against ifrs-full filers (e.g. Spotify's 20-F filings).
   */
  ifrsTags?: string[];
  label: string;
  /**
   * Alternate-semantics XBRL tags a meaningful share of filers use as their primary
   * line for this metric, surfaced as a hint by `secedgar_fetch_frames`. NOT pure
   * synonyms of `tags` (those differ historically but mean the same thing) — these
   * carry a different definition (e.g. cash incl. restricted cash, equity incl.
   * noncontrolling interest), so they are deliberately kept OUT of `tags` to avoid
   * conflating them into `secedgar_get_financials`' first-non-null fallback chain.
   */
  relatedTags?: RelatedTag[];
  tags: string[];
  taxonomy: ConceptTaxonomy;
  unit: string;
}
