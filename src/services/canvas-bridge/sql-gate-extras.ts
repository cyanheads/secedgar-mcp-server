/**
 * @fileoverview Bridge-layer SQL utility. System-catalog denial is delegated to
 * the framework via `QueryOptions.denySystemCatalogs`; `stripStringLiterals`
 * serves the bridge's `assertReferencedDataframesExist` pre-check, which scans
 * for minted `df_<id>` handles before the framework gate runs (#47).
 * @module services/canvas-bridge/sql-gate-extras
 */

/**
 * Strip single- and double-quoted string literals so catalog tokens embedded
 * in string constants do not cause false positives. Cheap heuristic — the
 * framework gate runs a real parser afterwards, this is a fast text gate.
 */
export function stripStringLiterals(sql: string): string {
  return sql.replace(/'([^'\\]|\\.|'')*'/g, "''").replace(/"([^"\\]|\\.|"")*"/g, '""');
}
