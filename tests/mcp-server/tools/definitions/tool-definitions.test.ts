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
    const off = buildToolDefinitions({ dropEnabled: false });
    const on = buildToolDefinitions({ dropEnabled: true });

    expect(off).toHaveLength(17);
    expect(on).toHaveLength(17);
    expect(off.map((def) => def.name)).toEqual(on.map((def) => def.name));
    expect(off.map((def) => def.name)).toContain('secedgar_dataframe_drop');
  });

  it('registers no duplicate tool names', () => {
    const names = buildToolDefinitions({ dropEnabled: false }).map((def) => def.name);

    expect(new Set(names).size).toBe(names.length);
  });

  describe('with EDGAR_DATAFRAME_DROP_ENABLED off', () => {
    const defs = buildToolDefinitions({ dropEnabled: false });
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

  describe('with EDGAR_DATAFRAME_DROP_ENABLED on', () => {
    const defs = buildToolDefinitions({ dropEnabled: true });

    it('registers secedgar_dataframe_drop live, with no disabled marker', () => {
      const drop = defs.find((def) => def.name === 'secedgar_dataframe_drop');

      expect(drop).toBe(dataframeDropTool);
      expect(disabledMarkerOf(drop)).toBeUndefined();
      expect(registeredNames(defs)).toHaveLength(17);
    });
  });
});
