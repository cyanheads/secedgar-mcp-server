<div align="center">
  <h1>@cyanheads/secedgar-mcp-server</h1>
  <p><b>Query SEC EDGAR filings, XBRL financials, and company data via MCP. STDIO or Streamable HTTP.</b>
  <div>16 Tools (+1 opt-in) • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/secedgar-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/secedgar-mcp-server) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/secedgar-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/secedgar-mcp-server/releases/latest/download/secedgar-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=secedgar-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvc2VjZWRnYXItbWNwLXNlcnZlciJdLCJlbnYiOnsiRURHQVJfVVNFUl9BR0VOVCI6IllvdXJOYW1lIHlvdXItZW1haWxAZXhhbXBsZS5jb20ifX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22secedgar-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fsecedgar-mcp-server%22%5D%2C%22env%22%3A%7B%22EDGAR_USER_AGENT%22%3A%22YourName%20your-email%40example.com%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://secedgar.caseyjhand.com/mcp](https://secedgar.caseyjhand.com/mcp)

</div>

---

## Overview

SEC EDGAR filings, financials, and ownership data. Look up companies by ticker, name, or CIK, search filings back to 1993, compare financials across companies, and trace ownership through insider trades, 13F holdings, 13D/13G blockholders, and fund portfolios. No API key required.

### Tools

| Tool | Description |
|:---|:---|
| `secedgar_company_search` | Find companies and retrieve entity info with optional recent filings |
| `secedgar_search_filings` | Search EDGAR filings since 1993: full text from 2001, archive browse before that |
| `secedgar_get_filing` | Fetch a filing's metadata and document text, paged or by section |
| `secedgar_get_financials` | Get historical XBRL financial data for one company and concept |
| `secedgar_get_snapshot` | One-call financial profile: the latest value of every supported concept |
| `secedgar_get_material_events` | 8-K filings with item codes decoded and filterable |
| `secedgar_get_insider_transactions` | Form 4 / 4-A insider transactions parsed from ownership XML |
| `secedgar_get_institutional_holdings` | 13F-HR quarterly holdings of one institutional manager |
| `secedgar_find_holders` | Reverse 13F lookup: which managers reported holding an issuer |
| `secedgar_get_beneficial_owners` | 5%+ blockholders of an issuer from structured SCHEDULE 13D / 13G filings |
| `secedgar_get_fund_holdings` | ETF and mutual fund portfolio holdings from the quarterly NPORT-P report |
| `secedgar_fetch_frames` | One XBRL concept × one period across every reporting company |
| `secedgar_compare_companies` | Compare named companies across several concepts, aligned on fiscal years or calendar quarters |
| `secedgar_search_concepts` | Discover supported XBRL concept names or reverse-lookup a raw tag |
| `secedgar_dataframe_describe` | List canvas dataframes with provenance, TTL, and schema |
| `secedgar_dataframe_query` | Run a single-statement SELECT across dataframes |
| `secedgar_dataframe_drop` | Drop a canvas dataframe by name; opt-in via `EDGAR_DATAFRAME_DROP_ENABLED=true` |

### Resources

| Resource | Description |
|:---|:---|
| `secedgar://concepts` | XBRL financial concepts grouped by statement, mapping friendly names to XBRL tags |
| `secedgar://filing-types` | Common SEC filing types, plus the 8-K item-code tables for both numbering regimes |

`secedgar_search_concepts` serves the same concept catalog to tool-only clients.

### Prompts

| Prompt | Description |
|:---|:---|
| `secedgar_company_analysis` | Structured analysis of a company's SEC filings: financial trends, risk factors, material events |

## Capability reference

### `secedgar_company_search` <sub>tool</sub>

- `query` takes a ticker (equities, ETFs, mutual funds), a current or former company name, or a CIK; `include_filings` (default on) adds up to `filing_limit` filings (default 10, at most 50 inline), filtered by `forms`, `filed_after`, and `filed_before`
- Returns SIC code, exchanges, fiscal year end, and state of incorporation, plus `series_id` / `class_id` for a fund ticker; fails as `no_match` (with near matches in `data.suggestions`) or `multiple_matches`
- A date or form filter can reach into the archive (up to 10 pages); `history_scanned_through` reports how far it got

---

### `secedgar_search_filings` <sub>tool</sub>

- Full-text `query` (phrases, `OR`, `-exclusion`, `wildcard*`, `ticker:` / `cik:` scoping), or browse by `forms` and/or entity with no query; `filed_after` / `filed_before` work alone (a lone `filed_after` runs through today, a lone `filed_before` starts at 2001-01-01, or at 1993-01-01 before 2001); `limit` up to 100, `offset` up to 9,999 (only with `sort: "relevance"` on a 2001-onward search)
- Full text covers 2001 onward; earlier ranges back to 1993 come from the archives, where free text needs `ticker:` / `cik:` scope and reads up to 50 documents (`scan` reports the counts)
- One row per filing, tagged with `source` (`efts`, `submissions`, `full-index`); full-text rows list `matched_documents` (filenames for `secedgar_get_filing`); the response carries `total`, `form_distribution`, `total_is_exact`, and `total_documents` for full-text searches

---

### `secedgar_get_filing` <sub>tool</sub>

- `accession_number` in dash or 18-digit form, optional `cik` to speed the lookup, `document` for an exhibit, `include_xbrl` for XBRL artifacts; `content_limit` 1,000–200,000 characters per page (default 50,000)
- Page with `offset` / `next_offset` until `content_truncated` is false, or jump with `section` (a heading such as `item 1` or `part i`), then drop `section` to page on, since it outranks `offset`; the first page of a truncated document carries an `outline` of up to 50 headings with offsets
- `documents` splits the filing into primary, exhibits, and auxiliary; `binary` entries (scans, PDFs, archives) fail as `binary_document`, and a `section` miss returns `section_not_found` with the outline
- If the archive doesn't serve a filing's primary document (common in 2000–2001), the full submission `<accession>.txt` is read instead and the notice says so

---

### `secedgar_get_financials` <sub>tool</sub>

- `company` (ticker or CIK) plus `concept` as a friendly name or raw XBRL tag; `taxonomy` `us-gaap` (default), `ifrs-full`, or `dei`; `period_type` `annual`, `quarterly`, or `all`; `unit` picks one SEC unit key (`ZAR`, `USD`, `USD/EUR`) when a concept is reported in several; `limit` 1–100 trims the inline series
- Returns a deduplicated series, newest first, one value per calendar period with `form`, `filed`, `accession_number`, and `tag`, all in one `unit` (other units are named in `caveats`); `tags_tried` lists the tags checked, and an empty result fails as `no_concept_data`, `no_frame_data`, `no_period_data`, or `no_unit_data`
- A `concept` that is neither a friendly name nor an UpperCamelCase tag fails as `unknown_concept`, with a formula for standard combinations (`free_cash_flow`, `ebitda`, `working_capital`) or up to three closest friendly names

---

### `secedgar_get_snapshot` <sub>tool</sub>

- `company`, `taxonomy` `us-gaap` (default) or `ifrs-full`, and `period_type` `annual`, `quarterly`, or `both` (default); one companyfacts read covers every supported concept, and nothing is staged as a dataframe
- Each `lines` entry reports the latest `annual` and `quarterly` value for a duration concept, or the latest `instant` value for balance-sheet and entity-info concepts, each with the `tag` it came from, under the line's `taxonomy`; concepts the filer doesn't report land in `gaps` with `tags_tried`

---

### `secedgar_get_material_events` <sub>tool</sub>

- `company` plus up to 20 `items` codes, dotted (`2.02`) since 2004-08-23 and single integers (`12`) before; the two regimes don't overlap, so pair them across the changeover; `filed_after` / `filed_before` work alone and reach into the archive; `limit` 1–100 (default 20)
- Each filing decodes its `items` to `code`, `label`, and `regime` (`current` / `legacy`); `item_distribution` counts every code in the window, and `total_8k_scanned` against `total_matched` shows what the filter removed
- A date window reads up to 10 archive pages; `history_scanned_through` and `dataset.truncated` report what went unread

---

### `secedgar_get_insider_transactions` <sub>tool</sub>

- `company` is the issuer; `transaction_type` `purchase` (code P), `sale` (code S), or `all` (default); `limit` 1–100 (default 20); does not cover Forms 3 or 5
- Without a date window it scans up to 100 of the newest Form 4 / 4-A filings; `filed_after` / `filed_before` (inclusive, either alone) read any period since mid-2003, up to 100 filings; `history_scanned_through` names the oldest filing parsed
- Each transaction carries the reporting person, relationship, `transaction_code` and `transaction_type`, `is_derivative`, unsigned `shares_traded` with `direction` (`acquire` / `dispose`), price per share, and shares owned after; `dataset.truncated` flags filings beyond those parsed, and `filings_other_issuer` counts Form 4s the company filed as a reporting owner of another issuer, which add no rows

---

### `secedgar_get_institutional_holdings` <sub>tool</sub>

- `company` is the 13F filer (a CIK is most reliable), not a portfolio company, which is `secedgar_find_holders`' job; `quarter` as `YYYY-QN`, defaulting to the newest filing; `limit` 1–500 (default 20) with `offset` / `next_offset`; `consolidate` (default true) merges sub-lines into positions sorted by value
- Older quarters are found in the archive (up to 10 pages); a quarter covered only by a 13F-NT notice fails as `no_filings_found` naming the notice's accession number and period
- Holdings carry issuer, CUSIP, `market_value_usd` in whole USD, shares or principal, and `put_call`; `total_holdings_in_filing` counts raw rows and `total_positions` distinct positions; a shared legal name fails as `ambiguous_entity`

---

### `secedgar_find_holders` <sub>tool</sub>

- `issuer` as a ticker, CIK, or name, plus an optional 9-character `cusip`, the precise match key (a name phrase-match both over- and under-matches); `quarter` as `YYYY-QN`, defaulting to the newest quarter past its 45-day filing deadline; `limit` 1–100 (default 20) from up to 500 fetched filings
- Rows carry `filer_cik`, `accession_number`, and `form`, while `search_mode` (`cusip` / `name`), `total_filings`, `fetched`, and `holders_in_quarter` size the result; the list is unranked, so pass a `filer_cik` to `secedgar_get_institutional_holdings` to read the position

---

### `secedgar_get_beneficial_owners` <sub>tool</sub>

- `issuer` is the company being held; `form_kind` `all` (default), `13D`, or `13G`; `include_amendments` (default true); `limit` 1–20 filings (default 10), each a separate document fetch
- Each filing lists `reporting_persons` with voting power, dispositive power, and `percent_of_class` per person, which joint filers report for the same shares, so they don't sum; a 13D carries `purpose_of_transaction`, a 13G has none
- Coverage starts 2024-12-18 with the structured XML schedules; `legacy_filings_before_coverage` counts the issuer's older `SC 13D` / `SC 13G` text filings

---

### `secedgar_get_fund_holdings` <sub>tool</sub>

- `fund` as a ticker (`VOO`), series ID (`S000002839`), or CIK; a multi-series trust fails as `series_required` with the series listed, so pass `series_id`; `report_date` picks a period from `available_report_periods`; `limit` 1–100 (default 20) with `offset` / `next_offset`
- Positions come largest first by `percent_of_net_assets`, with name, CUSIP / ISIN / LEI, `balance` and `units`, `value_usd`, and asset and issuer category, alongside fund net assets, total assets, and total liabilities
- Holdings are as of `report_period_date`, roughly two months before `filing_date`; `publication_lag_days` states the gap

---

### `secedgar_fetch_frames` <sub>tool</sub>

- `concept` as a friendly name or raw tag, `period` as `CY2023`, `CY2024Q2`, or `CY2023Q4I`, `taxonomy` `us-gaap` (default) or `dei`, `unit` (default `USD`), `sort` `desc` / `asc`; `limit` 1–100 (default 25) with `offset` / `next_offset`
- One call queries one tag: `unqueried_tags` and `related_tags` list variants to fetch separately; `value_distribution.max_to_p95_ratio` flags scale outliers, `period_end_range` shows fiscal-year mixing, and `caveats` flags fiscal-Q4 gaps
- A `concept` that is neither a friendly name nor an UpperCamelCase tag fails as `unknown_concept`; a well-formed tag with no frame is `no_data`

---

### `secedgar_compare_companies` <sub>tool</sub>

- 2–10 `companies` × 1–8 `concepts`; `taxonomy` `us-gaap` (default) or `ifrs-full`; `period_type` `annual` (default) or `quarterly`; `periods` 1–12 (default 4), trimmed further when the inline matrix gets too large
- `cells` align each value on a calendar `period` and keep its `frame`, `period_end`, and source `tag`; a call with no comparable annual data fails `no_comparable_data`
- `failed_companies` (reason `not_found`, `ambiguous`, or `no_company_facts`) and `gaps` report what's missing, and `caveats` flag differing period ends and unit mismatches between companies
- An unrecognized concept is listed in `unknown_concepts` with a hint; the call fails as `unknown_concept` only when every concept is unrecognized

---

### `secedgar_search_concepts` <sub>tool</sub>

- `search` is a substring over friendly name, label, and tags, so a raw tag like `NetIncomeLoss` reverse-maps to its friendly name; `group` and `taxonomy` filter; no arguments returns the full catalog
- Each concept lists `tags`, `ifrs_tags` (only where an IFRS element was confirmed in live 20-F filings), `related_tags`, `unit`, and `group`

---

### `secedgar_dataframe_describe` <sub>tool</sub>

- Optional `name` for one dataframe; omit it to list the tenant's active dataframes, newest first
- Each entry carries `source_tool`, `query_params`, `created_at` / `expires_at`, `row_count`, `truncated`, and the `column_schema` that SQL for `secedgar_dataframe_query` has to match

---

### `secedgar_dataframe_query` <sub>tool</sub>

- One DuckDB SELECT in `sql` (joins, aggregates, window functions, CTEs); `row_limit` 1–10,000 (default 1,000), `preview` for fewer inline rows, and `register_as` (`df_XXXXX_XXXXX`) to save the result as a new dataframe
- Returns `columns`, `rows`, `row_count`, and `row_count_capped`, which when true means `row_count` is the cap, not a total; BIGINT columns serialize as strings
- Writes, DDL, file-reading functions, multiple statements, and system catalogs are rejected with typed reasons (`non_select_statement`, `denied_function`, `multi_statement`, `system_catalog_access`, and others)

---

### `secedgar_dataframe_drop` <sub>tool</sub>

- `name` of the dataframe to drop; idempotent, returning `dropped: false` when nothing matched
- Off unless `EDGAR_DATAFRAME_DROP_ENABLED=true`; when disabled it is absent from `tools/list`

---

### `secedgar://concepts` <sub>resource</sub>

- The friendly-name catalog grouped by statement, as `text/markdown`, with the us-gaap, IFRS, and alternate-definition tags for each concept
- The names are what `secedgar_get_financials`, `secedgar_compare_companies`, and `secedgar_fetch_frames` accept as concepts

---

### `secedgar://filing-types` <sub>resource</sub>

- Common SEC forms with cadence and use cases, as `text/markdown`
- Includes the 8-K item-code tables for both numbering regimes, the vocabulary of `secedgar_get_material_events`' `items` filter

---

### `secedgar_company_analysis` <sub>prompt</sub>

- Arguments: `company` required; `focus_areas` optional free text
- Returns one user message with a numbered workflow (company search, a financial profile via `secedgar_get_snapshot` with trends via `secedgar_get_financials`, filing review, material events, and a peer comparison via `secedgar_compare_companies` with `secedgar_fetch_frames` for a market-wide ranking) and a findings template; insider, institutional, or blockholder terms in `focus_areas` add those ownership steps, and "ownership" adds all three

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

EDGAR-specific:

- Requests are paced under SEC's 10 req/s limit; after a 429, calls fail locally as `rate_limited` with a `retryAfter` countdown for `EDGAR_RATE_LIMIT_COOLDOWN_SECONDS`, then one probe goes out
- CIK resolution from tickers (fund tickers included), current and former company names, or raw CIKs, with near-match suggestions on a miss
- Friendly XBRL concept names that handle historical tag changes; `secedgar_get_financials`, `secedgar_get_snapshot`, and `secedgar_compare_companies` share the same dedup and tag priority, so their numbers agree, and `caveats` flag gaps in the series
- Filing documents converted from HTML to text, with heading detection and offset paging for oversized filings
- Opt-in local SQLite mirror of company tickers and XBRL company-facts (`EDGAR_MIRROR_ENABLED`) that serves CIK resolution and financials from disk

Agent-friendly output:

- In-conversation SQL: any tool whose response carries a `dataset` field has staged its full result as a DuckDB dataframe (`df_<id>`), while the inline list stays capped at `limit`; inspect it with `secedgar_dataframe_describe`, then query it with `secedgar_dataframe_query`
- Discriminated outputs and explicit gaps: `source` on filing-search rows, `search_mode`, 8-K item `regime`, typed `failed_companies` reasons, and `gaps` with `tags_tried` in place of zero-filled values
- Completeness disclosure: `history_scanned_through`, `total_is_exact`, `publication_lag_days`, and `dataset.truncated` tell agents how deep a scan went and what it left out
- One parameter name per concept: `company`, `filed_after` / `filed_before`, and `forms` mean the same thing on every tool, and common alternate spellings (`ticker`, `cik`, `start_date`, `end_date`, `form_types`, and others) are accepted as aliases

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- A User-Agent string in SEC's `"AppName contact@email.com"` format; no account or key required.

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

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set EDGAR_USER_AGENT
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `EDGAR_USER_AGENT` | **Required.** User-Agent sent to SEC, as `"AppName contact@email.com"`. SEC blocks IPs without one. A value that can't be sent as an HTTP header (an em dash or curly quote, an inner line break) stops the server at startup with an error naming this variable. | — |
| `EDGAR_RATE_LIMIT_RPS` | Max requests per second to SEC (1–10). | `10` |
| `EDGAR_RATE_LIMIT_COOLDOWN_SECONDS` | Seconds to refuse calls locally after a 429 before one probe goes out. | `600` |
| `EDGAR_TICKER_CACHE_TTL` | Seconds to cache the company and fund ticker files. | `3600` |
| `EDGAR_DATASET_TTL_SECONDS` | TTL for canvas dataframes, renewed on every dataframe operation. | `86400` |
| `EDGAR_DATAFRAME_DROP_ENABLED` | Set `true` to expose `secedgar_dataframe_drop`, the only destructive tool. | `false` |
| `EDGAR_MIRROR_ENABLED` | Enable the local SQLite mirror of company tickers and XBRL company-facts. Node/Bun only; bootstrap once with `bun run mirror:init`. | `false` |
| `EDGAR_MIRROR_PATH` | Directory holding the mirror databases. | `./data/edgar-mirror` |
| `EDGAR_MIRROR_REFRESH_CRON` | In-process refresh cron (HTTP transport only), e.g. `0 9 * * *`. Omit to refresh with `bun run mirror:refresh`. | — |
| `EDGAR_MIRROR_FALLBACK_LIVE` | Fall back to the live SEC API on a mirror miss. Set `false` for mirror-only reads. | `true` |
| `CANVAS_PROVIDER_TYPE` | Canvas engine; `none` disables dataframes. | `duckdb` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP base URL for traces and metrics. | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | OTLP log export endpoint (e.g. `http://localhost:4318/v1/logs`). | — |

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

The image defaults to HTTP on port 3010 and ships the mirror CLI, so a running container can bootstrap and refresh its own mirror:

```sh
docker exec <container> bun run mirror:verify    # sync status + sample reads
docker exec <container> bun run mirror:init      # one-time bootstrap from the SEC bulk archive
docker exec <container> bun run mirror:refresh   # re-ingest after SEC rebuilds the archive
```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers resources and prompts, starts the SEC client, canvas, and optional mirror. |
| `src/config` | Server environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`) and the `buildToolDefinitions()` registration list. |
| `src/mcp-server/resources/definitions` | Resource definitions: XBRL concepts and filing types. |
| `src/mcp-server/prompts/definitions` | Prompt definitions: company analysis. |
| `src/services/edgar` | Paced SEC client, CIK resolution, XBRL concept mapping and series dedup, ownership / 13D / 13G / NPORT-P parsers, 8-K item tables, HTML-to-text. |
| `src/services/edgar/mirror` | Opt-in local SQLite mirror of company tickers and XBRL company-facts. |
| `src/services/canvas-bridge` | Adapter over the framework `DataCanvas`: `df_<id>` naming, per-table TTL, system-catalog SQL deny. |
| `scripts` | Build, devcheck, and lint tooling, plus the `mirror:*` commands. |
| `tests` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) and [`AGENTS.md`](./AGENTS.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools in `buildToolDefinitions()` (`src/mcp-server/tools/definitions/index.ts`), and resources and prompts in the `createApp()` arrays in `src/index.ts`
- Wrap external SEC EDGAR calls: validate the raw response → normalize to a domain type → return the output schema; never fabricate a missing XBRL field — report it under `gaps` instead

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
