/**
 * @fileoverview Tests for dataframe-query tool — SQL against canvas dataframes.
 * @module tests/mcp-server/tools/definitions/dataframe-query.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
}));

import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

const mockBridge = {
  query: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dataframeQueryTool', () => {
  it('throws canvas_unavailable when no bridge is configured', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT 1' });

    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('declares system_catalog_access in errors contract (#22)', () => {
    const entry = dataframeQueryTool.errors?.find((e) => e.reason === 'system_catalog_access');
    expect(entry).toBeDefined();
    expect(entry!.code).toBe(JsonRpcErrorCode.ValidationError);
  });

  it('declares missing_table in errors contract (#47)', () => {
    const entry = dataframeQueryTool.errors?.find((e) => e.reason === 'missing_table');
    expect(entry).toBeDefined();
    expect(entry!.code).toBe(JsonRpcErrorCode.NotFound);
    expect(entry!.recovery.length).toBeGreaterThan(4);
  });

  it('declares invalid_sql in errors contract (#47)', () => {
    const entry = dataframeQueryTool.errors?.find((e) => e.reason === 'invalid_sql');
    expect(entry).toBeDefined();
    expect(entry!.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(entry!.recovery.length).toBeGreaterThan(4);
  });

  it('declares register_as_clash in errors contract (#60)', () => {
    const entry = dataframeQueryTool.errors?.find((e) => e.reason === 'register_as_clash');
    expect(entry).toBeDefined();
    expect(entry!.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(entry!.recovery).toMatch(/secedgar_dataframe_drop/);
  });

  it('declares non_select_statement in errors contract (#74)', () => {
    const entry = dataframeQueryTool.errors?.find((e) => e.reason === 'non_select_statement');
    expect(entry).toBeDefined();
    expect(entry!.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(entry!.recovery).toMatch(/secedgar_dataframe_describe/);
  });

  it('non_select_statement from the bridge surfaces reason + recovery hint on the wire (#74)', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    // The bridge rewraps a genuine non-SELECT (e.g. DROP) with the declared recovery
    // hint (#74); the handler passes it through untouched.
    mockBridge.query.mockRejectedValue(
      Object.assign(
        new Error(
          'Canvas query must be SELECT; got DROP. Mutations must use registerTable, drop, or clear.',
        ),
        {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'non_select_statement',
            statementType: 'DROP',
            recovery: {
              hint: 'Query only SELECT statements against df_<id> tables. Use secedgar_dataframe_describe to inspect available dataframes.',
            },
          },
        },
      ),
    );
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({ sql: 'DROP TABLE df_ABCDE_12345' });

    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'non_select_statement',
        recovery: { hint: expect.stringContaining('secedgar_dataframe_describe') },
      },
    });
  });

  it('register_as clash from the bridge surfaces reason + recovery hint on the wire (#60)', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    // Simulate the structured error the bridge rebuilds for a register_as clash.
    mockBridge.query.mockRejectedValue(
      Object.assign(
        new Error(
          'Canvas table "df_ABCDE_12345" already exists — register_as requires an unused name.',
        ),
        {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'register_as_clash',
            tableName: 'df_ABCDE_12345',
            recovery: {
              hint: 'Drop the existing dataframe with secedgar_dataframe_drop (when enabled), choose a different df_XXXXX_XXXXX name, or omit register_as.',
            },
          },
        },
      ),
    );
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT 1',
      register_as: 'df_ABCDE_12345',
    });

    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'register_as_clash',
        recovery: { hint: expect.stringContaining('secedgar_dataframe_drop') },
      },
    });
  });

  it('missing-table error from bridge surfaces missing_table reason (#47)', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    // Simulate the structured error thrown by canvas-bridge for a missing table
    mockBridge.query.mockRejectedValue(
      Object.assign(new Error('Catalog Error: Table with name df_QQQQQ_QQQQQ does not exist'), {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'missing_table',
          recovery: { hint: 'Use secedgar_dataframe_describe to list available dataframes.' },
        },
      }),
    );
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT * FROM df_QQQQQ_QQQQQ LIMIT 1' });

    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'missing_table' },
    });
  });

  it('system_catalog_access from the bridge surfaces reason + recovery hint on the wire (#47, #60)', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    // The bridge rebuilds framework system_catalog_access errors with the declared
    // recovery hint attached (#60); the handler passes them through untouched.
    mockBridge.query.mockRejectedValue(
      Object.assign(new Error('SQL references a denied system catalog: information_schema.'), {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'system_catalog_access',
          catalog: 'information_schema',
          recovery: {
            hint: 'Query only df_<id> tables. Use secedgar_dataframe_describe to list available dataframes.',
          },
        },
      }),
    );
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT * FROM information_schema.tables',
    });

    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'system_catalog_access',
        recovery: { hint: expect.stringContaining('secedgar_dataframe_describe') },
      },
    });
  });

  it('surfaces system_catalog_access reason when query targets information_schema (#22)', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    // The bridge query itself would throw via assertNoSystemCatalogAccess, simulate it
    mockBridge.query.mockRejectedValue(
      Object.assign(new Error('SQL references a denied system catalog: information_schema.'), {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'system_catalog_access',
          catalog: 'information_schema',
          recovery: { hint: 'Query only df_<id> tables.' },
        },
      }),
    );
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT * FROM information_schema.tables',
    });

    await expect(dataframeQueryTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'system_catalog_access' },
    });
  });

  it('returns query results', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    mockBridge.query.mockResolvedValue({
      result: {
        columns: ['id', 'name'],
        rowCount: 2,
        rows: [
          { id: '1', name: 'Apple' },
          { id: '2', name: 'NVIDIA' },
        ],
      },
      meta: undefined,
    });
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT id, name FROM df_ABC' });
    const result = await dataframeQueryTool.handler(input, ctx);

    expect(result.row_count).toBe(2);
    expect(result.columns).toEqual(['id', 'name']);
    expect(result.rows).toHaveLength(2);
  });

  it('populates enrichment notice when query returns 0 rows', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    mockBridge.query.mockResolvedValue({
      result: { columns: ['id'], rowCount: 0, rows: [] },
      meta: undefined,
    });
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT id FROM df_EMPTY WHERE 1=0' });
    await dataframeQueryTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('0 rows');
  });

  it('populates enrichment notice when results are capped', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    mockBridge.query.mockResolvedValue({
      result: {
        columns: ['id'],
        rowCount: 5000,
        rows: Array.from({ length: 1000 }, (_, i) => ({ id: String(i) })),
      },
      meta: undefined,
    });
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT id FROM df_BIG' });
    await dataframeQueryTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('1000 of 5000');
  });

  it('does not populate enrichment notice on normal results', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    mockBridge.query.mockResolvedValue({
      result: { columns: ['id'], rowCount: 3, rows: [{ id: '1' }, { id: '2' }, { id: '3' }] },
      meta: undefined,
    });
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({ sql: 'SELECT id FROM df_SMALL' });
    await dataframeQueryTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeUndefined();
  });

  it('register_as rejects names not matching df_XXXXX_XXXXX pattern (#53)', () => {
    // The Zod schema enforces the pattern at parse time — arbitrary names should never
    // reach DuckDB. register_as has never worked before (#53), so tightening breaks no one.
    expect(() =>
      dataframeQueryTool.input.parse({ sql: 'SELECT 1', register_as: 'aapl_big_years' }),
    ).toThrow();
    expect(() =>
      dataframeQueryTool.input.parse({ sql: 'SELECT 1', register_as: 'df_xxxxx_yyyyy' }),
    ).toThrow();
    expect(() =>
      dataframeQueryTool.input.parse({ sql: 'SELECT 1', register_as: 'df_ABCDE' }),
    ).toThrow();
    // Valid pattern passes
    expect(() =>
      dataframeQueryTool.input.parse({ sql: 'SELECT 1', register_as: 'df_ABCDE_12345' }),
    ).not.toThrow();
  });

  it('surfaces registered_as and expires_at when register_as is set (#28)', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    mockBridge.query.mockResolvedValue({
      result: {
        columns: ['rev_b', 'ticker'],
        rowCount: 2,
        rows: [
          { rev_b: 383.285, ticker: 'AAPL' },
          { rev_b: 211.915, ticker: 'MSFT' },
        ],
        tableName: 'df_NEW01_NEW02',
      },
      meta: { tableName: 'df_NEW01_NEW02', expiresAt: '2026-05-18T00:00:00.000Z' },
    });
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT CAST(value AS DOUBLE)/1e9 AS rev_b, ticker FROM df_A',
      register_as: 'df_NEW01_NEW02',
    });
    const result = await dataframeQueryTool.handler(input, ctx);

    expect(result.registered_as).toBe('df_NEW01_NEW02');
    expect(result.expires_at).toBe('2026-05-18T00:00:00.000Z');
  });

  it('formats results as a markdown table', async () => {
    const result = {
      columns: ['name', 'value'],
      row_count: 1,
      rows: [{ name: 'Apple', value: '100' }],
    };
    const blocks = dataframeQueryTool.format!(result);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('| name | value |');
    expect(blocks[0].text).toContain('Apple');
  });

  it('formats empty results with no-rows message', () => {
    const result = { columns: ['id'], row_count: 0, rows: [] };
    const blocks = dataframeQueryTool.format!(result);

    expect(blocks[0].text).toContain('No rows');
  });
});
