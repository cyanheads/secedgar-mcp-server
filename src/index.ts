#!/usr/bin/env node
/**
 * @fileoverview secedgar-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { requestContextService, runtimeCaps, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { companyAnalysisPrompt } from '@/mcp-server/prompts/definitions/company-analysis.prompt.js';
import { conceptsResource } from '@/mcp-server/resources/definitions/concepts.resource.js';
import { filingTypesResource } from '@/mcp-server/resources/definitions/filing-types.resource.js';
import { companySearchTool } from '@/mcp-server/tools/definitions/company-search.tool.js';
import { compareCompaniesTool } from '@/mcp-server/tools/definitions/compare-companies.tool.js';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { fetchFramesTool } from '@/mcp-server/tools/definitions/fetch-frames.tool.js';
import { findHoldersTool } from '@/mcp-server/tools/definitions/find-holders.tool.js';
import { getFilingTool } from '@/mcp-server/tools/definitions/get-filing.tool.js';
import { getFinancialsTool } from '@/mcp-server/tools/definitions/get-financials.tool.js';
import { getInsiderTransactionsTool } from '@/mcp-server/tools/definitions/get-insider-transactions.tool.js';
import { getInstitutionalHoldingsTool } from '@/mcp-server/tools/definitions/get-institutional-holdings.tool.js';
import { getMaterialEventsTool } from '@/mcp-server/tools/definitions/get-material-events.tool.js';
import { getSnapshotTool } from '@/mcp-server/tools/definitions/get-snapshot.tool.js';
import { searchConceptsTool } from '@/mcp-server/tools/definitions/search-concepts.tool.js';
import { searchFilingsTool } from '@/mcp-server/tools/definitions/search-filings.tool.js';
import { initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { initEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { initEdgarMirror } from '@/services/edgar/mirror/index.js';

// DuckDB is the only canvas engine we support and ships as a direct dep, so
// enable the canvas by default. Set CANVAS_PROVIDER_TYPE=none explicitly to
// turn it off (e.g. on Cloudflare Workers, where DuckDB has no V8-isolate
// build and the framework would fail to construct a canvas anyway).
process.env.CANVAS_PROVIDER_TYPE ??= 'duckdb';

// secedgar_dataframe_drop is the only destructive tool on this server and is
// off by default — TTL handles cleanup. Set EDGAR_DATAFRAME_DROP_ENABLED=true
// to expose it.
const dropEnabled = getServerConfig().dataframeDropEnabled;

await createApp({
  name: 'secedgar-mcp-server',
  title: 'secedgar-mcp-server',
  tools: [
    companySearchTool,
    searchFilingsTool,
    getFilingTool,
    getFinancialsTool,
    getSnapshotTool,
    getMaterialEventsTool,
    getInsiderTransactionsTool,
    getInstitutionalHoldingsTool,
    findHoldersTool,
    fetchFramesTool,
    compareCompaniesTool,
    searchConceptsTool,
    dataframeDescribeTool,
    dataframeQueryTool,
    ...(dropEnabled ? [dataframeDropTool] : []),
  ],
  resources: [conceptsResource, filingTypesResource],
  prompts: [companyAnalysisPrompt],
  instructions:
    'Use the secedgar_* tools to query SEC EDGAR — US public-company filings since 1993 plus historical XBRL financials. Resolve companies with secedgar_company_search (accepts ticker, name, or CIK), fetch document text with secedgar_get_filing by accession number, and search filings with secedgar_search_filings (full-text covers 2001-present; pre-2001 date ranges browse the archives by form and entity/date, so pre-2001 full-text matching requires ticker:/cik: entity scope; supports boolean operators and inline ticker:AAPL / cik:320193 targeting). For financials, secedgar_get_financials and secedgar_fetch_frames accept friendly names like "revenue" or "eps_diluted" (discover them with secedgar_search_concepts) or raw XBRL tags; secedgar_get_snapshot profiles one company across every supported concept in a single call, and secedgar_compare_companies puts 2-10 named companies side by side on aligned calendar periods. For 8-K material events, secedgar_get_material_events filters a company\'s 8-K history by item code (2.02 results, 5.02 officer changes, 4.02 non-reliance). Ownership runs in both directions: secedgar_get_institutional_holdings takes a 13F manager and returns its portfolio, secedgar_find_holders takes an issuer and returns the managers reporting it. Data-returning tools also materialize their full upstream response as a df_<id> handle for downstream SQL via secedgar_dataframe_query — list dataframes with secedgar_dataframe_describe.',
  async setup(core) {
    initEdgarApiService();
    initCanvasBridge(core.canvas);

    // Optional local mirror of company_tickers + XBRL company-facts. Needs SQLite
    // and a persistent filesystem, so it is Node/Bun only — skipped on Cloudflare
    // Workers, where the live SEC API stays the only path.
    const cfg = getServerConfig();
    if (cfg.mirrorEnabled && runtimeCaps.isNode && !runtimeCaps.isWorkerLike) {
      const mirror = initEdgarMirror({ dir: cfg.mirrorPath, userAgent: cfg.userAgent });

      // In-process nightly refresh, HTTP transport only. Under stdio, operators run
      // `bun run mirror:refresh` out-of-band; the full init always runs out-of-band.
      const transport = core.config?.mcpTransportType ?? 'stdio';
      if (cfg.mirrorRefreshCron && transport === 'http') {
        const bootCtx = requestContextService.createRequestContext({
          operation: 'edgar-mirror-refresh-init',
        });
        // The framework scheduler lazily imports the optional `node-cron` peer.
        // If scheduling fails for any reason, degrade gracefully: the mirror still
        // answers reads (with live fallback) and can be refreshed out-of-band via
        // `bun run mirror:refresh`. A scheduling fault must not crash the server.
        try {
          core.logger.info('Scheduling EDGAR mirror refresh', {
            ...bootCtx,
            cron: cfg.mirrorRefreshCron,
          });
          await schedulerService.schedule(
            'edgar-mirror-refresh',
            cfg.mirrorRefreshCron,
            async (jobCtx) => {
              try {
                const result = await mirror.runRefresh({
                  signal: AbortSignal.timeout(6 * 60 * 60_000),
                });
                core.logger.info('EDGAR mirror refresh complete', { ...jobCtx, ...result });
              } catch (err) {
                core.logger.error('EDGAR mirror refresh failed', {
                  ...jobCtx,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            },
            'Refresh the EDGAR mirror (company_tickers + XBRL company-facts) from the SEC bulk files.',
          );
          schedulerService.start('edgar-mirror-refresh');
        } catch (err) {
          core.logger.warning(
            'Could not schedule EDGAR mirror refresh; serving with live fallback. Run `bun run mirror:refresh` out-of-band to refresh the mirror.',
            {
              ...bootCtx,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
    }
  },
});
