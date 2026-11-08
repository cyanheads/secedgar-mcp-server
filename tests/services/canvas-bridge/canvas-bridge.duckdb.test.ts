/**
 * @fileoverview The canvas bridge against the framework's real `DataCanvas` and
 * DuckDB provider. One shared canvas per tenant under concurrent first stagings,
 * a replaced canvas's records purged and never listed, describe/drop/sweep that
 * never mint (#241), and the SQL gate's own rejections as the bridge passes or
 * rewraps them. Every call's context shares one `ctx.state`, as the tool calls of
 * one tenant do: `createMockContext` alone gives each context its own store,
 * which hides the race.
 * @module tests/services/canvas-bridge/canvas-bridge.duckdb
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@cyanheads/mcp-ts-core';
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CanvasBridge,
  MISSING_TABLE_HINT,
  SQL_READ_ONLY_HINT,
  SYSTEM_CATALOG_HINT,
} from '@/services/canvas-bridge/canvas-bridge.js';

let exportRoot: string;
let canvas: DataCanvas;
let bridge: CanvasBridge;
let shared: Context;
let requests = 0;

/** A context of its own (request id, signal) over the one tenant store every call shares. */
function ctx(): Context {
  requests += 1;
  return {
    ...createMockContext({ requestId: `r${requests}`, tenantId: 'default' }),
    state: shared.state,
  };
}

/** Stage `count` rows as a fresh dataframe and return its name. */
async function stage(count: number): Promise<string> {
  const registered = await bridge.registerDataframe(ctx(), {
    rows: Array.from({ length: count }, (_, i) => ({ v: i, label: `row ${i}` })),
    sourceTool: 'secedgar_fetch_frames',
    queryParams: { count },
  });
  if (!registered) throw new Error('registerDataframe staged nothing');
  return registered.tableName;
}

/** The query's rejection, for asserting on its code and data. */
async function rejection(
  sql: string,
): Promise<{ code: number; message: string; data: Record<string, unknown> }> {
  return await bridge.query(ctx(), sql).then(
    () => {
      throw new Error(`expected ${sql} to be refused`);
    },
    (err: { code: number; message: string; data: Record<string, unknown> }) => err,
  );
}

async function countRows(name: string): Promise<number> {
  const { result } = await bridge.query(ctx(), `SELECT COUNT(*) AS n FROM ${name}`);
  return Number(result.rows[0]?.n);
}

beforeAll(() => {
  process.env.EDGAR_USER_AGENT ??= 'test test@example.com';
});

beforeEach(() => {
  exportRoot = mkdtempSync(join(tmpdir(), 'secedgar-canvas-'));
  const provider = new DuckdbProvider({
    memoryLimitMb: 256,
    exportRootPath: exportRoot,
    defaultRowLimit: 1000,
    schemaSniffRows: 100,
  });
  canvas = new DataCanvas(
    provider,
    new CanvasRegistry(provider, {
      ttlMs: 60_000,
      absoluteCapMs: 600_000,
      maxCanvasesPerTenant: 100,
      sweeperIntervalMs: 0,
    }),
  );
  bridge = new CanvasBridge(canvas, { listingEnabled: true });
  shared = createMockContext({ tenantId: 'default' });
});

afterEach(async () => {
  await canvas.shutdown(shared);
  rmSync(exportRoot, { recursive: true, force: true });
});

describe('one shared canvas per tenant (#241)', () => {
  it('lands five concurrent first stagings on one canvas, each table answering its own count', async () => {
    const names = await Promise.all([1, 2, 3, 4, 5].map((count) => stage(count)));

    expect(canvas.countForTenant(shared)).toBe(1);
    for (const [i, name] of names.entries()) {
      expect(await countRows(name), name).toBe(i + 1);
    }
    const listed = await bridge.describe(ctx());
    expect(listed.map((m) => m.tableName).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect((await bridge.describe(ctx(), name)).map((m) => m.tableName)).toEqual([name]);
    }
  });

  it('lists none of a replaced canvas’s tables, and answers missing_table for them', async () => {
    const names = [await stage(3), await stage(4)];
    const storedId = await shared.state.get<string>('canvas-id');
    expect(storedId).toEqual(expect.any(String));
    expect(await canvas.drop(storedId as string, shared)).toBe(true);

    expect(await bridge.describe(ctx())).toEqual([]);
    for (const name of names) {
      expect(await bridge.describe(ctx(), name)).toEqual([]);
      const err = await rejection(`SELECT * FROM ${name}`);
      expect(err.code).toBe(JsonRpcErrorCode.NotFound);
      expect(err.data.reason).toBe('missing_table');
    }
  });

  it('answers missing_table for a replaced canvas’s table queried before any describe', async () => {
    const name = await stage(3);
    await canvas.drop((await shared.state.get<string>('canvas-id')) as string, shared);

    const err = await rejection(`SELECT * FROM ${name}`);
    expect(err.data.reason).toBe('missing_table');
    expect(await bridge.describe(ctx())).toEqual([]);
  });

  it('after a replace, lists exactly the tables a concurrent burst stages, each queryable', async () => {
    const old = await stage(2);
    await canvas.drop((await shared.state.get<string>('canvas-id')) as string, shared);

    const names = await Promise.all([1, 2, 3, 4, 5].map((count) => stage(count)));

    expect(canvas.countForTenant(shared)).toBe(1);
    const listed = (await bridge.describe(ctx())).map((m) => m.tableName).sort();
    expect(listed).toEqual([...names].sort());
    expect(listed).not.toContain(old);
    for (const [i, name] of names.entries()) {
      expect(await countRows(name), name).toBe(i + 1);
    }
  });

  it('reports no drop for a replaced canvas’s table, purging its record', async () => {
    const name = await stage(2);
    await canvas.drop((await shared.state.get<string>('canvas-id')) as string, shared);

    expect(await bridge.drop(ctx(), name)).toBe(false);
    expect(await shared.state.get(`df-meta/${name}`)).toBeNull();
    expect(canvas.countForTenant(shared)).toBe(0);
  });

  it('describes and drops on a cold canvas without minting one', async () => {
    expect(await bridge.describe(ctx())).toEqual([]);
    expect(await bridge.describe(ctx(), 'df_AAAAA_AAAAA')).toEqual([]);
    expect(await bridge.drop(ctx(), 'df_AAAAA_AAAAA')).toBe(false);

    expect(canvas.countForTenant(shared)).toBe(0);
    expect(await shared.state.get('canvas-id')).toBeNull();
  });

  it('sweeps an expired record on a cold canvas without minting one', async () => {
    await shared.state.set('df-meta/df_EXPIR_00001', {
      tableName: 'df_EXPIR_00001',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });

    expect(await bridge.describe(ctx())).toEqual([]);
    expect(await shared.state.get('df-meta/df_EXPIR_00001')).toBeNull();
    expect(canvas.countForTenant(shared)).toBe(0);
  });

  it('sweeps an expired table off the live canvas with its record', async () => {
    const name = await stage(2);
    const key = `df-meta/${name}`;
    const meta = await shared.state.get<Record<string, unknown>>(key);
    await shared.state.set(key, { ...meta, expiresAt: '2000-01-01T00:00:00.000Z' });

    expect(await bridge.describe(ctx())).toEqual([]);
    expect(await shared.state.get(key)).toBeNull();
    // Quoted, the handle skips the bridge's record pre-check and reaches the canvas itself.
    const err = await rejection(`SELECT * FROM "${name}"`);
    expect(err.data.reason).toBe('missing_table');
    expect(canvas.countForTenant(shared)).toBe(1);
  });

  it('refuses a mistyped handle from its records, minting nothing', async () => {
    const err = await rejection('SELECT * FROM df_ZZZZZ_ZZZZZ');

    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data.reason).toBe('missing_table');
    expect(err.data.recovery).toEqual({ hint: MISSING_TABLE_HINT });
    expect(canvas.countForTenant(shared)).toBe(0);
  });
});

describe('malformed dataframe names', () => {
  it.each(['   ', 'df_aaaaa_aaaaa', 'df_AAAAA_AAAAA ', 'x y', 'df_AAAAA_AAAA'])(
    'answers %j as an unknown name, reading no state',
    async (name) => {
      await stage(1);
      const probe = ctx();
      let reads = 0;
      const { state } = probe;
      const counted: Context = {
        ...probe,
        state: new Proxy(state, {
          get(target, prop, receiver) {
            reads += 1;
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      };

      expect(await bridge.describe(counted, name)).toEqual([]);
      expect(await bridge.drop(counted, name)).toBe(false);
      expect(reads).toBe(0);
    },
  );
});

describe('SQL gate rejections through the bridge', () => {
  it('keeps a SELECT naming an unknown column invalid_sql, with the engine detail', async () => {
    const name = await stage(1);

    for (const sql of [
      `SELECT nope FROM ${name}`,
      'WITH x AS (SELECT 1 AS a) SELECT nope FROM x',
    ]) {
      const err = await rejection(sql);
      expect(err.code, sql).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data.reason, sql).toBe('invalid_sql');
      expect(String(err.data.binderMessage), sql).toContain('"nope"');
    }
  });

  it('keeps a statement that opens with WITH and writes non_select_statement', async () => {
    const name = await stage(1);

    for (const sql of [
      `WITH x AS (SELECT 7 AS v, 'x' AS label) INSERT INTO ${name} SELECT v, label FROM x`,
      `WITH x AS (SELECT 1) DELETE FROM ${name}`,
    ]) {
      const err = await rejection(sql);
      expect(err.code, sql).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data.reason, sql).toBe('non_select_statement');
    }
    expect(await countRows(name)).toBe(1);
  });

  it('refuses a non-SELECT with the gate’s own hint and no statementType', async () => {
    const name = await stage(1);

    for (const sql of [`INSERT INTO ${name} VALUES (9, 'x')`, `DROP TABLE ${name}`]) {
      const err = await rejection(sql);
      expect(err.data.reason, sql).toBe('non_select_statement');
      expect(err.data, sql).not.toHaveProperty('statementType');
      expect(err.data.recovery, sql).toEqual({
        hint: 'Rewrite as a single SELECT — this surface is read-only and cannot create, alter, or drop tables.',
      });
    }
    expect(await countRows(name)).toBe(1);
  });

  it('keeps the gate’s hint naming the IN list for a PIVOT without one, WITH-led or not', async () => {
    const name = await stage(2);

    for (const sql of [
      `PIVOT ${name} ON label USING sum(v)`,
      `WITH p AS (SELECT * FROM ${name}) PIVOT p ON label USING sum(v)`,
    ]) {
      const err = await rejection(sql);
      expect(err.data.reason, sql).toBe('non_select_statement');
      expect(String((err.data.recovery as { hint: string }).hint), sql).toContain(
        'ON column IN (value, ...)',
      );
    }
  });

  it('refuses an alias or CTE spelled like a metadata view, with a hint to rename it', async () => {
    const name = await stage(1);

    for (const [sql, catalog] of [
      [`SELECT v AS pg_class FROM ${name}`, 'pg_class'],
      ['WITH duckdb_tables AS (SELECT 1 AS a) SELECT a FROM duckdb_tables', 'duckdb_tables'],
      [`SELECT t.v FROM ${name} AS sqlite_schema`, 'sqlite_schema'],
    ] as const) {
      const err = await rejection(sql);
      expect(err.code, sql).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data.reason, sql).toBe('system_catalog_access');
      expect(err.data.catalog, sql).toBe(catalog);
      expect(err.message, sql).toContain(catalog);
      expect(err.data.recovery, sql).toEqual({ hint: SYSTEM_CATALOG_HINT });
      expect(SYSTEM_CATALOG_HINT).toMatch(/column alias, table alias, or CTE .* so rename it\.$/);
    }
  });

  it('refuses a file read as sql_read_only with a hint that points at the df_<id> name, not a listing', async () => {
    await stage(1);

    const err = await rejection("SELECT * FROM 'data.csv'");
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('sql_read_only');
    expect(err.data.recovery).toEqual({ hint: SQL_READ_ONLY_HINT });
    expect(SQL_READ_ONLY_HINT).toContain('df_<id>');
    expect(SQL_READ_ONLY_HINT).not.toMatch(/\blist/);
  });

  it('answers a table the canvas lacks with the server’s missing_table hint', async () => {
    await stage(1);

    const err = await rejection('SELECT * FROM "df_ZZZZZ_ZZZZZ"');
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data.reason).toBe('missing_table');
    expect(err.data.tableName).toBe('df_ZZZZZ_ZZZZZ');
    expect(err.data.recovery).toEqual({ hint: MISSING_TABLE_HINT });
  });

  it('records a register_as table’s DuckDB column types through a describe of that table', async () => {
    const name = await stage(2);

    const { meta } = await bridge.query(
      ctx(),
      `SELECT CAST(v AS BIGINT) AS big, label, CAST(v AS DOUBLE) / 2 AS ratio FROM ${name}`,
      { registerAs: 'df_CHAIN_00001' },
    );

    expect(meta?.tableName).toBe('df_CHAIN_00001');
    expect(meta?.rowCount).toBe(2);
    expect(meta?.columnSchema.map((c) => [c.name, c.type])).toEqual([
      ['big', 'BIGINT'],
      ['label', 'VARCHAR'],
      ['ratio', 'DOUBLE'],
    ]);
    expect((await bridge.describe(ctx(), 'df_CHAIN_00001')).map((m) => m.tableName)).toEqual([
      'df_CHAIN_00001',
    ]);
  });
});
