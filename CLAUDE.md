# Agent Protocol

**Server:** secedgar-mcp-server
**Version:** 0.1.6
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

MCP server for SEC EDGAR — company lookups, filing search/retrieval, XBRL financial data, and cross-company comparison. Read-only, no API keys required. Full design: `docs/sec-edgar-mcp-design.md`.

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.

---

## MCP Surface

### Tools

| Name | Description | Key Inputs |
|:-----|:------------|:-----------|
| `secedgar_company_search` | Find companies and retrieve entity info with optional recent filings | `query`, `include_filings?`, `form_types?`, `filing_limit?` |
| `secedgar_search_filings` | Full-text search across all EDGAR filing documents since 1993 | `query`, `forms?`, `start_date?`, `end_date?`, `limit?` |
| `secedgar_get_filing` | Fetch a specific filing's metadata and document content | `accession_number`, `cik?`, `content_limit?`, `document?` |
| `secedgar_get_financials` | Get historical XBRL financial data for a company | `company`, `concept`, `taxonomy?`, `period_type?` |
| `secedgar_compare_metric` | Compare a financial metric across all reporting companies | `concept`, `period`, `unit?`, `limit?`, `sort?` |

### Resources

| URI | Description |
|:----|:------------|
| `secedgar://concepts` | Common XBRL financial concepts grouped by statement, mapping friendly names to XBRL tags |
| `secedgar://filing-types` | Common SEC filing types with descriptions, cadence, and use cases |

### Prompts

| Name | Description |
|:-----|:------------|
| `secedgar_company_analysis` | Guides structured analysis of a company's SEC filings |

---

## Domain Notes

- **Rate limit:** 10 req/s per IP — enforced by `EdgarApiService` (100ms inter-request delay)
- **User-Agent required:** `"AppName contact@email.com"` on every SEC request or IP gets blocked
- **CIK zero-padding:** URLs require 10-digit zero-padded CIK (`String(cik).padStart(10, '0')`)
- **XBRL friendly names:** `concept-map.ts` maps `"revenue"` → real XBRL tags; handles historical tag changes (ASC 606)
- **XBRL deduplication:** Filter to entries with `frame` field to get one value per standard calendar period
- **EFTS quirks:** `dateRange=custom` must be set when using date params; `entity` param is ignored (use `cik:` in query string)
- **Filing content:** HTML → text via `html-to-text` library; pre-2005 filings produce noisier output

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `EDGAR_USER_AGENT` | **Yes** | — | User-Agent for SEC compliance. Format: `"AppName contact@email.com"` |
| `EDGAR_RATE_LIMIT_RPS` | No | `10` | Max requests/second to SEC APIs. Do not exceed 10. |
| `EDGAR_TICKER_CACHE_TTL` | No | `3600` | Seconds to cache company_tickers.json |

---

## Services

| Module | Path | Purpose |
|:-------|:-----|:--------|
| `EdgarApiService` | `src/services/edgar/edgar-api-service.ts` | Rate-limited HTTP client, CIK resolution, all SEC API calls |
| `concept-map` | `src/services/edgar/concept-map.ts` | Static friendly name → XBRL tag mapping |
| `filing-to-text` | `src/services/edgar/filing-to-text.ts` | HTML → readable plain text conversion |

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.elicit` | Ask user for structured input. **Check for presence first:** `if (ctx.elicit) { ... }` |
| `ctx.sample` | Request LLM completion from the client. **Check for presence first:** `if (ctx.sample) { ... }` |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.progress` | Task progress (present when `task: true`) — `.setTotal(n)`, `.increment()`, `.update(message)`. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats. Three escalation levels:

```ts
// 1. Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// 2. Error factories — explicit code, concise
import { notFound, validationError, forbidden, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// 3. McpError — full control over code and data
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

Plain `Error` is fine for most cases. Use factories when the error code matters. See framework CLAUDE.md for the full auto-classification table and all available factories.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # EDGAR env vars (Zod schema)
  services/
    edgar/
      edgar-api-service.ts              # Rate-limited HTTP client, CIK resolution
      concept-map.ts                    # Friendly name → XBRL tag mapping
      filing-to-text.ts                 # HTML → plain text
      types.ts                          # Domain types
  mcp-server/
    tools/definitions/
      company-search.tool.ts
      search-filings.tool.ts
      get-filing.tool.ts
      get-financials.tool.ts
      compare-metric.tool.ts
    resources/definitions/
      concepts.resource.ts
      filing-types.resource.ts
    prompts/definitions/
      company-analysis.prompt.ts
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, re-copy to pick up changes.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `migrate-mcp-ts-template` | Migrate a template fork to use `@cyanheads/mcp-ts-core` as a package dependency |
| `maintenance` | Sync skills and dependencies after updates |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run lint:mcp` | Validate MCP tool/resource definitions |
| `bun run test` | Run tests |
| `bun run dev:stdio` | Dev mode (stdio) |
| `bun run dev:http` | Dev mode (HTTP) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, etc.)
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes
