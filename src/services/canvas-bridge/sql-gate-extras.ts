/**
 * @fileoverview Bridge-layer SQL utilities. System-catalog denial is now
 * delegated to the framework via `QueryOptions.denySystemCatalogs` (added in
 * mcp-ts-core 0.10.4). `stripStringLiterals` is kept for the bridge's
 * `assertReferencedDataframesExist` pre-check, which scans for minted
 * `df_<id>` handles before handing off to the framework gate (#47).
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
