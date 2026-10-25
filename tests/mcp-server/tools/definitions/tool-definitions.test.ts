/**
 * @fileoverview Pins the registration list `createApp()` receives, and what the
 *   `EDGAR_DATAFRAME_DROP_ENABLED` gate does to it (#103). The list is the input
 *   to both discovery paths: `ToolRegistry.registerAll` skips every entry
 *   carrying the disabled marker (so it never reaches `tools/list` or
 *   `tools/call`), while `buildServerManifest()` includes every entry passed to
 *   `createApp({ tools })` and spreads the marker onto the row as `disabled`,
 *   which the HTML landing page renders as its muted `disabled` group. Neither
 *   function is exported by `@cyanheads/mcp-ts-core` 0.12.8, so the marker both
 *   of them read is what these tests assert on.
 * @module tests/mcp-server/tools/definitions/tool-definitions
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/dataframe-drop.tool.js';
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

/**
 * The marker `disabledTool()` attaches and `getDisabledMetadata()` reads. The
 * framework keeps it off the public `ToolDefinition` interface (internal to the
 * registry, manifest, and landing renderer), so the key is named here rather
 * than imported.
 */
const DISABLED_KEY = '__mcpDisabled';

interface DisabledMarker {
  hint?: string;
  reason: string;
  since?: string;
}

function disabledMarkerOf(def: unknown): DisabledMarker | undefined {
  return (def as Record<string, DisabledMarker | undefined>)[DISABLED_KEY];
}

/** Entries `ToolRegistry.registerAll` actually registers — the `tools/list` set. */
function registeredNames(defs: readonly { name: string }[]): string[] {
  return defs.filter((def) => disabledMarkerOf(def) === undefined).map((def) => def.name);
}

describe('buildToolDefinitions', () => {
  it('lists every tool in both gate states, so the manifest count does not vary', () => {
    const off = buildToolDefinitions({ dropEnabled: false, clampOversizedLimits: true });
    const on = buildToolDefinitions({ dropEnabled: true, clampOversizedLimits: true });

    expect(off).toHaveLength(17);
    expect(on).toHaveLength(17);
    expect(off.map((def) => def.name)).toEqual(on.map((def) => def.name));
    expect(off.map((def) => def.name)).toContain('secedgar_dataframe_drop');
  });

  it('registers no duplicate tool names', () => {
    const names = buildToolDefinitions({ dropEnabled: false, clampOversizedLimits: true }).map(
      (def) => def.name,
    );

    expect(new Set(names).size).toBe(names.length);
  });

  describe('with EDGAR_DATAFRAME_DROP_ENABLED off', () => {
    const defs = buildToolDefinitions({ dropEnabled: false, clampOversizedLimits: true });
    const drop = defs.find((def) => def.name === 'secedgar_dataframe_drop');

    it('keeps secedgar_dataframe_drop out of the registered set', () => {
      const registered = registeredNames(defs);

      expect(registered).toHaveLength(16);
      expect(registered).not.toContain('secedgar_dataframe_drop');
      // Every other tool stays live.
      expect(registered).toContain('secedgar_dataframe_query');
      expect(registered).toContain('secedgar_dataframe_describe');
    });

    it('carries an operator-facing reason and the env var that enables it', () => {
      const marker = disabledMarkerOf(drop);

      expect(marker?.reason).toEqual(expect.any(String));
      expect(marker?.reason.length).toBeGreaterThan(20);
      expect(marker?.hint).toBe('EDGAR_DATAFRAME_DROP_ENABLED=true');
    });

    it('preserves the definition it wraps, so the tool is intact when re-enabled', () => {
      expect(drop?.name).toBe(dataframeDropTool.name);
      expect(drop?.handler).toBe(dataframeDropTool.handler);
      expect(drop?.input).toBe(dataframeDropTool.input);
      expect(drop?.errors).toBe(dataframeDropTool.errors);
    });
  });

  // Every #197 row as registered: the switch picks the advertised maximum, so a
  // tool listed through its plain definition instead of its factory fails here.
  describe('EDGAR_CLAMP_OVERSIZED_LIMITS maxima (#197)', () => {
    const rows = [
      ['secedgar_company_search', 'filing_limit', 50, 1000],
      ['secedgar_search_filings', 'limit', 100, 1000],
      ['secedgar_get_filing', 'content_limit', 200_000, 1_000_000],
      ['secedgar_get_material_events', 'limit', 100, 1000],
      ['secedgar_get_insider_transactions', 'limit', 100, 1000],
      ['secedgar_get_institutional_holdings', 'limit', 500, 1000],
      ['secedgar_find_holders', 'limit', 100, 1000],
      ['secedgar_get_beneficial_owners', 'limit', 20, 1000],
      ['secedgar_get_fund_holdings', 'limit', 100, 1000],
      ['secedgar_fetch_frames', 'limit', 100, 1000],
      ['secedgar_compare_companies', 'periods', 12, 1000],
      ['secedgar_dataframe_query', 'row_limit', 10_000, 100_000],
      ['secedgar_dataframe_query', 'preview', 10_000, 100_000],
    ] as const;

    const maximum = (clampOversizedLimits: boolean, name: string, field: string) => {
      const def = buildToolDefinitions({ dropEnabled: false, clampOversizedLimits }).find(
        (d) => d.name === name,
      );
      const schema = z.toJSONSchema(def!.input, { io: 'input' }) as {
        properties: Record<string, { maximum?: number }>;
      };
      return schema.properties[field]?.maximum;
    };

    it.each(rows)('%s %s advertises its cap off and its bound on', (name, field, cap, bound) => {
      expect(maximum(false, name, field)).toBe(cap);
      expect(maximum(true, name, field)).toBe(bound);
    });
  });

  describe('with EDGAR_DATAFRAME_DROP_ENABLED on', () => {
    const defs = buildToolDefinitions({ dropEnabled: true, clampOversizedLimits: true });

    it('registers secedgar_dataframe_drop live, with no disabled marker', () => {
      const drop = defs.find((def) => def.name === 'secedgar_dataframe_drop');

      expect(drop).toBe(dataframeDropTool);
      expect(disabledMarkerOf(drop)).toBeUndefined();
      expect(registeredNames(defs)).toHaveLength(17);
    });
  });
});
