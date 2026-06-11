<div align="center">
  <h1>@cyanheads/secedgar-mcp-server</h1>
  <p><b>Query SEC EDGAR filings, XBRL financials, and company data through MCP. STDIO & Streamable HTTP.</b>
  <div>10 Tools (+1 opt-in) • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/secedgar-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/secedgar-mcp-server) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/secedgar-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/secedgar-mcp-server/releases/latest/download/secedgar-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=secedgar-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvc2VjZWRnYXItbWNwLXNlcnZlciJdLCJlbnYiOnsiRURHQVJfVVNFUl9BR0VOVCI6IllvdXJOYW1lIHlvdXItZW1haWxAZXhhbXBsZS5jb20ifX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22secedgar-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/secedgar-mcp-server%22%5D%2C%22env%22%3A%7B%22EDGAR_USER_AGENT%22%3A%22YourName%20your-email%40example.com%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://secedgar.caseyjhand.com/mcp](https://secedgar.caseyjhand.com/mcp)

</div>

---

## Tools

Eight tools for querying SEC EDGAR data, plus three for SQL analytics over the DuckDB-backed canvas dataframes those tools materialize:

| Tool | Description |
|:---|:---|
| `secedgar_company_search` | Find companies and retrieve entity info with optional recent filings |
| `secedgar_search_filings` | Full-text search across all EDGAR filing documents since 1993 |
| `secedgar_get_filing` | Fetch a specific filing's metadata and document content |
| `secedgar_get_financials` | Get historical XBRL financial data for a company |
| `secedgar_get_insider_transactions` | Form 3/4/5 insider transactions (buys, sells, grants, exercises) parsed from ownership XML |
| `secedgar_get_institutional_holdings` | 13F-HR quarterly institutional holdings parsed from the information table |
| `secedgar_fetch_frames` | Fetch SEC XBRL frames for one concept × one period across all reporting companies |
| `secedgar_search_concepts` | Discover supported XBRL concept names or reverse-lookup a raw tag |
| `secedgar_dataframe_describe` | List canvas dataframes with provenance, TTL, and schema |
| `secedgar_dataframe_query` | Run a single-statement SELECT across dataframes |
| `secedgar_dataframe_drop` | Drop a canvas dataframe by name. Opt-in via `EDGAR_DATAFRAME_DROP_ENABLED=true` — off by default since TTL already handles cleanup |

### `secedgar_company_search`

Entry point for most EDGAR workflows — resolve tickers, names, or CIKs to entity details.

- Supports ticker symbols (`AAPL`, `VOO`), company names (`Apple`), or CIK numbers (`320193`)
- ETFs and mutual funds resolve by ticker via `company_tickers_mf.json`; fund results include `series_id` and `class_id` for downstream scoping
- Current and former company names both resolve (`Facebook` → Meta Platforms, `Square` → Block)
- Near-match suggestions on zero-result name search (e.g. `Microsfot` → `MICROSOFT CORP / MSFT`)
- Optionally includes recent filings with form type filtering
- Returns entity metadata: SIC code, exchanges, fiscal year end, state of incorporation

---

### `secedgar_search_filings`

Full-text search across all EDGAR filing documents since 1993.

- Exact phrases (`"material weakness"`), boolean operators (`revenue OR income`), wildcards (`account*`)
- Entity targeting within query string (`cik:320193` or `ticker:AAPL`) — scoped server-side by CIK, so filings made under a former company name (same CIK) are included
- Date range filtering, form type filtering, pagination up to 10,000 results
- Returns form distribution for narrowing follow-up searches
- When the entity-scoped window exceeds the inline limit, the already-fetched EFTS window is materialized as a `df_<id>` dataframe — query it with `secedgar_dataframe_query`

---

### `secedgar_get_filing`

Fetch a specific filing's metadata and document content by accession number.

- Accepts accession numbers in dash or no-dash format
- Converts HTML filings to readable plain text
- Configurable content limit (1K–200K characters, default 50K)
- Can fetch specific exhibits by document name
- **Offset paging** for large documents (10-K, S-1/A can exceed 1M chars): pass `next_offset` from a truncated response as `offset` on the next call to continue reading; first-page truncated responses include a detected `outline` (headings with offsets) for targeted navigation
- **Section targeting** via the `section` param: jumps directly to a named heading by case-insensitive substring match (e.g. `"risk factors"`, `"item 7"`, `"certain relationships"`); on a miss, the error carries the detected outline so you can pick the correct heading
- Extracted text is cached per `accession + document` (bounded LRU, 8 entries), making subsequent paged calls cheap

---

### `secedgar_get_financials`

Get historical XBRL financial data for a company with friendly concept name resolution.

- Friendly names like `"revenue"`, `"net_income"`, `"eps_diluted"` auto-resolve to correct XBRL tags
- Handles historical tag changes (e.g., ASC 606 revenue recognition)
- Automatic deduplication to one value per standard calendar period
- Filter by annual, quarterly, or all periods
- Optional `limit` caps the inline series to the most-recent N periods; the full series stays queryable via the `df_<id>` dataframe
- See `secedgar://concepts` resource for the full mapping

---

### `secedgar_get_insider_transactions`

Surface Form 3/4/5 insider activity for a company by parsing ownership XML.

- Reporting person, relationship to issuer (director, officer + title, 10% owner), and transaction date
- Transaction code mapped to a readable type (purchase, sale, gift, award, exercise, …); shares signed by acquired/disposed
- Price per share and shares owned after each transaction; covers non-derivative (open-market) and derivative (option/RSU) lines
- Filter by `transaction_type` (`purchase`, `sale`, `all`); scans newest filings first
- The full set of transactions parsed from the scanned recent filings is materialized as a `df_<id>` dataframe (the inline list is a preview capped at `limit`) — query it with `secedgar_dataframe_query` to aggregate net buy/sell by insider

---

### `secedgar_get_institutional_holdings`

Surface 13F-HR quarterly institutional holdings by parsing the information table.

- Pass an institution (CIK or name) to see what it holds, or a company CIK to find its own 13F filings
- Each holding: issuer name, CUSIP, market value (whole USD), shares/principal, and put/call; raw rows also carry investment discretion
- Sub-lines for the same security (one per manager/account) are consolidated into distinct positions sorted by value by default — pass `consolidate: false` for raw filing rows
- Resolves the filing-manager name and reporting quarter from the cover page; target a specific quarter with `quarter` (e.g. `"2025-Q4"`)
- `total_holdings_in_filing` counts raw info-table rows; `total_positions` counts distinct positions after consolidation (both before `limit`)
- The full parsed holdings set is materialized as a `df_<id>` dataframe (the inline list is a preview capped at `limit`) — query it with `secedgar_dataframe_query` for full-filing aggregation or cross-quarter joins on `cusip` + `reporting_period`

---

### `secedgar_fetch_frames`

Fetch SEC XBRL frames for one concept × one period across all reporting companies.

- Same friendly concept names as `secedgar_get_financials`
- Supports annual (`CY2023`), quarterly (`CY2024Q2`), and instant (`CY2023Q4I`) periods
- Inline response returns the top N ranked companies (sort + limit), with ticker enrichment
- The full frames response (all reporters, typically 2k–10k rows) is materialized as a `df_<id>` dataframe — query it with `secedgar_dataframe_query`
- `related_tags` flags alternate-definition tags some filers use as their primary line (e.g. `cash` → restricted-cash-inclusive total, `equity` → NCI-inclusive total), so a whole-universe screen on the base tag isn't silently under-inclusive — query those separately

---

### `secedgar_search_concepts`

Discover supported XBRL concept names before querying financials or cross-company comparisons.

- Search by friendly name, label, or raw XBRL tag
- Filter by statement group (`income_statement`, `balance_sheet`, `cash_flow`, `per_share`, `entity_info`) or taxonomy
- Reverse-lookup raw tags like `NetIncomeLoss` to the supported friendly names
- Surfaces `related_tags` for concepts with a high-coverage alternate-definition tag (e.g. restricted-cash-inclusive cash) so callers can discover them before screening
- Returns the same catalog used by `secedgar_get_financials`, `secedgar_fetch_frames`, and `secedgar://concepts`

---

### `secedgar_dataframe_describe` / `secedgar_dataframe_query` / `secedgar_dataframe_drop`

In-conversation SQL analytics over the dataframes that `secedgar_fetch_frames`, `secedgar_search_filings`, `secedgar_get_financials`, `secedgar_get_insider_transactions`, and `secedgar_get_institutional_holdings` materialize on a shared DuckDB-backed canvas. Each data-returning call adds a `dataset` field with a `df_XXXXX_XXXXX` handle; pass that handle to `secedgar_dataframe_query` for joins, aggregates, window functions, percentiles — standard DuckDB SQL.

- **Read-only by default.** Writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected by the framework SQL gate. System catalogs (`information_schema`, `pg_catalog`, `sqlite_master`, `duckdb_*`) are denied at the bridge layer so callers can't enumerate dataframes they don't already hold a handle for. `secedgar_dataframe_drop` is the only destructive tool and is opt-in (`EDGAR_DATAFRAME_DROP_ENABLED=true`); TTL handles cleanup otherwise.
- **Per-table TTL.** Each dataframe ages on its own clock (default 24h, override with `EDGAR_DATASET_TTL_SECONDS`). The canvas itself uses the framework's sliding TTL.
- **`register_as` chaining.** `secedgar_dataframe_query` can persist its result as a new dataframe (`df_XXXXX_XXXXX`) with a fresh TTL — pipe analyses without re-running the source query.

## Resources

| URI | Description |
|:---|:---|
| `secedgar://concepts` | Common XBRL financial concepts grouped by statement, mapping friendly names to XBRL tags |
| `secedgar://filing-types` | Common SEC filing types with descriptions, cadence, and use cases |

## Prompts

| Prompt | Description |
|:---|:---|
| `secedgar_company_analysis` | Guides a structured analysis of a public company's SEC filings: identify recent filings, extract financial trends, surface risk factors, and note material events |

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Structured output schemas with automatic formatting for human-readable display
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Structured logging with request-scoped context
- Runs locally (stdio/HTTP) from the same codebase

SEC EDGAR–specific:

- Rate-limited HTTP client respecting SEC's 10 req/s limit with automatic inter-request delay
- CIK resolution from tickers (including ETFs and mutual funds via `company_tickers_mf.json`), company names (current and former), or raw CIK numbers with local caching; near-match trigram suggestions on zero-result name queries; committed `former-names.json` asset for prior-name resolution (`Facebook` → Meta, `Square` → Block)
- Friendly XBRL concept name mapping with historical tag change handling
- Searchable concept catalog with statement-group metadata and reverse XBRL tag lookup
- HTML-to-text conversion for filing documents via `html-to-text`
- In-conversation SQL analytics: `secedgar_fetch_frames`, `secedgar_search_filings`, `secedgar_get_financials`, `secedgar_get_insider_transactions`, and `secedgar_get_institutional_holdings` materialize their full result as a DuckDB-backed canvas dataframe queryable via `secedgar_dataframe_query`
- No API keys required — SEC EDGAR is a free, public API

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

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher.

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
| `EDGAR_DATAFRAME_DROP_ENABLED` | Set to `true` to expose `secedgar_dataframe_drop` — the only destructive tool on this server. Off by default; TTL handles cleanup. | `false` |
| `EDGAR_MIRROR_ENABLED` | Enable the local SQLite mirror of `company_tickers` + XBRL company-facts so CIK resolution and financials read from disk instead of the live API. Node/Bun only (skipped on Workers). Bootstrap once with `bun run mirror:init`. | `false` |
| `EDGAR_MIRROR_PATH` | Directory holding the mirror SQLite databases. | `./data/edgar-mirror` |
| `EDGAR_MIRROR_REFRESH_CRON` | Cron for the in-process nightly refresh (HTTP transport only). Recommended `0 9 * * *`. Omit to refresh out-of-band via `bun run mirror:refresh`. | — |
| `EDGAR_MIRROR_FALLBACK_LIVE` | When the mirror misses (not yet synced, or a filing newer than the last refresh), fall back to the live SEC API. Set `false` for strict mirror-only reads. | `true` |
| `CANVAS_PROVIDER_TYPE` | Canvas engine. Defaults to `duckdb`; set to `none` to disable the canvas (e.g. when running on Cloudflare Workers, where DuckDB has no V8-isolate build). | `duckdb` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |

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
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). Eight SEC EDGAR tools plus three `dataframe_*` tools for SQL analytics. |
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

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
