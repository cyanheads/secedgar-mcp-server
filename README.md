<div align="center">
  <h1>secedgar-mcp-server</h1>
  <p><b>MCP server for SEC EDGAR — company lookups, filing search/retrieval, XBRL financial data, and cross-company comparison. Read-only, no API keys required. STDIO & Streamable HTTP</b>
  <div>5 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/secedgar-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/secedgar-mcp-server) [![Version](https://img.shields.io/badge/Version-0.1.5-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.27.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/)

[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

---

## Tools

Five tools for querying SEC EDGAR data:

| Tool | Description |
|:---|:---|
| `secedgar_company_search` | Find companies and retrieve entity info with optional recent filings |
| `secedgar_search_filings` | Full-text search across all EDGAR filing documents since 1993 |
| `secedgar_get_filing` | Fetch a specific filing's metadata and document content |
| `secedgar_get_financials` | Get historical XBRL financial data for a company |
| `secedgar_compare_metric` | Compare a financial metric across all reporting companies |

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
|:---|:---|
| `secedgar://concepts` | Common XBRL financial concepts grouped by statement, mapping friendly names to XBRL tags |
| `secedgar://filing-types` | Common SEC filing types with descriptions, cadence, and use cases |

## Prompts

| Prompt | Description |
|:---|:---|
| `secedgar_company_analysis` | Guides structured analysis of a company's SEC filings — identification, financial trends, risk factors, material events, and peer comparison |

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
- CIK resolution from tickers, company names, or raw CIK numbers with local caching
- Friendly XBRL concept name mapping with historical tag change handling
- HTML-to-text conversion for filing documents via `html-to-text`
- No API keys required — SEC EDGAR is a free, public API

## Getting started

### MCP client configuration

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "secedgar": {
      "type": "stdio",
      "command": "bunx",
      "args": ["secedgar-mcp-server@latest"],
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
    "secedgar": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "secedgar-mcp-server@latest"],
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
    "secedgar": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "EDGAR_USER_AGENT=YourAppName your-email@example.com", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/secedgar-mcp-server:latest"]
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

- [Bun v1.3.2](https://bun.sh/) or higher.

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

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `EDGAR_USER_AGENT` | **Required.** User-Agent header for SEC compliance. Format: `"AppName contact@email.com"`. SEC blocks IPs without a valid User-Agent. | — |
| `EDGAR_RATE_LIMIT_RPS` | Max requests/second to SEC APIs. Do not exceed 10. | `10` |
| `EDGAR_TICKER_CACHE_TTL` | Seconds to cache the company tickers lookup file. | `3600` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |

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

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). Five SEC EDGAR tools. |
| `src/mcp-server/resources/definitions/` | Resource definitions. XBRL concepts and filing types. |
| `src/mcp-server/prompts/definitions/` | Prompt definitions. Company analysis prompt. |
| `src/services/edgar/` | SEC EDGAR API client, XBRL concept mapping, HTML-to-text conversion. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

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
