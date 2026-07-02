/**
 * @fileoverview Adapter between the SEC EDGAR tools and the framework
 * DataCanvas primitive. Holds one shared canvas per tenant, generates
 * `df_XXXXX_XXXXX` table names, tracks per-table TTL + provenance in
 * `ctx.state`, and lazy-sweeps expired metadata on every public op. The
 * framework handles DuckDB-level TTL via `RegisterTableOptions.ttlMs`;
 * system-catalog access is denied via `QueryOptions.denySystemCatalogs`.
 * Best-effort: failed canvas operations log a warning and return
 * `undefined`/empty so the caller's inline response remains useful.
 * @module services/canvas-bridge/canvas-bridge
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  type CanvasInstance,
  type ColumnSchema,
  type DataCanvas,
  inferSchemaFromRows,
  type QueryResult,
} from '@cyanheads/mcp-ts-core/canvas';
import { McpError, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { idGenerator } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { isSelectShaped, stripStringLiterals } from './sql-gate-extras.js';

/** Per-table provenance + TTL metadata persisted in `ctx.state`. */
export interface DataframeMeta {
  /** Resolved column schema (all-nullable). */
  columnSchema: ColumnSchema[];
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 expiry timestamp. Lazy-checked on every dataframe op. */
  expiresAt: string;
  /** Materialization cap that produced `truncated`, when applicable. */
  maxRows: number | undefined;
  /** Input parameters the tool was called with, for downstream interpretation. */
  queryParams: Record<string, unknown>;
  /** Materialized row count. */
  rowCount: number;
  /** Tool that produced this dataframe (e.g. `secedgar_fetch_frames`). */
  sourceTool: string;
  /** Canvas table name (`df_XXXXX_XXXXX`). */
  tableName: string;
  /**
   * True when the upstream source has more rows than were materialized
   * (e.g. EFTS 10k cap exceeded). False when the dataframe holds the full
   * upstream result.
   */
  truncated: boolean;
}

/** Result of a successful `registerDataframe` call. */
export interface RegisterDataframeResult {
  columnSchema: ColumnSchema[];
  expiresAt: string;
  rowCount: number;
  tableName: string;
}

/**
 * Wire shape for the `dataset` field on tool outputs. Callers spread
 * additional fields (e.g. `truncated`) when applicable.
 */
export function toDatasetField(registered: RegisterDataframeResult): {
  name: string;
  row_count: number;
  expires_at: string;
} {
  return {
    name: registered.tableName,
    row_count: registered.rowCount,
    expires_at: registered.expiresAt,
  };
}

/** Options accepted by {@link CanvasBridge.registerDataframe}. */
export interface RegisterDataframeOptions {
  maxRows?: number;
  queryParams: Record<string, unknown>;
  rows: Record<string, unknown>[];
  sourceTool: string;
  truncated?: boolean;
}

/** Options accepted by {@link CanvasBridge.query}. */
export interface BridgeQueryOptions {
  /** Inline row preview cap. */
  preview?: number;
  /** Query params to record as provenance if registerAs is set. */
  queryParams?: Record<string, unknown>;
  /** Optional new dataframe name to materialize the result under. */
  registerAs?: string;
  /** Hard cap on rows materialized in the response (default 10_000). */
  rowLimit?: number;
  /** Tool name to record as source if registerAs is set. */
  sourceTool?: string;
}

const META_PREFIX = 'df-meta/';

/** Recovery hint for a `register_as` name that collides with an existing dataframe (#60). */
const REGISTER_AS_CLASH_HINT =
  'Drop the existing dataframe with secedgar_dataframe_drop (when enabled), choose a different df_XXXXX_XXXXX name, or omit register_as.';
const CANVAS_ID_KEY = 'canvas-id';

/** Token character set for `df_XXXXX_XXXXX` table names. */
const TABLE_NAME_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export class CanvasBridge {
  constructor(private readonly canvas: DataCanvas) {}

  /**
   * Persist a row set as `df_<id>` on the tenant's shared canvas. Returns
   * `undefined` on any canvas failure so callers can surface their inline
   * response without leaking infrastructure errors.
   */
  async registerDataframe(
    ctx: Context,
    options: RegisterDataframeOptions,
  ): Promise<RegisterDataframeResult | undefined> {
    if (options.rows.length === 0) {
      ctx.log.debug('Skipping dataframe registration — no rows', {
        sourceTool: options.sourceTool,
      });
      return;
    }

    try {
      await this.sweepExpired(ctx);
      const instance = await this.acquireSharedCanvas(ctx);
      const tableName = this.mintTableName();
      // inferSchemaFromRows always emits nullable: true since mcp-ts-core 0.10.4,
      // so the explicit force-nullable pass is no longer needed.
      const schema = inferSchemaFromRows(options.rows);

      const now = Date.now();
      const ttlMs = getServerConfig().datasetTtlSeconds * 1000;
      // Pass ttlMs to the framework so it manages DuckDB-level TTL natively.
      const result = await instance.registerTable(tableName, options.rows, { schema, ttlMs });

      const meta: DataframeMeta = {
        tableName: result.tableName,
        sourceTool: options.sourceTool,
        queryParams: options.queryParams,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        rowCount: result.rowCount,
        truncated: options.truncated ?? false,
        maxRows: options.maxRows,
        columnSchema: schema,
      };
      await ctx.state.set(`${META_PREFIX}${result.tableName}`, meta);

      ctx.log.info('Dataframe registered', {
        tableName: result.tableName,
        rowCount: result.rowCount,
        sourceTool: options.sourceTool,
      });

      return {
        tableName: result.tableName,
        rowCount: result.rowCount,
        expiresAt: meta.expiresAt,
        columnSchema: schema,
      };
    } catch (error) {
      ctx.log.warning('Dataframe registration failed', {
        error: error instanceof Error ? error.message : String(error),
        sourceTool: options.sourceTool,
      });
      return;
    }
  }

  /**
   * List dataframes with provenance. Sweeps expired tables first so the
   * listing reflects what's actually queryable.
   */
  async describe(ctx: Context, tableName?: string): Promise<DataframeMeta[]> {
    await this.sweepExpired(ctx);
    if (tableName) {
      const meta = await ctx.state.get<DataframeMeta>(`${META_PREFIX}${tableName}`);
      return meta ? [meta] : [];
    }
    const entries: DataframeMeta[] = [];
    for await (const { meta } of this.iterateMeta(ctx)) entries.push(meta);
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Run a SELECT against the shared canvas. Framework gate runs inside
   * `canvas.query`; this method additionally rejects system-catalog access
   * before handing the SQL off. Optional `registerAs` chains the result as a
   * new dataframe with a fresh per-table TTL (not inherited from parents).
   *
   * A pre-check surfaces a structured `missing_table` for an unregistered or
   * TTL-expired `df_<id>` before the framework gate's generic rejection. Any raw
   * DuckDB execution error that escapes the gate is re-thrown as a structured
   * `invalid_sql`; framework errors matching a declared tool-contract reason
   * (`missing_table`, `register_as_clash`, `system_catalog_access`) are rebuilt
   * with the contract recovery hint (#47, #54, #60); other structured McpErrors
   * propagate as-is.
   */
  async query(
    ctx: Context,
    sql: string,
    options: BridgeQueryOptions = {},
  ): Promise<{ result: QueryResult; meta?: DataframeMeta }> {
    await this.sweepExpired(ctx);
    await this.assertReferencedDataframesExist(ctx, sql);
    const instance = await this.acquireSharedCanvas(ctx);

    const registerAs = options.registerAs;
    // (#60) Reject a clashing register_as target against tracked dataframes before
    // the provider runs: the framework's own clash rejection is reclassified to a
    // bare databaseError in DuckdbProvider's catch (classifyDuckdbError has no
    // McpError rethrow guard), stripping reason/recovery before it reaches the
    // rewrap below. The rewrap stays as the fallback for untracked tables once the
    // framework-side fix lands. sweepExpired above already cleared expired metas,
    // so an expired name never false-clashes.
    if (registerAs) {
      const clash = await ctx.state.get<DataframeMeta>(`${META_PREFIX}${registerAs}`);
      if (clash) {
        throw validationError(
          `Canvas table "${registerAs}" already exists — register_as requires an unused name.`,
          {
            reason: 'register_as_clash',
            tableName: registerAs,
            recovery: { hint: REGISTER_AS_CLASH_HINT },
          },
        );
      }
    }
    const ttlMs = getServerConfig().datasetTtlSeconds * 1000;
    let result: QueryResult;
    try {
      result = await instance.query(sql, {
        ...(options.preview !== undefined && { preview: options.preview }),
        ...(options.rowLimit !== undefined && { rowLimit: options.rowLimit }),
        ...(registerAs !== undefined && { registerAs, ttlMs }),
        denySystemCatalogs: true,
        signal: ctx.signal,
      });
    } catch (err) {
      if (err instanceof McpError) {
        const data = err.data as Record<string, unknown> | undefined;
        // (#54) The framework gate's missing_table message and hint name internal SDK
        // methods ("registerTable()", "describe()"). Rebuild both with agent-facing
        // tool guidance so clients see consistent recovery text regardless of which
        // code path rejected.
        if (data?.reason === 'missing_table') {
          const tableName = data.tableName;
          const subject =
            typeof tableName === 'string' ? `Canvas table "${tableName}"` : 'Canvas table';
          throw notFound(
            `${subject} does not exist — it may have expired or was never registered.`,
            {
              reason: 'missing_table',
              ...(tableName !== undefined && { tableName }),
              recovery: {
                hint: 'Use secedgar_dataframe_describe to list available dataframes and verify the table name.',
              },
            },
          );
        }
        // (#52) The framework gate prepares every statement. When a SELECT has an
        // unknown column, DuckDB's binder throws before it can determine the statement
        // type, so the gate assigns statementType: 'UNKNOWN' and reason:
        // 'non_select_statement'. Guard on UNKNOWN (a genuine non-SELECT that prepares
        // successfully carries its real statementType, e.g. 'INSERT') and re-check the
        // SQL text — if it starts with SELECT or WITH it was a column/expression error,
        // not a non-SELECT. The framework discards the binder detail, so we cannot name
        // the offending column; point to dataframe_describe instead.
        if (
          data?.reason === 'non_select_statement' &&
          data?.statementType === 'UNKNOWN' &&
          isSelectShaped(sql)
        ) {
          throw validationError(
            'The query is SELECT-shaped but failed to prepare — most likely an unknown column name or invalid expression. Use secedgar_dataframe_describe to check column names.',
            {
              reason: 'invalid_sql',
              recovery: {
                hint: 'Use secedgar_dataframe_describe to check column names and verify the query.',
              },
            },
          );
        }
        // (#60) Contract recovery hints only attach via ctx.fail/ctx.recoveryFor, so
        // framework-origin errors reach clients without the declared guidance. Rebuild
        // both remaining declared reasons with their contract recovery text, mirroring
        // the missing_table treatment above.
        if (data?.reason === 'register_as_clash') {
          const tableName = data.tableName;
          const subject =
            typeof tableName === 'string'
              ? `Canvas table "${tableName}"`
              : 'The register_as target';
          throw validationError(
            `${subject} already exists — register_as requires an unused name.`,
            {
              reason: 'register_as_clash',
              ...(tableName !== undefined && { tableName }),
              recovery: { hint: REGISTER_AS_CLASH_HINT },
            },
          );
        }
        if (data?.reason === 'system_catalog_access') {
          throw validationError(err.message, {
            ...data,
            recovery: {
              hint: 'Query only df_<id> tables. Use secedgar_dataframe_describe to list available dataframes.',
            },
          });
        }
        // All other structured McpErrors (genuine non-SELECT statements, etc.)
        // propagate as-is.
        throw err;
      }
      // Any unclassified raw DuckDB execution error that escaped the framework's
      // prepare gate → structured invalid_sql. Missing tables are handled by the
      // pre-check above (the gate rejects an unbindable statement first).
      const msg = err instanceof Error ? err.message : String(err);
      throw validationError(msg, {
        reason: 'invalid_sql',
        recovery: {
          hint: 'Check the SQL statement for syntax errors and verify column and table names.',
        },
      });
    }

    let meta: DataframeMeta | undefined;
    if (registerAs && result.tableName) {
      const tableName = result.tableName;
      const now = Date.now();
      // Read the registered table's real DuckDB column types so dataframe_describe
      // reports them accurately (#28). Row inference can't be used here: DuckDB
      // serializes BIGINT as strings in query results (would mistype as VARCHAR),
      // and a zero-row result has nothing to sniff. describe() is authoritative
      // for both. Framework always emits nullable: true on inferred columns since 0.10.4.
      //
      // WORKAROUND (#53): instance.describe({ tableName }) triggers a DuckDB binder
      // error — "Ambiguous reference to column name 'table_name'" — because the
      // framework's describe() pushes an unqualified table_name filter into a WHERE
      // clause where a LEFT JOIN to duckdb_tables() is in scope. Use the unfiltered
      // describe() and find the entry by name instead. Revert to describe({ tableName })
      // when the framework qualifies the filter (t.table_name).
      const allTables = await instance.describe();
      const info = allTables.find((t) => t.name === tableName);
      const columnSchema: ColumnSchema[] =
        info?.columns ?? result.columns.map((name) => ({ name, type: 'VARCHAR' as const }));
      meta = {
        tableName,
        sourceTool: options.sourceTool ?? 'secedgar_dataframe_query',
        queryParams: options.queryParams ?? { sql },
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        rowCount: result.rowCount,
        truncated: false,
        maxRows: undefined,
        columnSchema,
      };
      await ctx.state.set(`${META_PREFIX}${tableName}`, meta);
    }

    return meta ? { result, meta } : { result };
  }

  /**
   * Surface a helpful, structured `missing_table` for a referenced `df_<id>`
   * handle that isn't registered — mistyped, or TTL-expired since it was minted.
   * Runs before the framework SQL gate, which otherwise rejects an unbindable
   * table with a generic "could not be prepared" `non_select_statement` (the gate
   * prepares every statement, so a missing table fails there first). Only the
   * minted-handle pattern `df_<5>_<5>` is checked; string literals are stripped so
   * a quoted handle never false-triggers, and other identifiers fall through to
   * the gate (#47).
   */
  private async assertReferencedDataframesExist(ctx: Context, sql: string): Promise<void> {
    const referenced = stripStringLiterals(sql).match(/\bdf_[A-Z0-9]{5}_[A-Z0-9]{5}\b/g);
    if (!referenced) return;
    for (const name of new Set(referenced)) {
      if ((await ctx.state.get(`${META_PREFIX}${name}`)) === null) {
        throw notFound(`Dataframe '${name}' does not exist or has expired.`, {
          reason: 'missing_table',
          recovery: {
            hint: 'Use secedgar_dataframe_describe to list available dataframes, then reference one of those names.',
          },
        });
      }
    }
  }

  /**
   * Idempotent drop. Removes the table from the canvas and the metadata
   * entry from `ctx.state`. Returns true when the table was found and
   * removed; false when neither side had it.
   */
  async drop(ctx: Context, tableName: string): Promise<boolean> {
    await this.sweepExpired(ctx);
    const metaKey = `${META_PREFIX}${tableName}`;
    const hadMeta = (await ctx.state.get(metaKey)) !== null;
    await ctx.state.delete(metaKey);

    try {
      const instance = await this.acquireSharedCanvas(ctx);
      const dropped = await instance.drop(tableName);
      return dropped || hadMeta;
    } catch (error) {
      ctx.log.warning('Canvas drop failed', {
        tableName,
        error: error instanceof Error ? error.message : String(error),
      });
      return hadMeta;
    }
  }

  /**
   * Iterate provenance entries, drop tables whose `expiresAt` is in the
   * past. Best-effort: a failure to drop one table does not stop the sweep
   * for others.
   */
  private async sweepExpired(ctx: Context): Promise<void> {
    const nowIso = new Date().toISOString();
    let instance: CanvasInstance | undefined;
    for await (const { key, meta } of this.iterateMeta(ctx)) {
      if (meta.expiresAt > nowIso) continue;

      instance ??= await this.acquireSharedCanvas(ctx).catch(() => undefined);
      if (instance) {
        try {
          await instance.drop(meta.tableName);
        } catch (error) {
          ctx.log.warning('TTL sweep drop failed', {
            tableName: meta.tableName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await ctx.state.delete(key);
      ctx.log.debug('Expired dataframe swept', {
        tableName: meta.tableName,
        expiredAt: meta.expiresAt,
      });
    }
  }

  /**
   * Cursor-paged scan of metadata entries. Yields `{ key, meta }` per
   * registered dataframe; consumers either collect or act + delete in-place.
   */
  private async *iterateMeta(ctx: Context): AsyncGenerator<{ key: string; meta: DataframeMeta }> {
    let cursor: string | undefined;
    do {
      const page = await ctx.state.list(META_PREFIX, {
        ...(cursor !== undefined && { cursor }),
        limit: 100,
      });
      for (const item of page.items) {
        if (item.value) yield { key: item.key, meta: item.value as DataframeMeta };
      }
      cursor = page.cursor;
    } while (cursor);
  }

  /**
   * Acquire the tenant's shared canvas. Reuse the stored canvas ID when one
   * is still live; mint a fresh canvas when the stored ID is unknown or
   * expired (registry returns NotFound; `acquire(undefined)` mints a new one).
   */
  private async acquireSharedCanvas(ctx: Context): Promise<CanvasInstance> {
    const stored = await ctx.state.get<string>(CANVAS_ID_KEY);
    if (stored) {
      try {
        return await this.canvas.acquire(stored, ctx);
      } catch {
        await ctx.state.delete(CANVAS_ID_KEY);
      }
    }
    const instance = await this.canvas.acquire(undefined, ctx);
    await ctx.state.set(CANVAS_ID_KEY, instance.canvasId);
    return instance;
  }

  /** Mint a `df_XXXXX_XXXXX` table name (14 chars, ~3.7×10^15 keyspace). */
  private mintTableName(): string {
    const left = idGenerator.generateRandomString(5, TABLE_NAME_CHARSET);
    const right = idGenerator.generateRandomString(5, TABLE_NAME_CHARSET);
    return `df_${left}_${right}`;
  }
}

let _bridge: CanvasBridge | undefined;

/**
 * Wire the canvas bridge during `setup()`. `canvas` is `undefined` when the
 * framework didn't construct a DataCanvas (`CANVAS_PROVIDER_TYPE=none`,
 * default, or Workers). Tools that materialize dataframes call
 * {@link getCanvasBridge} and skip materialization when the bridge is absent.
 */
export function initCanvasBridge(canvas: DataCanvas | undefined): void {
  _bridge = canvas ? new CanvasBridge(canvas) : undefined;
}

/** Return the canvas bridge, or `undefined` when canvas is unavailable. */
export function getCanvasBridge(): CanvasBridge | undefined {
  return _bridge;
}
