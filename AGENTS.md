# Agent Protocol

**Server:** secedgar-mcp-server
**Version:** 0.7.2
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.9.19`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0

Query SEC EDGAR filings, XBRL financials, and company data through MCP. Read-only, no API keys required. Full design: `docs/sec-edgar-mcp-design.md`.

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
2. **Add services** — scaffold domain service integrations using the `add-service` skill
3. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
4. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
5. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
6. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
7. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## MCP Surface

### Tools

| Name | Description | Key Inputs |
|:-----|:------------|:-----------|
| `secedgar_company_search` | Find companies and retrieve entity info with optional recent filings | `query`, `include_filings?`, `form_types?`, `filing_limit?` |
| `secedgar_search_filings` | Full-text search across all EDGAR filing documents since 1993 | `query`, `forms?`, `start_date?`, `end_date?`, `limit?` |
| `secedgar_get_filing` | Fetch a specific filing's metadata and document content | `accession_number`, `cik?`, `content_limit?`, `document?` |
| `secedgar_get_financials` | Get historical XBRL financial data for a company | `company`, `concept`, `taxonomy?`, `period_type?` |
| `secedgar_get_insider_transactions` | Form 3/4/5 insider transactions parsed from ownership XML | `ticker_or_cik`, `transaction_type?`, `limit?` |
| `secedgar_get_institutional_holdings` | 13F-HR quarterly institutional holdings parsed from the information table | `ticker_or_cik`, `quarter?`, `limit?` |
| `secedgar_fetch_frames` | Fetch SEC XBRL frames for one concept × one period across all reporting companies | `concept`, `period`, `unit?`, `limit?`, `sort?` |
| `secedgar_search_concepts` | Discover supported XBRL concept names or reverse-lookup a raw tag | `search?`, `group?`, `taxonomy?` |
| `secedgar_dataframe_describe` | List canvas dataframes with provenance, TTL, and schema | `name?` |
| `secedgar_dataframe_query` | Run a single-statement SELECT across dataframes (DuckDB SQL) | `sql`, `preview?`, `register_as?` |
| `secedgar_dataframe_drop` | Drop a canvas dataframe by name. Opt-in via `EDGAR_DATAFRAME_DROP_ENABLED=true` | `name` |

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
- **Dataframes:** `secedgar_search_filings`, `secedgar_get_financials`, and `secedgar_fetch_frames` materialize their full upstream response as `df_<id>` on a shared DuckDB-backed canvas (one per tenant). Each row set carries an all-nullable schema (sparse SEC columns must not trip DuckDB's NOT NULL appender rollback). Per-table TTL is bridge-side bookkeeping in `ctx.state` until [cyanheads/mcp-ts-core#140](https://github.com/cyanheads/mcp-ts-core/issues/140) lands. `secedgar_dataframe_query` runs framework's SQL gate plus a bridge-layer deny on `information_schema`, `pg_catalog`, `sqlite_master`, and `duckdb_*` catalogs.
- **Local mirror (opt-in, `EDGAR_MIRROR_ENABLED`):** routes `resolveCik`, `tryGetCompanyConcept`, and `tryGetFrames` to a local SQLite mirror (framework `MirrorService`) of `company_tickers.json` + the `companyfacts.zip` bulk archive; the live API is the fallback on a miss (`EDGAR_MIRROR_FALLBACK_LIVE`). Bootstrap out-of-band with `bun run mirror:init`; refresh nightly via cron (HTTP) or `bun run mirror:refresh`. Node/Bun only — skipped on Workers. Frames are assembled from the company-facts store, so `loc` (business location) is absent. No FTS5 — every routed lookup is exact/indexed (cik+taxonomy+tag point, taxonomy+tag scan, ticker/CIK).

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `EDGAR_USER_AGENT` | **Yes** | — | User-Agent for SEC compliance. Format: `"AppName contact@email.com"` |
| `EDGAR_RATE_LIMIT_RPS` | No | `10` | Max requests/second to SEC APIs. Do not exceed 10. |
| `EDGAR_TICKER_CACHE_TTL` | No | `3600` | Seconds to cache company_tickers.json |
| `EDGAR_DATASET_TTL_SECONDS` | No | `86400` | Per-table TTL for canvas-registered dataframes. Sliding window touched on every dataframe op. |
| `EDGAR_DATAFRAME_DROP_ENABLED` | No | `false` | Set to `true` to expose `secedgar_dataframe_drop`. TTL handles cleanup otherwise. |
| `EDGAR_MIRROR_ENABLED` | No | `false` | Enable the local SQLite mirror of company_tickers + XBRL company-facts. Node/Bun only (skipped on Workers). Bootstrap once with `bun run mirror:init`. |
| `EDGAR_MIRROR_PATH` | No | `./data/edgar-mirror` | Directory holding the mirror SQLite databases (tickers + companyfacts). |
| `EDGAR_MIRROR_REFRESH_CRON` | No | — | In-process nightly refresh cron (HTTP transport only). Recommended `0 9 * * *`. Omit to refresh out-of-band via `bun run mirror:refresh`. |
| `EDGAR_MIRROR_FALLBACK_LIVE` | No | `true` | Fall back to the live SEC API on a mirror miss (unsynced, or a filing newer than the last refresh). Set `false` for strict mirror-only reads. |
| `CANVAS_PROVIDER_TYPE` | No | `duckdb` | Canvas engine. Set to `none` to disable the canvas (e.g. on Cloudflare Workers). |

---

## Services

| Module | Path | Purpose |
|:-------|:-----|:--------|
| `EdgarApiService` | `src/services/edgar/edgar-api-service.ts` | Rate-limited HTTP client, CIK resolution, all SEC API calls |
| `concept-map` | `src/services/edgar/concept-map.ts` | Static friendly name → XBRL tag mapping |
| `filing-to-text` | `src/services/edgar/filing-to-text.ts` | HTML → readable plain text conversion |
| `CanvasBridge` | `src/services/canvas-bridge/canvas-bridge.ts` | Adapter over framework `DataCanvas`: `df_<id>` minting, all-nullable schema derivation, per-table TTL, shared-canvas acquire |
| `sql-gate-extras` | `src/services/canvas-bridge/sql-gate-extras.ts` | System-catalog SQL deny on top of the framework's read-only gate |
| `EdgarMirror` | `src/services/edgar/mirror/` | Opt-in local SQLite mirror (framework `MirrorService`) of company_tickers + XBRL company-facts; ready-gated read helpers back `resolveCik`/`tryGetCompanyConcept`/`tryGetFrames` |

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

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()`. The handler then receives `ctx.fail(reason, msg?, data?)` typed against the reason union, and `data.reason` is auto-populated for observability. The `recovery` field is required (≥5 words, lint-validated). Use `ctx.recoveryFor('reason')` to spread the contract recovery onto the wire; pass an explicit `{ recovery: { hint } }` when runtime context matters. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely without declaration. **All EDGAR tools that have known failure modes use this pattern.**

```ts
errors: [
  { reason: 'company_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'The company input does not resolve to a CIK',
    recovery: 'Use a ticker symbol or 10-digit CIK number for an exact match.' },
],
async handler(input, ctx) {
  if (!match) throw ctx.fail('company_not_found', `Company '${input.company}' not found.`, {
    ...ctx.recoveryFor('company_not_found'),
  });
}
```

**Service-layer pattern (no `ctx`).** Throw an `McpError` with `data: { reason, recovery: { hint } }`. The auto-classifier preserves `data` on the wire so clients see the same `error.data.reason` they'd see from `ctx.fail`.

**Fallback for ad-hoc throws** (no contract entry fits, prototype code): use error factories or plain `Error`.

```ts
import { notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });            // explicit code
throw new Error('Item not found');                       // auto-classified → NotFound
```

**HTTP responses.** `httpErrorFromResponse(response, { service, data })` from `/utils` maps the full status table (401/403/408/422/429/5xx) and captures body + `Retry-After`. Used in `EdgarApiService`.

See framework CLAUDE.md and the `api-errors` skill for the full reference.

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
      mirror/                           # Opt-in local SQLite mirror (framework MirrorService)
        edgar-mirror.ts                 #   two stores + ready-gated read helpers
        tickers-sync.ts                 #   company_tickers.json ingester
        companyfacts-sync.ts            #   companyfacts.zip streaming ingester (fflate)
        index.ts                        #   barrel + server-side singleton
        types.ts                        #   row shapes + constants
    canvas-bridge/
      canvas-bridge.ts                  # Framework DataCanvas adapter, df_<id> minting, per-table TTL
      sql-gate-extras.ts                # Bridge-layer system-catalog deny on top of framework SQL gate
  mcp-server/
    tools/definitions/
      company-search.tool.ts
      search-filings.tool.ts
      get-filing.tool.ts
      get-financials.tool.ts
      fetch-frames.tool.ts
      search-concepts.tool.ts
      dataframe-describe.tool.ts
      dataframe-query.tool.ts
      dataframe-drop.tool.ts            # Opt-in via EDGAR_DATAFRAME_DROP_ENABLED
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

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, run the `maintenance` skill — it re-syncs the agent directory automatically (Phase B).

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + UI resource pair |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent local mirror of a bulk upstream dataset (embedded SQLite + FTS5) — Tier 3, Node/Bun only |
| `api-services` | LLM, Speech, Graph services |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, re-audit. Use when `devcheck` flags a transitive advisory — stale lockfile can mask already-patched deps. If advisory survives, it's real. |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run lint:mcp` | Validate MCP tool/resource definitions |
| `bun run lint:packaging` | Validate env-var alignment between `manifest.json` and `server.json` |
| `bun run list-skills` | Print an index of available skills from `skills/` |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync with `changelog/` (used by devcheck) |
| `bun run bundle` | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `bun run test` | Run tests |
| `bun run mirror:init` | Bootstrap the local mirror (download company_tickers + companyfacts.zip). Out-of-band; resumable. |
| `bun run mirror:refresh` | Incrementally refresh the local mirror from the SEC bulk files. |
| `bun run mirror:verify` | Print mirror sync status + run sample reads. |
| `bun run start` | Production mode (`.env`-respecting transport) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. MCPB is stdio-only — HTTP deployments are unaffected. Delete `manifest.json` and `.mcpbignore` to opt out; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

---

## Changelog

Directory-based. Source of truth is `changelog/<major.minor>.x/<version>.md` — one file per released version. `CHANGELOG.md` is a generated index; never hand-edit it.

**To add a release entry:**

1. Author `changelog/<major.minor>.x/<version>.md` using `changelog/template.md` as a reference.
2. Add YAML frontmatter: `summary` (≤350 chars, no markdown), optional `breaking: true` flags breaking changes (`· ⚠️ Breaking` badge), optional `security: true` flags security fixes (`· 🛡️ Security` badge, pairs with a `## Security` body section).
3. Set the H1 heading to `# <version> — YYYY-MM-DD`.
4. Run `bun run changelog:build` to regenerate `CHANGELOG.md`.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

After a version bump and final commit, publish to both npm and GHCR:

```bash
bun publish --access public

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/cyanheads/secedgar-mcp-server:<version> \
  -t ghcr.io/cyanheads/secedgar-mcp-server:latest \
  --push .
```

Remind the user to run these after completing a release flow.

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

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`). Avoid `z.url()` / `z.cuid()` / `z.base64()` / `z.jwt()` — the `schema-format-portability` lint rejects format values outside OpenAI's allowlist. Drop the format method and move the constraint into describe text.
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — typed `errors[]` contract + `ctx.fail(reason, …, ctx.recoveryFor(reason))` when failure modes are known; factories or plain `Error` for ad-hoc throws. No try/catch.
- [ ] Tool error contracts include `recovery` strings (≥5 words)
- [ ] `format()` renders all data the LLM needs — Claude Code reads `structuredContent`, Claude Desktop reads `content[]`; both must carry the same data
- [ ] EDGAR upstream sparsity: schemas reflect real nullability; `format()` preserves uncertainty (don't fabricate facts from missing XBRL fields); tests cover at least one sparse payload
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext({ errors: tool.errors })` from `@cyanheads/mcp-ts-core/testing` for tools with declared contracts
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `bun run devcheck` passes
