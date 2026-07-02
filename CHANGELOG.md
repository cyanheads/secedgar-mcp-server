# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.12.0](changelog/0.12.x/0.12.0.md) — 2026-07-02 · ⚠️ Breaking

Breaking: get_financials dataframe columns fiscal_year/fiscal_period renamed to source_filing_fy/source_filing_fp; heading detection covers mixed-case Item/Part headings on styled filings; section-miss errors render the detected outline in the message

## [0.11.3](changelog/0.11.x/0.11.3.md) — 2026-07-02

Canvas-bridge register_as clash pre-check with contract recovery hints; EFTS degraded-2xx shape guard and typed ticker:/cik: validation in search_filings; insider-transactions canvas scan floor with truthful dataset.truncated; get_institutional_holdings docs drop the unimplemented issuer-to-holders lookup; .env.example dataframe settings

## [0.11.2](changelog/0.11.x/0.11.2.md) — 2026-07-02 · 🛡️ Security

secedgar_get_filing hardening: accession/CIK validation before network I/O, exhibit filename-fallback classification without headers, sentinel-framed upstream filing text; mcp-ts-core ^0.10.10 + lock re-resolve clears bun audit from 8 vulnerabilities to 0 (hono, js-yaml)

## [0.11.1](changelog/0.11.x/0.11.1.md) — 2026-06-20

Adopt mcp-ts-core ^0.10.9: dataframe_describe filtered-table binder fix and dataframe_query SELECT-shaped prepare failures now classified invalid_sql with DuckDB binder detail; plugin-manifest devcheck lint, synced skills, dependency refresh

## [0.11.0](changelog/0.11.x/0.11.0.md) — 2026-06-11

Dataframe-query error reclassification and register_as fix (#52, #53, #54); company_search and search_filings whitespace + pagination fixes (#55, #56, #57, #58); get_filing offset paging, section targeting, and extract cache (#59)

## [0.10.5](changelog/0.10.x/0.10.5.md) — 2026-06-11

mcp-ts-core ^0.10.6: post-pack bundle cleaner, packaging linter checks 8-9, skill syncs, websiteUrl removed from createApp()

## [0.10.4](changelog/0.10.x/0.10.4.md) — 2026-06-11

Server identity: name and title now use the machine name secedgar-mcp-server (was 'SEC EDGAR MCP Server')

## [0.10.3](changelog/0.10.x/0.10.3.md) — 2026-06-11

DataCanvas adoption: framework TTL, denySystemCatalogs, inferSchemaFromRows always-nullable; ctx.enrich.truncated() on 5 list tools; server identity fields; mcp-ts-core ^0.10.1 → ^0.10.5

## [0.10.2](changelog/0.10.x/0.10.2.md) — 2026-06-08

Fix get_financials frame collisions (Spotify IFRS Revenue 26× undercount), instant-period first-call fallback, fetch_frames no_data for empty tags, dataframe_query structured missing_table/invalid_sql, company_search MF fund tickers on mirror, insider shares_traded now unsigned with direction.

## [0.10.1](changelog/0.10.x/0.10.1.md) — 2026-06-08 · 🛡️ Security

Security: DataCanvas SQL gate fails closed on non-SELECT statements and denies pragma_* table functions; stringbool env-boolean parsing; .mcpbignore dev-dir anchoring; actionable node-cron peer error.

## [0.10.0](changelog/0.10.x/0.10.0.md) — 2026-06-08

secedgar_company_search: ETF/fund ticker resolution, former-name lookup (Facebook→Meta, Square→Block), near-match suggestions on zero-result name queries, and robustness fixes for private/pre-IPO filers

## [0.9.0](changelog/0.9.x/0.9.0.md) — 2026-06-08

Ownership tools now register full parsed results to the canvas; fetch_frames surfaces alternate-definition XBRL tags that cover a meaningful share of filers for the base concept.

## [0.8.4](changelog/0.8.x/0.8.4.md) — 2026-06-04

get_filing error data now returns categorized documents instead of a flat list; search_filings notes Form 3/4/5 index limitations

## [0.8.3](changelog/0.8.x/0.8.3.md) — 2026-06-02

Adopt @cyanheads/mcp-ts-core ^0.9.21 — per-request log context fix, secret-stripped error messages, and fail-fast retry behavior

## [0.8.2](changelog/0.8.x/0.8.2.md) — 2026-06-02

mirror:init/verify/refresh commands ship in the production Docker image; docker exec now a supported lever for mirror bootstrap and re-ingest

## [0.8.1](changelog/0.8.x/0.8.1.md) — 2026-06-01

search_filings cik:/ticker: now scopes server-side via EFTS ciks param; date/period validators; dataframe_query register_as preserves real DuckDB types; get_financials limit param

## [0.8.0](changelog/0.8.x/0.8.0.md) — 2026-06-01 · ⚠️ Breaking

get_institutional_holdings: whole-USD market values, distinct-position consolidation, working quarter targeting

## [0.7.4](changelog/0.7.x/0.7.4.md) — 2026-06-01

Gate cross-company frames on a full-coverage completion marker (falling back to live while the store is partial or re-syncing); fix the companyfacts ingester to checkpoint only after the full archive drains so an interrupted ingest re-streams on the next refresh.

## [0.7.3](changelog/0.7.x/0.7.3.md) — 2026-06-01

Declare node-cron dependency so EDGAR_MIRROR_REFRESH_CRON works in the published package and Docker image; wrap scheduler init in try/catch so a scheduling fault degrades gracefully instead of crashing startup.

## [0.7.2](changelog/0.7.x/0.7.2.md) — 2026-05-31

Opt-in local SQLite mirror of company_tickers and XBRL company-facts via MirrorService; routed lookups hit SQLite with live-API fallback. Adds EDGAR_MIRROR_* env vars, mirror:init/refresh/verify scripts, and Node/Bun-only Workers guard.

## [0.7.1](changelog/0.7.x/0.7.1.md) — 2026-05-30

Empty strings now rejected for required string fields — company/concept on secedgar_get_financials and concept/period on secedgar_fetch_frames return a clean ValidationError instead of reaching the handler.

## [0.7.0](changelog/0.7.x/0.7.0.md) — 2026-05-30

Insider transactions (Form 3/4/5), institutional holdings (13F), IFRS friendly-name resolution, ambiguous-company guard, and system_catalog_access error contract

## [0.6.3](changelog/0.6.x/0.6.3.md) — 2026-05-30

enrichment adoption — search/concept tools surface query echoes and empty-result guidance via typed enrichment block

## [0.6.2](changelog/0.6.x/0.6.2.md) — 2026-05-28 · 🛡️ Security

mcp-ts-core ^0.9.9 → ^0.9.13: HTTP body cap (413), session-init gate, quieter 401/403/400/404 logs, GET /mcp keywords; @biomejs/biome ^2.4.15 → ^2.4.16; plugin metadata files; code-simplifier skill.

## [0.6.1](changelog/0.6.x/0.6.1.md) — 2026-05-25

mcp-ts-core ^0.9.6 → ^0.9.9: git-wrapup skill, ctx.elicit/ctx.fail/ctx.notifyPromptListChanged/ctx.notifyToolListChanged docs, release artifact verification, structured tag annotation format; @duckdb/node-api ^1.5.3-r.1 → ^1.5.3-r.2; stdio/streamable-http npm keywords added.

## [0.6.0](changelog/0.6.x/0.6.0.md) — 2026-05-25

Concept catalog 16 → 33; get_financials companyfacts probe on no_concept_data; FY bracket label dropped; get_filing primary_document preserved on exhibit fetches; search_filings form_distribution fixed for forms filter; fiscal_year_end formatted MM-DD.

## [0.5.2](changelog/0.5.x/0.5.2.md) — 2026-05-23

`@cyanheads/mcp-ts-core ^0.9.1 → ^0.9.6`. `RequestContextLike` canvas cast removed. `zod` added as explicit dependency. `manifest.json` + `.mcpbignore` scaffolded for MCPB bundle support. Install badges added to README.

## [0.5.1](changelog/0.5.x/0.5.1.md) — 2026-05-17

`secedgar_fetch_frames` flags fiscal-Q4 silent dropout on `CY####Q[1-4]` periods via a new `caveats` field. Ticker enrichment now resolves multi-class CIKs to common stock (JPM, BAC, C) instead of preferred-share variants (JPM-PA, BAC-PS, C-PR).

## [0.5.0](changelog/0.5.x/0.5.0.md) — 2026-05-17 · ⚠️ Breaking

In-conversation SQL analytics over SEC EDGAR. `secedgar_search_filings`, `secedgar_get_financials`, and the new `secedgar_fetch_frames` (renamed from `secedgar_compare_metric`) now materialize their full upstream response as a DuckDB-backed `df_<id>` dataframe, queryable via three new `secedgar_dataframe_*` tools.

## [0.4.5](changelog/0.4.x/0.4.5.md) — 2026-05-16

Adopt framework ^0.9.1 — server now publishes a top-level `instructions` orientation string on every MCP `initialize` response. Definition linting moves to build-time only (lint:mcp / devcheck), no longer gates startup. Devcheck `bun outdated` parser fix and the 350-char changelog summary cap come along for the ride.

## [0.4.4](changelog/0.4.x/0.4.4.md) — 2026-05-08

secedgar_search_filings reports form_distribution consistent with total under entity targeting; framework ^0.8.13 → ^0.8.19, Node engine ≥24, schema descriptions tightened across all tools and resources.

## [0.4.3](changelog/0.4.x/0.4.3.md) — 2026-05-04

secedgar_search_filings adds sort (filing_date_desc default); secedgar_get_filing categorizes documents into primary/exhibits/auxiliary/xbrl from SEC headers and gates XBRL artifacts behind include_xbrl. Closes #3, #5.

## [0.4.2](changelog/0.4.x/0.4.2.md) — 2026-05-04

Framework bump to @cyanheads/mcp-ts-core 0.8.13; secedgar_get_filing now routes its three contract reasons through ctx.fail in the archive-resolution helper for full lint conformance.

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-04-30

Framework upgrade to @cyanheads/mcp-ts-core 0.8.7 with full typed-error-contract adoption, two domain bug fixes against issues #1 and #2, and skill / script syncs.

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-04-24

Framework upgrade to @cyanheads/mcp-ts-core 0.7.0, shared SEC fetch path with retry on filing document downloads, and the lint-warning cleanup that framework 0.6.16 surfaced.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-04-20

Framework upgrade, content parity across tools, and cleaner entity names.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-04-17

Concept discovery, filing lookup resilience, and framework sync.

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-03-30

Dependency updates and package metadata improvements.

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-03-28

Framework upgrade, enhanced skills, and MCP linter improvements.

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-03-24

Description and metadata updates.

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-03-24

Tool annotation improvements and agent protocol updates.

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-03-24

Packaging, documentation, and code formatting cleanup.

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-03-24

Fixes for taxonomy resolution, date validation, HTTP retry resilience, and Bun version bump.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-03-24

Improved entity-targeted search, better error diagnostics, and documentation overhaul.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-03-24

Dependency updates and code style fixes.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-03-24

Data quality and resilience fixes for filing text conversion, XBRL financials, and EFTS search results.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-03-24

Bug fixes for EFTS full-text search, improved error handling, and full test coverage.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-03-24

Metadata, documentation, and packaging polish — no functional changes.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-03-24

Initial release. MCP server for SEC EDGAR — company lookups, filing search/retrieval, XBRL financial data, and cross-company comparison.
