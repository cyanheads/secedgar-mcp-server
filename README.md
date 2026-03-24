<div align="center">
  <h1>secedgar-mcp-server</h1>
  <p><b>MCP server for SEC EDGAR — company lookups, filing search/retrieval, XBRL financial data, and cross-company comparison. Read-only, no API keys required. STDIO & Streamable HTTP</b></p>
  <p><b>5 Tools · 2 Resources · 1 Prompt</b></p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.27.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^5.9.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/)

</div>

---

## Tools

Five tools for querying SEC EDGAR data:

| Tool Name | Description |
|:----------|:------------|
| `secedgar_company_search` | Find companies and retrieve entity info with optional recent filings. |
| `secedgar_search_filings` | Full-text search across all EDGAR filing documents since 1993. |
| `secedgar_get_filing` | Fetch a specific filing's metadata and document content. |
| `secedgar_get_financials` | Get historical XBRL financial data for a company. |
| `secedgar_compare_metric` | Compare a financial metric across all reporting companies. |

### `secedgar_company_search`

Entry point for most EDGAR workflows — resolve tickers, names, or CIKs to entity details.

- Supports ticker symbols (`AAPL`), company names (`Apple`), or CIK numbers (`320193`)
- Optionally includes recent filings with form type filtering
- Returns entity metadata: SIC code, exchanges, fiscal year end, state of incorporation

---

### `secedgar_search_filings`

Full-text search across all EDGAR filing documents since 1993.

- Exact phrases (`"material weakness"`), boolean operators (`revenue OR income`), wildcards (`account*`)
- Entity targeting within query string (`cik:320193` or `ticker:AAPL`)
- Date range filtering, form type filtering, pagination up to 10,000 results
- Returns form distribution for narrowing follow-up searches

---

### `secedgar_get_filing`

Fetch a specific filing's metadata and document content by accession number.

- Accepts accession numbers in dash or no-dash format
- Converts HTML filings to readable plain text
- Configurable content limit (1K–200K characters, default 50K)
- Can fetch specific exhibits by document name

---

### `secedgar_get_financials`

Get historical XBRL financial data for a company with friendly concept name resolution.

- Friendly names like `"revenue"`, `"net_income"`, `"eps_diluted"` auto-resolve to correct XBRL tags
- Handles historical tag changes (e.g., ASC 606 revenue recognition)
- Automatic deduplication to one value per standard calendar period
- Filter by annual, quarterly, or all periods
- See `secedgar://concepts` resource for the full mapping

---

### `secedgar_compare_metric`

Compare a financial metric across all reporting companies for a specific period.

- Same friendly concept names as `secedgar_get_financials`
- Supports annual (`CY2023`), quarterly (`CY2024Q2`), and instant (`CY2023Q4I`) periods
- Sorted ranking with configurable limit and direction
- Enriches results with ticker symbols where available

## Resources

| URI | Description |
|:----|:------------|
| `secedgar://concepts` | Common XBRL financial concepts grouped by statement, mapping friendly names to XBRL tags. |
| `secedgar://filing-types` | Common SEC filing types with descriptions, cadence, and use cases. |

## Prompts

| Prompt | Description |
|:-------|:------------|
| `secedgar_company_analysis` | Guides structured analysis of a company's SEC filings — identification, financial trends, risk factors, material events, and peer comparison. |

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Structured output schemas with automatic formatting for human-readable display
- Unified error handling across all tools
- Structured logging with request-scoped context
- Runs locally (stdio/HTTP) from the same codebase

SEC EDGAR–specific:

- Rate-limited HTTP client respecting SEC's 10 req/s limit with automatic inter-request delay
- CIK resolution from tickers, company names, or raw CIK numbers with local caching
- Friendly XBRL concept name mapping with historical tag change handling
- HTML-to-text conversion for filing documents via `html-to-text`
- No API keys required — SEC EDGAR is a free, public API

## Getting Started

### MCP Client Configuration

Add to your MCP client config (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "secedgar-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["secedgar-mcp-server@latest"],
      "env": {
        "EDGAR_USER_AGENT": "YourAppName your-email@example.com",
        "MCP_TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

### Prerequisites

- [Bun v1.2.0](https://bun.sh/) or higher (for development)
- [Node.js v22.0.0](https://nodejs.org/) or higher (for production)

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

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `EDGAR_USER_AGENT` | **Required.** User-Agent header for SEC compliance. Format: `"AppName contact@email.com"`. SEC blocks IPs without a valid User-Agent. | — |
| `EDGAR_RATE_LIMIT_RPS` | Max requests/second to SEC APIs. Do not exceed 10. | `10` |
| `EDGAR_TICKER_CACHE_TTL` | Seconds to cache the company tickers lookup file. | `3600` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |

## Running the Server

### Local Development

- **Build and run the production version:**
  ```sh
  bun run build
  bun run start:http   # or start:stdio
  ```

- **Run in dev mode (auto-reload):**
  ```sh
  bun run dev:stdio    # or dev:http
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

## Project Structure

| Directory | Purpose |
|:----------|:--------|
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources/definitions/` | Resource definitions (`*.resource.ts`). |
| `src/mcp-server/prompts/definitions/` | Prompt definitions (`*.prompt.ts`). |
| `src/services/edgar/` | SEC EDGAR API client, XBRL concept mapping, HTML-to-text conversion. |
| `src/config/` | Environment variable parsing and validation with Zod. |

## Development Guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for domain-specific logging, `ctx.state` for storage
- Register new tools and resources in `src/index.ts`

## Contributing

Issues and pull requests are welcome. Run checks before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
