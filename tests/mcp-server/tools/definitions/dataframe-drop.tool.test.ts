/**
 * @fileoverview Tests for dataframe-drop tool — drop a named canvas dataframe.
 * @module tests/mcp-server/tools/definitions/dataframe-drop.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
}));

import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { bag, blockText, wireError } from '../../../support/assertions.js';

const mockBridge = {
  drop: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dataframeDropTool', () => {
  it('throws canvas_unavailable when no bridge is configured', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);
    const ctx = createMockContext({ errors: dataframeDropTool.errors });
    const input = dataframeDropTool.input.parse({ name: 'df_ABCDE_FGHIJ' });

    await expect(dataframeDropTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'canvas_unavailable' },
    });
  });

  it('names the npm/Docker switch and the MCPB bundle in the canvas_unavailable recovery, on both surfaces', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);
    const result = await runToolContract(dataframeDropTool, { name: 'df_ABCDE_FGHIJ' });

    const hint = String(bag(wireError(result).data.recovery).hint);
    expect(hint).toBe(
      'Dataframes need the DuckDB canvas. On an npm or Docker install, set CANVAS_PROVIDER_TYPE=duckdb (the default when unset) and restart the server; the MCPB bundle ships without DuckDB, so there the data tools return their results inline and stage no dataframe.',
    );
    expect(blockText(result.content)).toContain(hint);
  });

  it('returns dropped=true when the dataframe exists and is removed', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    mockBridge.drop.mockResolvedValue(true);

    const ctx = createMockContext({ errors: dataframeDropTool.errors });
    const input = dataframeDropTool.input.parse({ name: 'df_ABCDE_FGHIJ' });
    const result = await dataframeDropTool.handler(input, ctx);

    expect(result.dropped).toBe(true);
    expect(result.name).toBe('df_ABCDE_FGHIJ');
    expect(mockBridge.drop).toHaveBeenCalledWith(ctx, 'df_ABCDE_FGHIJ');
  });

  it('returns dropped=false when the dataframe is not found (idempotent)', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    mockBridge.drop.mockResolvedValue(false);

    const ctx = createMockContext({ errors: dataframeDropTool.errors });
    const input = dataframeDropTool.input.parse({ name: 'df_NOTHI_NGHERE' });
    const result = await dataframeDropTool.handler(input, ctx);

    expect(result.dropped).toBe(false);
    expect(result.name).toBe('df_NOTHI_NGHERE');
  });

  it('validates that name must be non-empty', () => {
    expect(() => dataframeDropTool.input.parse({ name: '' })).toThrow();
  });

  it('formats dropped=true as confirmation message', () => {
    const result = { name: 'df_ABCDE_FGHIJ', dropped: true };
    const blocks = dataframeDropTool.format!(result);
    expect(blocks).toHaveLength(1);
    expect(blockText(blocks)).toContain('Dropped');
    expect(blockText(blocks)).toContain('df_ABCDE_FGHIJ');
  });

  it('formats dropped=false as not-found message', () => {
    const result = { name: 'df_NOTHI_NGHERE', dropped: false };
    const blocks = dataframeDropTool.format!(result);
    expect(blocks).toHaveLength(1);
    expect(blockText(blocks)).toContain('not found');
    expect(blockText(blocks)).toContain('df_NOTHI_NGHERE');
  });

  it('calls bridge.drop with the exact name from input', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    mockBridge.drop.mockResolvedValue(true);

    const ctx = createMockContext({ errors: dataframeDropTool.errors });
    const input = dataframeDropTool.input.parse({ name: 'df_AAAAA_BBBBB' });
    await dataframeDropTool.handler(input, ctx);

    expect(mockBridge.drop).toHaveBeenCalledOnce();
    expect(mockBridge.drop).toHaveBeenCalledWith(ctx, 'df_AAAAA_BBBBB');
  });
});
