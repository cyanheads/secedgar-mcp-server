/**
 * @fileoverview The tool registration list handed to `createApp()` — every
 * secedgar tool definition, including the ones this deployment gates off.
 *
 * A gated tool stays in the list rather than being omitted from it:
 * `secedgar_dataframe_drop` is wrapped with `disabledTool()` when
 * `EDGAR_DATAFRAME_DROP_ENABLED` is off, which keeps it out of MCP registration
 * (clients cannot list or call it) while leaving it visible — with its reason
 * and enable hint — on the HTTP landing page, so an operator auditing the
 * server can see the capability exists and what turns it on (#103).
 *
 * @module mcp-server/tools/definitions/index
 */

import { disabledTool } from '@cyanheads/mcp-ts-core';
import { companySearchTool } from './company-search.tool.js';
import { compareCompaniesTool } from './compare-companies.tool.js';
import { dataframeDescribeTool } from './dataframe-describe.tool.js';
import { dataframeDropTool } from './dataframe-drop.tool.js';
import { dataframeQueryTool } from './dataframe-query.tool.js';
import { fetchFramesTool } from './fetch-frames.tool.js';
import { findHoldersTool } from './find-holders.tool.js';
import { getBeneficialOwnersTool } from './get-beneficial-owners.tool.js';
import { getFilingTool } from './get-filing.tool.js';
import { getFinancialsTool } from './get-financials.tool.js';
import { getFundHoldingsTool } from './get-fund-holdings.tool.js';
import { getInsiderTransactionsTool } from './get-insider-transactions.tool.js';
import { getInstitutionalHoldingsTool } from './get-institutional-holdings.tool.js';
import { getMaterialEventsTool } from './get-material-events.tool.js';
import { getSnapshotTool } from './get-snapshot.tool.js';
import { searchConceptsTool } from './search-concepts.tool.js';
import { searchFilingsTool } from './search-filings.tool.js';

/** Deployment gates that decide how a tool enters the registration list. */
export interface ToolDefinitionOptions {
  /**
   * `EDGAR_DATAFRAME_DROP_ENABLED`. When false, `secedgar_dataframe_drop` is
   * registered through `disabledTool()` instead of live.
   */
  dropEnabled: boolean;
}

/**
 * Build the tool list for `createApp({ tools })`. Length is constant across
 * deployments — the drop gate changes how the tool is registered, never whether
 * it is present, so the manifest's tool count matches the documented surface.
 */
export function buildToolDefinitions(options: ToolDefinitionOptions) {
  return [
    companySearchTool,
    searchFilingsTool,
    getFilingTool,
    getFinancialsTool,
    getSnapshotTool,
    getMaterialEventsTool,
    getInsiderTransactionsTool,
    getInstitutionalHoldingsTool,
    findHoldersTool,
    getBeneficialOwnersTool,
    getFundHoldingsTool,
    fetchFramesTool,
    compareCompaniesTool,
    searchConceptsTool,
    dataframeDescribeTool,
    dataframeQueryTool,
    options.dropEnabled
      ? dataframeDropTool
      : disabledTool(dataframeDropTool, {
          reason:
            'Dropping dataframes is turned off in this deployment; the per-table TTL reclaims canvas tables on its own.',
          hint: 'EDGAR_DATAFRAME_DROP_ENABLED=true',
        }),
  ];
}
