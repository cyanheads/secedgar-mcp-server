<div align="center">
  <h1>@cyanheads/secedgar-mcp-server</h1>
  <p><b>Query SEC EDGAR filings, XBRL financials, and company data through MCP. STDIO & Streamable HTTP.</b>
  <div>16 Tools (+1 opt-in) • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/secedgar-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/secedgar-mcp-server) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/secedgar-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/secedgar-mcp-server/releases/latest/download/secedgar-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=secedgar-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvc2VjZWRnYXItbWNwLXNlcnZlciJdLCJlbnYiOnsiRURHQVJfVVNFUl9BR0VOVCI6IllvdXJOYW1lIHlvdXItZW1haWxAZXhhbXBsZS5jb20ifX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22secedgar-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/secedgar-mcp-server%22%5D%2C%22env%22%3A%7B%22EDGAR_USER_AGENT%22%3A%22YourName%20your-email%40example.com%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://secedgar.caseyjhand.com/mcp](https://secedgar.caseyjhand.com/mcp)

</div>

---

## Overview

SEC EDGAR filings, XBRL financials, and company ownership data, keyless aside from a required SEC User-Agent header. Resolve companies by ticker, name, or CIK, search filings back to 1993, pull XBRL financials and cross-company comparisons by concept, and trace ownership — insider transactions, 13F institutional holdings, 13D/13G blockholders, and fund holdings — from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `secedgar_company_search` | Find companies and retrieve entity info with optional recent filings |
| `secedgar_search_filings` | Search EDGAR filings since 1993 — full-text (2001+) plus archive-backed browse for pre-2001 ranges |
| `secedgar_get_filing` | Fetch a specific filing's metadata and document content |
| `secedgar_get_financials` | Get historical XBRL financial data for a company |
| `secedgar_get_snapshot` | One-call financial profile — the latest value of every supported concept, grouped by statement |
| `secedgar_get_material_events` | 8-K filings with item codes decoded and filterable — earnings, officer changes, non-reliance |
| `secedgar_get_insider_transactions` | Form 4 / 4-A insider transactions (buys, sells, grants, exercises) parsed from ownership XML |
| `secedgar_get_institutional_holdings` | 13F-HR quarterly institutional holdings parsed from the information table |
| `secedgar_find_holders` | Reverse 13F lookup — which institutional managers reported holding an issuer |
| `secedgar_get_beneficial_owners` | 5%+ blockholders of an issuer, parsed from structured SCHEDULE 13D / 13G filings |
| `secedgar_get_fund_holdings` | ETF and mutual fund portfolio holdings from the quarterly NPORT-P report |
| `secedgar_fetch_frames` | Fetch SEC XBRL frames for one concept × one period across all reporting companies |
| `secedgar_compare_companies` | Compare named companies across several concepts, aligned on calendar periods |
| `secedgar_search_concepts` | Discover supported XBRL concept names or reverse-lookup a raw tag |
| `secedgar_dataframe_describe` | List canvas dataframes with provenance, TTL, and schema |
| `secedgar_dataframe_query` | Run a single-statement SELECT across dataframes |
| `secedgar_dataframe_drop` | Drop a canvas dataframe by name. Opt-in via `EDGAR_DATAFRAME_DROP_ENABLED=true` — off by default since TTL already handles cleanup, and uncallable until the flag is set |

### Resources

| Resource | Description |
|:---|:---|
| `secedgar://concepts` | Common XBRL financial concepts grouped by statement, mapping friendly names to XBRL tags |
| `secedgar://filing-types` | Common SEC filing types with descriptions, cadence, and use cases, plus the full 8-K item-code decode tables for both numbering regimes |

### Prompts

| Prompt | Description |
|:---|:---|
| `secedgar_company_analysis` | Guides a structured analysis of a public company's SEC filings: identify recent filings, extract financial trends, surface risk factors, and note material events |

## Capability reference

### `secedgar_company_search` <sub>tool</sub>

- Resolves ticker symbols, company names, or CIK numbers; a multi-class share ticker matches either form (`BRK-B` or `BRK.B`), and current/former names both resolve (`Facebook` → Meta Platforms, `Square` → Block)
- ETFs and mutual funds resolve by ticker via `company_tickers_mf.json`; fund results carry `series_id` and `class_id`
- Corporate suffix form need not match the registry (`Beacon Financial Corporation` → `Beacon Financial Corp`), but `Corp`/`Inc`/`Co`/`Ltd` stay distinct — separate registrants can differ only by which one they use
- Near-match suggestions on a zero-result name or ticker search (e.g. `Microsfot` → `MICROSOFT CORP / MSFT`)
- Optional recent filings inline with form-type filtering; `filed_after`/`filed_before` and under-filled form filters page into the older submissions archive, reaching filings past the ~1000-entry recent window — `history_scanned_through` reports the scan depth, and the full filtered history stages as `df_<id>` when it exceeds `filing_limit`
- Returns entity metadata — SIC code, exchanges, fiscal year end, state of incorporation

---

### `secedgar_search_filings` <sub>tool</sub>

- Full-text search (2001–present, the EFTS index floor) with exact phrases, boolean operators, wildcards, and inline entity targeting (`cik:320193` / `ticker:AAPL`, either share-class form for multi-class tickers) — server-side scoped by CIK, so former-name filings on the same entity are included
- Browse mode (omit `query`) lists by form type and/or entity, optionally narrowed by date; a bare date range must pair with forms or entity targeting
- Pre-2001 date ranges (back to 1993) route to the archives — entity-scoped reads the filer's full submissions history, unscoped browses the quarterly full-index; pre-2001 free-text search needs `ticker:`/`cik:` entity scope, since it works by reading up to 50 candidate documents (`scan` reports candidates/scanned/matched, costing ~5s for a full scan)
- A range crossing 2001-01-01 is split at the boundary and merged, each row tagged with its `source` (`efts`/`submissions`/`full-index`); `period_ending`, `ticker`, `file_description`, `sic`, and `location` exist only on `efts` rows
- Date range and form-type filtering, pagination up to 10,000 results; response includes form distribution for narrowing follow-up searches
- The full result set stages as `df_<id>` when it exceeds the inline limit

---

### `secedgar_get_filing` <sub>tool</sub>

- Accepts accession numbers in dash or no-dash format; fetches the primary document or a specific exhibit by name
- Converts HTML filings to plain text; pre-2005 filings produce noisier output
- Configurable `content_limit` (1K–200K characters, default 50K)
- Binary entries (scanned pages, PDF exhibits, packaged archives/spreadsheets) are marked `binary` in the document catalog and rejected with a `binary_document` error rather than returned as decoded bytes
- Offset paging for large documents (10-K, S-1/A can exceed 1M chars) — pass a truncated response's `next_offset` as `offset` to continue; first-page truncated responses include a detected `outline` (headings + offsets)
- `section` jumps directly to a named heading by substring match ignoring case, whitespace style, and quote style (`"risk factors"`, `"item 7"`) — a miss returns the detected outline; extracted text is cached per `accession + document` (bounded LRU, 8 entries) so paged calls are cheap

---

### `secedgar_get_financials` <sub>tool</sub>

- Friendly names (`"revenue"`, `"net_income"`, `"eps_diluted"`) auto-resolve to XBRL tags, including historical tag changes (e.g. ASC 606 revenue recognition) — see `secedgar://concepts` for the full mapping
- Automatic deduplication to one value per standard calendar period; filter by `period_type` (`annual`/`quarterly`/`all`)
- Optional `limit` caps the inline series to the most-recent N periods; the full series stays queryable via `df_<id>`
- `caveats` names every calendar quarter absent from the frame-tagged series — SEC reports fiscal Q4 as the 10-K residual, so the calendar quarter it spans carries no discrete quarterly value (calendar-year filers included), and a filer whose other fiscal quarters span non-calendar durations can lose a second quarter the same way
- A separate `caveats` entry appears when the concept resolved to an XBRL tag SEC has retired from the taxonomy — that only happens when no current tag reports for the filer, and the series can then stop years short

---

### `secedgar_get_snapshot` <sub>tool</sub>

- Reads the filer's complete companyfacts payload once and resolves every supported concept against it — one call instead of a run of `secedgar_get_financials` calls
- Same frame dedup and tag priority as `secedgar_get_financials`, so the two agree for any concept they both cover
- Duration concepts (income statement, cash flow, per-share) report their latest full year and latest single quarter; balance-sheet and entity-info concepts report their latest point-in-time value
- Concepts the filer does not report are listed under `gaps` with the XBRL tags that were tried — never zero-filled or interpolated
- IFRS filers resolve through the mapped IFRS tag variants via `taxonomy: "ifrs-full"`, covering the income statement, balance sheet, cash flow, and per-share concepts; each line reports the taxonomy its value came from
- Compact single-record profile, no dataframe — reach for `secedgar_get_financials` when a time series is needed

---

### `secedgar_get_material_events` <sub>tool</sub>

- Filter with `items` (e.g. `["2.02"]` results of operations, `["5.02"]` officer departures, `["4.02"]` non-reliance) — the only surface that scopes by what the event actually was, since `secedgar_search_filings` and `secedgar_company_search` cannot see item codes
- Two numbering regimes are both accepted and decoded: the dotted scheme in force since 2004-08-23, and single integers before it (legacy `12` is the ancestor of `2.02`, `9` of `7.01`); decoding keys off the code's shape so a filing straddling the changeover is never mis-decoded
- `item_distribution` counts every code across the scanned window before the filter, so a zero-hit filter still surfaces the items that are present
- A date window pages into the older submissions archive, reaching 8-K filings older than the ~1000-filing recent window; `history_scanned_through` discloses the scan depth
- The full decode table is in the `secedgar://filing-types` resource
- The full filtered set materializes as `df_<id>` with item codes on every row — item frequency over time is one `secedgar_dataframe_query` away

---

### `secedgar_get_insider_transactions` <sub>tool</sub>

- Parses Form 4 / 4-A insider transactions from ownership XML; Form 3 initial statements and Form 5 annual statements are not covered — reach those with `secedgar_search_filings` (`forms: ["3", "5"]`) plus `secedgar_get_filing`
- Reporting person, relationship to issuer (director, officer + title, 10% owner), and transaction date
- Transaction code mapped to a readable type (purchase, sale, gift, award, exercise, …); shares signed by acquired/disposed, price per share, and shares owned after each transaction; covers non-derivative (open-market) and derivative (option/RSU) lines
- Filter by `transaction_type` (`purchase`, `sale`, `all`); scans newest filings first
- The full set parsed from the scanned recent filings materializes as `df_<id>` (the inline list is a preview capped at `limit`) — query it to aggregate net buy/sell by insider

---

### `secedgar_get_institutional_holdings` <sub>tool</sub>

- Pass the institutional filer (CIK or full legal name, e.g. `0000102909` for Vanguard) to see what it holds; for the reverse direction — which managers hold a given company — use `secedgar_find_holders`, whose `filer_cik` results feed straight back into this tool
- Each holding: issuer name, CUSIP, market value (whole USD), shares/principal, and put/call; raw rows also carry investment discretion
- Sub-lines for the same security are consolidated into distinct positions sorted by value by default — pass `consolidate: false` for raw filing rows
- Resolves the filing-manager name and reporting quarter from the cover page; target a specific quarter with `quarter` (e.g. `"2025-Q4"`)
- `total_holdings_in_filing` counts raw info-table rows, `total_positions` counts distinct positions after consolidation (both before `limit`); page with `offset`, which returns `next_offset` while rows remain
- The full parsed holdings set materializes as `df_<id>` for full-filing aggregation or cross-quarter joins on `cusip` + `reporting_period`

---

### `secedgar_find_holders` <sub>tool</sub>

- Reverse 13F lookup — which institutional managers reported a position in an issuer, for one reporting quarter. Searching by `cusip` matches the identifier the 13F information table itself carries (the precise path); the name path both under-matches (managers write names differently) and over-matches (unrelated issuers sharing a word)
- A CUSIP is not derivable from a ticker anywhere in EDGAR — read one off any `secedgar_get_institutional_holdings` result, or fall back to the name path
- `quarter` targets a reporting period (`"2026-Q1"`); omit it for the newest quarter whose 45-day filing deadline has passed — the applied quarter and its filing window are echoed back
- Filings are kept by the period they report, not the date they were filed, so amendments restating an older quarter (roughly 6% of any window) don't land in the wrong quarter's holder list
- Up to 500 filer rows are fetched per call; `total_filings` reports the full count and `dataset.truncated` flags when more exist
- **The list is unranked** — EDGAR search relevance carries no signal about position size; read a manager's actual position by passing its `filer_cik` to `secedgar_get_institutional_holdings`

---

### `secedgar_get_beneficial_owners` <sub>tool</sub>

- The 5%-and-over stakes in an issuer — the blockholder layer between Form 4 insiders and 13F portfolios; input is the issuer, the company being held
- 13D is the activist form and carries the filer's stated purpose of the transaction; 13G is the passive form and has no purpose item at all — filter with `form_kind`
- Every reporting person is listed separately — voting power, dispositive power, and percent of class are reported per person even on a joint filing where several funds and their controlling principal report the same underlying shares, so summing those percentages double-counts the position
- Coverage starts **2024-12-18**, when SEC replaced the legacy `SC 13D` / `SC 13G` text filings with structured XML; earlier stakes are readable but not parseable, and `legacy_filings_before_coverage` reports how many the issuer has
- Amendments carry the current position and are included by default; `include_amendments=false` leaves only the filings that opened a position
- The full parsed set registers as `df_<id>`, one row per reporting person, so it joins the insider and 13F dataframes on issuer CIK

---

### `secedgar_get_fund_holdings` <sub>tool</sub>

- What an ETF or mutual fund owns, from the NPORT-P portfolio report it files each quarter — the inverse of the ownership tools, which answer who owns a company. Input is the fund: a ticker (`VOO`), a fund series ID (`S000002839`), or a CIK — name the registrant by CIK unless the fund itself trades under that name
- An NPORT-P covers exactly one fund series and a registrant trust files one report per series per period, so a trust running several funds needs the specific fund named; a registrant resolving to more than one series returns the series list with tickers, and one whose series carry no ticker is routed by reading the series off its newest report
- Every result is dated to `report_period_date` — reports publish roughly two months after the period they cover, so holdings are the portfolio as of that date, not as of today; `publication_lag_days` states the gap, and `report_date` targets an earlier period from `available_report_periods`
- Positions carry the security name, CUSIP/ISIN/LEI where the filer reports them, share balance, USD value, and percent of net assets, alongside fund-level net assets, total assets, and total liabilities
- Positions come back largest-first by percent of net assets, one page of `limit` rows from `offset`; the full report registers as `df_<id>` for aggregation and for joining the 13F and insider dataframes on CUSIP

---

### `secedgar_fetch_frames` <sub>tool</sub>

- Same friendly concept names as `secedgar_get_financials`, or a raw XBRL tag
- Supports annual (`CY2023`), quarterly (`CY2024Q2`), and instant (`CY2023Q4I`) periods
- Inline response returns one page of the ranked companies (sort + limit), with ticker enrichment; walk further down the ranking with `offset`, which returns `next_offset` while companies remain
- The full frames response (all reporters, typically 2k–10k rows) materializes as `df_<id>`
- `related_tags` flags alternate-definition tags some filers use as their primary line (e.g. `cash` → restricted-cash-inclusive total, `equity` → NCI-inclusive total), so a whole-universe screen on the base tag isn't silently under-inclusive — query those separately
- One call hits one XBRL tag; when a friendly name maps to multiple same-meaning tags, `unqueried_tags` lists the others to query and combine with an analysis-specific priority

---

### `secedgar_compare_companies` <sub>tool</sub>

- Compares 2-10 named companies across 1-8 concepts, aligned on calendar periods — the middle shape between `secedgar_get_financials` (one company over time) and `secedgar_fetch_frames` (one period across the market)
- One companyfacts read per company, resolved through the same frame dedup and tag priority as `secedgar_get_financials`
- Balance-sheet and entity-info concepts align on the calendar year or quarter their point-in-time snapshot falls in, so they sit in the same matrix as income-statement lines; each cell keeps its underlying XBRL frame
- `periods` bounds the inline matrix (1-12, default 4), shrinking further when companies × concepts × periods is too large for one response; the full aligned series always materializes as `df_<id>`
- A company that fails to resolve is reported in `failed_companies` and the comparison proceeds with the rest; a company that does not report a concept is reported in `gaps` with the tags that were tried — never interpolated
- `caveats` surface a filer missing calendar quarters, a concept that resolved to a retired tag for one company, differing period ends inside one aligned period, and unit mismatches across companies

---

### `secedgar_search_concepts` <sub>tool</sub>

- Search by friendly name, label, or raw XBRL tag; an empty search with no filters returns the full catalog
- Filter by statement group (`income_statement`, `balance_sheet`, `cash_flow`, `per_share`, `entity_info`) or taxonomy
- Reverse-lookup raw tags like `NetIncomeLoss` to the supported friendly names
- Surfaces `related_tags` for concepts with a high-coverage alternate-definition tag (e.g. restricted-cash-inclusive cash) so callers can discover them before screening
- Filtering by `taxonomy: "ifrs-full"` narrows the catalog to concepts with an IFRS tag confirmed against live 20-F filers — a concept with no IFRS equivalent is left out rather than mapped to a guess
- Returns the same catalog used by `secedgar_get_financials`, `secedgar_fetch_frames`, and `secedgar://concepts`

---

### `secedgar_dataframe_describe` <sub>tool</sub>

- Lists every dataframe (`df_XXXXX_XXXXX`) registered by the data-returning `secedgar_*` tools — any response carrying a `dataset` field holds one
- Optional `name` describes a single dataframe; omit to list every dataframe for the tenant
- Each entry surfaces source tool, query parameters, creation/expiry timestamps, row count, column schema, and whether the dataframe is truncated relative to the upstream source
- Read the column schema here before writing SQL for `secedgar_dataframe_query`

---

### `secedgar_dataframe_query` <sub>tool</sub>

- Runs a single-statement SELECT (standard DuckDB SQL — joins, aggregates, window functions, CTEs) against the dataframes registered by the data-returning `secedgar_*` tools
- Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected by the framework SQL gate; system catalogs (`information_schema`, `pg_catalog`, `sqlite_master`, `duckdb_*`) are denied at the bridge layer so callers can't enumerate dataframes they don't already hold a handle for
- `row_limit` caps rows materialized in the response (default 1000, max 10000); a capped result reports `row_count_capped: true` with `row_count` as that cap rather than a total — a SQL `LIMIT` exactly equal to the cap is indistinguishable from an exact result and reported as such
- `register_as` persists the result as a new dataframe (`df_XXXXX_XXXXX`) with a fresh TTL, to chain analyses without re-running the source query
- BIGINT columns (XBRL `value`, COUNT/SUM results) serialize as JSON strings to preserve precision past 2^53 — cast to `DOUBLE` in projections for inline arithmetic

---

### `secedgar_dataframe_drop` <sub>tool</sub>

- Drops a canvas dataframe by name; idempotent — returns `dropped: false` when nothing matched
- Opt-in via `EDGAR_DATAFRAME_DROP_ENABLED=true` — off by default since the per-table TTL already reclaims canvas tables, and this is the only destructive tool on the server
- Off, the tool is registered through `disabledTool()`: absent from `tools/list` and uncallable, but shown on the HTTP landing page in a `disabled` group naming the reason and the flag that enables it

---

### `secedgar://concepts` <sub>resource</sub>

- XBRL financial concepts grouped by statement (Income Statement, Balance Sheet, Cash Flow, Per Share, Entity Info), returned as `text/markdown`
- Maps the friendly names accepted by `secedgar_get_financials` and `secedgar_fetch_frames` to their underlying XBRL tags

---

### `secedgar://filing-types` <sub>resource</sub>

- Common SEC filing types with descriptions, cadence, and typical use cases, returned as `text/markdown`
- Includes the full 8-K item-code decode tables for both numbering regimes (the current dotted scheme and the pre-2004-08-23 legacy integers)
- Helps choose the `forms` parameter for `secedgar_search_filings`, the `form_types` filter for `secedgar_company_search`, or the `items` filter for `secedgar_get_material_events`

---

### `secedgar_company_analysis` <sub>prompt</sub>

- Arguments: `company` (name, ticker, or CIK) required; `focus_areas` free-text optional (e.g. `"revenue growth, debt levels, insider activity"`) — omitted, it performs a general analysis
- Baseline workflow: company identification, financial trends, recent-filing review, and material events, each routed through the corresponding `secedgar_*` tool, closing with a peer comparison via `secedgar_fetch_frames`
- `focus_areas` mentioning insider, institutional, or blockholder/activist terms adds the matching ownership step — insider transactions (Form 4/4-A), institutional holdings (`secedgar_find_holders` then `secedgar_get_institutional_holdings`), or 5%+ blockholders (13D/13G) — the generic word "ownership" adds all three
- Returns a single user-role message carrying the numbered workflow and a findings template to fill in

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

EDGAR-specific:

- Rate-limited HTTP client honoring SEC's 10 req/s limit with automatic inter-request delay; a 429 fails fast with a cool-down hint instead of retrying, since SEC's own block window outlasts any retry budget
- CIK resolution from tickers (including ETFs and mutual funds via `company_tickers_mf.json`), current and former company names, or raw CIK numbers, with local caching, corporate-suffix normalization, and near-match trigram suggestions on zero-result queries
- Friendly XBRL concept name mapping with historical tag-change handling and a searchable, reverse-lookupable concept catalog
- HTML-to-text conversion for filing documents, with heading detection and offset-based paging for oversized filings
- Opt-in local SQLite mirror of `company_tickers` + XBRL company-facts (`EDGAR_MIRROR_ENABLED`) serves CIK resolution and financials from disk instead of the live API

Agent-friendly output:

- In-conversation SQL analytics — data-returning tools materialize their full result as a DuckDB-backed canvas dataframe (`df_<id>`); inspect its columns with `secedgar_dataframe_describe`, then query with `secedgar_dataframe_query`
- Discriminated outputs — `source` fields on merged filing-search rows (`efts`/`submissions`/`full-index`), typed `caveats` entries for series staleness and fiscal-Q4 gaps, and `gaps`/`failed_companies` rows instead of silent omission
- Graceful partial failure — `secedgar_compare_companies` returns every resolved company alongside `failed_companies` and per-concept `gaps` rather than failing the whole request
- Provenance on scan and staleness — `history_scanned_through`, `publication_lag_days`, and `dataset.truncated` let agents reason about scan depth, report lag, and completeness

## Getting started

### Public Hosted Instance

A public instance is available at `https://secedgar.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "secedgar-mcp-server": {
      "type": "streamable-http",
      "url": "https://secedgar.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "secedgar-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/secedgar-mcp-server@latest"],
      "env": {
        "EDGAR_USER_AGENT": "YourAppName your-email@example.com",
        "MCP_TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "secedgar-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/secedgar-mcp-server@latest"],
      "env": {
        "EDGAR_USER_AGENT": "YourAppName your-email@example.com",
        "MCP_TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "secedgar-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "EDGAR_USER_AGENT=YourAppName your-email@example.com",
        "ghcr.io/cyanheads/secedgar-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
- A SEC EDGAR User-Agent string — any `"AppName contact@email.com"` format works; no account or key required.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/secedgar-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd secedgar-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Build:**

```sh
bun run build
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `EDGAR_USER_AGENT` | **Required.** User-Agent header for SEC compliance. Format: `"AppName contact@email.com"`. SEC blocks IPs without a valid User-Agent. | — |
| `EDGAR_RATE_LIMIT_RPS` | Max requests/second to SEC APIs. Do not exceed 10. | `10` |
| `EDGAR_TICKER_CACHE_TTL` | Seconds to cache the company tickers lookup file. | `3600` |
| `EDGAR_DATASET_TTL_SECONDS` | Per-table TTL for canvas-registered dataframes. Sliding window touched on every dataframe op. | `86400` |
| `EDGAR_DATAFRAME_DROP_ENABLED` | Set to `true` to expose `secedgar_dataframe_drop` — the only destructive tool on this server. Off by default; TTL handles cleanup, and the tool is still listed on the HTTP landing page as disabled, with the flag that enables it. | `false` |
| `EDGAR_MIRROR_ENABLED` | Enable the local SQLite mirror of `company_tickers` + XBRL company-facts so CIK resolution and financials read from disk instead of the live API. Node/Bun only (skipped on Workers). Bootstrap once with `bun run mirror:init`. | `false` |
| `EDGAR_MIRROR_PATH` | Directory holding the mirror SQLite databases. | `./data/edgar-mirror` |
| `EDGAR_MIRROR_REFRESH_CRON` | Cron for the in-process nightly refresh (HTTP transport only). Recommended `0 9 * * *`. Omit to refresh out-of-band via `bun run mirror:refresh`. | — |
| `EDGAR_MIRROR_FALLBACK_LIVE` | When the mirror misses (not yet synced, or a filing newer than the last refresh), fall back to the live SEC API. Set `false` for strict mirror-only reads. | `true` |
| `CANVAS_PROVIDER_TYPE` | Canvas engine. Defaults to `duckdb`; set to `none` to disable the canvas. | `duckdb` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run the production version:**

  ```sh
  bun run rebuild
  bun run start:http   # or start:stdio
  ```

- **Run checks and tests:**
  ```sh
  bun run devcheck     # Lints, formats, type-checks
  bun run test         # Runs test suite
  ```

### Docker

```sh
docker build -t secedgar-mcp-server .
docker run -e EDGAR_USER_AGENT="MyApp my@email.com" -p 3010:3010 secedgar-mcp-server
```

The image ships the mirror CLI, so the local mirror (`EDGAR_MIRROR_ENABLED`) can be bootstrapped, inspected, and refreshed inside a running container:

```sh
docker exec <container> bun run mirror:verify    # sync status + sample reads
docker exec <container> bun run mirror:init      # one-time bootstrap (downloads the SEC bulk archive)
docker exec <container> bun run mirror:refresh   # re-ingest when the archive has been rebuilt
```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). Fourteen SEC EDGAR tools plus three `dataframe_*` tools for SQL analytics. |
| `src/mcp-server/resources/definitions/` | Resource definitions. XBRL concepts and filing types. |
| `src/mcp-server/prompts/definitions/` | Prompt definitions. Company analysis prompt. |
| `src/services/edgar/` | SEC EDGAR API client, XBRL concept mapping, HTML-to-text conversion. |
| `src/services/canvas-bridge/` | Adapter over the framework `DataCanvas`: `df_<id>` minting, all-nullable schema derivation, per-table TTL bookkeeping, bridge-layer system-catalog SQL deny. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) and [`AGENTS.md`](./AGENTS.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays
- Wrap external SEC EDGAR calls: validate the raw response → normalize to a domain type → return the output schema; never fabricate a missing XBRL field — report it under `gaps` instead

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
