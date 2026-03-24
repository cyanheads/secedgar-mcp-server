/**
 * @fileoverview Domain types for SEC EDGAR API responses and internal data structures.
 * @module services/edgar/types
 */

/** CIK resolution result from company_tickers.json lookup. */
export interface CikMatch {
  cik: string;
  exchange?: string;
  name: string;
  ticker: string;
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
  exchanges: string[];
  filings: {
    recent: FilingsRecent;
    files: Array<{ name: string; filingCount: number; filingFrom: string; filingTo: string }>;
  };
  fiscalYearEnd: string;
  name: string;
  sic: string;
  sicDescription: string;
  stateOfIncorporation?: string;
  tickers: string[];
}

/** Parallel arrays from the submissions API recent filings. */
export interface FilingsRecent {
  accessionNumber: string[];
  filingDate: string[];
  form: string[];
  primaryDocDescription: string[];
  primaryDocument: string[];
  reportDate: string[];
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
    file_date: string;
    period_of_report?: string;
    display_names?: string[];
    entity_name?: string;
    file_num?: string[];
    film_num?: string[];
    biz_locations?: string[];
    inc_states?: string[];
    sics?: string[];
    form_type: string;
    file_description?: string;
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
  val: number;
}

/** Friendly concept name mapping. */
export interface ConceptMapping {
  label: string;
  tags: string[];
  taxonomy: string;
  unit: string;
}
