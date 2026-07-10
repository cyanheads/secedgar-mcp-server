/**
 * @fileoverview Tests for the canvas bridge — schema derivation forcing
 * all-nullable, accessor returning undefined without init, idempotent drop
 * semantics, TTL sweep behavior against a stubbed DataCanvas.
 * @module tests/services/canvas-bridge/canvas-bridge
 */

import { inferSchemaFromRows } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CanvasBridge,
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

// Since mcp-ts-core 0.10.4, inferSchemaFromRows always emits nullable: true —
// the bridge's deriveAllNullableSchema wrapper was removed. These tests verify
// the framework guarantee the bridge relies on.
describe('inferSchemaFromRows — always-nullable guarantee (mcp-ts-core ≥0.10.4)', () => {
  it('marks every inferred column nullable, including dense ones', () => {
    const rows = [
      { cik: '0000320193', name: 'Apple', value: 1 },
      { cik: '0000789019', name: 'Microsoft', value: 2 },
    ];
    const schema = inferSchemaFromRows(rows);
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
    const schema = inferSchemaFromRows(rows);
    const byName = Object.fromEntries(schema.map((c) => [c.name, c]));
    expect(byName.cik?.type).toBe('VARCHAR');
    expect(byName.value?.type).toBe('BIGINT');
    expect(byName.ratio?.type).toBe('DOUBLE');
    expect(byName.flag?.type).toBe('BOOLEAN');
  });

  it('marks columns nullable even when all sampled rows are non-null', () => {
    const rows = [
      { cik: '0000320193', loc: 'CA' },
      { cik: '0000789019', loc: 'WA' },
    ];
    const schema = inferSchemaFromRows(rows);
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

  // #60 — the framework's system_catalog_access error carries reason + catalog but
  // no recovery hint (contract hints only attach via ctx.fail). The bridge rebuilds
  // it with the declared recovery text, preserving message, reason, and catalog.
  it('framework system_catalog_access → declared recovery hint attached, reason + catalog preserved (#60)', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    const structured = Object.assign(
      new McpError(
        JsonRpcErrorCode.ValidationError,
        'Canvas query references a system catalog: information_schema.',
      ),
      { data: { reason: 'system_catalog_access', catalog: 'information_schema' } },
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
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('system_catalog_access');
    expect(err.data.catalog).toBe('information_schema');
    expect(err.data.recovery.hint).toMatch(/secedgar_dataframe_describe/);
    expect(err.message).toContain('information_schema');
  });

  // #60 — the framework's register_as_clash error carries reason + tableName but no
  // recovery hint. The bridge rebuilds it with the declared contract recovery text.
  it('framework register_as_clash → declared recovery hint attached, reason + tableName preserved (#60)', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    const structured = Object.assign(
      new McpError(
        JsonRpcErrorCode.ValidationError,
        'Canvas table "df_ABCDE_12345" already exists. Drop it before reusing the name.',
      ),
      { data: { reason: 'register_as_clash', tableName: 'df_ABCDE_12345' } },
    );
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockRejectedValue(structured),
    };
    const acquire = vi.fn().mockResolvedValue(instance);
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const err = await bridge
      .query(ctx, 'SELECT 1', { registerAs: 'df_ABCDE_12345' })
      .catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('register_as_clash');
    expect(err.data.tableName).toBe('df_ABCDE_12345');
    expect(err.data.recovery.hint).toMatch(/secedgar_dataframe_drop/);
    expect(err.message).toContain('df_ABCDE_12345');
  });

  // #60 — the pre-check path: DuckdbProvider's catch reclassifies the framework's own
  // structured clash into a bare databaseError (classifyDuckdbError has no McpError
  // rethrow guard), so a TRACKED clashing register_as target must be rejected before
  // the provider ever runs. The rewrap above remains the fallback for untracked tables.
  it('tracked register_as clash → structured error via pre-check, provider never called (#60)', async () => {
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn(),
    };
    const acquire = vi.fn().mockResolvedValue(instance);
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    await ctx.state.set('df-meta/df_TRACK_00001', {
      tableName: 'df_TRACK_00001',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });

    const err = await bridge
      .query(ctx, 'SELECT 1', { registerAs: 'df_TRACK_00001' })
      .catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('register_as_clash');
    expect(err.data.tableName).toBe('df_TRACK_00001');
    expect(err.data.recovery.hint).toMatch(/secedgar_dataframe_drop/);
    expect(instance.query).not.toHaveBeenCalled();
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

  // #54 — framework gate emits internal SDK method names in missing_table hint;
  // bridge catch rewrites it with an agent-facing recovery hint.
  it('framework missing_table McpError → rewritten with agent-facing recovery hint (#54)', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    const frameworkErr = Object.assign(
      new McpError(JsonRpcErrorCode.NotFound, 'Canvas table "mydata" does not exist.'),
      {
        data: {
          reason: 'missing_table',
          recovery: {
            hint: 'Re-stage the table via registerTable() or call describe() to see what tables are currently available.',
          },
        },
      },
    );
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockRejectedValue(frameworkErr),
    };
    const acquire = vi.fn().mockResolvedValue(instance);
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const err = await bridge.query(ctx, 'SELECT * FROM mydata').catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data.reason).toBe('missing_table');
    expect(err.data.recovery.hint).toMatch(/secedgar_dataframe_describe/);
    expect(err.data.recovery.hint).not.toMatch(/registerTable|describe\(\)/);
  });

  it('framework missing_table for lowercase df_ handle → agent-facing recovery hint (#54)', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    const frameworkErr = Object.assign(
      new McpError(JsonRpcErrorCode.NotFound, 'Canvas table "df_xxxxx_yyyyy" does not exist.'),
      {
        data: {
          reason: 'missing_table',
          recovery: {
            hint: 'Re-stage the table via registerTable() or call describe() to see what tables are currently available.',
          },
        },
      },
    );
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockRejectedValue(frameworkErr),
    };
    const acquire = vi.fn().mockResolvedValue(instance);
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const err = await bridge.query(ctx, 'SELECT * FROM df_xxxxx_yyyyy').catch((e) => e);
    expect(err.data.reason).toBe('missing_table');
    expect(err.data.recovery.hint).toMatch(/secedgar_dataframe_describe/);
  });

  // #52 — SELECT with unknown column gets misclassified by the framework gate as
  // non_select_statement + UNKNOWN; bridge reclassifies to invalid_sql when SELECT-shaped.
  it('non_select_statement+UNKNOWN with SELECT-shaped SQL → reclassified invalid_sql (#52)', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    const gateErr = Object.assign(
      new McpError(
        JsonRpcErrorCode.ValidationError,
        'Canvas query must be SELECT; the statement could not be parsed or prepared.',
      ),
      { data: { reason: 'non_select_statement', statementType: 'UNKNOWN' } },
    );
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockRejectedValue(gateErr),
    };
    const acquire = vi.fn().mockResolvedValue(instance);
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    await ctx.state.set('df-meta/df_AAAAA_BBBBB', {
      tableName: 'df_AAAAA_BBBBB',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });

    const err = await bridge
      .query(ctx, 'SELECT nonexistent_col FROM df_AAAAA_BBBBB LIMIT 5')
      .catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('invalid_sql');
    expect(err.data.recovery.hint).toMatch(/secedgar_dataframe_describe/);
  });

  it('non_select_statement+UNKNOWN with CTE SELECT → reclassified invalid_sql (#52)', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    const gateErr = Object.assign(
      new McpError(
        JsonRpcErrorCode.ValidationError,
        'Canvas query must be SELECT; the statement could not be parsed or prepared.',
      ),
      { data: { reason: 'non_select_statement', statementType: 'UNKNOWN' } },
    );
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockRejectedValue(gateErr),
    };
    const acquire = vi.fn().mockResolvedValue(instance);
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    await ctx.state.set('df-meta/df_AAAAA_BBBBB', {
      tableName: 'df_AAAAA_BBBBB',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });

    const err = await bridge
      .query(ctx, 'WITH x AS (SELECT 1) SELECT bad_col FROM x')
      .catch((e) => e);
    expect(err.data.reason).toBe('invalid_sql');
  });

  it('non_select_statement+UNKNOWN with INSERT SQL → stays non_select_statement (#52)', async () => {
    // An INSERT that reaches DuckDB and gets UNKNOWN statementType should not be
    // reclassified — it is NOT SELECT-shaped. In practice the gate catches it
    // earlier (INSERT would get statementType: 'INSERT'), but the isSelectShaped
    // guard covers the case regardless. Use a table name outside the df_ pattern
    // so the pre-check doesn't intercept it first.
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    const gateErr = Object.assign(
      new McpError(
        JsonRpcErrorCode.ValidationError,
        'Canvas query must be SELECT; the statement could not be parsed or prepared.',
      ),
      { data: { reason: 'non_select_statement', statementType: 'UNKNOWN' } },
    );
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockRejectedValue(gateErr),
    };
    const acquire = vi.fn().mockResolvedValue(instance);
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    // Use non-pattern table name so the pre-check doesn't intercept it.
    const err = await bridge.query(ctx, 'INSERT INTO my_table VALUES (1)').catch((e) => e);
    expect(err.data.reason).toBe('non_select_statement');
  });

  // #74 — a genuine non-SELECT (non-UNKNOWN statementType) is NOT reclassified to
  // invalid_sql (#52 only handles UNKNOWN column errors), but it IS rewrapped to
  // attach a recovery hint, mirroring the system_catalog_access rewrap. The reason
  // and statementType are preserved; only recovery is added.
  it('non_select_statement with non-UNKNOWN statementType → rewrapped with recovery hint (#74)', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    const gateErr = Object.assign(
      new McpError(JsonRpcErrorCode.ValidationError, 'Canvas query must be SELECT.'),
      { data: { reason: 'non_select_statement', statementType: 'INSERT' } },
    );
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockRejectedValue(gateErr),
    };
    const acquire = vi.fn().mockResolvedValue(instance);
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const err = await bridge.query(ctx, 'INSERT INTO t VALUES (1)').catch((e) => e);
    expect(err).not.toBe(gateErr); // rewrapped, not the same reference
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('non_select_statement');
    expect(err.data.statementType).toBe('INSERT');
    expect(err.data.recovery.hint).toMatch(/secedgar_dataframe_describe/);
  });

  // #74 — the reported repro: a DROP against a df_<id> handle. The pre-check does
  // not intercept it (DROP is a valid statement type, not a missing table), so it
  // reaches the gate, which rejects it as non_select_statement with statementType
  // 'DROP'. The bridge rewrap attaches the SELECT-only recovery hint.
  it('DROP statement → non_select_statement with recovery hint (#74)', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    const gateErr = Object.assign(
      new McpError(
        JsonRpcErrorCode.ValidationError,
        'Canvas query must be SELECT; got DROP. Mutations must use registerTable, drop, or clear.',
      ),
      { data: { reason: 'non_select_statement', statementType: 'DROP' } },
    );
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockRejectedValue(gateErr),
    };
    const acquire = vi.fn().mockResolvedValue(instance);
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    await ctx.state.set('df-meta/df_AAAAA_BBBBB', {
      tableName: 'df_AAAAA_BBBBB',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });

    const err = await bridge.query(ctx, 'DROP TABLE df_AAAAA_BBBBB').catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('non_select_statement');
    expect(err.data.statementType).toBe('DROP');
    expect(err.data.recovery.hint).toMatch(/SELECT/);
    expect(err.data.recovery.hint).toMatch(/secedgar_dataframe_describe/);
  });
});

describe('CanvasBridge.query with registerAs', () => {
  it("records the registered table's real DuckDB column types via describe-all + find (#28, #53)", async () => {
    // WORKAROUND (#53): describe({ tableName }) triggers an ambiguous-column binder
    // error in the framework. Bridge now calls unfiltered describe() and finds the
    // entry by name. Mock returns the full table list; bridge finds the registered one.
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
          name: 'df_OTHER_TABLE',
          kind: 'table',
          rowCount: 5,
          columns: [{ name: 'x', type: 'INTEGER', nullable: true }],
        },
        {
          name: 'df_NEW01_NEW02',
          kind: 'table',
          rowCount: 2,
          columns: [
            { name: 'rev_b', type: 'DOUBLE', nullable: true },
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

    // Must call unfiltered describe() — no tableName arg (#53 workaround).
    expect(instance.describe).toHaveBeenCalledWith();
    expect(instance.describe).not.toHaveBeenCalledWith({ tableName: expect.any(String) });
    const byName = Object.fromEntries((meta?.columnSchema ?? []).map((c) => [c.name, c]));
    expect(byName.rev_b?.type).toBe('DOUBLE');
    expect(byName.ticker?.type).toBe('VARCHAR');
    // Framework's inferSchemaFromRows always emits nullable: true since 0.10.4;
    // bridge reads DuckDB column types verbatim from describe() after registerAs.
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

  it('falls back to VARCHAR when describe-all find-miss occurs (#53)', async () => {
    // If the registered table is not found in describe()'s result list, the bridge
    // falls back to mapping result.columns to VARCHAR — same as the pre-#53 behavior
    // on a describe() empty-return.
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockResolvedValue({
        columns: ['col_a', 'col_b'],
        rowCount: 1,
        rows: [{ col_a: 'x', col_b: 'y' }],
        tableName: 'df_NEWTB_LEONE',
      }),
      // describe() returns an empty list — simulates a find-miss
      describe: vi.fn().mockResolvedValue([]),
    };
    const acquire = vi.fn().mockResolvedValue(instance);
    const canvas = { acquire } as unknown as Parameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas);
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const { meta } = await bridge.query(ctx, 'SELECT col_a, col_b FROM df_A', {
      registerAs: 'df_NEWTB_LEONE',
    });

    // Falls back to VARCHAR for each column in result.columns
    const byName = Object.fromEntries((meta?.columnSchema ?? []).map((c) => [c.name, c]));
    expect(byName.col_a?.type).toBe('VARCHAR');
    expect(byName.col_b?.type).toBe('VARCHAR');
  });
});
