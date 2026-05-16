#!/usr/bin/env node
/**
 * @fileoverview secedgar-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { companyAnalysisPrompt } from '@/mcp-server/prompts/definitions/company-analysis.prompt.js';
import { conceptsResource } from '@/mcp-server/resources/definitions/concepts.resource.js';
import { filingTypesResource } from '@/mcp-server/resources/definitions/filing-types.resource.js';
import { companySearchTool } from '@/mcp-server/tools/definitions/company-search.tool.js';
import { compareMetricTool } from '@/mcp-server/tools/definitions/compare-metric.tool.js';
import { getFilingTool } from '@/mcp-server/tools/definitions/get-filing.tool.js';
import { getFinancialsTool } from '@/mcp-server/tools/definitions/get-financials.tool.js';
import { searchConceptsTool } from '@/mcp-server/tools/definitions/search-concepts.tool.js';
import { searchFilingsTool } from '@/mcp-server/tools/definitions/search-filings.tool.js';
import { initEdgarApiService } from '@/services/edgar/edgar-api-service.js';

await createApp({
  tools: [
    companySearchTool,
    searchFilingsTool,
    getFilingTool,
    getFinancialsTool,
    compareMetricTool,
    searchConceptsTool,
  ],
  resources: [conceptsResource, filingTypesResource],
  prompts: [companyAnalysisPrompt],
  instructions:
    'Use the secedgar_* tools to query SEC EDGAR — US public-company filings since 1993 plus historical XBRL financials. Resolve companies with secedgar_company_search (accepts ticker, name, or CIK), fetch document text with secedgar_get_filing by accession number, and run full-text search across all filings with secedgar_search_filings (supports boolean operators and inline ticker:AAPL / cik:320193 targeting). For financials, secedgar_get_financials and secedgar_compare_metric accept friendly names like "revenue" or "eps_diluted" (discover them with secedgar_search_concepts) or raw XBRL tags.',
  setup() {
    initEdgarApiService();
  },
});
