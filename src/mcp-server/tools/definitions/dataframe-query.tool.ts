/**
 * @fileoverview Run a single-statement SELECT against the canvas dataframes
 * registered by SEC EDGAR data-returning tools. Layered SQL gate: framework
 * (single-statement → SELECT only → plan-walk allowlist + denied table
 * functions + system-catalog denial via `denySystemCatalogs`) so callers
 * cannot enumerate every df_<id> on the shared canvas.
 * @module mcp-server/tools/definitions/dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

/**
 * Escape text for one Markdown table cell. Backslashes go first: a cell is
 * inline Markdown, where a backslash before ASCII punctuation is consumed as an
 * escape, so escaping only the pipe drops a literal backslash that precedes
 * punctuation from the rendered text (`x\|y` would render as `x|y`) (#114).
 * Line breaks become `<br>`: `\n`, `\r\n`, and a lone `\r` are each a CommonMark
 * line ending, which would end the table row mid-cell (#121). `\r\n` is matched
 * first so it yields one break, not two.
 */
function escapeTableCell(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, '<br>');
}

export const dataframeQueryTool = tool('secedgar_dataframe_query', {
  description:
    'Run a single-statement SELECT against the canvas dataframes registered by the data-returning secedgar_* tools — any tool whose response carries a `dataset` handle. Inspect a dataframe with secedgar_dataframe_describe first; its column schema is what the SQL has to match. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected. System catalogs (information_schema, pg_catalog, sqlite_master, duckdb_*) are denied — list dataframes via secedgar_dataframe_describe. Optional register_as chains the result as a new dataframe with a fresh TTL.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  // Agent-facing context — empty-result and row-cap notices populated via ctx.enrich
  // so they reach structuredContent and content[] automatically.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when the query returned no rows, or when the row cap withheld some.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the result set held more rows than the row cap allowed through.'),
    shown: z.number().optional().describe('Number of rows returned inline.'),
    cap: z
      .number()
      .optional()
      .describe(
        'The row cap that actually bound — `preview` when it is lower than `row_limit`, otherwise `row_limit`.',
      ),
  },

  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The DataCanvas service is not configured for this deployment',
      recovery: 'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment to enable dataframes.',
    },
    {
      reason: 'system_catalog_access',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL query references a denied DuckDB system catalog (information_schema, pg_catalog, sqlite_master, duckdb_*)',
      recovery:
        'Query only df_<id> tables. Use secedgar_dataframe_describe to list available dataframes.',
      thrownBy: 'service',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'The SQL query references a df_<id> table that does not exist or has expired',
      recovery:
        'Use secedgar_dataframe_describe to list available dataframes and verify the table name.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_sql',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SELECT fails to prepare — an unknown column or an invalid expression — or hits an engine error no more specific reason covers',
      recovery:
        'Check SQL syntax, column names, and table references against secedgar_dataframe_describe.',
      thrownBy: 'service',
    },
    {
      reason: 'sql_execution_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SELECT prepared but failed on the data it read — a cast or conversion that does not fit, an out-of-range value, or invalid input to a function',
      recovery:
        'Wrap the failing cast in TRY_CAST, or filter out the rows the error message names before converting them.',
      thrownBy: 'service',
    },
    {
      reason: 'register_as_clash',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The register_as target name already exists on the canvas',
      recovery:
        'Drop the existing dataframe with secedgar_dataframe_drop (when enabled), choose a different df_XXXXX_XXXXX name, or omit register_as.',
      thrownBy: 'service',
    },
    {
      reason: 'non_select_statement',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL is not a SELECT (DROP, INSERT, UPDATE, DDL, PRAGMA, EXPLAIN, etc.) or does not parse — only read-only SELECTs run against dataframes',
      recovery:
        'Query only SELECT statements against df_<id> tables. Use secedgar_dataframe_describe to inspect available dataframes.',
      thrownBy: 'service',
    },
    {
      reason: 'multi_statement',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL holds more than one statement',
      recovery:
        'Send exactly one SELECT statement per call, and split multi-statement SQL into separate calls.',
      thrownBy: 'service',
    },
    {
      reason: 'denied_function',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL calls a file-reading or external-data table function such as read_csv, read_parquet, or glob',
      recovery:
        'Remove the file-reading function and query only the df_<id> tables secedgar_dataframe_describe lists.',
      thrownBy: 'service',
    },
    {
      reason: 'plan_operator_not_allowed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The query plan uses an operator outside the read-only allowlist, such as the range() or generate_series() table functions',
      recovery:
        'Rewrite with read-only SELECT constructs — joins, aggregates, window functions, CTEs, and unnest() are supported.',
      thrownBy: 'service',
    },
  ],

  input: z.object({
    sql: z
      .string()
      .min(1)
      .describe(
        'Single-statement SELECT against df_<id> tables on the shared canvas. Standard DuckDB SQL — joins, aggregates, window functions, CTEs all supported. Reference dataframes by the names returned in fetch/search responses or listed by secedgar_dataframe_describe. BIGINT columns (e.g., XBRL `value`, COUNT/SUM results) serialize as JSON strings to preserve precision past 2^53 — CAST(col AS DOUBLE) in projections for inline arithmetic.',
      ),
    register_as: z
      .string()
      .regex(
        /^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/,
        'register_as must match df_XXXXX_XXXXX (uppercase letters and digits, exactly 5 characters each segment).',
      )
      .optional()
      .describe(
        'When set, persist the result as a new dataframe under this name (must match df_XXXXX_XXXXX shape, or pass a fresh df_<id> generated by the agent). Fresh TTL window — not inherited from the parents in the SELECT. Use to chain analyses without re-running the source SQL.',
      ),
    preview: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional()
      .describe(
        'Rows to include in the immediate response. Defaults to the row limit. Set lower (e.g., 50) when chaining via register_as and only a sample is needed inline.',
      ),
    row_limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(1000)
      .describe(
        'Hard cap on rows materialized in the response. Default 1000, max 10000. A query matching more rows than this stops at the cap and `row_count_capped` comes back true; the full result lives on-canvas under register_as when provided, so do not raise this to keep large results. One case is not detectable: a SQL LIMIT exactly equal to this cap reads identically to a result that genuinely holds that many rows, and is reported as exact.',
      ),
  }),

  output: z.object({
    columns: z.array(z.string()).describe('Column names in projection order.'),
    row_count: z
      .number()
      .describe(
        'Rows the query produced, up to `row_limit` (exceeds `rows.length` when `preview` returned fewer). Read it with `row_count_capped`: when that is true this number is the `row_limit` cap itself, and the size of the full result is not in this response.',
      ),
    row_count_capped: z
      .boolean()
      .describe(
        'True when the query matched more rows than `row_limit`, so `row_count` is that cap rather than a total. False means `row_count` is exact — including when it happens to equal `row_limit`.',
      ),
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Materialized rows, bounded by `preview` / `row_limit`.'),
    registered_as: z
      .string()
      .optional()
      .describe('Set when `register_as` was supplied and the new dataframe was materialized.'),
    expires_at: z
      .string()
      .optional()
      .describe('ISO 8601 expiry timestamp for the newly registered dataframe, when applicable.'),
  }),

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.', {
        ...ctx.recoveryFor('canvas_unavailable'),
      });
    }

    const { result, meta } = await bridge.query(ctx, input.sql, {
      ...(input.register_as !== undefined && { registerAs: input.register_as }),
      ...(input.preview !== undefined && { preview: input.preview }),
      rowLimit: input.row_limit,
      sourceTool: 'secedgar_dataframe_query',
      queryParams: { sql: input.sql },
    });

    ctx.log.info('Dataframe query executed', {
      rowCount: result.rowCount,
      returned: result.rows.length,
      registeredAs: meta?.tableName,
    });

    // `preview` and `row_limit` are independent ceilings; report the one that
    // actually bound, so `cap` names a number the caller can act on and the
    // guidance points at the lever that will widen the window.
    const preview = input.preview;
    const previewBinds = preview !== undefined && preview < input.row_limit;
    const lever = previewBinds ? 'raise preview' : 'raise row_limit (max 10000)';

    if (result.rowCount === 0) {
      ctx.enrich.notice(
        'Query returned 0 rows. Verify dataframe names (use secedgar_dataframe_describe) and check your WHERE conditions.',
      );
    } else if (result.truncated === true) {
      /**
       * `row_limit` is pushed into the query as the provider's own cap, so the
       * query stops at it and `rowCount` equals `rows.length` — the row
       * arithmetic below cannot see the withheld rows. The provider reads one
       * row past the cap and reports `truncated`, which is the only signal
       * separating a capped result from a table holding exactly `row_limit`
       * rows (#109). `rowCount` is that cap here, never a total, so the
       * guidance names the ceiling instead of claiming a size.
       */
      ctx.enrich.truncated({
        shown: result.rows.length,
        cap: previewBinds ? preview : input.row_limit,
        guidance:
          `Showing ${result.rows.length} rows. The query matched more than row_limit (${input.row_limit}), so row_count is that cap and the full size is not in this response. ` +
          `Use register_as to materialize the whole result — its row_count is then exact — or ${lever}` +
          (previewBinds ? `, and raise row_limit (max 10000) to fetch past the query cap.` : '.'),
      });
    } else if (result.rowCount > result.rows.length) {
      /**
       * `preview` slices after the query runs, and the `registerAs` path counts
       * the materialized table with COUNT(*), so `rowCount` is exact on both —
       * the "of M" wording is correct here and only here.
       */
      ctx.enrich.truncated({
        shown: result.rows.length,
        cap: previewBinds ? preview : input.row_limit,
        guidance: `Showing ${result.rows.length} of ${result.rowCount} rows (capped). Use register_as to persist the full result, or ${lever}.`,
      });
    }

    return {
      columns: result.columns,
      row_count: result.rowCount,
      row_count_capped: result.truncated === true,
      rows: result.rows,
      registered_as: meta?.tableName,
      expires_at: meta?.expiresAt,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.registered_as) {
      lines.push(
        `Registered as ${result.registered_as} (expires ${result.expires_at ?? 'unknown'}).`,
      );
    }
    /**
     * A bare row count reads as the size of the result. When `row_limit` capped
     * the query it is the cap instead, and the header has to say so — this line
     * is the whole disclosure for clients that forward only `content[]` (#109).
     */
    const shownNote =
      result.rows.length < result.row_count ? `, showing ${result.rows.length}` : '';
    const cappedNote = result.row_count_capped
      ? ` — capped at row_limit${shownNote}; more rows matched`
      : shownNote
        ? ` (showing ${result.rows.length} of ${result.row_count})`
        : '';
    lines.push(`**${result.row_count} ${result.row_count === 1 ? 'row' : 'rows'}**${cappedNote}\n`);

    if (result.rows.length === 0) {
      lines.push('_No rows._');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    const header = `| ${result.columns.map(escapeTableCell).join(' | ')} |`;
    const sep = `| ${result.columns.map(() => '---').join(' | ')} |`;
    lines.push(header, sep);
    for (const row of result.rows) {
      const cells = result.columns.map((c) => {
        const v = row[c];
        if (v === null || v === undefined) return '';
        if (typeof v === 'string') return escapeTableCell(v);
        if (typeof v === 'object') return escapeTableCell(JSON.stringify(v));
        return String(v);
      });
      lines.push(`| ${cells.join(' | ')} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
