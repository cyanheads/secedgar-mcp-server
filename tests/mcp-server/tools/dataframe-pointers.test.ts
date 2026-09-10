/**
 * @fileoverview Pins the describe-then-query pointer across the whole tool
 *   surface (#104). Every tool that stages a `df_<id>` handle has to name both
 *   dataframe tools, in that order, on the surfaces an agent reads before it
 *   ever calls anything: the tool `description` and the `dataset.name`
 *   `.describe()`. The two dataframe tools in turn describe the shape of what
 *   they hold rather than enumerating producers — the enumeration went stale
 *   once already (5 and 3 named against 11 real).
 * @module tests/mcp-server/tools/dataframe-pointers
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { companySearchTool } from '@/mcp-server/tools/definitions/company-search.tool.js';
import { compareCompaniesTool } from '@/mcp-server/tools/definitions/compare-companies.tool.js';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { fetchFramesTool } from '@/mcp-server/tools/definitions/fetch-frames.tool.js';
import { findHoldersTool } from '@/mcp-server/tools/definitions/find-holders.tool.js';
import { getBeneficialOwnersTool } from '@/mcp-server/tools/definitions/get-beneficial-owners.tool.js';
import { getFinancialsTool } from '@/mcp-server/tools/definitions/get-financials.tool.js';
import { getFundHoldingsTool } from '@/mcp-server/tools/definitions/get-fund-holdings.tool.js';
import { getInsiderTransactionsTool } from '@/mcp-server/tools/definitions/get-insider-transactions.tool.js';
import { getInstitutionalHoldingsTool } from '@/mcp-server/tools/definitions/get-institutional-holdings.tool.js';
import { getMaterialEventsTool } from '@/mcp-server/tools/definitions/get-material-events.tool.js';
import { searchFilingsTool } from '@/mcp-server/tools/definitions/search-filings.tool.js';
import { dataframeGuidance } from '@/services/canvas-bridge/canvas-bridge.js';

/** Every tool that calls `bridge.registerDataframe` and returns a `dataset` handle. */
const PRODUCERS = [
  companySearchTool,
  searchFilingsTool,
  getFinancialsTool,
  fetchFramesTool,
  compareCompaniesTool,
  getMaterialEventsTool,
  getInsiderTransactionsTool,
  getInstitutionalHoldingsTool,
  findHoldersTool,
  getBeneficialOwnersTool,
  getFundHoldingsTool,
] as const;

/** `.describe()` text of `dataset.name`, reached through the optional wrapper. */
function datasetNameDescription(output: z.ZodType): string {
  const shape = (output as unknown as { shape: Record<string, z.ZodType> }).shape;
  const dataset = shape.dataset as unknown as {
    description?: string;
    unwrap?: () => { shape: Record<string, { description?: string }> };
    shape?: Record<string, { description?: string }>;
  };
  const inner = dataset.unwrap ? dataset.unwrap() : (dataset as { shape: never });
  const name = (inner as { shape: Record<string, { description?: string }> }).shape.name;
  if (!name?.description) throw new Error('dataset.name carries no .describe() text.');
  return name.description;
}

/** Index of the first mention, or Infinity when the text never names it. */
function positionOf(text: string, needle: string): number {
  const at = text.indexOf(needle);
  return at === -1 ? Number.POSITIVE_INFINITY : at;
}

describe('staged dataframe pointers', () => {
  it('covers eleven producers', () => {
    expect(PRODUCERS).toHaveLength(11);
    expect(new Set(PRODUCERS.map((t) => t.name)).size).toBe(11);
  });

  describe.each(PRODUCERS.map((tool) => [tool.name, tool] as const))('%s', (_name, tool) => {
    it('names describe before query in the dataset.name field description', () => {
      const text = datasetNameDescription(tool.output);

      expect(text).toContain('secedgar_dataframe_describe');
      expect(text).toContain('secedgar_dataframe_query');
      expect(positionOf(text, 'secedgar_dataframe_describe')).toBeLessThan(
        positionOf(text, 'secedgar_dataframe_query'),
      );
    });

    it('names describe before query in the tool description', () => {
      const text = tool.description ?? '';

      expect(text).toContain('secedgar_dataframe_describe');
      expect(text).toContain('secedgar_dataframe_query');
      expect(positionOf(text, 'secedgar_dataframe_describe')).toBeLessThan(
        positionOf(text, 'secedgar_dataframe_query'),
      );
    });
  });

  describe('dataframe tool descriptions', () => {
    it('describe no longer enumerates producing tools', () => {
      const text = dataframeDescribeTool.description ?? '';

      // The enumeration went stale at five named tools against eleven real ones.
      expect(text).not.toContain('secedgar_fetch_frames');
      expect(text).not.toContain('secedgar_get_financials');
      expect(text).toContain('data-returning secedgar_* tools');
    });

    it('query no longer enumerates producing tools and points at describe first', () => {
      const text = dataframeQueryTool.description ?? '';

      expect(text).not.toContain('secedgar_search_filings');
      expect(text).not.toContain('secedgar_get_financials');
      expect(text).toContain('data-returning secedgar_* tools');
      expect(text).toContain('secedgar_dataframe_describe');
    });
  });

  describe('dataframeGuidance', () => {
    it('composes one describe-then-query sentence naming the handle and its size', () => {
      const text = dataframeGuidance({ name: 'df_ABCDE_12345', row_count: 4200 });

      expect(text).toContain('df_ABCDE_12345');
      expect(text).toContain('4200 rows');
      expect(positionOf(text, 'secedgar_dataframe_describe')).toBeLessThan(
        positionOf(text, 'secedgar_dataframe_query'),
      );
    });
  });
});
