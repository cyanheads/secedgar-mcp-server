/**
 * @fileoverview Tests for the bridge-layer system-catalog deny that sits on
 * top of the framework SQL gate.
 * @module tests/services/canvas-bridge/sql-gate-extras
 */

import { describe, expect, it } from 'vitest';
import { assertNoSystemCatalogAccess } from '@/services/canvas-bridge/sql-gate-extras.js';

describe('assertNoSystemCatalogAccess', () => {
  it('allows ordinary SELECTs against df_ tables', () => {
    expect(() => assertNoSystemCatalogAccess('SELECT * FROM df_ABCDE_FGHIJ')).not.toThrow();
    expect(() =>
      assertNoSystemCatalogAccess(
        "SELECT loc, COUNT(*) FROM df_ABC WHERE loc LIKE 'US-%' GROUP BY loc",
      ),
    ).not.toThrow();
  });

  it('rejects information_schema', () => {
    expect(() => assertNoSystemCatalogAccess('SELECT * FROM information_schema.tables')).toThrow(
      /system catalog/i,
    );
  });

  it('rejects pg_catalog', () => {
    expect(() => assertNoSystemCatalogAccess('SELECT * FROM pg_catalog.pg_tables')).toThrow(
      /system catalog/i,
    );
  });

  it('rejects sqlite_master', () => {
    expect(() => assertNoSystemCatalogAccess('SELECT * FROM sqlite_master')).toThrow(
      /system catalog/i,
    );
  });

  it('rejects duckdb_tables() table function', () => {
    expect(() => assertNoSystemCatalogAccess('SELECT * FROM duckdb_tables()')).toThrow(
      /system catalog/i,
    );
  });

  it('rejects duckdb_columns reference', () => {
    expect(() => assertNoSystemCatalogAccess('SELECT column_name FROM duckdb_columns')).toThrow(
      /system catalog/i,
    );
  });

  it('rejects when catalog name appears in any case', () => {
    expect(() => assertNoSystemCatalogAccess('SELECT * FROM INFORMATION_SCHEMA.TABLES')).toThrow(
      /system catalog/i,
    );
  });

  it('tolerates catalog tokens inside string literals', () => {
    expect(() =>
      assertNoSystemCatalogAccess(
        "SELECT * FROM df_ABCDE_FGHIJ WHERE entity_name LIKE '%information_schema%'",
      ),
    ).not.toThrow();
  });

  it('attaches structured data.reason on rejection', () => {
    try {
      assertNoSystemCatalogAccess('SELECT * FROM information_schema.tables');
      expect.fail('expected throw');
    } catch (err) {
      expect((err as { data?: { reason?: string } }).data?.reason).toBe('system_catalog_access');
    }
  });

  it('attaches recovery hint pointing to dataframe_describe', () => {
    try {
      assertNoSystemCatalogAccess('SELECT * FROM duckdb_views');
      expect.fail('expected throw');
    } catch (err) {
      const data = (err as { data?: { recovery?: { hint?: string } } }).data;
      expect(data?.recovery?.hint).toMatch(/secedgar_dataframe_describe/);
    }
  });
});
