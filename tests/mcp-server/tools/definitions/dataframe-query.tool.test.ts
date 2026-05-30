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
