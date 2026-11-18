/**
 * @fileoverview Tests for the canvas bridge against a stubbed DataCanvas —
 * schema derivation forcing all-nullable, the accessor and its listing switch,
 * idempotent drop semantics, and the rewraps of framework errors. The real
 * engine's behavior is pinned in `canvas-bridge.duckdb.test.ts`.
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
  SQL_READ_ONLY_HINT,
  SYSTEM_CATALOG_HINT,
} from '@/services/canvas-bridge/canvas-bridge.js';

const ORIGINAL_ENV = process.env;
const STDIO = { mcpTransportType: 'stdio', mcpAuthMode: 'none' } as const;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV, EDGAR_USER_AGENT: 'test test@example.com' };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  initCanvasBridge(undefined, STDIO);
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
    initCanvasBridge(undefined, STDIO);
    expect(getCanvasBridge()).toBeUndefined();
  });

  it('returns a bridge when canvas is provided', () => {
    const fakeCanvas = {} as Parameters<typeof initCanvasBridge>[0];
    initCanvasBridge(fakeCanvas, STDIO);
    expect(getCanvasBridge()).toBeDefined();
  });

  it.each([
    ['http', 'none', false],
    ['http', 'jwt', true],
    ['http', 'oauth', true],
    ['stdio', 'none', true],
    ['stdio', 'jwt', true],
  ] as const)(
    'over %s with auth %s, lists dataframes: %s (#242)',
    (mcpTransportType, mcpAuthMode, listingEnabled) => {
      const fakeCanvas = {} as Parameters<typeof initCanvasBridge>[0];
      initCanvasBridge(fakeCanvas, { mcpTransportType, mcpAuthMode });
      expect(getCanvasBridge()?.listingEnabled).toBe(listingEnabled);
    },
  );
});

describe('CanvasBridge.registerDataframe', () => {
  it('returns undefined and skips canvas work when rows is empty', async () => {
    const acquireShared = vi.fn();
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const result = await bridge.registerDataframe(ctx, {
      rows: [],
      sourceTool: 'secedgar_fetch_frames',
      queryParams: { concept: 'revenue', period: 'CY2023' },
    });

    expect(result).toBeUndefined();
    expect(acquireShared).not.toHaveBeenCalled();
  });

  it('returns undefined and logs warning when canvas acquire fails (best-effort)', async () => {
    const acquireShared = vi.fn().mockRejectedValue(new Error('canvas down'));
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
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
    const acquireShared = vi.fn().mockResolvedValue(instance);
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
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
    const acquireShared = vi.fn().mockResolvedValue(instance);
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const dropped = await bridge.drop(ctx, 'df_NOTHI_NGHER');
    expect(dropped).toBe(false);
    expect(instance.drop).toHaveBeenCalledWith('df_NOTHI_NGHER');
  });
});

describe('CanvasBridge.query error classification (#47)', () => {
  /** The `missing_table` the framework's gate throws, the engine's message on its cause. */
  async function engineMissingTable(tableName: string) {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    return new McpError(
      JsonRpcErrorCode.NotFound,
      `Canvas table "${tableName}" does not exist. The table may have expired, been dropped, or the name may be mistyped.`,
      {
        reason: 'missing_table',
        tableName,
        recovery: {
          hint: "Re-run the tool that produced this table to stage it again, or list the currently staged tables with this server's dataframe-describe tool.",
        },
      },
      {
        cause: new Error(
          `Catalog Error: Table with name ${tableName} does not exist!\nDid you mean "df_AAAAA_BBBBB"?`,
        ),
      },
    );
  }

  it('hands a query naming only unregistered handles to the canvas acquireShared resolves (#251)', async () => {
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockRejectedValue(await engineMissingTable('df_QQQQQ_QQQQQ')),
    };
    const acquireShared = vi.fn().mockResolvedValue(instance);
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    await expect(bridge.query(ctx, 'SELECT * FROM df_QQQQQ_QQQQQ LIMIT 1')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'missing_table', tableName: 'df_QQQQQ_QQQQQ' },
    });
    expect(acquireShared).toHaveBeenCalledWith(ctx, {
      create: true,
      onReplace: expect.any(Function),
    });
    expect(instance.query).toHaveBeenCalledWith(
      'SELECT * FROM df_QQQQQ_QQQQQ LIMIT 1',
      expect.objectContaining({ denySystemCatalogs: true }),
    );
  });

  it('missing_table names the df and points to dataframe_describe, no catalog leak (#47, #251)', async () => {
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockRejectedValue(await engineMissingTable('df_QQQQQ_QQQQQ')),
    };
    const acquireShared = vi.fn().mockResolvedValue(instance);
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const err = await bridge.query(ctx, 'SELECT * FROM df_QQQQQ_QQQQQ LIMIT 1').catch((e) => e);
    expect(err.message).toBe(
      'Canvas table "df_QQQQQ_QQQQQ" does not exist — it may have expired or was never registered.',
    );
    expect(JSON.stringify(err.data)).not.toMatch(/duckdb|catalog error|did you mean/i);
    expect(err.data.tableName).toBe('df_QQQQQ_QQQQQ');
    expect(err.data.recovery.hint).toMatch(/dataframe_describe/);
  });

  it('hands the SQL to the canvas as written, unregistered handles in a comment and a literal included (#251)', async () => {
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockResolvedValue({ columns: ['note'], rows: [], rowCount: 0 }),
    };
    const acquireShared = vi.fn().mockResolvedValue(instance);
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const sql =
      "SELECT note FROM df_AAAAA_BBBBB WHERE note = 'see df_OLDXX_OLDXX' -- superseded df_OLDYY_OLDYY";

    const { result } = await bridge.query(ctx, sql);
    expect(result.rowCount).toBe(0);
    expect(instance.query).toHaveBeenCalledExactlyOnceWith(sql, {
      denySystemCatalogs: true,
      signal: ctx.signal,
    });
  });

  // #60 — the framework's system_catalog_access error carries reason + catalog and a
  // hint that sends the caller to a listing. The bridge rebuilds it with the declared
  // recovery text, preserving message, reason, and catalog.
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
    const acquireShared = vi.fn().mockResolvedValue(instance);
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const err = await bridge.query(ctx, 'SELECT 1').catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('system_catalog_access');
    expect(err.data.catalog).toBe('information_schema');
    expect(err.data.recovery.hint).toBe(SYSTEM_CATALOG_HINT);
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
    const acquireShared = vi.fn().mockResolvedValue(instance);
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
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
    const acquireShared = vi.fn().mockResolvedValue(instance);
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
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
    const acquireShared = vi.fn().mockResolvedValue(instance);
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
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
    const acquireShared = vi.fn().mockResolvedValue(instance);
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
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
    const acquireShared = vi.fn().mockResolvedValue(instance);
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const err = await bridge.query(ctx, 'SELECT * FROM df_xxxxx_yyyyy').catch((e) => e);
    expect(err.data.reason).toBe('missing_table');
    expect(err.data.recovery.hint).toMatch(/secedgar_dataframe_describe/);
  });

  // #74 — mcp-ts-core 0.13.22's gate refuses every non-SELECT before it is prepared,
  // with statementType 'UNKNOWN' and a hint of its own (a PIVOT without an IN list
  // gets one naming the list). The rewrap keeps message, reason, and hint, and drops
  // the statementType no caller reads. Which statements reach this refusal — a
  // WITH-led INSERT included — is pinned against the real gate in
  // canvas-bridge.duckdb.test.ts.
  it('non_select_statement → rewrapped without statementType, the gate’s hint kept (#74)', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    const hint =
      'Rewrite as a single SELECT — this surface is read-only and cannot create, alter, or drop tables.';
    const gateErr = Object.assign(
      new McpError(JsonRpcErrorCode.ValidationError, 'Canvas query must be SELECT.'),
      {
        data: { reason: 'non_select_statement', statementType: 'UNKNOWN', recovery: { hint } },
      },
    );
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockRejectedValue(gateErr),
    };
    const acquireShared = vi.fn().mockResolvedValue(instance);
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    await ctx.state.set('df-meta/df_AAAAA_BBBBB', {
      tableName: 'df_AAAAA_BBBBB',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });

    const err = await bridge.query(ctx, 'DROP TABLE df_AAAAA_BBBBB').catch((e) => e);
    expect(err).not.toBe(gateErr); // rewrapped, not the same reference
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.message).toBe('Canvas query must be SELECT.');
    expect(err.data).toEqual({ reason: 'non_select_statement', recovery: { hint } });
  });

  /**
   * The gate's invalid_sql carries statementType 'UNKNOWN' as non_select_statement
   * does; the rewrap drops it the same way, the gate's error kept on cause for the log.
   * Its hint is written per engine error class and kept, with the gate's generic
   * reference to a describe tool naming this server's — except the two hints that
   * send the caller to list the staged tables, a listing refused over HTTP with auth
   * none (#242), which are replaced. A reworded one keeps the substitution.
   */
  it.each([
    {
      shape: 'an unknown column',
      binderMessage:
        'Binder Error: Referenced column "nope" not found in FROM clause!\nCandidate bindings: "label"',
      gateHint:
        "Correct the column or function the message names; list the staged columns with this server's dataframe-describe tool.",
      hint: 'Correct the column or function the message names; list the staged columns with secedgar_dataframe_describe.',
    },
    {
      shape: 'an unknown function',
      binderMessage: 'Catalog Error: Scalar Function with name nope does not exist!',
      gateHint:
        "Correct the function, type, collation, or schema name the message reports missing — list the staged tables with this server's dataframe-describe tool.",
      hint: 'Correct the function, type, collation, or schema name the message reports missing; reference each df_<id> table by its bare name.',
    },
    {
      shape: 'a file the engine could not read',
      binderMessage: 'IO Error: No files found that match the pattern "x"',
      gateHint:
        "Send a read-only SELECT over the staged tables — list them with this server's dataframe-describe tool. This surface reads no files and cannot create, alter, or drop anything.",
      hint: SQL_READ_ONLY_HINT,
    },
    {
      shape: 'an unknown function, the gate’s listing hint reworded',
      binderMessage: 'Catalog Error: Scalar Function with name nope does not exist!',
      gateHint:
        "Correct the function or type the message reports missing — list the staged tables with this server's dataframe-describe tool.",
      hint: 'Correct the function or type the message reports missing — list the staged tables with secedgar_dataframe_describe.',
    },
    {
      shape: 'a syntax error, whose hint names no tool',
      binderMessage: 'Parser Error: syntax error at or near "FORM"',
      gateHint:
        'Fix the SQL syntax the message names and send a single read-only SELECT. Put AS before an alias that is a SQL keyword, or double-quote it.',
      hint: 'Fix the SQL syntax the message names and send a single read-only SELECT. Put AS before an alias that is a SQL keyword, or double-quote it.',
    },
  ])(
    'invalid_sql for $shape → rewrapped without statementType, message, detail, and hint kept (#251)',
    async ({ binderMessage, gateHint, hint }) => {
      const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
      const gateErr = new McpError(
        JsonRpcErrorCode.ValidationError,
        `Canvas query failed to prepare: ${binderMessage}`,
        {
          reason: 'invalid_sql',
          statementType: 'UNKNOWN',
          binderMessage,
          recovery: { hint: gateHint },
        },
      );
      const instance = {
        canvasId: 'cid_test',
        query: vi.fn().mockRejectedValue(gateErr),
      };
      const acquireShared = vi.fn().mockResolvedValue(instance);
      const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
      const bridge = new CanvasBridge(canvas, { listingEnabled: true });
      const ctx = createMockContext({ tenantId: 'test-tenant' });

      const err = await bridge.query(ctx, 'SELECT nope FROM df_AAAAA_BBBBB').catch((e) => e);
      expect(err).not.toBe(gateErr);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.message).toBe(`Canvas query failed to prepare: ${binderMessage}`);
      expect(err.data).toEqual({ reason: 'invalid_sql', binderMessage, recovery: { hint } });
      expect(err.cause).toBe(gateErr);
    },
  );

  it('invalid_sql with no hint → rewrapped with none, for the contract recovery to fill (#251)', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    const binderMessage = 'Binder Error: Referenced column "nope" not found in FROM clause!';
    const gateErr = new McpError(
      JsonRpcErrorCode.ValidationError,
      `Canvas query failed to prepare: ${binderMessage}`,
      { reason: 'invalid_sql', statementType: 'UNKNOWN', binderMessage },
    );
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockRejectedValue(gateErr),
    };
    const acquireShared = vi.fn().mockResolvedValue(instance);
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const err = await bridge.query(ctx, 'SELECT nope FROM df_AAAAA_BBBBB').catch((e) => e);
    expect(err.data).toEqual({ reason: 'invalid_sql', binderMessage });
  });
});

describe('CanvasBridge.query with registerAs', () => {
  it("records the registered table's real DuckDB column types from a describe of that table alone (#28, #53)", async () => {
    // Since mcp-ts-core 0.13.4 describe({ tableName }) qualifies its filter, so the
    // bridge reads the one table instead of every table on the canvas (#53).
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
            { name: 'rev_b', type: 'DOUBLE', nullable: true },
            { name: 'ticker', type: 'VARCHAR', nullable: true },
          ],
        },
      ]),
    };
    const acquireShared = vi.fn().mockResolvedValue(instance);
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
    const ctx = createMockContext({ tenantId: 'test-tenant' });

    const { meta } = await bridge.query(
      ctx,
      'SELECT CAST(value AS DOUBLE)/1e9 AS rev_b, ticker FROM df_A',
      { registerAs: 'df_NEW01_NEW02' },
    );

    expect(instance.describe).toHaveBeenCalledExactlyOnceWith({
      tableName: 'df_NEW01_NEW02',
      signal: ctx.signal,
    });
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
    const acquireShared = vi.fn().mockResolvedValue(instance);
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
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

  it('falls back to VARCHAR when describe returns no entry for the table (#53)', async () => {
    // With no entry for the registered table, the bridge maps result.columns to
    // VARCHAR.
    const instance = {
      canvasId: 'cid_test',
      query: vi.fn().mockResolvedValue({
        columns: ['col_a', 'col_b'],
        rowCount: 1,
        rows: [{ col_a: 'x', col_b: 'y' }],
        tableName: 'df_NEWTB_LEONE',
      }),
      describe: vi.fn().mockResolvedValue([]),
    };
    const acquireShared = vi.fn().mockResolvedValue(instance);
    const canvas = { acquireShared } as unknown as ConstructorParameters<typeof CanvasBridge>[0];
    const bridge = new CanvasBridge(canvas, { listingEnabled: true });
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
