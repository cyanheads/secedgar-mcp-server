/**
 * @fileoverview Adapter between the SEC EDGAR tools and the framework
 * DataCanvas primitive. Reaches the tenant's one shared canvas through
 * `DataCanvas.acquireShared`, which keeps its id in `ctx.state`, mints it once
 * under concurrent first calls, and purges the `df-meta/` records of a canvas
 * that died before minting the next (#241). Generates `df_XXXXX_XXXXX` table
 * names, tracks per-table TTL + provenance in `ctx.state`, and lazy-sweeps
 * expired metadata on every public op. The framework handles DuckDB-level TTL
 * via `RegisterTableOptions.ttlMs`; system-catalog access is denied via
 * `QueryOptions.denySystemCatalogs`. Registration is best-effort: a failed
 * canvas operation logs a warning and returns `undefined` so the producing
 * tool's inline response remains useful.
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
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { McpError, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { idGenerator } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { stripStringLiterals } from './sql-gate-extras.js';

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

/**
 * Describe-then-query pointer for a staged `df_<id>` handle. Composed here so
 * every producer names both dataframe tools in the same order and the wording
 * cannot drift site to site (#104).
 *
 * Emit it only on the branch that actually registered a dataframe:
 * {@link CanvasBridge.registerDataframe} returns `undefined` when the canvas is
 * off, registration failed, or the row set was empty, and this text promises a
 * table the caller can query. `ctx.enrich.notice` is last-wins across
 * `notice`/`truncated`, so a call site where both can fire composes one string
 * rather than emitting two. A `truncated` dataset holds only the rows fetched, and
 * the pointer says so rather than calling the table the full set (#162).
 */
export function dataframeGuidance(dataset: {
  name: string;
  row_count: number;
  truncated?: boolean;
}): string {
  const staged = dataset.truncated
    ? `The rows fetched are staged as ${dataset.name} (${dataset.row_count} rows), not the full set`
    : `Full set staged as ${dataset.name} (${dataset.row_count} rows)`;
  return `${staged} — use secedgar_dataframe_describe to inspect its columns, then secedgar_dataframe_query to analyze it with SQL.`;
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

/** Options accepted by {@link CanvasBridge}; {@link initCanvasBridge} derives them from the transport. */
export interface CanvasBridgeOptions {
  /**
   * Whether `secedgar_dataframe_describe` may list every dataframe. Off over
   * HTTP with auth `none`, where every caller resolves to one tenant and so
   * shares one canvas; a dataframe is then described by its name only (#242).
   */
  listingEnabled: boolean;
}

const META_PREFIX = 'df-meta/';

/**
 * The one shape a dataframe name takes: what {@link CanvasBridge} mints and what
 * `register_as` accepts. A name of any other shape names no dataframe, so it is
 * answered as unknown without a `ctx.state` read, whose key rules would
 * otherwise reject it with a reason-less storage error.
 */
export const DATAFRAME_NAME_RE = /^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/;
/** Recovery hint for a `register_as` name that collides with an existing dataframe (#60). */
export const REGISTER_AS_CLASH_HINT =
  'Drop the existing dataframe with secedgar_dataframe_drop (when enabled), choose a different df_XXXXX_XXXXX name, or omit register_as.';

/**
 * Recovery hint for a `df_<id>` the canvas does not hold (#47, #54). It points at
 * the name the producing tool returned and says where listing is refused, so it
 * reads true in both deployment shapes (#242).
 */
export const MISSING_TABLE_HINT =
  'Reference the df_<id> name the producing tool returned in its `dataset` field, or a register_as name, and re-run that tool if the table expired. secedgar_dataframe_describe without a name lists the active dataframes, except over HTTP with auth none, where that listing is refused.';

/** Recovery hint for SQL that names a DuckDB system catalog or metadata view, as a table or as an alias. */
export const SYSTEM_CATALOG_HINT =
  'Query only the df_<id> tables, by the name the producing tool returned in its `dataset` field; a column alias, table alias, or CTE named like a DuckDB metadata view (the name the message gives) is refused too, so rename it.';

/** Recovery hint for SQL that names a file as a table, or otherwise asks the engine to read or write outside the canvas. */
export const SQL_READ_ONLY_HINT =
  'Query only the df_<id> tables, by the name the producing tool returned in its `dataset` field, referenced by bare name; this surface reads no files and cannot create, alter, or drop anything.';

/** Token character set for `df_XXXXX_XXXXX` table names. */
const TABLE_NAME_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export class CanvasBridge {
  constructor(
    private readonly canvas: DataCanvas,
    private readonly options: CanvasBridgeOptions,
  ) {}

  /** Whether a describe without a name may list every dataframe (#242). */
  get listingEnabled(): boolean {
    return this.options.listingEnabled;
  }

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
      const instance = await this.canvasFor(ctx, true);
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
   * The named dataframe's provenance, or every dataframe's when `tableName` is
   * omitted. Resolves the live canvas first, without minting one, so the records
   * of a canvas that died are purged before any is read; then sweeps expired
   * tables, so what is returned is what a query can reach. A name not shaped
   * like a dataframe name returns nothing, reading no state.
   */
  async describe(ctx: Context, tableName?: string): Promise<DataframeMeta[]> {
    if (tableName !== undefined && !DATAFRAME_NAME_RE.test(tableName)) return [];
    await this.canvasFor(ctx, false);
    await this.sweepExpired(ctx);
    if (tableName !== undefined) {
      const meta = await ctx.state.get<DataframeMeta>(`${META_PREFIX}${tableName}`);
      return meta ? [meta] : [];
    }
    const entries: DataframeMeta[] = [];
    for await (const { meta } of this.iterateMeta(ctx)) entries.push(meta);
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Run a SELECT against the shared canvas, minting it when none is live. The
   * framework's read-only gate runs inside `instance.query`, with
   * `denySystemCatalogs` set. Optional `registerAs` chains the result as a new
   * dataframe with a fresh per-table TTL (not inherited from parents).
   *
   * A pre-check answers an unregistered or TTL-expired `df_<id>` as
   * `missing_table` from the records alone, before the canvas is acquired. Any
   * raw DuckDB execution error that escapes the gate is re-thrown as a structured
   * `invalid_sql`. The framework's `missing_table`, `register_as_clash`, and
   * `system_catalog_access` are rebuilt with this server's recovery hints (#47,
   * #54, #60), as is `sql_read_only`, whose engine hint points at a listing
   * (#242), and its `non_select_statement` without the `statementType` it
   * carries; other structured McpErrors propagate as-is — the framework's
   * `sql_execution_error` (a SELECT that prepared and then failed on the data),
   * `invalid_sql`, `multi_statement`, `denied_function`, and
   * `plan_operator_not_allowed`, each with its own recovery hint.
   */
  async query(
    ctx: Context,
    sql: string,
    options: BridgeQueryOptions = {},
  ): Promise<{ result: QueryResult; meta?: DataframeMeta }> {
    await this.sweepExpired(ctx);
    await this.assertReferencedDataframesExist(ctx, sql);
    const instance = await this.canvasFor(ctx, true);

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
        // (#54) The framework's missing_table hint points at a generic describe tool.
        // Rebuild it with this server's guidance, so a missing table reads the same
        // whether the records or the canvas refused it.
        if (data?.reason === 'missing_table') {
          const tableName = data.tableName;
          const subject =
            typeof tableName === 'string' ? `Canvas table "${tableName}"` : 'Canvas table';
          throw notFound(
            `${subject} does not exist — it may have expired or was never registered.`,
            {
              reason: 'missing_table',
              ...(tableName !== undefined && { tableName }),
              recovery: { hint: MISSING_TABLE_HINT },
            },
          );
        }
        // (#60) A framework-origin clash arrives with the gate's generic hint, which
        // the contract fill never replaces, or with none. Rebuild it with the
        // contract recovery text, mirroring the missing_table treatment above.
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
        // The gate's hint sends the caller to a listing and is silent on the alias
        // case: its name scan refuses a column alias, table alias, or CTE spelled
        // like a metadata view as readily as the view itself.
        if (data?.reason === 'system_catalog_access') {
          throw validationError(err.message, {
            ...data,
            recovery: { hint: SYSTEM_CATALOG_HINT },
          });
        }
        // The engine's hint sends the caller to a listing, which is refused over HTTP
        // with auth none (#242).
        if (data?.reason === 'sql_read_only') {
          throw validationError(err.message, { ...data, recovery: { hint: SQL_READ_ONLY_HINT } });
        }
        // (#74) The gate refuses every non-SELECT before it is prepared, as
        // `statementType: 'UNKNOWN'` on every path but an EXPLAIN failure, where it is
        // 'SELECT'; no caller reads it, so it stays off the wire. The gate's hint is
        // kept: it is written per shape (a PIVOT without an IN list names the list),
        // and the contract's recovery fills in when one is ever missing.
        if (data?.reason === 'non_select_statement') {
          const { statementType: _statementType, ...rest } = data;
          throw validationError(err.message, rest);
        }
        // All other structured McpErrors propagate as-is.
        throw err;
      }
      // Any unclassified raw DuckDB execution error that escaped the framework's
      // prepare gate → structured invalid_sql. A missing table arrives as the
      // framework's missing_table, rebuilt above.
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
      const [info] = await instance.describe({ tableName, signal: ctx.signal });
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
   * Answer a referenced `df_<id>` handle with no record — mistyped, or
   * TTL-expired since it was minted — as `missing_table` from the records
   * alone, before the canvas is acquired, so a mistyped handle mints no canvas.
   * Only the minted-handle pattern `df_<5>_<5>` is checked; string literals and
   * quoted identifiers are stripped so a quoted handle never false-triggers, and
   * other identifiers fall through to the gate, which answers a table the canvas
   * lacks as `missing_table` itself (#47).
   */
  private async assertReferencedDataframesExist(ctx: Context, sql: string): Promise<void> {
    const referenced = stripStringLiterals(sql).match(/\bdf_[A-Z0-9]{5}_[A-Z0-9]{5}\b/g);
    if (!referenced) return;
    for (const name of new Set(referenced)) {
      if ((await ctx.state.get(`${META_PREFIX}${name}`)) === null) {
        throw notFound(`Dataframe '${name}' does not exist or has expired.`, {
          reason: 'missing_table',
          recovery: { hint: MISSING_TABLE_HINT },
        });
      }
    }
  }

  /**
   * Idempotent drop. Removes the table from the live canvas and the metadata
   * entry from `ctx.state`, minting no canvas. Returns true when either side
   * had it; false when neither did, or the name is not shaped like a dataframe
   * name, which reads no state.
   */
  async drop(ctx: Context, tableName: string): Promise<boolean> {
    if (!DATAFRAME_NAME_RE.test(tableName)) return false;
    // Resolved before the record is read, so a dead canvas's purged record never reports a drop.
    const instance = await this.canvasFor(ctx, false);
    await this.sweepExpired(ctx);
    const metaKey = `${META_PREFIX}${tableName}`;
    const hadMeta = (await ctx.state.get(metaKey)) !== null;
    await ctx.state.delete(metaKey);
    if (!instance) return hadMeta;

    try {
      return (await instance.drop(tableName)) || hadMeta;
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
   * past. The live canvas is resolved only once an expired entry turns up, and
   * never minted: with none live, the entry's record alone is deleted.
   * Best-effort: a failure to drop one table does not stop the sweep for others.
   */
  private async sweepExpired(ctx: Context): Promise<void> {
    const nowIso = new Date().toISOString();
    let live: Promise<CanvasInstance | undefined> | undefined;
    for await (const { key, meta } of this.iterateMeta(ctx)) {
      if (meta.expiresAt > nowIso) continue;

      live ??= this.canvasFor(ctx, false);
      const instance = await live;
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
   * The tenant's shared canvas, through `acquireShared` under its default
   * `canvas-id` key (the key this bridge has always stored the id under, so an
   * id stored earlier is reused). `create: false` never mints and resolves
   * `undefined` when no canvas is live. Whenever none is live, `df-meta/` is
   * purged first, under the framework's per-tenant lock: no call obtains the
   * next canvas until the purge settles, so it can never delete a record written
   * for that canvas (#241).
   */
  private canvasFor(ctx: Context, create: true): Promise<CanvasInstance>;
  private canvasFor(ctx: Context, create: false): Promise<CanvasInstance | undefined>;
  private canvasFor(ctx: Context, create: boolean): Promise<CanvasInstance | undefined> {
    return this.canvas.acquireShared(ctx, { create, onReplace: () => this.purgeMeta(ctx) });
  }

  /**
   * Delete every `df-meta/` record: the tables they describe died with the
   * canvas that held them. Idempotent, since `acquireShared` runs it again after
   * it throws, after a failed mint, and after the lock holder is cancelled.
   */
  private async purgeMeta(ctx: Context): Promise<void> {
    const keys: string[] = [];
    for await (const { key } of this.iterateMeta(ctx)) keys.push(key);
    if (keys.length > 0) await ctx.state.deleteMany(keys);
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
 * framework didn't construct a DataCanvas (`CANVAS_PROVIDER_TYPE=none`, or
 * Workers). Tools that materialize dataframes call {@link getCanvasBridge} and
 * skip materialization when the bridge is absent. Listing is off over HTTP with
 * auth `none`: every caller there resolves to the `default` tenant and so shares
 * one canvas (#242). `ctx.tenantId` is `default` on stdio too, so the switch
 * reads the transport.
 */
export function initCanvasBridge(
  canvas: DataCanvas | undefined,
  config: Pick<AppConfig, 'mcpTransportType' | 'mcpAuthMode'>,
): void {
  _bridge = canvas
    ? new CanvasBridge(canvas, {
        listingEnabled: !(config.mcpTransportType === 'http' && config.mcpAuthMode === 'none'),
      })
    : undefined;
}

/** Return the canvas bridge, or `undefined` when canvas is unavailable. */
export function getCanvasBridge(): CanvasBridge | undefined {
  return _bridge;
}
