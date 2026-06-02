/**
 * @fileoverview Adapter between the SEC EDGAR tools and the framework
 * DataCanvas primitive. Holds one shared canvas per tenant, generates
 * `df_XXXXX_XXXXX` table names, derives all-nullable schemas (sparse SEC
 * columns must not trip NOT NULL appender rollbacks), tracks per-table TTL +
 * provenance in `ctx.state`, and lazy-sweeps expired tables on every public
 * op. Best-effort: failed canvas operations log a warning and return
 * `undefined`/empty so the caller's inline response remains useful.
 *
 * Per-table TTL is bridge-side bookkeeping; backstop for
 * cyanheads/mcp-ts-core#140 until the framework exposes
 * `RegisterTableOptions.ttlMs`.
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
import { idGenerator } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { assertNoSystemCatalogAccess } from './sql-gate-extras.js';

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
const CANVAS_ID_KEY = 'canvas-id';

/** Token character set for `df_XXXXX_XXXXX` table names. */
const TABLE_NAME_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Walk a sample of rows, infer column types, force every column to
 * `nullable: true`. The framework's default sniffer infers NOT NULL from
 * non-null samples; DuckDB rolls back the entire appender batch the first
 * time a sparse SEC column (e.g. `loc`, `ticker`) carries a null on a row
 * past the sample window.
 */
export function deriveAllNullableSchema(rows: Record<string, unknown>[]): ColumnSchema[] {
  return inferSchemaFromRows(rows).map((col) => ({ ...col, nullable: true }));
}

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
      const schema = deriveAllNullableSchema(options.rows);

      const result = await instance.registerTable(tableName, options.rows, { schema });

      const now = Date.now();
      const ttlMs = getServerConfig().datasetTtlSeconds * 1000;
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
   */
  async query(
    ctx: Context,
    sql: string,
    options: BridgeQueryOptions = {},
  ): Promise<{ result: QueryResult; meta?: DataframeMeta }> {
    assertNoSystemCatalogAccess(sql);
    await this.sweepExpired(ctx);
    const instance = await this.acquireSharedCanvas(ctx);

    const registerAs = options.registerAs;
    const result = await instance.query(sql, {
      ...(options.preview !== undefined && { preview: options.preview }),
      ...(options.rowLimit !== undefined && { rowLimit: options.rowLimit }),
      ...(registerAs !== undefined && { registerAs }),
      signal: ctx.signal,
    });

    let meta: DataframeMeta | undefined;
    if (registerAs && result.tableName) {
      const tableName = result.tableName;
      const now = Date.now();
      const ttlMs = getServerConfig().datasetTtlSeconds * 1000;
      // Read the registered table's real DuckDB column types so dataframe_describe
      // reports them accurately (#28). Row inference can't be used here: DuckDB
      // serializes BIGINT as strings in query results (would mistype as VARCHAR),
      // and a zero-row result has nothing to sniff. describe() is authoritative
      // for both. Force all-nullable per the bridge convention.
      const [info] = await instance.describe({ tableName });
      const columnSchema: ColumnSchema[] = (
        info?.columns ?? result.columns.map((name) => ({ name, type: 'VARCHAR' as const }))
      ).map((col) => ({ ...col, nullable: true }));
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
