/**
 * @fileoverview Tests for the bridge-layer SQL utility — `stripStringLiterals`.
 * System-catalog denial is now delegated to the framework via
 * `QueryOptions.denySystemCatalogs` (added in mcp-ts-core 0.10.4); the
 * `assertNoSystemCatalogAccess` function was removed from this module.
 * Catalog-denial behavior is exercised by the bridge integration tests.
 * @module tests/services/canvas-bridge/sql-gate-extras
 */

import { describe, expect, it } from 'vitest';
import { stripStringLiterals } from '@/services/canvas-bridge/sql-gate-extras.js';

describe('stripStringLiterals', () => {
  it('passes plain SQL through unchanged (no literals)', () => {
    const sql = 'SELECT * FROM df_ABCDE_FGHIJ';
    expect(stripStringLiterals(sql)).toBe(sql);
  });

  it('strips single-quoted literals to empty single-quoted strings', () => {
    const result = stripStringLiterals(
      "SELECT * FROM df_ABCDE_FGHIJ WHERE entity_name LIKE '%information_schema%'",
    );
    expect(result).not.toContain('information_schema');
    expect(result).toContain("''");
  });

  it('strips double-quoted identifiers to empty double-quoted strings', () => {
    const result = stripStringLiterals('SELECT "information_schema" FROM df_ABCDE_FGHIJ');
    expect(result).not.toContain('information_schema');
    expect(result).toContain('""');
  });

  it('handles escaped quotes inside literals', () => {
    const result = stripStringLiterals("SELECT * FROM df_A WHERE x = 'it\\'s a test'");
    expect(result).toContain("''");
  });

  it('preserves df_<id> handles outside literals', () => {
    const result = stripStringLiterals(
      "SELECT * FROM df_ABCDE_FGHIJ WHERE note = 'see df_OLD01_OLD02'",
    );
    // The real df_ in FROM is preserved; the one inside the string is stripped.
    expect(result).toContain('df_ABCDE_FGHIJ');
    expect(result).not.toContain('df_OLD01_OLD02');
  });
});
