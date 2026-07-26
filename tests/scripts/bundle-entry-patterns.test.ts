/**
 * @fileoverview Guards the two bundle-entry patterns that `scripts/clean-mcpb.ts`
 * (the strip step) and `scripts/lint-packaging.ts` (the post-bundle content check)
 * each declare. They must stay identical: if the linter's pattern is narrower than
 * the stripper's, the check passes on a bundle that still ships the entries; if it
 * is wider, every bundle fails the check. Both files' JSDoc points at this test.
 * @module tests/scripts/bundle-entry-patterns
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY as CLEAN_AGENT_DOC,
  NATIVE_BINDING_ENTRY as CLEAN_NATIVE_BINDING,
  filterAgentDocEntries,
  filterNativeBindingEntries,
} from '../../scripts/clean-mcpb.js';
import {
  AGENT_DOC_ENTRY as LINT_AGENT_DOC,
  NATIVE_BINDING_ENTRY as LINT_NATIVE_BINDING,
} from '../../scripts/lint-packaging.js';

describe('bundle entry patterns', () => {
  it('declares the same AGENT_DOC_ENTRY in both scripts', () => {
    expect(LINT_AGENT_DOC.source).toBe(CLEAN_AGENT_DOC.source);
    expect(LINT_AGENT_DOC.flags).toBe(CLEAN_AGENT_DOC.flags);
  });

  it('declares the same NATIVE_BINDING_ENTRY in both scripts', () => {
    expect(LINT_NATIVE_BINDING.source).toBe(CLEAN_NATIVE_BINDING.source);
    expect(LINT_NATIVE_BINDING.flags).toBe(CLEAN_NATIVE_BINDING.flags);
  });

  it('matches dependency-shipped agent docs and leaves project files alone', () => {
    expect(
      filterAgentDocEntries([
        'node_modules/@cyanheads/mcp-ts-core/skills/add-tool/SKILL.md',
        'node_modules/some-dep/.claude/settings.json',
        'node_modules/some-dep/.agents/skills/x.md',
        'node_modules/some-dep/SKILL.md',
        'dist/index.js',
        'skills/add-tool/SKILL.md',
      ]),
    ).toEqual([
      'node_modules/@cyanheads/mcp-ts-core/skills/add-tool/SKILL.md',
      'node_modules/some-dep/.claude/settings.json',
      'node_modules/some-dep/.agents/skills/x.md',
      'node_modules/some-dep/SKILL.md',
    ]);
  });

  it('matches platform-specific native bindings only', () => {
    expect(
      filterNativeBindingEntries([
        'node_modules/@duckdb/node-bindings-darwin-arm64/duckdb.node',
        'node_modules/@duckdb/node-api/lib/index.js',
        'dist/index.js',
      ]),
    ).toEqual(['node_modules/@duckdb/node-bindings-darwin-arm64/duckdb.node']);
  });
});
