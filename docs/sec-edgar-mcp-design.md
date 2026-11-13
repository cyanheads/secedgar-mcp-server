# SEC EDGAR MCP Server — Design

**Package:** `@cyanheads/secedgar-mcp-server`

## MCP Surface

### Tools

The core tools designed below. The full shipped surface — snapshot, comparison, ownership, fund-holdings, concept-search, and dataframe tools included — is the MCP Surface table in `CLAUDE.md`.

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `secedgar_company_search` | Find companies and retrieve entity info with optional recent filings. Entry point for most workflows. | `query`, `include_filings?`, `forms?`, `filing_limit?` | `readOnlyHint`, `openWorldHint` |
| `secedgar_search_filings` | Search EDGAR filings since 1993 — EFTS full-text for 2001-present, archive-backed browse (submissions history / quarterly full-index) for pre-2001 ranges. | `query`, `forms?`, `filed_after?`, `filed_before?`, `limit?`, `offset?` | `readOnlyHint`, `openWorldHint` |
| `secedgar_get_filing` | Fetch a specific filing's metadata and document content by accession number, paged by offset, by section heading, or at a phrase. | `accession_number`, `cik?`, `content_limit?`, `document?`, `include_xbrl?`, `offset?`, `section?`, `find?` | `readOnlyHint`, `idempotentHint` |
| `secedgar_get_financials` | Get historical XBRL financial data for a company. Accepts friendly concept names. | `company`, `concept`, `taxonomy?`, `period_type?`, `unit?`, `limit?` | `readOnlyHint`, `idempotentHint` |
| `secedgar_fetch_frames` | Compare a financial metric across all reporting companies for a specific period. | `concept`, `period`, `taxonomy?`, `unit?`, `limit?`, `offset?`, `sort?` | `readOnlyHint`, `openWorldHint` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `secedgar://concepts` | Reference list of common XBRL financial concepts grouped by financial statement, mapping friendly names to XBRL tags. The "menu" an agent reads before calling `secedgar_get_financials`, `secedgar_compare_companies`, or `secedgar_fetch_frames`. | No |
| `secedgar://filing-types` | Reference list of common SEC filing types with descriptions, cadence, and typical use cases. | No |

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `secedgar_company_analysis` | Guides a structured analysis of a public company's SEC filings: identify recent filings, extract financial trends, surface risk factors, note material events. | `company`, `focus_areas?` |

---

## Overview

[SEC EDGAR](https://www.sec.gov/edgar) (Electronic Data Gathering, Analysis, and Retrieval) is the SEC's public database of corporate filings. Every public company, fund, and insider is required to file here. The data is entirely free, requires no authentication, and covers filings from 1993 to present. Note that EDGAR's EFTS full-text index only reaches back to 2001; `secedgar_search_filings` serves pre-2001 date ranges from the archives (submissions history and quarterly full-index) instead, so full-text matching before 2001 requires entity scope.

The MCP server wraps EDGAR's public REST APIs to give LLM agents structured access to: company lookups, filing search and retrieval, structured financial data (XBRL), and cross-company financial comparison.

**Target users:** Financial analysts, investors, researchers, journalists, compliance professionals, and any LLM workflow that needs to query public company disclosures or financial data.

**Read-only.** EDGAR's public APIs are data-only. The authenticated filer submission APIs (EDGAR Next) are out of scope.

---

## License & Deployability

| Aspect | Detail |
|:-------|:-------|
| **Data license** | U.S. Government public domain. Federal government works are not copyrightable under 17 U.S.C. § 105. No restrictions on redistribution, commercial use, or derivative works. |
| **API access** | No authentication or API keys. Only requirement is a descriptive `User-Agent` header with contact email. |
| **Rate limits** | 10 requests/second per IP. SEC will block IPs that exceed this. |
| **Self-hosting OK?** | Yes. No terms prohibit proxying, caching, or rebroadcasting. The data is public domain. The SEC's [fair access policy](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data) focuses on rate limiting, not usage restrictions. |
| **Operational notes** | 10 req/s is adequate for typical MCP usage but tight for a public server with multiple concurrent users sharing one IP. Cache `company_tickers.json` (changes infrequently), XBRL frames data (static once published), and filing content (immutable once filed). Bulk data snapshots (`companyfacts.zip`, `submissions.zip`) available for offline enrichment. |

---

## Requirements

- Look up companies by ticker symbol, name, or CIK number
- Search filing documents by keyword, phrase, boolean expressions, date range, and form type
- Retrieve filing document content as readable text (HTML → text conversion)
- Query structured financial data (XBRL) for specific metrics over time
- Compare a financial metric across all reporting companies for a given period
- Handle XBRL concept name complexity — map friendly names like "revenue" to the correct (and historically variable) XBRL tags
- Deduplicate XBRL data (prior-period comparatives appear in multiple filings)
- Respect SEC rate limits (10 req/s) with a descriptive User-Agent header
- Work server-side only (EDGAR APIs do not support CORS)

---

## Domain Map

### Data Sources

| Domain | Base URL | Purpose | Auth |
|:-------|:---------|:--------|:-----|
| **data.sec.gov** | `https://data.sec.gov/` | REST APIs: submissions, XBRL companyfacts, companyconcept, frames | None |
| **efts.sec.gov** | `https://efts.sec.gov/LATEST/search-index` | Full-text search (Elasticsearch-backed) | None |
| **www.sec.gov** | `https://www.sec.gov/` | Static files (ticker maps), filing archives, legacy search | None |

All require `User-Agent: AppName contact@email.com` header. Rate limit: 10 req/s per IP.

### Nouns and Operations

| Noun | Operations | API |
|:-----|:-----------|:----|
| **Company** | Lookup by ticker/name/CIK, get entity info, list tickers | `company_tickers.json`, submissions API |
| **Filing** | List by company (filtered), full-text search, get document content | Submissions API, EFTS API, Archives |
| **Financial Metric** | Get time series for one company, compare across companies | companyconcept API, frames API |
| **XBRL Concept** | List available concepts for a company | companyfacts API |

### Filing Types (most commonly queried)

| Form | Cadence | What It Contains |
|:-----|:--------|:-----------------|
| **10-K** | Annual | Audited financials, MD&A, risk factors, business overview |
| **10-Q** | Quarterly (Q1-Q3) | Unaudited financials, MD&A, market risks |
| **8-K** | Event-driven | Material events, scoped by item code. Two numbering regimes — the dotted scheme since 2004-08-23, single integers before it — with the full decode tables in `secedgar://filing-types` and `secedgar_get_material_events` filtering on them |
| **DEF 14A** | Annual proxy | Board elections, executive pay, shareholder votes |
| **13F-HR** | Quarterly | Institutional holdings ($100M+ AUM) |
| **Form 4** | Per-transaction | Insider buy/sell: date, shares, price, transaction code |
| **SC 13D/G** | Threshold | 5%+ beneficial ownership (activist vs. passive) |
| **S-1** | One-time | IPO registration: prospectus, financials, risk factors |
| **20-F** | Annual | Foreign private issuer equivalent of 10-K |

### Classification into MCP Primitives

| Operation | Primitive | Reasoning |
|:----------|:----------|:----------|
| Company lookup + filings list | **Tool** | Requires query input, optional filters, CIK resolution logic |
| Full-text filing search | **Tool** | Complex query params (text, date range, form filters) |
| Get filing document | **Tool** | Needs accession number, content extraction, truncation |
| Financial time series | **Tool** | Concept name resolution, dedup, period filtering |
| Cross-company comparison | **Tool** | Period/unit/concept params, sorting, limit |
| Common XBRL concepts reference | **Resource** | Static reference data, useful as injectable context |
| Filing types reference | **Resource** | Static reference data, aids tool selection |
| Company entity info | ~~Resource~~ | Rejected — submissions API payload is large and filings need filter params → tool is better fit |

---

## Tool Designs

### 1. `secedgar_company_search`

**Workflow:** "Find Apple" / "What's Tesla's CIK?" / "Show me Microsoft's recent 10-K filings"

**What it wraps:** `company_tickers.json` plus the committed former-name and former-ticker assets (ticker/name → CIK resolution), and on a miss EDGAR's entity index and a full-text search of 10-K subsidiaries exhibits → submissions API (entity details + filings).

The submissions API returns both entity metadata and filings in a single call. Splitting them into two tools would hit the same endpoint twice.

```ts
input: z.object({
  query: z.string()
    .describe('Company ticker symbol (e.g., "AAPL"), name (e.g., "Apple"), or CIK number (e.g., "320193"). '
      + 'Ticker is the fastest lookup. Name search does fuzzy matching.'),
  include_filings: z.boolean().default(true)
    .describe('Include recent filings in the response. Set to false for entity-info-only lookups.'),
  forms: z.array(z.string()).optional()
    .describe('Filter filings to specific form types (e.g., ["10-K", "10-Q", "8-K"]). '
      + 'Without this, returns all form types.'),
  filing_limit: z.number().int().min(1).max(1000).default(10) // served at min(filing_limit, 50)
    .describe('Maximum number of filings to return. The API\'s recent window holds the last year or 1,000 filings per company, whichever is more.'),
})

output: z.object({
  cik: z.string().describe('Central Index Key, zero-padded to 10 digits.'),
  name: z.string().describe('SEC-conformed company name.'),
  tickers: z.array(z.string()).describe('Associated ticker symbols.'),
  exchanges: z.array(z.string()).describe('Exchanges where listed.'),
  sic: z.string().describe('SIC industry code.'),
  sic_description: z.string().describe('Human-readable SIC description.'),
  state_of_incorporation: z.string().optional(),
  fiscal_year_end: z.string().describe('Fiscal year end (MMDD format).'),
  filings: z.array(z.object({
    accession_number: z.string(),
    form: z.string(),
    filing_date: z.string(),
    report_date: z.string().optional(),
    primary_document: z.string(),
    description: z.string().optional(),
  })).optional().describe('Recent filings, filtered by forms if specified.'),
  total_filings: z.number().optional()
    .describe('Filings matching the filter across everything scanned; can exceed the inline list.'),
})
```

**Handler flow:**
1. If `query` looks like a number → treat as CIK, zero-pad
2. If `query` is 1-5 letters in any case, or anything typed in uppercase → the listed-symbol lookup via `Map` (O(1)), a dotted class retried hyphenated (`BRK.B` → BRK-B, #110); then, for uppercase input, the ticker-spelling readings (`UEC.N`, `CFGPH`, `GLOP`; a non-US code such as `7203.T` is no match, #235); then a former ticker, the company that held the symbol most recently (#237), weighed against step 3's names. A listed symbol answers as listed, with a `reading` naming any earlier, different holder of it
3. Otherwise → case-insensitive name search over `company_tickers.json` titles and committed former names, tiered: exact as written (including the registry title with its corporate suffix dropped, so "Apple" matches "Apple Inc."), exact once commas, periods, and apostrophes are deleted and whitespace runs collapse on both sides ("QXO Inc" matches "QXO, Inc."), exact once runs of one-letter words join on that form ("JM Smucker" matches "J M SMUCKER Co"), prefix of the joined form ending at a word boundary ("U.S. Bancorp" matches "US BANCORP \DE\"), then substring as written starting at a word boundary. Each tier ranks above the looser one after it, so a title typed as listed never ties a former name that equals it only without punctuation (#210), and "US Gold" names U.S. GOLD CORP. alone instead of tying the former name "u s gold corp", equal only once joined (#219). No hit begins or ends inside a word of the name, so "SY Bancorp" never names Embassy Bancorp and "helix acquisition corp ii" never lists Helix Acquisition Corp. III; a query ending mid-word still matches a name that contains it as written ("Berkshire Hath") (#218). A query with no letter or digit matches nothing. Resolve within the best tier a current title reaches and return every match from it; a former name can tie a current title but never outrank one. No fuzzy-matching library needed — prefix + substring covers practical cases across ~10K entries.
4. When no name tier matches and the query has two or more words → the word-order tier: the query's words as a set, against each current or former name's words under the exact tiers' fold, initials, and suffix rules ("Charles Schwab" matches SCHWAB CHARLES CORP, #236)
5. For input not typed in uppercase, the listed-symbol lookup the first step skipped, then a former ticker (`amrk`; `bk` keeps its name-pass answer)
6. `secedgar_company_search` only, when steps 1–5 found nothing (a non-US listing code or a query with no letter or digit skips this and the next step) → EDGAR's entity index (`search-index?keysTyped=`, at most 10 hits), SEC's trailing ticker list split from each name and the hits ranked on the name tiers. One CIK at an exact tier resolves, with a `resolvedAs` note; several at the best tier fail `ambiguous_company`, with SEC's `hits.total` as `total_matches` when SEC returned only part of its hits; a lone hit at the prefix or substring tier leads `data.suggestions`
7. When no index hit reaches a name tier → one quoted full-text search of 10-Ks, reading only EX-21 (subsidiaries exhibit) hits: their filers, ticker-file filers first, go in the `no_match` message and `data.parents`
8. Fetch `data.sec.gov/submissions/CIK{padded}.json`
9. Filter `filings.recent` parallel arrays by `forms` if provided
10. Slice to `filing_limit`, served at most 50 inline; past that, a dataframe or a `secedgar_search_filings` recipe covers the rest

**Key design decisions:**
- The word-order tier lives in `resolveCik`, ahead of the entity index, and runs only when every name tier misses
  - *Decision:* EDGAR's entity index answers "Charles Schwab" with a 2008–2010 Reg D filer as its lone exact hit, while SEC registers the broker as SCHWAB CHARLES CORP. Index hits rank after every local tier, so the tier must exist locally for the registry name to win, and running only on a miss means it changes no answer that resolves without it.
- An uppercase former ticker answers ahead of the name passes unless a current name is the input exactly, or its holder is listed no more and the names find one company
  - *Decision:* uppercase input is usually a ticker, so `BK` reads as BNY (still listed, as BNY) over BK Technologies Corp, whose name only starts with it, and `STR`, which starts many names, settles on its last holder. But a former ticker is weaker evidence than an exact name or a single name match for a delisted holder: without those two exceptions `CHUBB` read as CommerceHub instead of Chubb Ltd, and `DINE` as Rewards Network instead of Dine Brands.
- A symbol several companies held resolves to the most recent holder
  - *Decision:* failing such a symbol as ambiguous would turn calls that resolve today into errors. The `reading` names the earlier holders, and a listed symbol keeps answering as listed, with its earlier holder named, so no call that resolves today starts failing.
- An entity-index failure fails the call, while an EX-21 search failure keeps `no_match`
  - *Decision:* when the index cannot answer, the server cannot say whether the company exists, so reporting `no_match` would assert something it does not know. The EX-21 search is the last step and the answer is already `no_match`, so its failure leaves that answer and says the search did not run. The caller's cancel ends the call from either step.
- Only EX-21 hits name a parent
  - *Decision:* the other 10-K documents that mention a private company are mostly a lender's schedule of investments or a competitor's or customer's narrative, so naming those filers would assert an ownership link the filing does not make.

**Error guidance:**
- No match → `"No company found for '{query}'."`, then one of three sentences on the exhibits search: the filers of the EX-21 hits (`'Vertafore' appears in the subsidiaries exhibit (EX-21) of ROPER TECHNOLOGIES INC (ROP, CIK 0000882835), in its 10-K filed 2026-02-24 (accession …), so it may be a subsidiary of that filer.`, also in `data.parents`); none, pointing to `secedgar_search_filings` with the quoted name; or, when SEC could not run it, that the search did not run and when to retry. Near matches follow in the message and `data.suggestions`, and the recovery hint names each field attached and suggests a ticker symbol (e.g., 'AAPL'), full company name, or 10-digit CIK. An entity-index failure is not a no-match: the call fails with that failure's reason, as `rate_limited`, `sec_unavailable`, or `efts_degraded_response`.
- Ambiguous name → `ambiguous_company` (`ValidationError`), as on `secedgar_get_financials`, listing up to 10 candidates in the message and `data.matches`, with the full count in `data.total_matches`: `"'Blue Owl Capital' matches multiple companies: 0001823945 BLUE OWL CAPITAL INC. (OWL), 0001655888 Blue Owl Capital Corp (OBDC). Retry with one of these tickers or 10-digit CIKs."`; a longer list ends `Showing 10 of 66 matches; for one not listed, retry with a fuller name, its ticker, or its CIK.`

---

### 2. `secedgar_search_filings`

**Workflow:** "Find 10-K filings mentioning 'material weakness' in 2024" / "Search for AI risk disclosures"

**What it wraps:** EFTS full-text search API (`efts.sec.gov/LATEST/search-index`).

```ts
input: z.object({
  query: z.string()
    .describe('Full-text search query. Supports: '
      + 'exact phrases ("material weakness"), '
      + 'boolean operators (revenue OR income), '
      + 'exclusion (-preliminary), '
      + 'wildcard suffix (account*), '
      + 'entity targeting (one cik:320193 or ticker:AAPL term, never led by - or NOT). '
      + 'Terms are AND\'d by default.'),
  forms: z.array(z.string()).optional()
    .describe('Filter to specific form types (e.g., ["10-K", "10-Q", "8-K"]). '
      + 'Without this, searches all form types.'),
  filed_after: z.string().optional()
    .describe('Only include filings filed on or after this date (YYYY-MM-DD). Use alone or with filed_before; alone, the search runs through today (UTC).'),
  filed_before: z.string().optional()
    .describe('Only include filings filed on or before this date (YYYY-MM-DD). Use alone or with filed_after; alone, the search starts at 2001-01-01, or at 1993-01-01 (the archive start) for a date before 2001.'),
  limit: z.number().int().min(1).max(1000).default(20) // served at min(limit, 100)
    .describe('Results per page. Capped at 100: a larger value, up to 1000, returns what 100 returns. Default 20 to keep responses concise.'),
  offset: z.number().int().min(0).max(9999).default(0)
    .describe('Pagination offset. Increment by limit for next page. Under sort=relevance on a 2001-onward search without entity scope, EDGAR pages server-side and serves offsets up to 9900, where a page of 100 ends at its 10,000-document cap; a deeper offset is rejected.'),
})

output: z.object({
  total: z.number().describe("Matching filings, one per accession — for a search, exact when one 100-document window held every match, else a lower bound; for a forms- or entity-only browse from 2001 on, EDGAR's own count; a range crossing 2001-01-01 sums the archive rows and one window's filings."),
  total_is_exact: z.boolean().describe('False when total is a lower bound.'),
  total_documents: z.number().optional().describe('EFTS document count (capped at 10,000).'),
  results: z.array(z.object({
    accession_number: z.string().describe('Use with secedgar_get_filing to retrieve content.'),
    form: z.string(),
    filing_date: z.string(),
    period_ending: z.string().optional(),
    company_name: z.string(),
    cik: z.string(),
    tickers: z.array(z.string()).optional(),
    file_description: z.string().optional(),
    matched_documents: z.array(z.object({ name: z.string(), type: z.string().optional() })).optional(),
    sic: z.string().optional(),
    location: z.string().optional(),
  })),
  form_distribution: z.record(z.number()).optional()
    .describe('Filings in hand counted by form type. Helps narrow follow-up searches.'),
})
```

**Handler flow:**
1. Build query params: `q` (omitted when empty), `forms` (normalized once per call: each element trimmed and uppercased, blanks dropped, then comma-joined; a list holding only blanks is no form filter, so with no query it fails `missing_criteria`), `ciks` when `cik:`/`ticker:` targeting resolved a CIK, `dateRange=custom` + `startdt`/`enddt` if dates provided (a lone bound is paired first, so both are always sent), `from`, `size`
2. Fetch `efts.sec.gov/LATEST/search-index`
3. Collapse the Elasticsearch hits — one per matching document, `_id` = `<accession>:<filename>` — to one row per accession, listing the matched documents
4. Count `form_distribution` from those rows

**Key design decisions:**
- Default `limit: 20` (not 100) — most searches don't need 100 results and it keeps LLM context lean
- One row per filing, with `total` and `form_distribution` counting filings — EFTS returns a hit per matching document, so a filing whose body and exhibits match would otherwise fill several rows. EFTS counts only documents (`hits.total.value`, and the `form_filter` aggregation, whose buckets also fold amendments into the root form) and serves 100 hits per request whatever `size` asks, so a search's exact filing count exists only when one window holds every match; past that, `total` is the window's filings with `total_is_exact: false`, and `total_documents` keeps EFTS's count. A browse (no `q`) is the exception: EFTS matches each filing's primary document alone, so `hits.total.value` is the filing count and becomes `total`, trusted while the window shows one document per accession. `form_distribution` describes the filings in hand rather than the whole match set (#124)
- Entity filtering via one `cik:` / `ticker:` term in the `query` string, resolved to a CIK passed through EFTS's plural `ciks` param (the singular `entity` param is ignored) — server-side scope, so filings under a former company name on the same CIK are included. A `ticker:` term takes every spelling `resolveCik` reads (`UEC.N`, `CFGPH`, `GLOP`, #235), and `effectiveQuery` names the reading beside the CIK, `(entity scope: CIK 0001334933, UEC.N read as UEC (URANIUM ENERGY CORP))`, identically on every page, since each page resolves the term again
  - *Decision:* a term led by `-` or a `NOT` term, or a second entity term, fails `unsupported_entity_scope` before any request (#243). `ciks` only scopes in, so an exclusion has no scope to become, and passed through as text it changes nothing (full-text search returns the same documents with or without `-ticker:AAPL`), while a second term sent as text matches nothing. A `+` before the term is removed with it, a term inside a quoted phrase still scopes with the phrase read without it, and attached punctuation (`(ticker:AAPL)`) keeps failing `unresolved_ticker` / `invalid_cik`.
- A relevance `offset` past 9,900 fails as `offset_out_of_range` before any request — EFTS refuses a `from` past 9,900 whatever the query, so sending it can only fail
  - *Decision:* the check sits on the one path that sends `offset` as `from` (relevance, no entity scope, a 2001-onward range), and the schema keeps `.max(9999)`, because the date-sorted, entity-scoped, and archive paths page rows the call assembled, and a pre-2001 browse answers offsets 9,901–9,999; narrowing the schema would reject calls that answer (#214).

**Error guidance:**
- No results → `"No filings match. Try broader terms, remove date filters, or check spelling. Exact phrases require double quotes."`
- Relevance offset past 9,900 → `offset_out_of_range`, not retryable, naming offset 9,900 (whose page of 100 ends at the 10,000-document cap) and the narrowing levers: a shorter date window, a forms filter, more specific terms

---

### 3. `secedgar_get_filing`

**Workflow:** "Read Apple's 10-K from November 2023" / "Get filing 0000320193-23-000106"

**What it wraps:** Filing archive index + primary document fetch + HTML-to-text extraction.

```ts
input: z.object({
  accession_number: z.string(),          // "0000320193-23-000106" or "000032019323000106"
  cik: z.string().optional(),            // speeds the lookup; without it, full-text search, the accession prefix, then the index page's filers
  content_limit: z.number().int().min(1000).max(1000000).default(50000), // a page is served at min(content_limit, 200000)
  document: z.string().optional(),       // an exhibit or other filename; omitted or blank: the primary
  include_xbrl: z.boolean().default(false), // XBRL viewer and taxonomy files, under documents.xbrl
  offset: z.number().int().min(0).default(0), // where the page starts; under find, where the search starts
  section: z.string().min(1).optional(), // a heading, or a document line equal to or starting with the value; outranks find and offset
  find: z.string().max(200).optional(),  // a phrase in the text, folded like section; outranks offset; blank reads as omitted
})

const documentEntry = z.object({
  name: z.string(), type: z.string(), description: z.string().optional(),
  size: z.number().optional(), binary: z.boolean().optional(),
})

output: z.object({
  accession_number: z.string(),
  form: z.string().optional(),           // from the submissions feed, else the filing's SEC header
  filing_date: z.string().optional(),
  company_name: z.string().optional(),
  cik: z.string(),
  period_ending: z.string().optional(),
  primary_document: z.string(),          // the path read: an SEC rendering, an accession-prefixed name, or <accession>.txt
  requested_document: z.string().optional(),
  documents: z.object({
    primary: z.array(documentEntry), exhibits: z.array(documentEntry),
    auxiliary: z.array(documentEntry), xbrl: z.array(documentEntry).optional(),
  }),
  content: z.string(),                   // this page's text
  content_truncated: z.boolean(),
  content_total_length: z.number(),
  next_offset: z.number().optional(),    // pass as offset, without section or find, for the next page
  outline: z.array(z.object({ heading: z.string(), offset: z.number() })).optional(), // up to 50, on a truncated first page with no section or find
  occurrences: z.array(z.object({ offset: z.number(), context: z.string() })).optional(), // with find: up to 20, from the one the page opens at
  occurrences_total: z.number().optional(), // with find: occurrences in the whole document
  filing_url: z.string(),
})
```

**Handler flow:**
1. Normalize accession number (ensure dash format for display, no-dash for URL path)
2. Without `cik`, the candidate CIKs are the filers EDGAR full-text search records for the accession, then the accession number's prefix (the filer's CIK or a filing agent's); a search SEC cannot answer degrades to the prefix alone, while a cancel or a rate-limit refusal ends the call (#215). Each candidate runs steps 3–5 in turn; when none serves the filing, read `<accn>-index.html` under the prefix CIK and run up to three of the parties it names (`browse-edgar?CIK=` links) not yet tried — the filer of a pre-2001 agent-filed accession, which full-text search does not cover (#203)
3. Fetch filing index: `www.sec.gov/Archives/edgar/data/{cik}/{accn_nodashes}/index.json`, with the CIK unpadded (a zero-padded archive path answers 301)
4. Determine target document (primary or specified). With the index, read the `<accn>-index-headers.html` page and the filer's submissions feed together (both also feed the response metadata). The primary is the feed's `primaryDocument` (last path segment) when the accession is in its recent window, else the document the header page types with the submission's form, else the largest readable document, never an `R<n>.htm` viewer page. Size alone picks an 8-K's larger press-release exhibit, so it is only the fallback
5. Fetch document HTML. A primary the feed records through a stylesheet path (`xslSCHEDULE_13D_X02/primary_doc.xml`) is read as SEC renders it at that path while the index lists the raw file at 600,000 bytes or less: the raw XML strips to one unlabeled line, and a holdings report's rendering runs about 20 times its raw size. A rendering that answers 404, or that SEC cannot serve, gives way to the raw file, and `documents` keeps the raw file as the primary (#216). A sequence-numbered name that answers 404 (`0001.htm`, common in 2000–2001 indexes) is read again as `<accession>-0001.htm` in the same directory, and a caller-named document resolves in either spelling (#213). `primary_document` and `filing_url` name the path read. When the primary the index names is served under neither spelling — the prefixed read answering 404, or SEC unable to serve it, as with a rendering — read the full submission `<accession>.txt` instead and say so in the response notice; a caller-named document served under neither fails with a hint naming the submission (unless it is the submission) and `cik`. Index entries with no filename are dropped, and a blank `document` reads as omitted
6. Convert HTML to clean text (strip tags, normalize whitespace, preserve table structure where possible). Filer-written text in an SEC rendering (`div.largetext`, styled `white-space: pre-wrap`) keeps its whitespace, so a 13D's Item paragraphs stay apart (#216)
7. Pick where the page starts: `section`'s landing, where a table-of-contents row that links to its section lands on that section (#239); else, with `find`, the first occurrence at or after `offset` — its line's start when that is at most 200 characters back, else the first word starting within those 200 (#238); else `offset`
8. Cut `content_limit` characters from there at a word boundary; a cut page reports `next_offset`

**Error guidance:**
- 404 → `"Filing not found. Verify the accession number. Format: '0000320193-23-000106' (with dashes)."`
- Document not in filing → `"Document '{name}' not found in this filing. Available documents: {list}. Use one of these names."`
- `section` matches nothing → `section_not_found` with the outline, pointing a phrase that is not a heading at `find`
- No occurrence of `find` at or after `offset` → `phrase_not_found`, saying how many occur before `offset`

---

### 4. `secedgar_get_financials`

**Workflow:** "What was Apple's revenue for the last 5 years?" / "Show Tesla's quarterly EPS trend"

**What it wraps:** XBRL companyconcept API with friendly name → XBRL tag mapping and automatic deduplication.

This is the highest-value tool in the server. The XBRL API is powerful but has terrible ergonomics for LLMs: concept names are long camelCase strings like `RevenueFromContractWithCustomerExcludingAssessedTax`, duplicates litter the data, and companies change tags across fiscal years. This tool absorbs all that complexity.

```ts
input: z.object({
  company: z.string()
    .describe('Ticker symbol (e.g., "AAPL") or CIK number. Ticker is preferred.'),
  concept: z.string()
    .describe('Financial concept — friendly name (e.g., "revenue", "net_income", "assets", "eps_diluted") '
      + 'or raw XBRL tag (e.g., "AccountsPayableCurrent"). '
      + 'Friendly names auto-resolve to the correct XBRL tags and handle historical tag changes. '
      + 'See secedgar://concepts for the full list of supported names and mappings.'),
  taxonomy: z.enum(['us-gaap', 'ifrs-full', 'dei']).default('us-gaap')
    .describe('XBRL taxonomy. us-gaap for US companies, ifrs-full for foreign filers, dei for entity info (shares outstanding).'),
  period_type: z.enum(['annual', 'quarterly', 'all']).optional()
    .describe('Filter to annual (FY) or quarterly (Q1-Q4) data. "all" returns both. When omitted, annual, except that an instant concept returns its full series.'),
  unit: z.string().optional()
    .describe('SEC unit key to read the series in, for a concept reported in more than one (e.g. "ZAR" and a "USD" convenience translation).'),
})

output: z.object({
  company: z.string(),
  cik: z.string(),
  concept: z.string().describe('XBRL tag behind the newest value.'),
  label: z.string().describe('Human-readable label for the concept.'),
  description: z.string().optional().describe('XBRL taxonomy description.'),
  unit: z.string().describe('Unit of measure of every value (e.g., "USD", "shares", "USD/shares").'),
  data: z.array(z.object({
    period: z.string().describe('Calendar period label (e.g., "CY2023", "CY2023Q3").'),
    value: z.number(),
    start: z.string().optional().describe('Period start date (duration items only).'),
    end: z.string().describe('Period end date.'),
    fiscal_year: z.number().nullable(),
    fiscal_period: z.string().nullable(),
    form: z.string().describe('Source filing type (10-K, 10-Q, etc.).'),
    filed: z.string().describe('Date the source filing was submitted.'),
    accession_number: z.string().describe('Source filing accession number for secedgar_get_filing.'),
    tag: z.string().describe('XBRL tag this value was reported under.'),
  })).describe('Deduplicated time series, newest first.'),
  tags_tried: z.array(z.string()).optional()
    .describe('XBRL tags that were attempted (shown when using friendly names that map to multiple tags).'),
})
```

**Handler flow:**
1. Reject a `concept` that is neither a friendly name nor tag-shaped (`unknown_concept`, see below) before any other step
2. Resolve `company` to CIK (via ticker lookup)
3. Map friendly `concept` name to XBRL tag(s) — some map to multiple tags (e.g., "revenue" → 5 tags)
4. For each mapped tag, fetch `data.sec.gov/api/xbrl/companyconcept/CIK{padded}/{taxonomy}/{tag}.json`; a unit served as anything but an array is dropped at the service edge, and a tag left with no values is answered from one companyfacts read
5. Merge results if multiple tags returned data; each value keeps its source tag and unit key
6. Deduplicate within each unit key: keep only entries with `frame` field (one value per standard calendar period); a frame held by a proxy statement takes the latest fact another form reports for the same tag, unit, and period; an annual frame held by a 10-Q takes the same-period fact from the 10-K, stays when it covers a closed fiscal year, and otherwise drops out (a trailing-twelve-month figure); when its own tag and unit hold no year-long fact to test it against, it is tested against the filer's annual-report year ends, read from one companyfacts request made only then; same-frame collisions go to the lower tag index, then the later filing
7. Read one unit: `unit` when given (an unreported key fails as `no_unit_data`, listing the keys the concept reports), else the unit of the newest value, then the unit with more framed periods, then the alphabetically first; a caveat names every other unit with its period count and span
8. Filter by `period_type` (FY vs Q1-Q4)
9. Sort newest first

- *Decision:* frames compete only within one unit key. A 20-F filer frames a year in its reporting currency and in a USD convenience translation, and letting the units compete printed a translated value under the reporting currency wherever the translation was filed later. The default unit is never the catalog mapping's `unit`, which reads `USD` under `ifrs-full` too; newest value first follows a presentation-currency change, and the period count settles the translation tie. Other units are reached through `unit` rather than added to the dataframe, which keeps one row per period. `get_snapshot` and `compare_companies` read the same default unit without the caveat.

**Friendly name → XBRL tag mapping** (36 concepts; `src/services/edgar/concept-map.ts` is the source of truth):

| Friendly Name | XBRL Tags (tried in order) | IFRS Tags (`ifrs-full`) | Taxonomy | Unit |
|:------|:------------|:------------|:---------|:-----|
| `accounts_payable` | `AccountsPayableCurrent` | `TradeAndOtherCurrentPayables` | us-gaap | USD |
| `accounts_receivable` | `AccountsReceivableNetCurrent`, `ReceivablesNetCurrent`, `AccountsReceivableGrossCurrent` | `CurrentTradeReceivables`, `TradeAndOtherCurrentReceivables` | us-gaap | USD |
| `assets` | `Assets` | `Assets` | us-gaap | USD |
| `cash` | `CashAndCashEquivalentsAtCarryingValue` | `CashAndCashEquivalents` | us-gaap | USD |
| `current_assets` | `AssetsCurrent` | `CurrentAssets` | us-gaap | USD |
| `current_liabilities` | `LiabilitiesCurrent` | `CurrentLiabilities` | us-gaap | USD |
| `debt` | `LongTermDebt`, `LongTermDebtNoncurrent` | `LongtermBorrowings` | us-gaap | USD |
| `equity` | `StockholdersEquity` | `EquityAttributableToOwnersOfParent`, `Equity` | us-gaap | USD |
| `goodwill` | `Goodwill` | `Goodwill` | us-gaap | USD |
| `intangible_assets` | `FiniteLivedIntangibleAssetsNet`, `IntangibleAssetsNetExcludingGoodwill` | `IntangibleAssetsOtherThanGoodwill` | us-gaap | USD |
| `inventory` | `InventoryNet`, `InventoryGross` | `Inventories` | us-gaap | USD |
| `liabilities` | `Liabilities` | `Liabilities` | us-gaap | USD |
| `notes_payable` | `LongTermNotesPayable`, `NotesPayable`, `LongTermDebt` | — | us-gaap | USD |
| `ppe_net` | `PropertyPlantAndEquipmentNet` | `PropertyPlantAndEquipment` | us-gaap | USD |
| `capex` | `PaymentsToAcquirePropertyPlantAndEquipment`, `PaymentsToAcquireProductiveAssets` | `PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities` | us-gaap | USD |
| `depreciation_amortization` | `DepreciationDepletionAndAmortization`, `DepreciationAndAmortization`, `Depreciation` | `DepreciationAndAmortisationExpense`, `DepreciationAmortisationAndImpairmentLossReversalOfImpairmentLossRecognisedInProfitOrLoss`, `DepreciationExpense` | us-gaap | USD |
| `dividends_paid` | `PaymentsOfDividends`, `PaymentsOfDividendsCommonStock` | `DividendsPaid`, `DividendsPaidClassifiedAsFinancingActivities` | us-gaap | USD |
| `financing_cash_flow` | `NetCashProvidedByUsedInFinancingActivities` | `CashFlowsFromUsedInFinancingActivities` | us-gaap | USD |
| `investing_cash_flow` | `NetCashProvidedByUsedInInvestingActivities` | `CashFlowsFromUsedInInvestingActivities` | us-gaap | USD |
| `operating_cash_flow` | `NetCashProvidedByUsedInOperatingActivities` | `CashFlowsFromUsedInOperatingActivities` | us-gaap | USD |
| `share_repurchases` | `PaymentsForRepurchaseOfCommonStock`, `PaymentsForRepurchaseOfEquity`, `StockRepurchasedAndRetiredDuringPeriodValue` | `PaymentsToAcquireOrRedeemEntitysShares`, `PurchaseOfTreasuryShares` | us-gaap | USD |
| `shares_outstanding` | `EntityCommonStockSharesOutstanding` | — | dei | shares |
| `cogs` | `CostOfGoodsAndServicesSold`, `CostOfRevenue`, `CostOfGoodsSold` | `CostOfSales` | us-gaap | USD |
| `gross_profit` | `GrossProfit` | `GrossProfit` | us-gaap | USD |
| `interest_expense` | `InterestExpense`, `InterestExpenseDebt`, `InterestExpenseNonoperating`, `InterestExpenseOperating` | `InterestExpense`, `FinanceCosts` | us-gaap | USD |
| `net_income` | `NetIncomeLoss` | `ProfitLoss` | us-gaap | USD |
| `operating_income` | `OperatingIncomeLoss` | `ProfitLossFromOperatingActivities` | us-gaap | USD |
| `pretax_income` | `IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest`, `IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments` | `ProfitLossBeforeTax` | us-gaap | USD |
| `rd_expense` | `ResearchAndDevelopmentExpense` | `ResearchAndDevelopmentExpense` | us-gaap | USD |
| `revenue` | `RevenueFromContractWithCustomerExcludingAssessedTax`, `Revenues`, `RevenueFromContractWithCustomerIncludingAssessedTax`, `SalesRevenueNet`, `SalesRevenueGoodsNet` | `Revenue`, `RevenueFromContractsWithCustomers` | us-gaap | USD |
| `sga_expense` | `SellingGeneralAndAdministrativeExpense` | `SellingGeneralAndAdministrativeExpense` | us-gaap | USD |
| `stock_based_compensation` | `ShareBasedCompensation`, `AllocatedShareBasedCompensationExpense` | `ExpenseFromSharebasedPaymentTransactionsWithEmployees`, `ExpenseFromSharebasedPaymentTransactionsInWhichGoodsOrServicesReceivedDidNotQualifyForRecognitionAsAssets` (picked per filer by coverage) | us-gaap | USD |
| `tax_expense` | `IncomeTaxExpenseBenefit` | `IncomeTaxExpenseContinuingOperations` | us-gaap | USD |
| `eps_basic` | `EarningsPerShareBasic` | `BasicEarningsLossPerShare` | us-gaap | USD/shares |
| `eps_diluted` | `EarningsPerShareDiluted` | `DilutedEarningsLossPerShare` | us-gaap | USD/shares |
| `shares_diluted` | `WeightedAverageNumberOfDilutedSharesOutstanding` | `AdjustedWeightedAverageShares` | us-gaap | shares |

Alternate-definition tags (`cash` incl. restricted cash, `equity` incl. noncontrolling interests, the continuing-operations cash-flow variants, `ppe_net` incl. finance-lease right-of-use assets) are `relatedTags` — surfaced as hints, never walked as fallbacks.

Revenue is the most complex: companies switched from `SalesRevenueNet` to `RevenueFromContractWithCustomerExcludingAssessedTax` around 2017-2018 (ASC 606 adoption). The handler tries all variants and merges for full history.

**Error guidance:**
- Neither a friendly name nor tag-shaped (`/^[A-Z][A-Za-z0-9]*$/` after trimming) → `unknown_concept` (`NotFound`) before company resolution or any SEC request: `"'{name}' is neither a supported concept name nor an XBRL tag."`, with a recovery hint carrying a formula for a standard combination (`free_cash_flow` → `operating_cash_flow − capex`, `ebitda` → `operating_income + depreciation_amortization`, `working_capital` → `current_assets − current_liabilities`) or up to three closest catalog names (Dice trigram ≥ 0.3 against name and label), then a pointer to `secedgar_search_concepts`. Shared by `get_financials`, `compare_companies` (which fails only when every concept is unknown and otherwise lists them in `unknown_concepts`), and `fetch_frames`. A friendly name is a catalog name or one of its aliases (`capital_expenditures` for `capex`, `cash_and_cash_equivalents` for `cash`) in any case or separator form, or a lowerCamelCase spelling of either (`operatingIncome`), which is split at its humps only after the input misses as typed; the formula table is read the same way, so `freeCashFlow` gets its formula. `__proto__` and `constructor` are unknown like any other name.
  - *Decision:* an alias is the concept's label keyed like a name, or that label minus its sign qualifier (`income_tax_expense`, `pre_tax_income`), and only where it has one reading — `total_debt`, `total_equity`, `eps`, `cost_of_revenue`, `net_sales`, and `ppe` each name more than one quantity and stay unknown. Names and aliases resolve through one `Map` built at load, so a key two entries claim fails at startup and no input reads a property off `Object.prototype` (#240).
  - *Decision:* the camelCase split applies only to input opening lowercase: no item element opens lowercase, while a split uppercase-initial tag would read a catalog ladder in place of the tag asked for (`InterestExpense` → `interest_expense`'s four tags, `SharesOutstanding` → a `dei` tag) (#240).
  - *Decision:* the tag-shape test is the rejection line because every item element in us-gaap, ifrs-full, dei, and srt matches it and SEC matches tags case-sensitively, so nothing that could return data is rejected; it also keeps path-shaped input out of the request URL, where the tag is a path segment.
  - *Decision:* `total_debt` has no formula — `debt` is long-term only and the catalog has no current-portion concept, so any formula would understate.
- No data for concept → `"No XBRL data for '{tag}' under {taxonomy} for this company. This company may use a different tag or taxonomy. Try 'ifrs-full' for foreign filers."`

---

### 5. `secedgar_fetch_frames`

**Workflow:** "Which companies had the highest revenue in 2023?" / "Rank companies by total assets in Q1 2024"

**What it wraps:** XBRL frames API — returns one fact per company for a given concept and calendar period.

```ts
input: z.object({
  concept: z.string()
    .describe('Financial concept — same friendly names as secedgar_get_financials '
      + '(e.g., "revenue", "assets", "eps_basic") or raw XBRL tag.'),
  taxonomy: z.enum(['us-gaap', 'dei']).default('us-gaap')
    .describe('Frames namespace a raw XBRL tag is read from. A friendly name keeps its own '
      + 'mapped taxonomy unless dei is passed.'),
  period: z.string()
    .describe('Calendar period. Formats:\n'
      + '  "CY2023" — full year 2023 (duration, for income statement items)\n'
      + '  "CY2024Q2" — Q2 2024 (duration, for quarterly income items)\n'
      + '  "CY2023Q4I" — Q4 2023 instant (balance sheet items like assets, cash)\n'
      + 'Use duration periods (no I suffix) for income/cash flow items. '
      + 'Use instant periods (I suffix) for balance sheet items.'),
  unit: z.enum(['USD', 'USD-per-shares', 'shares', 'pure']).default('USD')
    .describe('Unit of measure. Use "USD-per-shares" for EPS, "shares" for share counts, "pure" for ratios.'),
  limit: z.number().int().min(1).max(1000).default(25) // served at min(limit, 100)
    .describe('Number of companies to return. Results are sorted by value.'),
  offset: z.number().int().min(0).default(0)
    .describe('Rank to start the page at, 0-based. Pass next_offset from the previous response.'),
  sort: z.enum(['desc', 'asc']).default('desc')
    .describe('Sort direction. "desc" for highest values first (typical for revenue, assets). '
      + '"asc" for lowest values (useful for finding companies with losses or small positions).'),
})

output: z.object({
  concept: z.string(),
  period: z.string(),
  unit: z.string(),
  label: z.string(),
  total_companies: z.number().describe('Total companies reporting this metric for this period.'),
  data: z.array(z.object({
    rank: z.number(),
    company_name: z.string(),
    cik: z.string(),
    ticker: z.string().optional(),
    value: z.number(),
    location: z.string().optional(),
    period_end: z.string(),
    accession_number: z.string().describe('Source filing for secedgar_get_filing.'),
  })),
})
```

**Handler flow:**
1. Reject a `concept` that is neither a friendly name nor tag-shaped (`unknown_concept`, as in `secedgar_get_financials`) before the frames request, which interpolates the tag into its path
2. Resolve the concept and `taxonomy` to a namespace and XBRL tag through `resolveConceptTarget`, the resolution `secedgar_get_financials` uses: a raw tag reads from the requested namespace, a friendly name keeps its mapped taxonomy under the `us-gaap` default (`shares_outstanding` → `dei`), and an explicit `dei` reads a friendly name's tags from `dei`
3. Fetch `data.sec.gov/api/xbrl/frames/{taxonomy}/{tag}/{unit}/{period}.json`
4. Sort by value (desc or asc)
5. Slice the page from `offset` to `offset + limit`
6. Enrich with ticker symbols from cached `company_tickers.json`

**Key constraints:**
- Frames only cover standard calendar periods (±30 day tolerance from exact calendar boundaries)
- Companies with non-standard fiscal years may not appear (e.g., Apple's September FY end sometimes falls outside tolerance for CY annual frames)
- A frame exists only for the periods filers reported its tag in, so there is no fixed start year. XBRL phased in from 2009 and earlier years appear only as comparatives restated in later filings, so frames thin with age (`NetIncomeLoss` frames 13 filers for CY1995); a tag adopted later has none before it (`revenue`'s ASC 606 tag `RevenueFromContractWithCustomerExcludingAssessedTax` has no annual frame through CY2013 and one filer for CY2014, while `Revenues` frames 1,812 for CY2009)
  - *Decision:* a `no_data` names the tag it read and carries the same `unqueried_tags` (`tags.slice(1)`) a success reports, in its message as well as its data, rather than querying the other tags itself, so a call still sends one frames request and the caller picks which tags to read and how to combine them (#207).
- SEC publishes frames under `us-gaap` and `dei` only, so `taxonomy` offers exactly those two
  - *Decision:* a friendly name paired with an explicit `dei` reads its tags from `dei` rather than keeping the mapping's taxonomy, because that is the rule `get_financials` already applies through `resolveConceptTarget`; one rule across tools beats a frames-only exception, and the `no_data` hint names the mapping's taxonomy for that case.
- A frame row is the latest-filed fact for the period, and the live frames API carries no form: an annual `NetIncomeLoss` row can be a DEF 14A pay-versus-performance figure, and an annual row for a year still open or inside its 10-K window can be a 10-Q trailing-twelve-month figure, so both carry a caveat. Frames assembled from the local mirror read each fact's form and apply the per-filer holder rules instead (`holderFormsResolved`), with no caveat.

**Error guidance:**
- 404 → `"No data for {tag}/{unit}/{period} in the {taxonomy} frames."`, naming the tag read; for a friendly name mapped to several tags the message goes on to list the others, which `data.unqueried_tags` carries too (empty for a raw tag or single-tag name). The hint says to check duration vs. instant period (add 'I' for balance sheet items) and the unit (USD-per-shares for EPS), that a tag has frames only for the periods filers reported it in, and, when tags went unqueried, to query each as `concept` with the same period and unit. It names no start year. A namespace note follows: for a raw tag, which namespace was read and when to switch (`dei` for cover-page tags such as `EntityCommonStockSharesOutstanding`); for a friendly name read outside its mapped taxonomy, to omit `taxonomy`, in place of querying the other tags, which miss there too.

---

## API Reference

### Endpoints Used

| API | URL Pattern | Used By |
|:----|:-----------|:--------|
| Ticker lookup | `https://www.sec.gov/files/company_tickers.json` | `secedgar_company_search`, all tools (CIK resolution) |
| Submissions | `https://data.sec.gov/submissions/CIK{cik}.json` | `secedgar_company_search` |
| EFTS search | `https://efts.sec.gov/LATEST/search-index?q=...` | `secedgar_search_filings`, `secedgar_find_holders`, `secedgar_get_filing` (filer lookup), `secedgar_company_search` (a quoted search with `forms=10-K` for EX-21 subsidiaries exhibits, after a miss) |
| EFTS entity index | `https://efts.sec.gov/LATEST/search-index?keysTyped=...` | `secedgar_company_search` (after a miss in the ticker file), `secedgar_get_institutional_holdings` (entity lookup) |
| Filing archive | `https://www.sec.gov/Archives/edgar/data/{cik}/{accn}/` (CIK unpadded) | `secedgar_get_filing` |
| Company concept | `https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/{taxonomy}/{tag}.json` | `secedgar_get_financials` |
| Company facts | `https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json` | `secedgar_get_snapshot`, `secedgar_compare_companies`, `secedgar_get_financials` (tags companyconcept serves empty, the fiscal-year ends a 10-Q-held annual frame is tested against or an instant concept's annual view is selected on, and the no-data probe) |
| Frames | `https://data.sec.gov/api/xbrl/frames/{taxonomy}/{tag}/{unit}/{period}.json` | `secedgar_fetch_frames` |

### API Quirks

| Quirk | Impact | Mitigation |
|:------|:-------|:-----------|
| `data.sec.gov` URLs need the 10-digit zero-padded CIK; archive paths take it unpadded | A bare integer fails the APIs; a padded `www.sec.gov/Archives` path answers 301, so each archive read costs two requests | `String(cik).padStart(10, '0')` for `data.sec.gov`; strip the leading zeros for archive paths |
| EFTS `entity` param is ignored server-side | Can't filter by company name via param | Resolve `cik:` / `ticker:` targeting to a CIK and pass it in the plural `ciks` param |
| EFTS `dateRange` must be `"custom"` to activate | Passing just `startdt`/`enddt` silently does nothing | Always set `dateRange=custom` when dates provided |
| EFTS ignores a one-sided custom range | `startdt` or `enddt` alone returns the same hits as no dates — a lone `startdt` of 2026-10-01 answers 10,000+ hits filed from 2002 on | Pair a lone bound before the request: `filed_after` runs through today (UTC), `filed_before` starts at 2001-01-01, or at 1993-01-01 when it falls before 2001 and routes to the archives (#185) |
| EFTS ignores `size` | Every request answers with 100 hits | Page with `from` and slice to `limit` locally |
| EFTS relays a search-backend failure as a 200 | The body carries `errorType`, `errorMessage`, `trace`, and `requestId` in place of `hits`; `ConnectionError`, `TimeoutError`, and `NoLivingConnectionsError` succeed on a resend, any other class (`ResponseError`) does not | Retry the transport classes on the request's retry ladder, fail any other on its one request, and carry the class and message in typed fields, never the trace or request id (#206) |
| EFTS serves a 10,000-document result window | `hits.total.value` stops at 10,000, and a `from` past 9,900 is refused as a `ResponseError` body, with or without `q` and whatever the match total | Fail a deeper relevance `offset` before the request (`offset_out_of_range`); break large queries into date sub-ranges (#214) |
| Caller text sent as EFTS `q` or `keysTyped` may hold a backslash or a control character | Each must reach EFTS escaped for the term to be searched as typed | Escape caller text before it reaches full-text search, in `EdgarApiService` only: each backslash doubled, each control character (category Cc) written `\uXXXX` (#205) |
| Conformed names end in a delimited qualifier 13F information tables omit (`US BANCORP \DE\`, `PROGRESSIVE CORP/OH/`) | A phrase built from the registry title matches almost nothing: 2 documents with `\DE\` against 2,315 for `"US BANCORP"` in one quarter's window. Without the qualifier, two registrants can share a phrase (`FIRST BANCORP /PR/` and `/NC/`) and get the same holders | `find_holders` drops one trailing `\` or `/` qualifier of 1–6 letters before quoting; `resolved_issuer_name` keeps the registry title (#205). When another current registrant's title, minus its own qualifier, is the same phrase, the notice names it with CIK and ticker and points to `cusip`, read from the in-memory registry with no request; keeping the qualifier for such a name was rejected, since `"FIRST BANCORP /PR/"` matches 9 documents where the bare phrase matches 458 (#224) |
| XBRL data contains duplicates | Prior-period comparatives appear in multiple filings | Filter to entries with `frame` field for one-per-period |
| A frame goes to the latest-filed fact for its period | A DEF 14A's pay-versus-performance `NetIncomeLoss`, or a 10-Q's trailing-twelve-month figure, can hold an annual frame | Answer a proxy-held frame with the filer's own report of the period; drop a 10-Q-held annual frame unless it covers a closed fiscal year |
| companyconcept serves some units as an empty object (`"units":{"USD":{}}`) | Iterating the unit as a list throws | Drop non-array units at the service edge; answer the tag from companyfacts |
| Revenue tag changed ~2017-2018 | `SalesRevenueNet` → `RevenueFromContractWithCustomerExcludingAssessedTax` | Try multiple tags, merge results |
| Frames ±30 day tolerance | Non-standard fiscal years may not appear | Document as known limitation |
| Submissions returns parallel arrays | Not standard array-of-objects | Zip into objects in handler |

---

## Services

| Module | Type | Purpose | Used By |
|:-------|:-----|:--------|:--------|
| `EdgarApiService` | Service | Rate-limited HTTP client for all SEC EDGAR APIs | All tools |
| `concept-map` | Static data | Friendly name → XBRL tag mapping | `secedgar_get_financials`, `secedgar_get_snapshot`, `secedgar_compare_companies`, `secedgar_fetch_frames`, `secedgar_search_concepts` |
| `filing-to-text` | Utility | Filing HTML → readable plain text | `secedgar_get_filing` |

### `EdgarApiService`

Owns all EDGAR HTTP I/O. Init/accessor pattern — initialized in `setup()`.

- **Paced fetch** — One process-wide `createPacer` queue spaces request starts to 10 req/s (100ms apart). Separate from the framework's inbound rate limiter — this prevents SEC IP bans.
- **Retry with backoff** — Retries 500/502/503/504, an attempt that gets no HTTP response at all (a refused or reset connection, a DNS failure, a connect timeout), and a 2xx whose body fails to read after its headers (the connection breaks off mid-body, invalid chunk framing or compression, or no body bytes for 15 s), with exponential backoff: 3 attempts, sleeping 1 s and then 2 s between them, each re-admitted through the block gate and re-paced. Each attempt gets 15 s from dispatch to response headers before it is aborted and counted as no response — Bun has no connect timeout of its own, and neither runtime bounds a server that accepts and never answers — and queue time in the pacer is outside that cap. The body read is bounded only by its idle limit, measured between reads, so a large body that keeps arriving is never cut, while a stalled one fails its attempt after 15 s — the runtimes alone bound a stall at undici's 300 s on Node and not at all on Bun. Every body is read inside the ladder; an error status's diagnostic body is read through the same reader, bounded to 500 bytes, the idle limit, the budget, and the caller's signal (#202), and rides the error's `cause` to the server's log, never to the caller (#244); a body the ladder does not read (404, retried 5xx, 429, an answer landing as the caller cancels) is cancelled (#188); a probe whose headers arrive still reopens the block gate, and only its own call retries a body that then breaks. Once the attempts run out, the last one decides: a 500, 502, 503, or 504 fails as `sec_unavailable` and no HTTP response or a body that failed to read as `sec_unreachable`, both `ServiceUnavailable` (a 504 too, with `data.status` keeping it) and retryable, with a hint to retry the same call in a minute (#233). A 200 body that reads whole but is not JSON where JSON is expected fails as `sec_unreachable` on its one request, unretried. EDGAR full-text search answers a failure of its search backend with a 200 naming the error class (`errorType`); its two readers (the search and the entity lookup) opt in, so a transport class (`ConnectionError`, `TimeoutError`, `NoLivingConnectionsError`) fails the attempt and retries like a 5xx, its wait and backoff charged to the budget, and ends as `efts_degraded_response` (`retryable: true`), while any other class fails on its one request (`retryable: false`), each carrying `upstreamErrorType` and `upstreamErrorMessage` bounded to 500 bytes (#206). A submissions document or archive page whose JSON lacks the arrays its readers index (the six filing columns, `filings.files`, `tickers`, `exchanges`) fails the same way, before the cache write (#186). Each message is composed from the host, the attempts, and the transport code (Bun's own `code`, Node's `cause.code`) or the timeout; the runtime's text rides `cause` to the log only. **Cancellation and the failure budget (#179):** each tool call builds one `CallScope` (`call-scope.ts`) from `ctx.signal` and passes it to every service method that reaches SEC. The caller's signal reaches every pacer wait, block-gate wait, `fetch`, body read, and backoff sleep: a queued request leaves the pacer unsent, an in-flight attempt aborts, and whatever rejects once the signal has fired is rethrown with the caller's reason — never retried and never counted as a no-response or body-read failure. The scope also carries a 40 s failure budget (`CALL_FAILURE_BUDGET_MS`) that keeps a call against an unresponsive SEC inside the MCP client's 60 s default. Only time SEC spends failing the call is charged: the wait on each attempt that got no response headers or a 5xx, each backoff sleep, the idle time of a stalled body, and the wait on a probe whose silence the call counts as its own attempt. Healthy progress is never charged — pacer queue time, answered requests, a body still arriving — so a call SEC keeps answering with a 2xx is never cut, however long its pacer waits run. Each attempt's header wait and each body-idle wait is the lesser of its 15 s cap and the budget left, and a backoff is slept only while the budget outlasts it; concurrent failing attempts in one call each charge it. Once the budget is spent no further attempt or backoff starts, in that call only: the request fails with the error its last attempt earned (a 5xx is `sec_unavailable`; no response or an unreadable body is `sec_unreachable`), its message saying retries stopped at the call's 40 s budget for SEC failures. A request that finds the budget already spent by earlier requests sends nothing and fails as `sec_unreachable` with a "No request sent … budget … spent" message. The ticker-file load (`company_tickers.json`, then `company_tickers_mf.json`) is shared by every call that needs the ticker index, so it runs under its own scope (`CallScope.unowned()`): a full budget and a signal that never fires. A call waiting on it (`awaitShared`) is charged the failure time the load spends while it waits, no more, with one wait per call — a second wait from the same call joins the first. A waiter's cancel ends only its own wait; the load completes and caches for the others. A 429 is never retried: SEC blocks the IP until its request rate has stayed under the limit for ten minutes, and each request sent meanwhile restarts that clock.
- **Rate-limit block gate** — A 429 stops all outbound SEC traffic for `EDGAR_RATE_LIMIT_COOLDOWN_SECONDS` (default 600): calls fail locally as `rate_limited` with `retryAfter` counting down, then the first call after the cool-down goes out alone as a probe. Mirror-served reads keep answering during the block.
- **User-Agent** — Required `"AppName contact@email.com"` header on every request.
- **CIK resolution** — Loads `company_tickers.json` into memory (TTL: 1 hour). Builds O(1) lookup indexes: ticker → CIK (`Map`), CIK → entity (`Map`). Name search over current and former names ranks exact as written, exact once commas, periods, and apostrophes are deleted and whitespace runs collapse, exact once spaced initials join, prefix of the joined form ending at a word boundary, then substring as written starting at one. When no tier matches, a query of two or more words is compared as a set of words against each name's (the word-order tier, so "Charles Schwab" meets SCHWAB CHARLES CORP). Symbols resolve ahead of the name passes for uppercase input: a listed symbol, then a former ticker from the committed `former-tickers.json` asset (Wayback captures of `company_tickers.json`), the most recent holder winning, in memory with no SEC request — except that a current name the input matches exactly, or the one company the names find for a holder listed no more, keeps the name passes' answer. `resolveEntityByName` (EDGAR's entity index, SEC's trailing ticker list split from each name) and `findSubsidiaryParents` (a quoted search of 10-K EX-21 exhibits) are the network steps `secedgar_company_search` adds after a miss.

```ts
class EdgarApiService {
  fetch(url: string): Promise<Response>  // rate-limited, retried, User-Agent attached

  resolveCik(query: string): Promise<CikMatch | CikMatch[]>
  getSubmissions(cik: string): Promise<SubmissionsResponse>
  searchFilings(params: SearchParams): Promise<EftsResponse>
  getFilingIndex(cik: string, accn: string): Promise<FilingIndex>
  getFilingDocument(cik: string, accn: string, doc: string): Promise<string>
  getCompanyConcept(cik: string, taxonomy: string, tag: string): Promise<ConceptResponse>
  getFrames(taxonomy: string, tag: string, unit: string, period: string): Promise<FramesResponse>
}
```

### `concept-map`

Static mapping of friendly names to XBRL tag arrays. Pure data — no I/O, no service instantiation. Imported directly by tools.

```ts
interface ConceptMapping {
  tags: string[];       // XBRL tags, tried in order
  taxonomy: string;     // us-gaap | ifrs-full | dei
  unit: string;         // USD | USD/shares | shares
  label: string;        // Human-readable label
  aliases?: readonly string[];  // other one-reading spellings, e.g. capital_expenditures
}

const CONCEPT_MAP: Record<string, ConceptMapping> = { /* ... */ };
const CONCEPT_INDEX: Map<string, ConceptMapping>;  // every name and alias, built at load

function resolveConcept(input: string): ConceptMapping | undefined;  // as typed, then split from lowerCamelCase
function findUnknownConcept(input: string): UnknownConcept | undefined;  // neither a catalog name nor tag-shaped
```

### `filing-to-text`

Converts SEC filing HTML to readable plain text. Peer dependency on [`html-to-text`](https://www.npmjs.com/package/html-to-text) (built on `htmlparser2`).

```ts
function filingToText(html: string, limit?: number): {
  text: string;
  truncated: boolean;
  totalLength: number;
};
```

**Why `html-to-text`:** Purpose-built for HTML→text with native table support — tables render as aligned columns. `htmlparser2` is tolerant of malformed markup (common in pre-2010 SEC filings). Lightweight, well-maintained, no browser/DOM dependency.

**Known limitations:** Pre-2005 filings use deeply nested layout tables (not data tables), producing noisier output. Some filings embed data in images or PDFs within HTML — invisible to any HTML parser. Both acceptable for v1. The library's DOM walk is recursive, so conversion caps it at 512 levels (`limits.maxDepth`) and prints `[…]` where markup nests deeper — the stack otherwise overflows near 1,360 levels on Node. Legacy SGML `<PAGE>` markers, which the parser never closes, are replaced with line breaks first so a long text document does not reach the cap. A plain-text SGML `<TEXT>` body (no `<html`, `<body`, `<p`, `<div`, `<br`, `<font`, `<tr`, `<td`, or `<xml` in it) has its tags dropped and goes through as a `<pre>` block, so pre-2001 submissions and 2000s ASCII primary documents keep their lines and their headings; input with no plain body converts exactly as before. The library converts only `<body>` elements when the input has one, so in a submission holding an HTML document each plain body goes in a `<body>` of its own and every document converts in order; uuencoded payloads, machine-readable files (`.xml`, `.xsd`, `.css`, `.js`, `.json`), and the XBRL renderer's generated files (`<TYPE>XML`: the `R*.htm` viewer pages and their script and stylesheet) stay out. Input over the library's 16,777,216-character `maxInputLength` is truncated without an ellipsis; no measured filing reaches it.

---

## Local Mirror (opt-in)

`EDGAR_MIRROR_ENABLED=true` stands up a persistent local SQLite mirror of the two **bounded** SEC reference layers so the throttled live API is bypassed for the highest-volume calls. Built on the framework `MirrorService` (`@cyanheads/mcp-ts-core/mirror`); Node/Bun only (SQLite + filesystem), skipped on Cloudflare Workers.

### Layers

| Layer | Source | Store | Backs |
|:------|:-------|:------|:------|
| Ticker/CIK | `company_tickers.json` (~800 KB JSON) + fund symbols from `company_tickers_mf.json` (empty name, no series/class) | `tickers` — PK `ticker`, index `cik` | `resolveCik`, `cikToTicker` |
| XBRL company-facts | `companyfacts.zip` (~1.3 GB bulk archive) | `company_concepts` — PK `cik\|taxonomy\|tag`, `units` JSON blob, indexes `taxonomy,tag` and `cik` | `tryGetCompanyConcept`, `tryGetCompanyFacts`, `tryGetFrames` |

One row per `(cik, taxonomy, tag)` stores the concept's full `units` map verbatim, so a point read (`getByIds`) reconstructs the `companyconcept` API shape and a `taxonomy+tag` scan reconstructs the `frames` API shape off the same ~2.5M-row table — no separate ~10⁸-row fact-inversion table, keeping the store inside the embedded-SQLite tier.

**No FTS5.** Every routed lookup is exact/indexed (cik+taxonomy+tag point, taxonomy+tag scan, cik scan for the whole-company read and a frames call's fiscal-year-end reads, ticker/CIK equality); full-text search would add ingestion cost and disk with no access path to serve. EFTS filing-text search stays live and out of scope.

### Sync model

- **Init** (`bun run mirror:init`) — out-of-band one-shot. Downloads `company_tickers.json`, then streams `companyfacts.zip` through fflate (`Unzip` + `UnzipInflate`), parsing each `CIK*.json` entry into rows with bounded memory. The durable `checkpoint` (the archive's `Last-Modified`) is emitted only on a terminal page after the whole archive has drained, so an interrupted ingest leaves no completion checkpoint and the next refresh re-streams the full archive (idempotent upserts) rather than skipping a partial store as already-synced.
- **Refresh** (`bun run mirror:refresh`, or in-process via `EDGAR_MIRROR_REFRESH_CRON` on HTTP) — re-downloads the ticker file and, for company-facts, a `Last-Modified` HEAD short-circuits when the nightly archive (rebuilt ~03:00 ET) is unchanged; otherwise re-ingests. Upsert-only — a company/ticker dropped upstream lingers (low-harm; CIKs are permanent).
- **One sync per store** — each SQLite store carries the framework's sync lease, so an init or refresh started while another process syncs the same store file is refused (`Conflict`, `data.reason: 'sync_locked'`): `mirror:init` and `mirror:refresh` exit 1 with "Mirror sync is already in progress in another process or instance.", and the in-process refresh logs the skip at `info` and waits for its next tick. A run killed mid-sync holds the lease until it lapses (2 minutes).
- **Readiness** — point lookups (`resolveCik`, `tryGetCompanyConcept`) key off the durable completion marker (`mirror.ready()`), so they keep serving during a refresh. The cross-company frames aggregation gates on the stricter `companyFactsComplete()` (`status === 'complete'`): a full-table scan over a partial or mid-(re)sync store would yield a silently-incomplete frame, so frames fall back to the live API until the layer is fully synced.
- **In-container ops** — the production Docker image carries the three `mirror:*` scripts plus a minimal path-alias `tsconfig.json` (`@/*` → `./dist/*`), so an operator can run `docker exec <container> bun run mirror:<init|refresh|verify>` against a deployed server — no rebuild, no out-of-band store shipping. Bun runs the `.ts` scripts natively and resolves their `@/` imports against the compiled `./dist/` via the emitted tsconfig.

### Routing

With `EDGAR_MIRROR_FALLBACK_LIVE` (default `true`), each routed read goes live wherever SEC may hold something newer than the store, and the store answers when that live read fails with anything but the caller's cancel (#234). Before a layer is ready (frames: complete, the stricter gate above) every read is live.

| Read | Live when | Store answers otherwise |
|:-----|:----------|:------------------------|
| Ticker index (`resolveCik`) | every ticker-cache TTL, as with no mirror | only if `company_tickers.json` fails: all mirror rows, standing for the TTL. Mirror fund rows always join, behind the live fund slice |
| `tryGetCompanyConcept`, `tryGetCompanyFacts` | the filer's newest `isXBRL` filing, on any form, was accepted on or after the day before the companyfacts checkpoint (the archive's `Last-Modified`); or the store does not hold the filer | the stored row; a tag the store lacks is `null` with no live read, as SEC's 404 for an unreported tag |
| `tryGetFrames` | the period's filing window was still open at the checkpoint: `CY####` until October 31 of the next year, a quarterly or instant period until six months after its calendar quarter ends | the store's frame, holder-form rules applied (#123, #142); live on a miss |

- **Recency read.** The filer's newest XBRL acceptance comes from its submissions document through `getSubmissions` and its cache, so it costs one read per filer per TTL and nothing in a call that already read the document; archive pages count to the end of their last filing day. A store with no checkpoint reads live without it. Point reads asking while a filer's read is in flight share it — another call's read only when it cannot outspend their own failure budget — and ask again under their own scope when the call that started it is cancelled. The submissions cache holds at most 160 MiB of documents by the service's size estimate (448 MiB with the archive-page and full-index caches), dropping the one used longest ago.
- **Failures.** A failed recency or live point read leaves the store answering for that filer, without asking SEC, for 60 s or the failure's `retryAfter` when longer, so a 429 block never turns an answer the store holds into a failure. A read the call's own failure budget ended, SEC failing none of its attempts (never sent, or its only attempt cut short of its 15 s wait), answers from the store and marks nothing, since it says nothing about SEC or the filer. A live 404 is SEC answering, not failing: the stored row answers where the store holds one, since SEC never drops a fact from a filer's companyfacts once reported, `null` answers where it does not, and nothing is marked. The store answers only where it holds the answer: a live failure for a filer it lacks, or for an open period it has no frame for, stands. A call whose failure budget is already spent reads the store for a filer it holds.
- **Why these rules.** Reading the ticker file every TTL costs one request and picks up symbols listed since the last refresh. The per-filer recency read makes the store's miss authoritative, so an unchanged filer's unreported tags cost no live read. A closed frames period keeps the holder-form rules only the store applies. A gate on the store's age was rejected: a monthly store would answer nothing from the mirror, and a nightly one would still miss same-day filings.

Strict mirror-only mode (`false`) sends no request for any of these reads: a miss is empty, and an unsynced layer throws. Frames are assembled from the company-facts store and therefore carry no `loc` (business location); the live frames endpoint adds it, and the tool treats an empty value as absent.

### Config

| Env Var | Default | Description |
|:--------|:--------|:------------|
| `EDGAR_MIRROR_ENABLED` | `false` | Enable the mirror. |
| `EDGAR_MIRROR_PATH` | `./data/edgar-mirror` | Directory for the two SQLite databases. |
| `EDGAR_MIRROR_REFRESH_CRON` | — | In-process nightly refresh cron (HTTP only); recommended `0 9 * * *`. |
| `EDGAR_MIRROR_FALLBACK_LIVE` | `true` | Read live wherever SEC may hold something newer than the store (Routing above), the store answering when that read fails. `false` is strict mirror-only. |

`submissions.zip` (filing-history metadata) and the EFTS full-text index are out of scope — a follow-on issue for the former, no bulk download for the latter.

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `EDGAR_USER_AGENT` | **Yes** | — | User-Agent string for SEC compliance. Format: `"AppName contact@email.com"`. SEC may block requests without this. |
| `EDGAR_RATE_LIMIT_RPS` | No | `10` | Max requests per second to SEC APIs. Do not exceed 10. |
| `EDGAR_RATE_LIMIT_COOLDOWN_SECONDS` | No | `600` | Seconds to stop sending to SEC after a 429 before one probe request goes out. |
| `EDGAR_TICKER_CACHE_TTL` | No | `3600` | Seconds to cache the ticker index (company_tickers.json + company_tickers_mf.json). A failed fund-file load is retried after 60 s, or the rate-limit cool-down, instead of standing for the TTL. |

Minimal config — the API is entirely public and free.

---

## Implementation Order

1. **Config + server setup** — Zod schema for env vars, `createApp` scaffold
2. **`EdgarApiService`** — HTTP client with rate limiting, User-Agent, CIK resolution, concept mapping
3. **`secedgar_company_search`** — Foundation tool, exercises CIK resolution and submissions API
4. **`secedgar_get_financials`** — Highest-value tool, exercises XBRL + concept mapping + dedup
5. **`secedgar_search_filings`** — EFTS integration
6. **`secedgar_get_filing`** — Filing content retrieval + HTML-to-text
7. **`secedgar_fetch_frames`** — Frames API
8. **Resources** — `secedgar://concepts`, `secedgar://filing-types`
9. **Prompt** — `company_analysis`

Each step is independently testable. Steps 3-7 can be parallelized once the service layer is solid.

---

## Design Decisions

### Why friendly concept names?

The raw XBRL tag for revenue is `RevenueFromContractWithCustomerExcludingAssessedTax` (55 characters). No LLM will reliably produce this, and even if it does, the tag changed from `SalesRevenueNet` in 2017. Friendly names (`"revenue"`) hide this complexity and automatically handle tag evolution. The tradeoff: a catalog of a few dozen common concepts (36 today) covers most financial analysis workflows. Raw tags are accepted as an escape hatch.

### Why deduplicate with the `frame` field?

Every 10-K filing includes prior-year comparatives. Apple's 2023 10-K reports 2023, 2022, and 2021 revenue — all three appear in the API response under that filing's accession number. Without deduplication, the agent sees 3x the data with conflicting signals. The `frame` field marks the "canonical" value for each calendar period.

### Why Form 4 XML parsing came later

Insider trading (Form 4) is a common workflow, but Form 4 documents are structured XML requiring dedicated parsing — transaction codes, derivative vs. non-derivative tables, footnotes. The first release served insider trading through the general-purpose tools: filter company filings to `forms: ["4"]`, then read individual filings. `secedgar_get_insider_transactions` later added the dedicated parser, and the same approach carried over to 13F information tables, SCHEDULE 13D/13G, and NPORT-P.

The submissions feed cross-lists schedules under investors as well as issuers. `secedgar_get_beneficial_owners` therefore checks each parsed issuer CIK before attributing ownership, comparing without zero-padding. Its newest-first scan stops at `limit` matching parsed filings or 50 examined documents. `total_structured_filings = filings_examined + filings_not_examined`, and `filings_examined = filings_parsed + filings_excluded_other_issuer + filings_failed.length`. A missing document records `document_not_found`; an unreadable schedule or unusable issuer identity records `unparseable`. These failures set `partial` and retain successful filings; `truncated` instead identifies unexamined schedules. Inline and dataframe ownership rows contain only matching schedules, and the notice composes document recovery with the applicable scan bound and dataframe guidance.

Item 4 `purpose_of_transaction` and each reporting person's `notes` are filer-written text, returned as filed with their line breaks. Each has its own bound, 5,000 and 2,000 characters: a longer value is its first characters, nothing appended, flagged by `purpose_truncated` or `notes_truncated`, and the one composed notice counts the cuts and points to the whole text in the dataframe, whose rows carry both fields uncut, or in the filing through `secedgar_get_filing`. The purpose bound is the trade between completeness and one call's size. Of 48 sampled Item 4s, 5,000 returns 44 whole, while 1,200 cut 34. Uncut, the 20 longest make a 136.5 KB response, against 117 KB at the bound. `format()` quotes each value as data: `escapeMarkdownInline`, then `> ` before every line, so a CommonMark parse reads back the `structuredContent` value, CR and CRLF as LF, and a filer line opening with `>` or a fence stays text (#200).

### Why compose 13F amendments into the quarter?

Disclosing amendments without applying them left totals short: Berkshire's 2025-Q1 NEW HOLDINGS amendment adds $1.1B across 4 rows, Nucor included. `secedgar_get_institutional_holdings` therefore composes the quarter from the original 13F-HR and its same-period 13F-HR/A amendments, and each amendment reports `applied_as` so callers can inspect any accession with `secedgar_get_filing`.

The two amendment types are honored by meaning: a RESTATEMENT replaces everything composed so far, a NEW HOLDINGS amendment appends. The exception is a NEW HOLDINGS table that repeats every composed row, a mislabeled resubmission (First Eagle's 2026-Q2 amendment: 614 original rows plus 2), which is applied as a restatement because trusting the cover type would double a $60B portfolio. Order is `acceptanceDateTime`, not filing date (Advisors Asset Management filed a 2020-Q2 restatement and a new-holdings amendment on one day) and not `amendmentNo` (filers skip numbers). Values normalize by each accession's own filing date, since a 2026 amendment of a 2022 quarter reports whole dollars. An amendment table with no rows, or whose type, index, or table cannot be read, is `not_applied` rather than allowed to blank the quarter; a failed last restatement falls back to the previous base. The original 13F-HR's table is still read and required: it backs `total_holdings_in_filing` and the existing error contract.

Discovery continues through the relevant submissions archive coverage, bounded at ten pages; incomplete discovery is explicit. Header lookup failures preserve amendment identity and the successful original, while cancellation propagates. All chained reads, table reads included, share one `CallScope` and failure budget; a rate-limit block or exhausted budget stops further optional reads.

`secedgar_find_holders` keeps its five-page document sample. Its continuation notice reuses `secedgar_search_filings` with the exact query, filing dates, relevance sort and fetched-document offset, avoiding a second paging API. The call is written as JSON in a code span, so `content[]` rendered as Markdown keeps the quoted phrase's escaping and parses back to the JSON `structuredContent` carries (#220). Results are filtered by reporting period and deduplicated across both tools by filer CIK and latest filing date. Reachable documents are `min(total_filings, 10000)`; a lower-bound total does not claim paging can reach beyond EDGAR's window.

### Why answer an over-cap comparison up to its caps?

`secedgar_compare_companies` reads the first 10 `companies` inputs and the first 8 distinct `concepts` and returns the rest, as supplied, in `deferred_companies` / `deferred_concepts`, with one notice naming the re-calls that compare them (#201). The answered part is exactly what the shorter call returns, so rejecting the longer one only costs a round trip; raising the caps instead would add a companyfacts read per company.

- *Decision:* the company cap counts inputs as given — an unresolved input, or a second name for a company already read, keeps its place — so no input past the tenth is resolved. The concept cap counts distinct known concepts: a second spelling merges (#145) and an unknown name takes no place (#128).
- *Decision:* when both lists defer, the notice names three re-calls with the same other inputs — the deferred companies with the 8 compared concepts, the 10 companies read with the deferred concepts, and the two deferred lists together — one per set of unread cells. Two re-calls, each pairing one deferred list with the other full input list, pass the other cap, re-defer, and read the deferred-by-deferred cells twice. A lone deferred company is paired with one of the 10 in its two re-calls, since `companies` takes at least two, and that company leaves the second re-call, so no unread cell is read twice; the first re-call reads the paired company's compared cells again.
- *Decision:* each list is rejected past 100, since past the cap it is only echoed back and a wider screen is `secedgar_fetch_frames`' job. `EDGAR_CLAMP_OVERSIZED_LIMITS` governs it beside the numeric clamps (#197); a second switch would be a knob no deployment needs. Off, 10 and 8 are the advertised maxima again.
- *Decision:* an input resolving to a CIK an earlier input resolved is read once, under the earlier input, with a caveat worded like the concept merge, and is not a `failed_companies` entry (#217).

### Why one shared canvas per tenant?

Every staged dataframe lives on the tenant's one canvas so that tables from different tools join in a single query.

- *Decision:* the canvas bridge reaches it only through `DataCanvas.acquireShared`, and the `df-meta/` records are purged whenever the stored canvas is replaced. Concurrent first stagings would otherwise each mint a canvas and strand tables on the losers, and records left behind by a dead canvas would have `secedgar_dataframe_describe` list tables that no longer exist. Describe, drop, and the expiry sweep never mint a canvas.
- *Decision:* `secedgar_dataframe_describe` without a `name` is refused as `listing_unavailable` over HTTP with `MCP_AUTH_MODE=none`. Every caller there resolves to the `default` tenant and so shares one canvas, and a listing would show each caller the others' dataframes with their query parameters. Describing, querying, and dropping by exact name are unchanged, as is listing over stdio and authenticated HTTP.

### Why not wrap an existing npm package?

`sec-edgar-toolkit` (the only open-source TS option) is AGPL-3.0 licensed — any server wrapping it must be open-sourced. The SEC APIs are simple REST endpoints with no auth, so a thin service layer with rate limiting is more appropriate than a dependency.

---

## Future Considerations

| Feature | Complexity | Value | Notes |
|:--------|:-----------|:------|:------|
| SIC-based industry search | Low | Medium | Filter company_tickers by SIC code |
| Filing diff | Medium | Medium | Compare two filings of the same type for changes |
| RSS/Atom feed monitoring | Low | Low | Poll for new filings from specific companies |
