/**
 * @fileoverview Drop a canvas dataframe by name. Idempotent — removes the
 * canvas table and the bridge-side provenance entry; returns whether anything
 * was found and removed.
 * @module mcp-server/tools/definitions/dataframe-drop
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

export const dataframeDropTool = tool('secedgar_dataframe_drop', {
  description:
    'Drop a canvas dataframe by name. Idempotent — returns dropped=false when nothing matched. Use to free canvas resources ahead of the per-table TTL when an analysis is complete.',
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The DataCanvas service is not configured for this deployment',
      recovery: 'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable dataframes.',
    },
  ],

  input: z.object({
    name: z.string().min(1).describe('Canvas table name (df_XXXXX_XXXXX) to drop.'),
  }),

  output: z.object({
    name: z.string().describe('Name that was requested for drop.'),
    dropped: z
      .boolean()
      .describe('True when the dataframe existed and was removed; false when nothing matched.'),
  }),

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.', {
        ...ctx.recoveryFor('canvas_unavailable'),
      });
    }
    const dropped = await bridge.drop(ctx, input.name);
    ctx.log.info('Dataframe drop requested', { name: input.name, dropped });
    return { name: input.name, dropped };
  },

  format: (result) => [
    {
      type: 'text',
      text: result.dropped ? `Dropped ${result.name}.` : `${result.name} not found.`,
    },
  ],
});
