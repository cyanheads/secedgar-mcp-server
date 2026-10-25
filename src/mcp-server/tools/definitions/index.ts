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
import type { LimitClampOptions } from '@/mcp-server/tools/limit-clamp.js';
import { createCompanySearchTool } from './company-search.tool.js';
import { createCompareCompaniesTool } from './compare-companies.tool.js';
import { dataframeDescribeTool } from './dataframe-describe.tool.js';
import { dataframeDropTool } from './dataframe-drop.tool.js';
import { createDataframeQueryTool } from './dataframe-query.tool.js';
import { createFetchFramesTool } from './fetch-frames.tool.js';
import { createFindHoldersTool } from './find-holders.tool.js';
import { createGetBeneficialOwnersTool } from './get-beneficial-owners.tool.js';
import { createGetFilingTool } from './get-filing.tool.js';
import { getFinancialsTool } from './get-financials.tool.js';
import { createGetFundHoldingsTool } from './get-fund-holdings.tool.js';
import { createGetInsiderTransactionsTool } from './get-insider-transactions.tool.js';
import { createGetInstitutionalHoldingsTool } from './get-institutional-holdings.tool.js';
import { createGetMaterialEventsTool } from './get-material-events.tool.js';
import { getSnapshotTool } from './get-snapshot.tool.js';
import { searchConceptsTool } from './search-concepts.tool.js';
import { createSearchFilingsTool } from './search-filings.tool.js';

/**
 * Deployment gates that decide how a tool enters the registration list.
 * `clampOversizedLimits` (`EDGAR_CLAMP_OVERSIZED_LIMITS`) picks each clamped
 * field's advertised maximum, so `tools/list` shows the bound in force (#197).
 */
export interface ToolDefinitionOptions extends LimitClampOptions {
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
    createCompanySearchTool(options),
    createSearchFilingsTool(options),
    createGetFilingTool(options),
    getFinancialsTool,
    getSnapshotTool,
    createGetMaterialEventsTool(options),
    createGetInsiderTransactionsTool(options),
    createGetInstitutionalHoldingsTool(options),
    createFindHoldersTool(options),
    createGetBeneficialOwnersTool(options),
    createGetFundHoldingsTool(options),
    createFetchFramesTool(options),
    createCompareCompaniesTool(options),
    searchConceptsTool,
    dataframeDescribeTool,
    createDataframeQueryTool(options),
    options.dropEnabled
      ? dataframeDropTool
      : disabledTool(dataframeDropTool, {
          reason:
            'Dropping dataframes is turned off in this deployment; the per-table TTL reclaims canvas tables on its own.',
          hint: 'EDGAR_DATAFRAME_DROP_ENABLED=true',
        }),
  ];
}
