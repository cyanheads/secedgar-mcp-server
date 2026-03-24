# SEC EDGAR MCP Server — Design

**Package:** `@cyanheads/secedgar-mcp-server`

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `secedgar_company_search` | Find companies and retrieve entity info with optional recent filings. Entry point for most workflows. | `query`, `include_filings?`, `form_types?`, `filing_limit?` | `readOnlyHint`, `openWorldHint` |
| `secedgar_search_filings` | Full-text search across all EDGAR filing documents since 1993. | `query`, `forms?`, `start_date?`, `end_date?`, `limit?`, `offset?` | `readOnlyHint`, `openWorldHint` |
| `secedgar_get_filing` | Fetch a specific filing's metadata and document content by accession number. | `accession_number`, `cik?`, `content_limit?`, `document?` | `readOnlyHint`, `idempotentHint` |
| `secedgar_get_financials` | Get historical XBRL financial data for a company. Accepts friendly concept names. | `company`, `concept`, `taxonomy?`, `period_type?` | `readOnlyHint`, `idempotentHint` |
| `secedgar_compare_metric` | Compare a financial metric across all reporting companies for a specific period. | `concept`, `period`, `unit?`, `limit?`, `sort?` | `readOnlyHint`, `openWorldHint` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `secedgar://concepts` | Reference list of common XBRL financial concepts grouped by financial statement, mapping friendly names to XBRL tags. The "menu" an agent reads before calling `secedgar_get_financials`. | No |
| `secedgar://filing-types` | Reference list of common SEC filing types with descriptions, cadence, and typical use cases. | No |

### Prompts

| Name | Description | Args |
|:-----|:------------|:-----|
| `secedgar_company_analysis` | Guides a structured analysis of a public company's SEC filings: identify recent filings, extract financial trends, surface risk factors, note material events. | `company`, `focus_areas?` |

---

## Overview

[SEC EDGAR](https://www.sec.gov/edgar) (Electronic Data Gathering, Analysis, and Retrieval) is the SEC's public database of corporate filings. Every public company, fund, and insider is required to file here. The data is entirely free, requires no authentication, and covers filings from 1993 to present.

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
| **8-K** | Event-driven | Material events: M&A (1.01), earnings (2.02), exec changes (5.02) |
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

**What it wraps:** `company_tickers.json` (ticker/name → CIK resolution) → submissions API (entity details + filings).

The submissions API returns both entity metadata and filings in a single call. Splitting them into two tools would hit the same endpoint twice.

```ts
input: z.object({
  query: z.string()
    .describe('Company ticker symbol (e.g., "AAPL"), name (e.g., "Apple"), or CIK number (e.g., "320193"). '
      + 'Ticker is the fastest lookup. Name search does fuzzy matching.'),
  include_filings: z.boolean().default(true)
    .describe('Include recent filings in the response. Set to false for entity-info-only lookups.'),
  form_types: z.array(z.string()).optional()
    .describe('Filter filings to specific form types (e.g., ["10-K", "10-Q", "8-K"]). '
      + 'Without this, returns all form types.'),
  filing_limit: z.number().int().min(1).max(50).default(10)
    .describe('Maximum number of filings to return. The API has up to 1,000 recent filings per company.'),
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
  })).optional().describe('Recent filings, filtered by form_types if specified.'),
  total_filings: z.number().optional()
    .describe('Total number of filings matching the filter (may exceed filing_limit).'),
})
```

**Handler flow:**
1. If `query` looks like a number → treat as CIK, zero-pad
2. If `query` is 1-5 letters → case-insensitive ticker lookup via `Map` (O(1))
3. Otherwise → name search against `company_tickers.json`: exact match first, then case-insensitive prefix, then substring. Return top 5 scored matches. No fuzzy-matching library needed — prefix + substring covers practical cases across ~10K entries.
4. Fetch `data.sec.gov/submissions/CIK{padded}.json`
5. Filter `filings.recent` parallel arrays by `form_types` if provided
6. Slice to `filing_limit`

**Error guidance:**
- No match → `"No company found for '{query}'. Try a ticker symbol (e.g., 'AAPL'), full company name, or 10-digit CIK."`
- Ambiguous name → return top matches with tickers: `"Multiple matches for 'Apple': AAPL (Apple Inc.), APLE (Apple Hospitality REIT). Specify a ticker for exact match."`

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
      + 'entity targeting (cik:320193 or ticker:AAPL within the query string). '
      + 'Terms are AND\'d by default.'),
  forms: z.array(z.string()).optional()
    .describe('Filter to specific form types (e.g., ["10-K", "10-Q", "8-K"]). '
      + 'Without this, searches all form types.'),
  start_date: z.string().optional()
    .describe('Start of date range (YYYY-MM-DD). Both start_date and end_date must be provided for date filtering.'),
  end_date: z.string().optional()
    .describe('End of date range (YYYY-MM-DD). Both start_date and end_date must be provided for date filtering.'),
  limit: z.number().int().min(1).max(100).default(20)
    .describe('Results per page. Max 100. Default 20 to keep responses concise.'),
  offset: z.number().int().min(0).default(0)
    .describe('Pagination offset. Increment by limit for next page. Hard cap at 10,000 total results.'),
})

output: z.object({
  total: z.number().describe('Total matching filings (capped at 10,000).'),
  total_is_exact: z.boolean().describe('False when total hits the 10,000 cap.'),
  results: z.array(z.object({
    accession_number: z.string().describe('Use with secedgar_get_filing to retrieve content.'),
    form: z.string(),
    filing_date: z.string(),
    period_ending: z.string().optional(),
    company_name: z.string(),
    cik: z.string(),
    tickers: z.array(z.string()).optional(),
    file_description: z.string().optional(),
    sic: z.string().optional(),
    location: z.string().optional(),
  })),
  form_distribution: z.record(z.number()).optional()
    .describe('Count of results by form type from aggregations. Helps narrow follow-up searches.'),
})
```

**Handler flow:**
1. Build query params: `q`, `forms` (comma-join), `dateRange=custom` + `startdt`/`enddt` if dates provided, `from`, `size`
2. Fetch `efts.sec.gov/LATEST/search-index`
3. Map Elasticsearch hits to clean output objects
4. Extract `form_filter` aggregation for distribution info

**Key design decisions:**
- Default `limit: 20` (not 100) — most searches don't need 100 results and it keeps LLM context lean
- Include `form_distribution` from ES aggregations — lets the agent see "142 results in 10-K, 89 in 8-K" and refine
- Entity filtering via `cik:` / `ticker:` in the `query` string (the `entity` parameter is ignored server-side)

**Error guidance:**
- No results → `"No filings match. Try broader terms, remove date filters, or check spelling. Exact phrases require double quotes."`
- 10K cap hit → `"Results capped at 10,000. Narrow with date range or form type filters."`

---

### 3. `secedgar_get_filing`

**Workflow:** "Read Apple's 10-K from November 2023" / "Get filing 0000320193-23-000106"

**What it wraps:** Filing archive index + primary document fetch + HTML-to-text extraction.

```ts
input: z.object({
  accession_number: z.string()
    .describe('Filing accession number in either format: '
      + '"0000320193-23-000106" (dashes) or "000032019323000106" (no dashes). '
      + 'Obtained from secedgar_company_search or secedgar_search_filings results.'),
  cik: z.string().optional()
    .describe('Company CIK. Optional but recommended — speeds up URL construction. '
      + 'If omitted, derived from the accession number prefix.'),
  content_limit: z.number().int().min(1000).max(200000).default(50000)
    .describe('Maximum characters of document text to return. '
      + '10-K filings can exceed 500,000 characters. Default 50,000 captures the first ~12,000 words '
      + '(typically business overview, risk factors, and MD&A). '
      + 'Increase to 200,000 for full financial statements, or decrease for quick summaries.'),
  document: z.string().optional()
    .describe('Specific document filename within the filing (e.g., "ex-21.htm" for subsidiaries list). '
      + 'Default: the primary document. Available documents listed in the response metadata.'),
})

output: z.object({
  accession_number: z.string(),
  form: z.string(),
  filing_date: z.string(),
  company_name: z.string(),
  cik: z.string(),
  period_ending: z.string().optional(),
  primary_document: z.string(),
  documents: z.array(z.object({
    name: z.string(),
    type: z.string(),
    size: z.number().optional(),
  })).describe('All documents in this filing. Use the name field with the document input param to fetch exhibits.'),
  content: z.string().describe('Document text content, truncated to content_limit.'),
  content_truncated: z.boolean().describe('True if content was truncated.'),
  content_total_length: z.number().describe('Full document length before truncation.'),
  filing_url: z.string().describe('Direct URL to the filing on SEC.gov.'),
})
```

**Handler flow:**
1. Normalize accession number (ensure dash format for display, no-dash for URL path)
2. Derive CIK from accession number prefix if not provided
3. Fetch filing index: `sec.gov/Archives/edgar/data/{cik}/{accn_nodashes}/{accn}-index.json`
4. Determine target document (primary or specified)
5. Fetch document HTML
6. Convert HTML to clean text (strip tags, normalize whitespace, preserve table structure where possible)
7. Truncate to `content_limit`

**Error guidance:**
- 404 → `"Filing not found. Verify the accession number. Format: '0000320193-23-000106' (with dashes)."`
- Document not in filing → `"Document '{name}' not found in this filing. Available documents: {list}. Use one of these names."`

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
  period_type: z.enum(['annual', 'quarterly', 'all']).default('annual')
    .describe('Filter to annual (FY) or quarterly (Q1-Q4) data. "all" returns both.'),
})

output: z.object({
  company: z.string(),
  cik: z.string(),
  concept: z.string().describe('XBRL tag name used.'),
  label: z.string().describe('Human-readable label for the concept.'),
  description: z.string().optional().describe('XBRL taxonomy description.'),
  unit: z.string().describe('Unit of measure (e.g., "USD", "shares", "USD/shares").'),
  data: z.array(z.object({
    period: z.string().describe('Calendar period label (e.g., "CY2023", "CY2023Q3").'),
    value: z.number(),
    start: z.string().optional().describe('Period start date (duration items only).'),
    end: z.string().describe('Period end date.'),
    fiscal_year: z.number(),
    fiscal_period: z.string(),
    form: z.string().describe('Source filing type (10-K, 10-Q, etc.).'),
    filed: z.string().describe('Date the source filing was submitted.'),
    accession_number: z.string().describe('Source filing accession number for secedgar_get_filing.'),
  })).describe('Deduplicated time series, newest first.'),
  tags_tried: z.array(z.string()).optional()
    .describe('XBRL tags that were attempted (shown when using friendly names that map to multiple tags).'),
})
```

**Handler flow:**
1. Resolve `company` to CIK (via ticker lookup)
2. Map friendly `concept` name to XBRL tag(s) — some map to multiple tags (e.g., "revenue" → 3 possible tags)
3. For each mapped tag, fetch `data.sec.gov/api/xbrl/companyconcept/CIK{padded}/{taxonomy}/{tag}.json`
4. Merge results if multiple tags returned data (union, dedup by period)
5. Deduplicate: keep only entries with `frame` field (one value per standard calendar period)
6. Filter by `period_type` (FY vs Q1-Q4)
7. Sort newest first

**Friendly name → XBRL tag mapping:**

| Friendly Name | XBRL Tags (tried in order) | Taxonomy | Unit |
|:------|:------------|:---------|:-----|
| `revenue` | `RevenueFromContractWithCustomerExcludingAssessedTax`, `Revenues`, `SalesRevenueNet`, `SalesRevenueGoodsNet` | us-gaap | USD |
| `net_income` | `NetIncomeLoss` | us-gaap | USD |
| `operating_income` | `OperatingIncomeLoss` | us-gaap | USD |
| `gross_profit` | `GrossProfit` | us-gaap | USD |
| `eps_basic` | `EarningsPerShareBasic` | us-gaap | USD/shares |
| `eps_diluted` | `EarningsPerShareDiluted` | us-gaap | USD/shares |
| `assets` | `Assets` | us-gaap | USD |
| `liabilities` | `Liabilities` | us-gaap | USD |
| `equity` | `StockholdersEquity` | us-gaap | USD |
| `cash` | `CashAndCashEquivalentsAtCarryingValue` | us-gaap | USD |
| `debt` | `LongTermDebt`, `LongTermDebtNoncurrent` | us-gaap | USD |
| `shares_outstanding` | `EntityCommonStockSharesOutstanding` | dei | shares |
| `operating_cash_flow` | `NetCashProvidedByUsedInOperatingActivities` | us-gaap | USD |
| `capex` | `PaymentsToAcquirePropertyPlantAndEquipment` | us-gaap | USD |

Revenue is the most complex: companies switched from `SalesRevenueNet` to `RevenueFromContractWithCustomerExcludingAssessedTax` around 2017-2018 (ASC 606 adoption). The handler tries all variants and merges for full history.

**Error guidance:**
- Unknown friendly name → `"Unknown concept '{name}'. Use a friendly name (revenue, net_income, assets, etc.) or a raw XBRL tag. See secedgar://concepts for the full list."`
- No data for concept → `"No XBRL data for '{tag}' under {taxonomy} for this company. This company may use a different tag or taxonomy. Try 'ifrs-full' for foreign filers."`

---

### 5. `secedgar_compare_metric`

**Workflow:** "Which companies had the highest revenue in 2023?" / "Rank companies by total assets in Q1 2024"

**What it wraps:** XBRL frames API — returns one fact per company for a given concept and calendar period.

```ts
input: z.object({
  concept: z.string()
    .describe('Financial concept — same friendly names as secedgar_get_financials '
      + '(e.g., "revenue", "assets", "eps_basic") or raw XBRL tag.'),
  period: z.string()
    .describe('Calendar period. Formats:\n'
      + '  "CY2023" — full year 2023 (duration, for income statement items)\n'
      + '  "CY2024Q2" — Q2 2024 (duration, for quarterly income items)\n'
      + '  "CY2023Q4I" — Q4 2023 instant (balance sheet items like assets, cash)\n'
      + 'Use duration periods (no I suffix) for income/cash flow items. '
      + 'Use instant periods (I suffix) for balance sheet items.'),
  unit: z.enum(['USD', 'USD-per-shares', 'shares', 'pure']).default('USD')
    .describe('Unit of measure. Use "USD-per-shares" for EPS, "shares" for share counts, "pure" for ratios.'),
  limit: z.number().int().min(1).max(100).default(25)
    .describe('Number of companies to return. Results are sorted by value.'),
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
1. Map friendly concept name to XBRL tag (same mapping as `secedgar_get_financials`)
2. Fetch `data.sec.gov/api/xbrl/frames/{taxonomy}/{tag}/{unit}/{period}.json`
3. Sort by value (desc or asc)
4. Slice to `limit`
5. Enrich with ticker symbols from cached `company_tickers.json`

**Key constraints:**
- Frames only cover standard calendar periods (±30 day tolerance from exact calendar boundaries)
- Companies with non-standard fiscal years may not appear (e.g., Apple's September FY end sometimes falls outside tolerance for CY annual frames)
- Annual data starts ~2009 (SEC XBRL mandate)

**Error guidance:**
- 404 → `"No data for {concept}/{unit}/{period}. Check: duration vs. instant period (add 'I' for balance sheet items), correct unit (USD-per-shares for EPS), and period exists (data starts ~CY2009)."`

---

## API Reference

### Endpoints Used

| API | URL Pattern | Used By |
|:----|:-----------|:--------|
| Ticker lookup | `https://www.sec.gov/files/company_tickers.json` | `secedgar_company_search`, all tools (CIK resolution) |
| Submissions | `https://data.sec.gov/submissions/CIK{cik}.json` | `secedgar_company_search` |
| EFTS search | `https://efts.sec.gov/LATEST/search-index?q=...` | `secedgar_search_filings` |
| Filing archive | `https://www.sec.gov/Archives/edgar/data/{cik}/{accn}/` | `secedgar_get_filing` |
| Company concept | `https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/{taxonomy}/{tag}.json` | `secedgar_get_financials` |
| Frames | `https://data.sec.gov/api/xbrl/frames/{taxonomy}/{tag}/{unit}/{period}.json` | `secedgar_compare_metric` |

### API Quirks

| Quirk | Impact | Mitigation |
|:------|:-------|:-----------|
| CIK must be 10-digit zero-padded in URLs | Bare integers from ticker lookup fail | `String(cik).padStart(10, '0')` |
| EFTS `entity` param is ignored server-side | Can't filter by company name via param | Embed `cik:NNNNNN` or `ticker:XXX` in the `q` query string |
| EFTS `dateRange` must be `"custom"` to activate | Passing just `startdt`/`enddt` silently does nothing | Always set `dateRange=custom` when dates provided |
| EFTS `size` is capped at 100 | Requesting 200 returns 100 | Enforce max 100 in schema |
| EFTS total hits capped at 10,000 | Can't paginate beyond 10K | Break large queries into date sub-ranges |
| XBRL data contains duplicates | Prior-period comparatives appear in multiple filings | Filter to entries with `frame` field for one-per-period |
| Revenue tag changed ~2017-2018 | `SalesRevenueNet` → `RevenueFromContractWithCustomerExcludingAssessedTax` | Try multiple tags, merge results |
| Frames ±30 day tolerance | Non-standard fiscal years may not appear | Document as known limitation |
| Submissions returns parallel arrays | Not standard array-of-objects | Zip into objects in handler |

---

## Services

| Module | Type | Purpose | Used By |
|:-------|:-----|:--------|:--------|
| `EdgarApiService` | Service | Rate-limited HTTP client for all SEC EDGAR APIs | All tools |
| `concept-map` | Static data | Friendly name → XBRL tag mapping | `secedgar_get_financials`, `secedgar_compare_metric` |
| `filing-to-text` | Utility | Filing HTML → readable plain text | `secedgar_get_filing` |

### `EdgarApiService`

Owns all EDGAR HTTP I/O. Init/accessor pattern — initialized in `setup()`.

- **Rate-limited fetch** — Enforces 10 req/s outbound via minimum 100ms inter-request delay. Separate from the framework's inbound rate limiter — this prevents SEC IP bans.
- **Retry with backoff** — Retries 429/503 responses with exponential backoff (3 attempts, 1s/2s/4s). SEC returns these intermittently during peak load and maintenance.
- **User-Agent** — Required `"AppName contact@email.com"` header on every request.
- **CIK resolution** — Loads `company_tickers.json` into memory (TTL: 1 hour). Builds O(1) lookup indexes: ticker → CIK (`Map`), CIK → entity (`Map`). Name search uses case-insensitive prefix then substring against the entity list.

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
}

const CONCEPT_MAP: Record<string, ConceptMapping> = { /* ... */ };

function resolveConcept(input: string): ConceptMapping | undefined;
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

**Known limitations:** Pre-2005 filings use deeply nested layout tables (not data tables), producing noisier output. Some filings embed data in images or PDFs within HTML — invisible to any HTML parser. Both acceptable for v1.

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `EDGAR_USER_AGENT` | **Yes** | — | User-Agent string for SEC compliance. Format: `"AppName contact@email.com"`. SEC may block requests without this. |
| `EDGAR_RATE_LIMIT_RPS` | No | `10` | Max requests per second to SEC APIs. Do not exceed 10. |
| `EDGAR_TICKER_CACHE_TTL` | No | `3600` | Seconds to cache the company_tickers.json lookup file. |

Minimal config — the API is entirely public and free.

---

## Implementation Order

1. **Config + server setup** — Zod schema for env vars, `createApp` scaffold
2. **`EdgarApiService`** — HTTP client with rate limiting, User-Agent, CIK resolution, concept mapping
3. **`secedgar_company_search`** — Foundation tool, exercises CIK resolution and submissions API
4. **`secedgar_get_financials`** — Highest-value tool, exercises XBRL + concept mapping + dedup
5. **`secedgar_search_filings`** — EFTS integration
6. **`secedgar_get_filing`** — Filing content retrieval + HTML-to-text
7. **`secedgar_compare_metric`** — Frames API
8. **Resources** — `secedgar://concepts`, `secedgar://filing-types`
9. **Prompt** — `company_analysis`

Each step is independently testable. Steps 3-7 can be parallelized once the service layer is solid.

---

## Design Decisions

### Why friendly concept names?

The raw XBRL tag for revenue is `RevenueFromContractWithCustomerExcludingAssessedTax` (55 characters). No LLM will reliably produce this, and even if it does, the tag changed from `SalesRevenueNet` in 2017. Friendly names (`"revenue"`) hide this complexity and automatically handle tag evolution. The tradeoff: supporting ~15 common concepts covers 90%+ of financial analysis workflows. Raw tags are accepted as an escape hatch.

### Why deduplicate with the `frame` field?

Every 10-K filing includes prior-year comparatives. Apple's 2023 10-K reports 2023, 2022, and 2021 revenue — all three appear in the API response under that filing's accession number. Without deduplication, the agent sees 3x the data with conflicting signals. The `frame` field marks the "canonical" value for each calendar period.

### Why not parse Form 4 XML?

Insider trading (Form 4) is a common workflow, but Form 4 documents are structured XML requiring dedicated parsing — transaction codes, derivative vs. non-derivative tables, footnotes. This adds significant complexity for a niche use case. The initial design serves insider trading through the general-purpose tools: filter company filings to `form_types: ["4"]`, then read individual filings. A dedicated `secedgar_insider_trades` tool with XML parsing is a natural Phase 2 addition.

### Why not wrap an existing npm package?

`sec-edgar-toolkit` (the only open-source TS option) is AGPL-3.0 licensed — any server wrapping it must be open-sourced. The SEC APIs are simple REST endpoints with no auth, so a thin service layer with rate limiting is more appropriate than a dependency.

---

## Future Considerations

| Feature | Complexity | Value | Notes |
|:--------|:-----------|:------|:------|
| `secedgar_insider_trades` tool | Medium | High | Parse Form 4 XML for structured buy/sell/grant data |
| 13F holdings parsing | Medium | High | Parse 13F XML for institutional portfolio positions |
| Filing section extraction | High | High | Parse 10-K/10-Q into named sections (Risk Factors, MD&A, etc.) |
| Company financial snapshot | Low | Medium | Composite tool: revenue + net income + assets + cash in one call |
| SIC-based industry search | Low | Medium | Filter company_tickers by SIC code |
| Filing diff | Medium | Medium | Compare two filings of the same type for changes |
| RSS/Atom feed monitoring | Low | Low | Poll for new filings from specific companies |
