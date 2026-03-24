# Changelog

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
