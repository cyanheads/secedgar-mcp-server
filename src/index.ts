#!/usr/bin/env node
/**
 * @fileoverview secedgar-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { companyAnalysisPrompt } from '@/mcp-server/prompts/definitions/company-analysis.prompt.js';
import { conceptsResource } from '@/mcp-server/resources/definitions/concepts.resource.js';
import { filingTypesResource } from '@/mcp-server/resources/definitions/filing-types.resource.js';
import { companySearchTool } from '@/mcp-server/tools/definitions/company-search.tool.js';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { fetchFramesTool } from '@/mcp-server/tools/definitions/fetch-frames.tool.js';
import { getFilingTool } from '@/mcp-server/tools/definitions/get-filing.tool.js';
import { getFinancialsTool } from '@/mcp-server/tools/definitions/get-financials.tool.js';
import { searchConceptsTool } from '@/mcp-server/tools/definitions/search-concepts.tool.js';
import { searchFilingsTool } from '@/mcp-server/tools/definitions/search-filings.tool.js';
import { initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { initEdgarApiService } from '@/services/edgar/edgar-api-service.js';

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
  tools: [
    companySearchTool,
    searchFilingsTool,
    getFilingTool,
    getFinancialsTool,
    fetchFramesTool,
    searchConceptsTool,
    dataframeDescribeTool,
    dataframeQueryTool,
    ...(dropEnabled ? [dataframeDropTool] : []),
  ],
  resources: [conceptsResource, filingTypesResource],
  prompts: [companyAnalysisPrompt],
  instructions:
    'Use the secedgar_* tools to query SEC EDGAR — US public-company filings since 1993 plus historical XBRL financials. Resolve companies with secedgar_company_search (accepts ticker, name, or CIK), fetch document text with secedgar_get_filing by accession number, and run full-text search across all filings with secedgar_search_filings (supports boolean operators and inline ticker:AAPL / cik:320193 targeting). For financials, secedgar_get_financials and secedgar_fetch_frames accept friendly names like "revenue" or "eps_diluted" (discover them with secedgar_search_concepts) or raw XBRL tags. Data-returning tools also materialize their full upstream response as a df_<id> handle for downstream SQL via secedgar_dataframe_query — list dataframes with secedgar_dataframe_describe.',
  setup(core) {
    initEdgarApiService();
    initCanvasBridge(core.canvas);
  },
});
