# Changelog

## [0.4.1] — 2026-04-30

Framework upgrade to `@cyanheads/mcp-ts-core` 0.8.7 with full typed-error-contract adoption, two domain bug fixes against issues [#1](https://github.com/cyanheads/secedgar-mcp-server/issues/1) and [#2](https://github.com/cyanheads/secedgar-mcp-server/issues/2), and skill / script syncs.

### Fixed

- **`secedgar_get_financials` no longer throws on default invocation for balance-sheet concepts** ([#1](https://github.com/cyanheads/secedgar-mcp-server/issues/1)) — `period_type` is now optional. The handler computes the effective default from the resolved concept's mapping group: balance-sheet items default to `'all'` (so instant frames `CYxxxxQxI` aren't filtered out), every other group keeps the previous `'annual'` default. Bare calls for `assets`, `liabilities`, `equity`, `cash`, `debt` now return data instead of a recovery hint. Income-statement defaults are unchanged.
- **`EdgarApiService` HTTP errors now classify by status** — `rawFetch` uses `httpErrorFromResponse` from `@cyanheads/mcp-ts-core/utils`, mapping 401/403/408/422/429/5xx to the correct `JsonRpcErrorCode` and capturing body + `Retry-After` into `error.data`. The `EDGAR_USER_AGENT` hint for 403 is preserved as a structured `data.recovery.hint`. 404 paths in `fetchJson` / `fetchText` now throw `notFound` instead of `serviceUnavailable` — semantically correct.

### Added

- **Typed error contracts on five tools** — `company_search`, `search_filings`, `get_filing`, `get_financials`, `compare_metric` declare `errors[]` arrays per the framework's 0.8.0 contract pattern. Twelve declared reasons total (`no_match`, `multiple_matches`, `invalid_date_range`, `document_not_found`, `no_documents`, `filing_not_found`, `company_not_found`, `no_concept_data`, `no_frame_data`, `no_period_data`, `unknown_concept`, `no_data`), each with a ≥5-word `recovery` string. Handlers throw via `ctx.fail(reason, msg, { ...ctx.recoveryFor(reason) })`; the `get_filing` archive helper carries reasons via `data: { reason }` per the 0.8.1 service-layer pattern. Error responses now mirror `data.recovery.hint` into `content[]` text per 0.8.3's parity invariant — clients see the same recovery guidance whether they read `structuredContent` or `content[]`.
- **Two new friendly XBRL concept names** ([#2](https://github.com/cyanheads/secedgar-mcp-server/issues/2)) — `depreciation_amortization` (tags: `DepreciationDepletionAndAmortization`, `DepreciationAndAmortization`, `Depreciation`) and `notes_payable` (tags: `LongTermNotesPayable`, `NotesPayable`, `LongTermDebt`). The multi-tag fallback chain handles cross-filer variation observed in production traffic for D&A across LMT / NOC / GD.
- **`bun run start` script** — bare `.env`-respecting transport script for hosted MCP runners (template change adopted from framework 0.7.6).

### Changed

- **`@cyanheads/mcp-ts-core` `^0.7.0` → `^0.8.7`** (1 minor + 8 patches: typed error contracts, `ctx.fail` / `ctx.recoveryFor` helpers, `httpErrorFromResponse` utility, error-path parity, framework-antipatterns devcheck step, security hardening for HTTP origin guard / landing auth / log scrubbing, vitest config `.mjs` fix, and skill drift fixes).
- **`html-to-text` `^9.0.5` → `^10.0.0`** — maintenance major release; minimum Node bumped to 20.19+ (project already requires ≥22), no API breaks.
- **Dropped `dev:stdio` / `dev:http` watch scripts** from `package.json` (template cleanup adopted from framework 0.8.6 — smoke tests now run via `bun run rebuild && bun run start:stdio`).
- **Errors section in `CLAUDE.md` / `AGENTS.md`** rewritten to lead with the typed-contract pattern; checklist updated to require `recovery` strings (≥5 words) and `createMockContext({ errors: tool.errors })` for tests with declared contracts.
- **Refreshed all project skills from the package** (12 updated: `add-service` 1.3→1.5, `add-tool` 1.8→2.4, `api-context` 1.1→1.2, `api-errors` 1.0→1.4, `api-linter` 1.1→1.2, `design-mcp-server` 2.7→2.8, `field-test` 2.0→2.3, `maintenance` 1.5→2.0, `release-and-publish` 2.1→2.2, `report-issue-framework` 1.3→1.4, `security-pass` 1.1→1.2, `setup` 1.5→1.6). Re-synced into `.claude/skills/` and `.agents/skills/`.
- **Synced framework `scripts/` additions** — `check-framework-antipatterns.ts` (new devcheck step) and `split-changelog.ts`.

### Tests

- All five tool test files thread `createMockContext({ errors: tool.errors })` so `ctx.fail` is wired against the contract's reasons.
- Two new regression tests for issue [#1](https://github.com/cyanheads/secedgar-mcp-server/issues/1) — bare `concept: 'assets'` returns data; explicit `period_type: 'annual'` against a balance-sheet item still surfaces the structured `no_period_data` recovery hint.
- Two new tests in `concept-map.test.ts` lock the tag ordering for `depreciation_amortization` and `notes_payable`.

---

## [0.4.0] — 2026-04-24

Framework upgrade to `@cyanheads/mcp-ts-core` 0.7.0, shared SEC fetch path with retry on filing document downloads, and the lint-warning cleanup that framework 0.6.16 surfaced.

### Changed

- Updated `@cyanheads/mcp-ts-core` from `^0.5.3` to `^0.7.0` (covers 0.5.4 through 0.7.0 — directory-based changelog system, landing page + SEP-1649 Server Card at `/.well-known/mcp.json`, `MCP_PUBLIC_URL` override for TLS-terminating proxies, flattened ZodError messages with structured `issues`, locale-aware format-parity, new `describe-on-fields` recursion, HTTP transport hardening, and more)
- Updated dev tooling: `@biomejs/biome` `^2.4.12→^2.4.13`, `vitest` `^4.1.4→^4.1.5`
- Refactored `EdgarApiService` to share a single `rawFetch` across JSON and text fetches. Filing document downloads (`fetchText` / `tryFetchText`) now retry on 429 / 500 / 502 / 503 / 504 with exponential backoff — previously they bypassed the retry loop and failed immediately on transient upstream errors. Retryable status codes hoisted to a `RETRYABLE_STATUSES` Set
- Added `.describe()` on the array-element `z.object({...})` in every tool's output schema (`company-search` filings, `compare-metric` data, `get-filing` documents, `get-financials` data, `search-concepts` concepts, `search-filings` results) — satisfies the new recursive `describe-on-fields` linter
- Refreshed all project skills from the package; most external skills bumped (`add-tool` 1.6→1.8, `design-mcp-server` 2.4→2.7, `field-test` 1.2→2.0, `maintenance` 1.3→1.5, `polish-docs-meta` 1.4→1.7, `setup` 1.3→1.5, `report-issue-local` / `report-issue-framework` 1.1→1.3, and others). Skills also re-synced to `.claude/skills/` and `.agents/skills/`
- Synced framework `scripts/` additions: `build-changelog.ts`, `check-docs-sync.ts`, `check-skills-sync.ts`. The latter two back new devcheck steps that verify `CLAUDE.md` ↔ `AGENTS.md` and `skills/` ↔ agent-dir mirrors stay aligned
- CLAUDE.md / AGENTS.md skills table updated with `api-linter`, `release-and-publish`, and `security-pass`; agent-skill-directory guidance now references the `maintenance` skill's automatic Phase-B sync. AGENTS.md realigned byte-identical to CLAUDE.md for the new `Docs Sync` devcheck step

### Added

- Three new skills adopted from the framework: `api-linter` (v1.1) — definition-lint rule reference; `release-and-publish` (v2.1) — post-wrapup ship workflow across npm / MCP Registry / GHCR with transient-failure retries; `security-pass` (v1.1) — eight-axis MCP-flavored security audit
- Documented `MCP_PUBLIC_URL` in `.env.example` and surfaced it in `server.json` — public-facing origin override for deployments behind TLS-terminating reverse proxies (Cloudflare Tunnel, Caddy, nginx)
- Tracked `.github/ISSUE_TEMPLATE/` (bug_report, feature_request, config) that were previously on disk but untracked

---

## [0.3.0] — 2026-04-20

Framework upgrade, content parity across tools, and cleaner entity names.

### Changed

- Updated `@cyanheads/mcp-ts-core` from `^0.3.5` to `^0.5.3`
- Updated `format()` output across all six tools so every terminal field in the output schema renders in the markdown twin, satisfying the framework's new `format-parity` linter — clients reading `content[]` now see the same data as clients reading `structuredContent`
- Stripped trailing `(TICKER)` and `(CIK …)` parentheticals from `company_name` in `secedgar_search_filings` results — ticker and CIK are already separate fields, so the duplicate was removed from both `structuredContent` and rendered text
- `secedgar_get_financials` and `secedgar_get_filing` now always render `tags_tried` and the filing document list when present (previously hidden for single-entry cases)
- Refreshed project skills from the package (`add-tool` 1.3→1.6, `api-config` 1.1→1.2, `design-mcp-server` 2.2→2.4, `field-test` 1.1→1.2, `maintenance` 1.2→1.3, `polish-docs-meta` 1.3→1.4, `setup` 1.2→1.3) and propagated to `.claude/skills/` and `.agents/skills/`
- Bumped MCP SDK badge in README to `^1.29.0`

---

## [0.2.0] — 2026-04-17

Concept discovery, filing lookup resilience, and framework sync.

### Added

- Added `secedgar_search_concepts` for browsing friendly XBRL names, filtering by statement group or taxonomy, and reverse-looking up raw tags
- Added `AGENTS.md` and the `add-app-tool` skill to align the repo with current framework conventions

### Changed

- Updated `@cyanheads/mcp-ts-core` from `^0.2.10` to `^0.3.5`
- Updated dev tooling: `@biomejs/biome` `^2.4.10→^2.4.12`, `@types/node` `^25.5.0→^25.6.0`, `typescript` `^6.0.2→^6.0.3`, `vitest` `^4.1.2→^4.1.4`
- Added statement-group metadata to concept mappings and refreshed the README, agent docs, tree doc, and skills for the six-tool surface

### Fixed

- Improved `secedgar_get_filing` when CIK is omitted by resolving candidate CIKs from SEC search metadata and handling missing documents more reliably
- Serialized EDGAR throttling so concurrent requests cannot bypass the configured inter-request delay
- Preserved sparse upstream EDGAR data as optional fields in filing and financial responses, with clearer not-found behavior for concept and frame lookups

---

## [0.1.11] — 2026-03-30

Dependency updates and package metadata improvements.

### Changed

- Updated `@cyanheads/mcp-ts-core` from `^0.2.8` to `^0.2.10`
- Updated `@biomejs/biome` from `^2.4.9` to `^2.4.10`
- Enriched `author` field in `package.json` with email and homepage URL
- Added `funding` array to `package.json` (GitHub Sponsors, Buy Me a Coffee)

---

## [0.1.10] — 2026-03-28

Framework upgrade, enhanced skills, and MCP linter improvements.

### Changed

- Upgraded `@cyanheads/mcp-ts-core` from `^0.1.28` to `^0.2.8`
- Added `overrides` for transitive dependency security fixes (`brace-expansion`, `path-to-regexp`, `picomatch`)
- Bumped `@biomejs/biome` to `^2.4.9` and `vitest` to `^4.1.2`
- MCP linter (`scripts/lint-mcp.ts`) now discovers and validates `server.json` and `package.json` alongside tool/resource/prompt definitions
- Added `remotes` array to `server.json` with public hosted instance URL
- Added `LOGS_DIR` env var to README configuration table
- Updated `add-tool` skill (v1.1): enhanced `format()` template, added Tool Response Design section (partial success, empty results, metadata, context budget)
- Updated `add-resource` skill (v1.1): added tool coverage guidance for tool-only MCP clients
- Updated `design-mcp-server` skill (v2.1): live API probing, tools-as-primary-interface emphasis, batch input design, convenience shortcuts, enhanced error design, service resilience planning
- Updated `polish-docs-meta` skill (v1.2): description propagation rule, GitHub repository metadata sync step
- Enriched `format()` output across all 5 tools — surfaces CIK, exchange, period dates, report descriptions, document lists, filing URLs, and accession numbers for better LLM reasoning

### Added

- `report-issue-framework` skill — file bugs and feature requests against `@cyanheads/mcp-ts-core`
- `report-issue-local` skill — file bugs and feature requests against this server's repo

---

## [0.1.9] — 2026-03-24

Description and metadata updates.

### Changed

- Unified project description across `package.json`, `server.json`, `Dockerfile`, and `README.md` to a shorter tagline
- Updated `CLAUDE.md` agent protocol description to match
- Added `typescript` keyword to `package.json`

---

## [0.1.8] — 2026-03-24

Tool annotation improvements and agent protocol updates.

### Changed

- Added `idempotentHint: true` annotation to all five tools — signals to MCP clients that repeated calls with the same inputs are safe
- Added `openWorldHint: true` annotation to `get-filing` and `get-financials` tools — previously only set on search/compare tools
- Added publishing instructions section to `CLAUDE.md` (npm + Docker GHCR commands)

---

## [0.1.7] — 2026-03-24

Packaging, documentation, and code formatting cleanup.

### Changed

- Removed static Version badge from README — npm badge already provides this
- Removed Docker MCP client configuration example from README (Docker section under Running still exists)
- Added build step to README installation instructions
- Changed default `MCP_LOG_LEVEL` documentation from `debug` to `info`
- Added `exports` field to `package.json` for proper ESM resolution
- Removed `CLAUDE.md` from npm `files` array
- Removed unnecessary `packageArguments` from `server.json` npm package entries
- Bumped `server.json` top-level version to match package version
- Formatting cleanup in `get-financials.tool.ts`, `search-filings.tool.ts`, and `edgar-api-service.ts`

---

## [0.1.6] — 2026-03-24

Fixes for taxonomy resolution, date validation, HTTP retry resilience, and Bun version bump.

### Fixed

- `get-financials` respects user-provided taxonomy when it differs from the `us-gaap` default — previously the resolved mapping always overwrote the input
- `get-financials` shows a targeted error hint when using `ifrs-full` taxonomy vs the default
- `search-filings` validates that both `start_date` and `end_date` are provided together — rejects partial date ranges at input
- `edgar-api-service` retries on 500, 502, and 504 responses in addition to existing 429 and 503

### Changed

- Bun minimum engine version bumped to `>=1.3.0`, packageManager to `bun@1.3.11`
- README default log level updated to `debug`, prerequisite Bun version corrected to v1.3.0, npm badge updated to scoped package name

---

## [0.1.5] — 2026-03-24

Improved entity-targeted search, better error diagnostics, and documentation overhaul.

### Changed

- `search-filings` resolves `ticker:` and `cik:` targeting in queries — looks up the company name and substitutes it into the EFTS query, then post-filters results by CIK for accurate entity-scoped search
- `compare-metric` distinguishes unknown concepts (no mapping + 404) from valid concepts with no data — error message now suggests checking `secedgar://concepts` for unknown names
- `get-financials` reports actionable errors when deduplication removes all entries (no frame-aligned data) or when the period type filter yields no results (suggests the correct period type)
- Prompt description uses template literal instead of string concatenation

### Docs

- README overhaul: added npm and Bun badges, Docker and npx configuration examples, sentence-case headings, cleaned up table formatting, added auth mention, updated prerequisites to Bun v1.3.2, added tests directory to project structure

---

## [0.1.4] — 2026-03-24

Dependency updates and code style fixes.

### Changed

- Updated dev dependencies: `typescript` `^5.9.3→^6.0.2`, `@biomejs/biome` `^2.4.7→^2.4.8`, `vitest` `^4.1.0→^4.1.1`
- Formatting and style fixes applied by updated Biome (line wrapping, template literals)

---

## [0.1.3] — 2026-03-24

Data quality and resilience fixes for filing text conversion, XBRL financials, and EFTS search results.

### Fixed

- Inline XBRL markup (`<ix:header>`, `<ix:nonFraction>`, etc.) stripped before HTML→text conversion — eliminates noise in modern filing output
- `get-filing` tool returns proper `notFound()` error for 404 responses instead of an unclassified exception
- `get-financials` period type filtering uses frame pattern (`CY2024`, `CY2024Q1`) instead of `fp` field — `fp` reflects the filing period, not the data point period
- `get-financials` output schema allows nullable `fiscal_year` and `fiscal_period` — some XBRL data points lack these fields
- `search-filings` output schema and type allow optional `form` field — some EFTS results omit it

### Changed

- `company-search` query input now requires `.min(1)` — rejects empty strings at validation

---

## [0.1.2] — 2026-03-24

Bug fixes for EFTS full-text search, improved error handling, and full test coverage.

### Fixed

- EFTS response field mapping — `form_type` → `form`, `period_of_report` → `period_ending`, `entity_name` → `display_names[]`, `file_num` → `ciks[]`, added `adsh` for reliable accession numbers
- Error handling in `compare-metric` and `get-financials` tools — only swallow 404s (tag not reported), re-throw real errors instead of silently catching all exceptions
- Client-side limit slicing in `search-filings` — EFTS search-index endpoint ignores `size`/`from` params, so apply requested limit after fetch

### Changed

- `edgar-api-service` — 403 error messages now include hostname and User-Agent format hint for faster debugging
- `EftsHit` type — updated to match actual EDGAR EFTS response structure (`adsh`, `ciks`, `form`, `items`, `root_forms`, `sequence`, `xsl`)
- `CLAUDE.md` — added `migrate-mcp-ts-template` skill to skills table

### Added

- Test suite with 7 test files covering all tools, resources, and services
  - Tools: `company-search`, `search-filings`, `get-filing`, `get-financials`, `compare-metric`
  - Resources: `concepts`, `filing-types`
  - Services: `concept-map`, `filing-to-text`
- Updated `docs/tree.md` with test directory structure

---

## [0.1.1] — 2026-03-24

Metadata, documentation, and packaging polish — no functional changes.

### Added

- `README.md` with full tool/resource/prompt docs, configuration, and getting started guide
- `LICENSE` file (Apache 2.0)
- `bunfig.toml` for Bun runtime configuration
- `docs/tree.md` directory structure

### Changed

- `.env.example` — replaced template placeholders with SEC EDGAR env vars
- `CLAUDE.md` — added `lint:mcp` command, fixed import example to use real service path
- `Dockerfile` — added OCI description and source labels
- `package.json` — filled in description, mcpName, keywords, repository URLs, author, bun engine, packageManager
- `server.json` — filled in name/description/repo URL, set runtimeHint to bun, added `EDGAR_USER_AGENT` env var

### Removed

- Template echo tests (`echo.tool.test.ts`, `echo.resource.test.ts`, `echo.prompt.test.ts`)

---

## [0.1.0] — 2026-03-24

Initial release. MCP server for SEC EDGAR — company lookups, filing search/retrieval, XBRL financial data, and cross-company comparison.

### Added

- **Tools**
  - `secedgar_company_search` — find companies and retrieve entity info with optional recent filings
  - `secedgar_search_filings` — full-text search across all EDGAR filing documents since 1993
  - `secedgar_get_filing` — fetch a specific filing's metadata and document content
  - `secedgar_get_financials` — get historical XBRL financial data for a company (friendly concept names supported)
  - `secedgar_compare_metric` — compare a financial metric across all reporting companies for a period
- **Resources**
  - `secedgar://concepts` — XBRL financial concepts grouped by statement, mapping friendly names to tags
  - `secedgar://filing-types` — common SEC filing types with descriptions, cadence, and use cases
- **Prompts**
  - `secedgar_company_analysis` — guided structured analysis of a company's SEC filings
- **Services**
  - `EdgarApiService` — rate-limited HTTP client with CIK resolution and ticker caching
  - `concept-map` — static friendly name → XBRL tag mapping (handles ASC 606 historical tag changes)
  - `filing-to-text` — HTML → readable plain text conversion via `html-to-text`
- **Infrastructure**
  - Dockerfile and `.dockerignore` for containerized deployment
  - Biome for linting and formatting
  - Vitest test scaffolding
  - Build scripts (build, clean, rebuild, devcheck, tree, lint-mcp)
  - Stdio and HTTP transport support
  - Design document (`docs/sec-edgar-mcp-design.md`)
