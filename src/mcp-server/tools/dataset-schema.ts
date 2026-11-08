/**
 * @fileoverview The `dataset` output object the eleven dataframe-producing tools share: the
 * handle of the staged `df_<id>` table, its row count, and its expiry. A tool that also
 * reports truncation extends it with its own `truncated` field.
 * @module mcp-server/tools/dataset-schema
 */

import { z } from '@cyanheads/mcp-ts-core';

/** The `dataset` object's shared fields. */
export const datasetSchema = z.object({
  name: z
    .string()
    .describe('Dataframe handle for secedgar_dataframe_describe, then secedgar_dataframe_query.'),
  row_count: z.number().describe('Rows materialized in the dataframe.'),
  expires_at: z.string().describe('ISO 8601 expiry timestamp.'),
});
