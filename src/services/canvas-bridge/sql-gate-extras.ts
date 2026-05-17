/**
 * @fileoverview Bridge-layer SQL gate additions on top of the framework's
 * read-only gate. The framework rejects writes, DDL, and external-data table
 * functions; this module additionally denies access to DuckDB system catalogs
 * (`information_schema`, `pg_catalog`, `sqlite_master`, `duckdb_*`) so callers
 * cannot enumerate every `df_<id>` on the shared canvas and bypass the
 * possession-required access model.
 * @module services/canvas-bridge/sql-gate-extras
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';

/**
 * Catalog identifiers that must not appear in a user-supplied SELECT. Tested
 * against the SQL with string literals stripped so a literal value
 * `'information_schema'` does not trip the gate.
 */
const FORBIDDEN_CATALOG_PATTERNS: ReadonlyArray<RegExp> = [
  /\binformation_schema\b/i,
  /\bpg_catalog\b/i,
  /\bsqlite_master\b/i,
  /\bduckdb_[a-z_]+\b/i,
];

/**
 * Strip single- and double-quoted string literals so catalog tokens embedded
 * in string constants do not cause false positives. Cheap heuristic — the
 * framework gate runs a real parser afterwards, this is a fast text gate.
 */
function stripStringLiterals(sql: string): string {
  return sql.replace(/'([^'\\]|\\.|'')*'/g, "''").replace(/"([^"\\]|\\.|"")*"/g, '""');
}

/**
 * Reject SELECTs that reference DuckDB system catalogs. Throws
 * `ValidationError` with `data.reason = 'system_catalog_access'`.
 */
export function assertNoSystemCatalogAccess(sql: string): void {
  const stripped = stripStringLiterals(sql);
  for (const pattern of FORBIDDEN_CATALOG_PATTERNS) {
    const match = stripped.match(pattern);
    if (match) {
      throw validationError(`SQL references a denied system catalog: ${match[0]}.`, {
        reason: 'system_catalog_access',
        catalog: match[0],
        recovery: {
          hint: 'Query only df_<id> tables. Use secedgar_dataframe_describe to list available dataframes.',
        },
      });
    }
  }
}
