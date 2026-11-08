/**
 * @fileoverview Describe the dataframes materialized by SEC EDGAR data-returning
 * tools, with provenance, TTL, and column schema. Reads from the canvas bridge,
 * which lazy-sweeps expired tables before responding. Over HTTP with auth
 * `none` every caller shares one canvas, so a call without `name` fails
 * `listing_unavailable` and a dataframe is described by its exact name only
 * (#242).
 * @module mcp-server/tools/definitions/dataframe-describe
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdown } from '@cyanheads/mcp-ts-core/utils';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

export const dataframeDescribeTool = tool('secedgar_dataframe_describe', {
  description:
    'Describe the dataframes (df_XXXXX_XXXXX) registered by the data-returning secedgar_* tools — any tool whose response carries a `dataset` handle stages its full result set here. Pass that handle as `name`; each entry surfaces source tool, query parameters, creation/expiry timestamps, row count, column schema, and whether the dataframe is truncated relative to the upstream source. Without `name` it lists every active dataframe, except over HTTP with auth none, where every caller shares one canvas and that listing is refused. Read the column schema here before writing SQL for secedgar_dataframe_query.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The DataCanvas service is not configured for this deployment',
      recovery:
        'Dataframes need the DuckDB canvas. On an npm or Docker install, set CANVAS_PROVIDER_TYPE=duckdb (the default when unset) and restart the server; the MCPB bundle ships without DuckDB, so there the data tools return their results inline and stage no dataframe.',
    },
    {
      reason: 'listing_unavailable',
      code: JsonRpcErrorCode.Forbidden,
      when: 'name is omitted or empty over HTTP with auth none, where every caller shares one canvas',
      recovery:
        'Pass the exact df_XXXXX_XXXXX name the producing tool returned in its `dataset` field, or the register_as name you chose; this deployment does not list dataframes.',
      severity: 'notice',
    },
  ],

  input: z.object({
    name: z
      .string()
      .optional()
      .describe(
        'Table name (df_XXXXX_XXXXX) to describe: the `dataset` name a data tool returned, or a register_as name. Omit it, or pass an empty string, to list every active dataframe; over HTTP with auth none that listing is refused.',
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
              .describe(
                'ISO 8601 expiry timestamp, fixed when the table is staged; queries do not extend it.',
              ),
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
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.');
    }

    // An empty name lists, as an omitted one does, so it is refused alike.
    const name = input.name || undefined;
    if (name === undefined && !bridge.listingEnabled) {
      throw ctx.fail(
        'listing_unavailable',
        'Listing dataframes is refused over HTTP with auth none: every caller of this deployment shares one canvas.',
        { ...ctx.recoveryFor('listing_unavailable') },
      );
    }

    const entries = await bridge.describe(ctx, name);
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
      /**
       * Each value is copy-back JSON, so it renders as a code span: outside code
       * a CommonMark client consumes the backslash of a quoted phrase's `\"`
       * (#221). A `register_as` table's columns are the caller's SQL aliases and
       * DuckDB types, so names and types render escaped.
       */
      const params = Object.entries(df.query_params)
        .map(([k, v]) => `${k}=${markdown().inlineCode(JSON.stringify(v)).build()}`)
        .join(', ');
      if (params) lines.push(`- Params: ${params}`);
      const cols = df.column_schema
        .map(
          (c) =>
            `${escapeMarkdownInline(c.name)}:${escapeMarkdownInline(c.type)} (nullable=${c.nullable})`,
        )
        .join(', ');
      lines.push(`- Columns: ${cols}`);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
