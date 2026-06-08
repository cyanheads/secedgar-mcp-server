/**
 * @fileoverview List the dataframes materialized by SEC EDGAR data-returning
 * tools, with provenance, TTL, and column schema. Reads from the canvas
 * bridge (which lazy-sweeps expired tables before responding).
 * @module mcp-server/tools/definitions/dataframe-describe
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

export const dataframeDescribeTool = tool('secedgar_dataframe_describe', {
  description:
    'List dataframes (df_XXXXX_XXXXX) materialized by secedgar_fetch_frames, secedgar_search_filings, secedgar_get_financials, secedgar_get_insider_transactions, and secedgar_get_institutional_holdings. Each entry surfaces source tool, query parameters, creation/expiry timestamps, row count, column schema, and whether the dataframe is truncated relative to the upstream source.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The DataCanvas service is not configured for this deployment',
      recovery: 'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable dataframes.',
    },
  ],

  input: z.object({
    name: z
      .string()
      .optional()
      .describe(
        'Optional table name (df_XXXXX_XXXXX) to describe a single dataframe. Omit to list all dataframes.',
      ),
  }),

  output: z.object({
    dataframes: z
      .array(
        z
          .object({
            name: z.string().describe('Canvas table name (df_XXXXX_XXXXX).'),
            source_tool: z.string().describe('Tool that produced this dataframe.'),
            query_params: z
              .record(z.string(), z.unknown())
              .describe('Input parameters the source tool was called with.'),
            created_at: z.string().describe('ISO 8601 creation timestamp.'),
            expires_at: z
              .string()
              .describe('ISO 8601 expiry timestamp. Sliding TTL touched on every dataframe op.'),
            row_count: z.number().describe('Rows materialized in the dataframe.'),
            truncated: z
              .boolean()
              .describe('True when the upstream source had more rows than were materialized.'),
            max_rows: z
              .number()
              .optional()
              .describe('Materialization cap that produced `truncated`, when applicable.'),
            column_schema: z
              .array(
                z
                  .object({
                    name: z.string().describe('Column name.'),
                    type: z.string().describe('Canvas column type (VARCHAR, BIGINT, DOUBLE, ...).'),
                    nullable: z.boolean().describe('Whether the column permits NULL.'),
                  })
                  .describe('One column declaration in the dataframe schema.'),
              )
              .describe('Resolved column schema (all SEC dataframe columns are nullable).'),
          })
          .describe('Provenance and schema for one dataframe.'),
      )
      .describe('Active dataframes for this tenant, newest first. Empty when none are registered.'),
  }),

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.', {
        ...ctx.recoveryFor('canvas_unavailable'),
      });
    }

    const entries = await bridge.describe(ctx, input.name);
    return {
      dataframes: entries.map((meta) => ({
        name: meta.tableName,
        source_tool: meta.sourceTool,
        query_params: meta.queryParams,
        created_at: meta.createdAt,
        expires_at: meta.expiresAt,
        row_count: meta.rowCount,
        truncated: meta.truncated,
        max_rows: meta.maxRows,
        column_schema: meta.columnSchema.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable ?? true,
        })),
      })),
    };
  },

  format: (result) => {
    if (result.dataframes.length === 0) {
      return [{ type: 'text', text: 'No active dataframes.' }];
    }
    const lines: string[] = [`**${result.dataframes.length} active dataframe(s):**\n`];
    for (const df of result.dataframes) {
      const truncated = df.truncated
        ? ` (truncated${df.max_rows ? ` at ${df.max_rows}` : ''})`
        : '';
      lines.push(`### ${df.name}`);
      lines.push(`- Source: ${df.source_tool}`);
      lines.push(`- Rows: ${df.row_count}${truncated}`);
      lines.push(`- Created: ${df.created_at} — Expires: ${df.expires_at}`);
      const params = Object.entries(df.query_params)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', ');
      if (params) lines.push(`- Params: ${params}`);
      const cols = df.column_schema
        .map((c) => `${c.name}:${c.type} (nullable=${c.nullable})`)
        .join(', ');
      lines.push(`- Columns: ${cols}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
