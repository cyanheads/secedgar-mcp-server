/**
 * @fileoverview Tests for dataframe-describe tool — list canvas dataframes with provenance and schema.
 * @module tests/mcp-server/tools/definitions/dataframe-describe.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
}));

import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { at, bag, blockText, wireError } from '../../../support/assertions.js';
import { readCommonMark } from '../../../support/commonmark.js';

const mockBridge = {
  describe: vi.fn(),
  listingEnabled: true,
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
  mockBridge.listingEnabled = true;
});

describe('listing every dataframe (#242)', () => {
  describe('refused where callers share one canvas (HTTP with auth none)', () => {
    beforeEach(() => {
      mockBridge.listingEnabled = false;
      vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    });

    it.each([{}, { name: '' }])(
      'fails %j as listing_unavailable on both surfaces, reading nothing',
      async (input) => {
        const result = await runToolContract(dataframeDescribeTool, input);

        const error = wireError(result);
        expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
        expect(error.data.reason).toBe('listing_unavailable');
        const hint = String(bag(error.data.recovery).hint);
        expect(hint).toBe(
          'Pass the exact df_XXXXX_XXXXX name the producing tool returned in its `dataset` field, or the register_as name you chose; this deployment does not list dataframes.',
        );
        const text = readCommonMark(blockText(result.content));
        expect(text).toContain(
          'Listing dataframes is refused over HTTP with auth none: every caller of this deployment shares one canvas.',
        );
        expect(text).toContain(`Recovery: ${hint}`);
        expect(mockBridge.describe).not.toHaveBeenCalled();
      },
    );

    it('describes a dataframe by name', async () => {
      mockBridge.describe.mockResolvedValue([sampleMeta]);

      const result = await runToolContract(dataframeDescribeTool, { name: 'df_ABCDE_FGHIJ' });

      expect(result.isError).toBeFalsy();
      expect(mockBridge.describe).toHaveBeenCalledWith(expect.anything(), 'df_ABCDE_FGHIJ');
      const output = dataframeDescribeTool.output.parse(result.structuredContent);
      expect(output.dataframes.map((df) => df.name)).toEqual(['df_ABCDE_FGHIJ']);
      expect(blockText(result.content)).toContain('### df_ABCDE_FGHIJ');
    });

    it('declares the refusal as a notice-level Forbidden', () => {
      const entry = dataframeDescribeTool.errors?.find((e) => e.reason === 'listing_unavailable');
      expect(entry).toMatchObject({ code: JsonRpcErrorCode.Forbidden, severity: 'notice' });
    });
  });

  describe('allowed on stdio and authenticated HTTP', () => {
    beforeEach(() => {
      vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
      mockBridge.describe.mockResolvedValue([sampleMeta]);
    });

    it.each([{}, { name: '' }])('lists %j as every active dataframe', async (input) => {
      const result = await runToolContract(dataframeDescribeTool, input);

      expect(result.isError).toBeFalsy();
      expect(mockBridge.describe).toHaveBeenCalledWith(expect.anything(), undefined);
      const output = dataframeDescribeTool.output.parse(result.structuredContent);
      expect(output.dataframes.map((df) => df.name)).toEqual(['df_ABCDE_FGHIJ']);
    });
  });
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

  it('names the npm/Docker switch and the MCPB bundle in the canvas_unavailable recovery, on both surfaces', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(undefined);
    const result = await runToolContract(dataframeDescribeTool, {});

    const hint = String(bag(wireError(result).data.recovery).hint);
    expect(hint).toBe(
      'Dataframes need the DuckDB canvas. On an npm or Docker install, set CANVAS_PROVIDER_TYPE=duckdb (the default when unset) and restart the server; the MCPB bundle ships without DuckDB, so there the data tools return their results inline and stage no dataframe.',
    );
    expect(blockText(result.content)).toContain(hint);
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
    expect(blockText(blocks)).toBe('No active dataframes.');
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
    expect(blockText(blocks)).toContain('1 active dataframe(s)');
    expect(blockText(blocks)).toContain('df_ABCDE_FGHIJ');
    expect(blockText(blocks)).toContain('secedgar_fetch_frames');
    expect(blockText(blocks)).toContain('3131');
    expect(blockText(blocks)).toContain('cik:VARCHAR');
  });

  it('renders each staged parameter as a code span and each column escaped, reading back as structuredContent (#221)', async () => {
    // A register_as table: its query_params hold the caller's SQL, its columns the caller's aliases.
    vi.mocked(getCanvasBridge).mockReturnValue(mockBridge as any);
    mockBridge.describe.mockResolvedValue([
      {
        ...sampleMeta,
        sourceTool: 'secedgar_dataframe_query',
        queryParams: {
          query: '"US BANCORP"',
          forms: ['10-K'],
          name: 'US BANCORP \\DE\\',
          sql: 'SELECT `a` AS "a*b*" FROM df_ABCDE_FGHIJ',
        },
        columnSchema: [
          { name: 'a*b*', type: 'INTEGER', nullable: true },
          { name: '<b>x</b>', type: 'STRUCT("[x](y)" VARCHAR)', nullable: true },
        ],
      },
    ]);

    const result = await runToolContract(dataframeDescribeTool, {});

    expect(result.isError).toBeFalsy();
    const df = at(dataframeDescribeTool.output.parse(result.structuredContent).dataframes);
    expect(df.query_params.query).toBe('"US BANCORP"');
    // The copy-back JSON of each value reads back as the code span's text.
    const params = Object.entries(df.query_params)
      .map(([key, value]) => `${key}=⟨code_inline:${JSON.stringify(value)}⟩`)
      .join(', ');
    const columns = df.column_schema
      .map((c) => `${c.name}:${c.type} (nullable=${c.nullable})`)
      .join(', ');
    const parsed = readCommonMark(blockText(result.content)).split('\n\n');
    expect(parsed).toContain(`Params: ${params}`);
    expect(parsed).toContain(`Columns: ${columns}`);
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
    expect(blockText(blocks)).toContain('truncated');
    expect(blockText(blocks)).toContain('at 1000');
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
    expect(blockText(blocks)).toContain('2 active dataframe(s)');
    expect(blockText(blocks)).toContain('df_AAAAA_11111');
    expect(blockText(blocks)).toContain('df_BBBBB_22222');
  });
});
