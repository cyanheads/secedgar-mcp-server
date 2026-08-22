/**
 * @fileoverview Pins the one client-visible wire change in mcp-ts-core 0.12.0:
 *   tool input objects are strict at the root, so an argument key no tool
 *   declares is rejected by name instead of being silently stripped. Exercised
 *   through `runToolContract`, which runs the same validate → handle → format
 *   pipeline the transport does — the raw `definition.input` schema alone does
 *   not carry the strictness.
 * @module tests/mcp-server/tools/strict-inputs
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { searchConceptsTool } from '@/mcp-server/tools/definitions/search-concepts.tool.js';
import { blockText } from '../../support/assertions.js';

describe('strict tool inputs', () => {
  it('accepts a call using only declared keys', async () => {
    const result = await runToolContract(searchConceptsTool, { search: 'revenue' });

    expect(result.isError).toBeFalsy();
    expect(blockText(result.content)).toContain('revenue');
  });

  it('rejects an undeclared argument key by name instead of stripping it', async () => {
    // The cast is the point of the test: `limit` is not declared by the tool, so
    // the input type forbids it. Before 0.12.0 the key was dropped and the call
    // succeeded; it is now a validation failure naming the offending key.
    const undeclared = { search: 'revenue', limit: 5 } as unknown as z.input<
      typeof searchConceptsTool.input
    >;
    const result = await runToolContract(searchConceptsTool, undeclared);

    expect(result.isError).toBe(true);
    expect(blockText(result.content)).toContain('limit');
  });
});
