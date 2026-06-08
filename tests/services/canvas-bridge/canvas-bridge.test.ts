/**
 * @fileoverview Tests for the canvas bridge — schema derivation forcing
 * all-nullable, accessor returning undefined without init, idempotent drop
 * semantics, TTL sweep behavior against a stubbed DataCanvas.
 * @module tests/services/canvas-bridge/canvas-bridge
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CanvasBridge,
  deriveAllNullableSchema,
  getCanvasBridge,
  initCanvasBridge,
} from '@/services/canvas-bridge/canvas-bridge.js';

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV, EDGAR_USER_AGENT: 'test test@example.com' };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  initCanvasBridge(undefined);
});

describe('deriveAllNullableSchema', () => {
  it('marks every inferred column nullable, including dense ones', () => {
    const rows = [
      { cik: '0000320193', name: 'Apple', value: 1 },
      { cik: '0000789019', name: 'Microsoft', value: 2 },
    ];
    const schema = deriveAllNullableSchema(rows);
    expect(schema).toHaveLength(3);
    for (const col of schema) {
      expect(col.nullable).toBe(true);
    }
  });

  it('preserves the inferred column types', () => {
    const rows = [
      { cik: '0000320193', value: 383285000000, ratio: 0.25, flag: true },
      { cik: '0000789019', value: 211915000000, ratio: 0.31, flag: false },
    ];
    const schema = deriveAllNullableSchema(rows);
    const byName = Object.fromEntries(schema.map((c) => [c.name, c]));
    expect(byName.cik?.type).toBe('VARCHAR');
    expect(byName.value?.type).toBe('BIGINT');
    expect(byName.ratio?.type).toBe('DOUBLE');
    expect(byName.flag?.type).toBe('BOOLEAN');
  });

  it('handles sparse columns the framework would normally infer NOT NULL on', () => {
    const rows = [
      { cik: '0000320193', loc: 'CA' },
      { cik: '0000789019', loc: 'WA' },
    ];
    const schema = deriveAllNullableSchema(rows);
    const loc = schema.find((c) => c.name === 'loc');
    expect(loc?.nullable).toBe(true);
  });
});

describe('init/accessor', () => {
  it('returns undefined before init', () => {
    initCanvasBridge(undefined);
    expect(getCanvasBridge()).toBeUndefined();
  });

  it('returns a bridge when canvas is provided', () => {
    const fakeCanvas = {} as Parameters<typeof initCanvasBridge>[0];
    initCanvasBridge(fakeCanvas);
    expect(getCanvasBridge()).toBeDefined();
  });
});

describe('CanvasBridge.registerDataframe', () => {
  it('returns undefined and skips canvas work when rows is empty', async () => {
    const acquire = vi.fn();
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const result = await bridge.registerDataframe(ctx, {
      rows: [],
      sourceTool: 'secedgar_fetch_frames',
      queryParams: { concept: 'revenue', period: 'CY2023' },
    });

    expect(result).toBeUndefined();
    expect(acquire).not.toHaveBeenCalled();
  });

  it('returns undefined and logs warning when canvas acquire fails (best-effort)', async () => {
    const acquire = vi.fn().mockRejectedValue(new Error('canvas down'));
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const warningSpy = vi.spyOn(ctx.log, 'warning');

    const result = await bridge.registerDataframe(ctx, {
      rows: [{ x: 1 }],
      sourceTool: 'secedgar_fetch_frames',
      queryParams: {},
    });

    expect(result).toBeUndefined();
    expect(warningSpy).toHaveBeenCalled();
  });

  it('mints df_XXXXX_XXXXX-shaped table names', async () => {
    const registerTable = vi
      .fn()
      .mockImplementation((name: string) =>
        Promise.resolve({ tableName: name, rowCount: 2, columns: ['x'] }),
      );
    const instance = {
      canvasId: 'cid_test',
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      registerTable,
    };
    const acquire = vi.fn().mockResolvedValue(instance);
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const result = await bridge.registerDataframe(ctx, {
      rows: [{ x: 1 }, { x: 2 }],
      sourceTool: 'secedgar_fetch_frames',
      queryParams: { concept: 'revenue' },
    });

    expect(result?.tableName).toMatch(/^df_[A-Z0-9]{5}_[A-Z0-9]{5}$/);
    expect(result?.tableName).toHaveLength(14);
  });
});

describe('CanvasBridge.drop', () => {
  it('is idempotent — returns false when nothing matched', async () => {
    const instance = {
      canvasId: 'cid_test',
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      drop: vi.fn().mockResolvedValue(false),
    };
    const acquire = vi.fn().mockResolvedValue(instance);
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const dropped = await bridge.drop(ctx, 'df_NOTHIN_GHEREE');
    expect(dropped).toBe(false);
  });
});

describe('CanvasBridge.query error classification (#47)', () => {
  it('unregistered df_<id> reference → structured missing_table via pre-check (#47)', async () => {
    // The framework gate rejects an unbindable table with a generic
    // non_select_statement; the bridge pre-check surfaces a useful missing_table
    // first — before the canvas is even acquired.
    const acquire = vi.fn();
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    await expect(bridge.query(ctx, 'SELECT * FROM df_QQQQQ_QQQQQ LIMIT 1')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'missing_table' },
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('missing_table names the df and points to dataframe_describe, no catalog leak (#47)', async () => {
    const acquire = vi.fn();
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const err = await bridge.query(ctx, 'SELECT * FROM df_QQQQQ_QQQQQ LIMIT 1').catch((e) => e);
    expect(err.message).toContain('df_QQQQQ_QQQQQ');
    expect(err.message).not.toMatch(/duckdb|catalog|did you mean/i);
    expect(err.data.recovery.hint).toMatch(/dataframe_describe/);
  });

  it('a quoted df_<id> in a string literal does not false-trigger missing_table (#47)', async () => {
    // String literals are stripped before the handle scan, so a registered df in
    // FROM still runs even when an unregistered handle appears inside a string.
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockResolvedValue({ columns: ['note'], rows: [], rowCount: 0 }),
    };
    const acquire = vi.fn().mockResolvedValue(instance);
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    await ctx.state.set('df-meta/df_AAAAA_BBBBB', {
      tableName: 'df_AAAAA_BBBBB',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });

    const { result } = await bridge.query(
      ctx,
      "SELECT note FROM df_AAAAA_BBBBB WHERE note = 'see df_OLDXX_OLDXX'",
    );
    expect(result.rowCount).toBe(0);
    expect(instance.query).toHaveBeenCalled();
  });

  it('already-structured McpError rethrows as-is (preserves reason) (#47)', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    const structured = Object.assign(
      new McpError(JsonRpcErrorCode.ValidationError, 'system catalog denied'),
      { data: { reason: 'system_catalog_access' } },
    );
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockRejectedValue(structured),
    };
    const acquire = vi.fn().mockResolvedValue(instance);
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const err = await bridge.query(ctx, 'SELECT 1').catch((e) => e);
    expect(err).toBe(structured); // same reference — not re-wrapped
    expect(err.data.reason).toBe('system_catalog_access');
  });

  it('unclassified DuckDB error → generic invalid_sql reason (#47)', async () => {
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockRejectedValue(new Error('Parser Error: syntax error at or near "SELEKT"')),
    };
    const acquire = vi.fn().mockResolvedValue(instance);
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    await expect(bridge.query(ctx, 'SELEKT 1')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_sql' },
    });
  });
});

describe('CanvasBridge.query with registerAs', () => {
  it("records the registered table's real DuckDB column types — not all VARCHAR (#28)", async () => {
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockResolvedValue({
        columns: ['rev_b', 'ticker'],
        rowCount: 2,
        rows: [
          { rev_b: 383.285, ticker: 'AAPL' },
          { rev_b: 211.915, ticker: 'MSFT' },
        ],
        tableName: 'df_NEW01_NEW02',
      }),
      describe: vi.fn().mockResolvedValue([
        {
          name: 'df_NEW01_NEW02',
          kind: 'table',
          rowCount: 2,
          columns: [
            { name: 'rev_b', type: 'DOUBLE', nullable: false },
            { name: 'ticker', type: 'VARCHAR', nullable: true },
          ],
        },
      ]),
    };
    const acquire = vi.fn().mockResolvedValue(instance);
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const { meta } = await bridge.query(
      ctx,
      'SELECT CAST(value AS DOUBLE)/1e9 AS rev_b, ticker FROM df_A',
      { registerAs: 'df_NEW01_NEW02' },
    );

    expect(instance.describe).toHaveBeenCalledWith({ tableName: 'df_NEW01_NEW02' });
    const byName = Object.fromEntries((meta?.columnSchema ?? []).map((c) => [c.name, c]));
    expect(byName.rev_b?.type).toBe('DOUBLE');
    expect(byName.ticker?.type).toBe('VARCHAR');
    // Forced all-nullable per the bridge convention, regardless of DuckDB's view.
    expect(meta?.columnSchema.every((c) => c.nullable)).toBe(true);
  });

  it('types a BIGINT column from describe even with zero result rows (#28)', async () => {
    // DuckDB serializes BIGINT as strings in query rows, and a 0-row result has
    // nothing to sniff — describe() is the authoritative source for both.
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockResolvedValue({
        columns: ['total_value', 'ticker'],
        rowCount: 0,
        rows: [],
        tableName: 'df_BIG01_BIG02',
      }),
      describe: vi.fn().mockResolvedValue([
        {
          name: 'df_BIG01_BIG02',
          kind: 'table',
          rowCount: 0,
          columns: [
            { name: 'total_value', type: 'BIGINT', nullable: true },
            { name: 'ticker', type: 'VARCHAR', nullable: true },
          ],
        },
      ]),
    };
    const acquire = vi.fn().mockResolvedValue(instance);
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const { meta } = await bridge.query(
      ctx,
      'SELECT SUM(value) AS total_value, ticker FROM df_A WHERE 1=0 GROUP BY ticker',
      { registerAs: 'df_BIG01_BIG02' },
    );

    const byName = Object.fromEntries((meta?.columnSchema ?? []).map((c) => [c.name, c]));
    expect(byName.total_value?.type).toBe('BIGINT');
    expect(byName.ticker?.type).toBe('VARCHAR');
  });
});
