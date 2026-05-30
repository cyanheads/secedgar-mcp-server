/**
 * @fileoverview Tests for dataframe-describe tool — list canvas dataframes with provenance and schema.
 * @module tests/mcp-server/tools/definitions/dataframe-describe.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
}));

import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

const mockBridge = {
  describe: vi.fn(),
};

const sampleMeta = {
  tableName: 'df_ABCDE_FGHIJ',
  sourceTool: 'secedgar_fetch_frames',
  queryParams: { concept: 'revenue', period: 'CY2023' },
  createdAt: '2026-05-01T00:00:00.000Z',
  expiresAt: '2026-05-02T00:00:00.000Z',
  rowCount: 3131,
  truncated: false,
  maxRows: undefined,
  columnSchema: [
    { name: 'cik', type: 'VARCHAR', nullable: true },
    { name: 'value', type: 'BIGINT', nullable: true },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dataframeDescribeTool', () => {
  it('throws canvas_unavailable when no bridge is configured', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);
    const ctx = createMockContext({ errors: dataframeDescribeTool.errors });
    const input = dataframeDescribeTool.input.parse({});

    await expect(dataframeDescribeTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_unavailable' },
    });
  });

  it('returns all dataframes when bridge has entries', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    mockBridge.describe.mockResolvedValue([sampleMeta]);

    const ctx = createMockContext({ errors: dataframeDescribeTool.errors });
    const input = dataframeDescribeTool.input.parse({});
    const result = await dataframeDescribeTool.handler(input, ctx);

    expect(result.dataframes).toHaveLength(1);
    const df = result.dataframes[0]!;
    expect(df.name).toBe('df_ABCDE_FGHIJ');
    expect(df.source_tool).toBe('secedgar_fetch_frames');
    expect(df.row_count).toBe(3131);
    expect(df.truncated).toBe(false);
    expect(df.max_rows).toBeUndefined();
    expect(df.column_schema).toHaveLength(2);
    expect(df.column_schema[0]).toMatchObject({ name: 'cik', type: 'VARCHAR', nullable: true });
  });

  it('returns empty array when no dataframes exist', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    mockBridge.describe.mockResolvedValue([]);

    const ctx = createMockContext({ errors: dataframeDescribeTool.errors });
    const input = dataframeDescribeTool.input.parse({});
    const result = await dataframeDescribeTool.handler(input, ctx);

    expect(result.dataframes).toHaveLength(0);
  });

  it('passes name filter to bridge describe when specified', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    mockBridge.describe.mockResolvedValue([sampleMeta]);

    const ctx = createMockContext({ errors: dataframeDescribeTool.errors });
    const input = dataframeDescribeTool.input.parse({ name: 'df_ABCDE_FGHIJ' });
    await dataframeDescribeTool.handler(input, ctx);

    expect(mockBridge.describe).toHaveBeenCalledWith(ctx, 'df_ABCDE_FGHIJ');
  });

  it('passes undefined to bridge describe when name is omitted', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    mockBridge.describe.mockResolvedValue([sampleMeta]);

    const ctx = createMockContext({ errors: dataframeDescribeTool.errors });
    const input = dataframeDescribeTool.input.parse({});
    await dataframeDescribeTool.handler(input, ctx);

    expect(mockBridge.describe).toHaveBeenCalledWith(ctx, undefined);
  });

  it('maps truncated and max_rows fields correctly', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    mockBridge.describe.mockResolvedValue([{ ...sampleMeta, truncated: true, maxRows: 5000 }]);

    const ctx = createMockContext({ errors: dataframeDescribeTool.errors });
    const input = dataframeDescribeTool.input.parse({});
    const result = await dataframeDescribeTool.handler(input, ctx);

    expect(result.dataframes[0]!.truncated).toBe(true);
    expect(result.dataframes[0]!.max_rows).toBe(5000);
  });

  it('preserves query_params from meta', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    const params = { concept: 'assets', period: 'CY2024Q1I', unit: 'USD' };
    mockBridge.describe.mockResolvedValue([{ ...sampleMeta, queryParams: params }]);

    const ctx = createMockContext({ errors: dataframeDescribeTool.errors });
    const input = dataframeDescribeTool.input.parse({});
    const result = await dataframeDescribeTool.handler(input, ctx);

    expect(result.dataframes[0]!.query_params).toEqual(params);
  });

  it('formats empty dataframes list with no-active message', () => {
    const result = { dataframes: [] };
    const blocks = dataframeDescribeTool.format!(result);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('No active dataframes.');
  });

  it('formats single dataframe with provenance and schema', () => {
    const result = {
      dataframes: [
        {
          name: 'df_ABCDE_FGHIJ',
          source_tool: 'secedgar_fetch_frames',
          query_params: { concept: 'revenue', period: 'CY2023' },
          created_at: '2026-05-01T00:00:00.000Z',
          expires_at: '2026-05-02T00:00:00.000Z',
          row_count: 3131,
          truncated: false,
          max_rows: undefined,
          column_schema: [{ name: 'cik', type: 'VARCHAR', nullable: true }],
        },
      ],
    };
    const blocks = dataframeDescribeTool.format!(result);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('1 active dataframe(s)');
    expect(blocks[0].text).toContain('df_ABCDE_FGHIJ');
    expect(blocks[0].text).toContain('secedgar_fetch_frames');
    expect(blocks[0].text).toContain('3131');
    expect(blocks[0].text).toContain('cik:VARCHAR');
  });

  it('format renders truncated indicator when truncated=true', () => {
    const result = {
      dataframes: [
        {
          name: 'df_XXXXX_YYYYY',
          source_tool: 'secedgar_get_financials',
          query_params: {},
          created_at: '2026-05-01T00:00:00.000Z',
          expires_at: '2026-05-02T00:00:00.000Z',
          row_count: 1000,
          truncated: true,
          max_rows: 1000,
          column_schema: [],
        },
      ],
    };
    const blocks = dataframeDescribeTool.format!(result);
    expect(blocks[0].text).toContain('truncated');
    expect(blocks[0].text).toContain('at 1000');
  });

  it('format renders multiple dataframes with section headers', () => {
    const df = (name: string) => ({
      name,
      source_tool: 'secedgar_fetch_frames',
      query_params: {},
      created_at: '2026-05-01T00:00:00.000Z',
      expires_at: '2026-05-02T00:00:00.000Z',
      row_count: 100,
      truncated: false,
      max_rows: undefined,
      column_schema: [],
    });
    const result = {
      dataframes: [df('df_AAAAA_11111'), df('df_BBBBB_22222')],
    };
    const blocks = dataframeDescribeTool.format!(result);
    expect(blocks[0].text).toContain('2 active dataframe(s)');
    expect(blocks[0].text).toContain('df_AAAAA_11111');
    expect(blocks[0].text).toContain('df_BBBBB_22222');
  });
});
