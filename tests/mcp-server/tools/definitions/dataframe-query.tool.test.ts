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
import { blockText } from '../../../support/assertions.js';

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
    // The cap is disclosed structurally, not only in the notice prose.
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(1000);
    expect(enrichment.cap).toBe(dataframeQueryTool.input.parse({ sql: 'SELECT 1' }).row_limit);
  });

  it('reports preview as the cap when it binds below row_limit', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    mockBridge.query.mockResolvedValue({
      result: {
        columns: ['id'],
        rowCount: 67,
        rows: Array.from({ length: 3 }, (_, i) => ({ id: String(i) })),
      },
      meta: undefined,
    });
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT id FROM df_MID',
      preview: 3,
      row_limit: 1000,
    });
    await dataframeQueryTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(3);
    // preview (3), not row_limit (1000), is what actually withheld the rows.
    expect(enrichment.cap).toBe(3);
    expect(enrichment.notice).toContain('raise preview');
  });

  it('reports row_limit as the cap when preview does not bind below it', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    mockBridge.query.mockResolvedValue({
      result: {
        columns: ['id'],
        rowCount: 5000,
        rows: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })),
      },
      meta: undefined,
    });
    const ctx = createMockContext({ errors: dataframeQueryTool.errors });
    // preview === row_limit is the boundary the canvas provider allows; it
    // rejects preview > rowLimit outright, so that combination never reaches here.
    const input = dataframeQueryTool.input.parse({
      sql: 'SELECT id FROM df_BIG',
      preview: 100,
      row_limit: 100,
    });
    await dataframeQueryTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.cap).toBe(100);
    expect(enrichment.notice).toContain('raise row_limit');
  });

  // (#109) `row_limit` is pushed into the query as the provider's `rowLimit`, so a
  // capped result comes back with `rowCount === rows.length` and the row arithmetic
  // cannot see it. `QueryResult.truncated` is the only signal, and when it is set
  // `rowCount` is the cap rather than a total — so the guidance must never print
  // "of {rowCount}". Each case below mirrors one row of the issue's truth table.
  describe('row_limit-bound truncation (#109)', () => {
    it('discloses truncation when row_limit bound and rowCount equals rows.length', async () => {
      vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
      mockBridge.query.mockResolvedValue({
        result: {
          columns: ['id'],
          rowCount: 3,
          rows: Array.from({ length: 3 }, (_, i) => ({ id: String(i) })),
          truncated: true,
        },
        meta: undefined,
      });
      const ctx = createMockContext({ errors: dataframeQueryTool.errors });
      const input = dataframeQueryTool.input.parse({ sql: 'SELECT * FROM df_BIG', row_limit: 3 });
      const result = await dataframeQueryTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.shown).toBe(3);
      expect(enrichment.cap).toBe(3);
      expect(enrichment.notice).toContain('row_limit');
      // rowCount is the cap here, so no "of 3 rows" total may be claimed.
      expect(enrichment.notice).not.toMatch(/of \d+ rows/);
      expect(result.row_count_capped).toBe(true);
    });

    it('names both ceilings when row_limit and preview bind on the same query', async () => {
      vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
      // row_limit=5 capped the query (truncated), preview=3 cut the inline rows further.
      mockBridge.query.mockResolvedValue({
        result: {
          columns: ['id'],
          rowCount: 5,
          rows: Array.from({ length: 3 }, (_, i) => ({ id: String(i) })),
          truncated: true,
        },
        meta: undefined,
      });
      const ctx = createMockContext({ errors: dataframeQueryTool.errors });
      const input = dataframeQueryTool.input.parse({
        sql: 'SELECT * FROM df_BIG',
        row_limit: 5,
        preview: 3,
      });
      const result = await dataframeQueryTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.shown).toBe(3);
      // preview is the ceiling that bound the inline list.
      expect(enrichment.cap).toBe(3);
      expect(enrichment.notice).toContain('preview');
      expect(enrichment.notice).toContain('row_limit');
      // 5 is the row_limit cap, not the size of the result — never presented as a total.
      expect(enrichment.notice).not.toContain('of 5');
      expect(result.row_count_capped).toBe(true);
    });

    it('stays silent when row_limit is above the true row count', async () => {
      vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
      mockBridge.query.mockResolvedValue({
        result: { columns: ['id'], rowCount: 2, rows: [{ id: '1' }, { id: '2' }] },
        meta: undefined,
      });
      const ctx = createMockContext({ errors: dataframeQueryTool.errors });
      const input = dataframeQueryTool.input.parse({ sql: 'SELECT * FROM df_SMALL' });
      const result = await dataframeQueryTool.handler(input, ctx);

      expect(getEnrichment(ctx).truncated).toBeUndefined();
      expect(result.row_count_capped).toBe(false);
    });

    it('stays silent for a caller-supplied LIMIT equal to row_limit (documented ambiguity)', async () => {
      vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
      // DuckDB cannot distinguish this from a table holding exactly 10 matching rows:
      // its own LIMIT bounds what the engine ever produces, so `truncated` stays unset.
      mockBridge.query.mockResolvedValue({
        result: {
          columns: ['id'],
          rowCount: 10,
          rows: Array.from({ length: 10 }, (_, i) => ({ id: String(i) })),
        },
        meta: undefined,
      });
      const ctx = createMockContext({ errors: dataframeQueryTool.errors });
      const input = dataframeQueryTool.input.parse({
        sql: 'SELECT * FROM df_BIG LIMIT 10',
        row_limit: 10,
      });
      const result = await dataframeQueryTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBeUndefined();
      expect(enrichment.notice).toBeUndefined();
      expect(result.row_count_capped).toBe(false);
    });

    it('keeps the exact-total wording on the register_as path, where truncated is never set', async () => {
      vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
      // registerAs materializes the whole result and counts it with COUNT(*), so
      // rowCount is exact and the fallback comparison stays load-bearing.
      mockBridge.query.mockResolvedValue({
        result: {
          columns: ['id'],
          rowCount: 67,
          rows: Array.from({ length: 3 }, (_, i) => ({ id: String(i) })),
          tableName: 'df_NEW01_NEW02',
        },
        meta: { tableName: 'df_NEW01_NEW02', expiresAt: '2026-05-18T00:00:00.000Z' },
      });
      const ctx = createMockContext({ errors: dataframeQueryTool.errors });
      const input = dataframeQueryTool.input.parse({
        sql: 'SELECT * FROM df_BIG',
        register_as: 'df_NEW01_NEW02',
        preview: 3,
      });
      const result = await dataframeQueryTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.notice).toContain('3 of 67');
      expect(result.row_count_capped).toBe(false);
    });

    it('stays silent when a register_as query is fully materialized within the preview', async () => {
      vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
      mockBridge.query.mockResolvedValue({
        result: {
          columns: ['id'],
          rowCount: 3,
          rows: [{ id: '1' }, { id: '2' }, { id: '3' }],
          tableName: 'df_NEW01_NEW02',
        },
        meta: { tableName: 'df_NEW01_NEW02', expiresAt: '2026-05-18T00:00:00.000Z' },
      });
      const ctx = createMockContext({ errors: dataframeQueryTool.errors });
      const input = dataframeQueryTool.input.parse({
        sql: 'SELECT * FROM df_SMALL',
        register_as: 'df_NEW01_NEW02',
      });
      await dataframeQueryTool.handler(input, ctx);

      expect(getEnrichment(ctx).truncated).toBeUndefined();
    });

    it('stays silent on an aggregate producing fewer rows than any cap', async () => {
      vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
      mockBridge.query.mockResolvedValue({
        result: { columns: ['count'], rowCount: 1, rows: [{ count: '4200' }] },
        meta: undefined,
      });
      const ctx = createMockContext({ errors: dataframeQueryTool.errors });
      const input = dataframeQueryTool.input.parse({ sql: 'SELECT COUNT(*) AS count FROM df_BIG' });
      await dataframeQueryTool.handler(input, ctx);

      expect(getEnrichment(ctx).truncated).toBeUndefined();
    });

    it('keeps the empty-result notice untouched when the cap never bound', async () => {
      vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
      mockBridge.query.mockResolvedValue({
        result: { columns: ['id'], rowCount: 0, rows: [] },
        meta: undefined,
      });
      const ctx = createMockContext({ errors: dataframeQueryTool.errors });
      const input = dataframeQueryTool.input.parse({
        sql: 'SELECT id FROM df_BIG OFFSET 9999',
      });
      const result = await dataframeQueryTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('0 rows');
      expect(enrichment.truncated).toBeUndefined();
      expect(result.row_count_capped).toBe(false);
    });

    it('carries the cap disclosure into format() output, without claiming a total', () => {
      // content[]-only clients read format(); row_count is the cap in this state, so
      // the header must not present it as the size of the result.
      const blocks = dataframeQueryTool.format!({
        columns: ['id'],
        row_count: 3,
        row_count_capped: true,
        rows: [{ id: '1' }, { id: '2' }, { id: '3' }],
      });

      const text = blockText(blocks);
      expect(text).toContain('row_limit');
      expect(text).not.toContain('showing 3 of 3');
    });

    it('names the cap, not a total, in format() when row_limit and preview both bind', () => {
      // row_limit=5 capped the query and preview=3 cut further: row_count is the
      // cap, so the "of M" wording the preview-only branch uses must not appear.
      const blocks = dataframeQueryTool.format!({
        columns: ['id'],
        row_count: 5,
        row_count_capped: true,
        rows: [{ id: '1' }, { id: '2' }, { id: '3' }],
      });

      const text = blockText(blocks);
      expect(text).toContain('capped at row_limit');
      expect(text).toContain('showing 3');
      expect(text).not.toContain('of 5');
    });

    it('keeps the of-total wording in format() when the count is exact', () => {
      const blocks = dataframeQueryTool.format!({
        columns: ['id'],
        row_count: 67,
        row_count_capped: false,
        rows: [{ id: '1' }, { id: '2' }, { id: '3' }],
      });

      expect(blockText(blocks)).toContain('showing 3 of 67');
    });
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
    expect(enrichment.truncated).toBeUndefined();
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
      row_count_capped: false,
      rows: [{ name: 'Apple', value: '100' }],
    };
    const blocks = dataframeQueryTool.format!(result);

    expect(blocks).toHaveLength(1);
    expect(blockText(blocks)).toContain('| name | value |');
    expect(blockText(blocks)).toContain('Apple');
  });

  it('formats empty results with no-rows message', () => {
    const result = { columns: ['id'], row_count: 0, row_count_capped: false, rows: [] };
    const blocks = dataframeQueryTool.format!(result);

    expect(blockText(blocks)).toContain('No rows');
  });
});
