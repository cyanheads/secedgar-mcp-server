/**
 * @fileoverview Bridge-layer SQL utilities. System-catalog denial is now
 * delegated to the framework via `QueryOptions.denySystemCatalogs` (added in
 * mcp-ts-core 0.10.4). `stripStringLiterals` is kept for the bridge's
 * `assertReferencedDataframesExist` pre-check, which scans for minted
 * `df_<id>` handles before handing off to the framework gate (#47).
 * `isSelectShaped` is used in the catch block to reclassify a
 * `non_select_statement` + UNKNOWN that is actually a column-not-found error
 * (#52).
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

/**
 * Return true when the SQL is SELECT-shaped: after stripping string literals
 * and SQL comments (-- line comments and block comments), the
 * statement starts with SELECT or WITH. Used to distinguish a column-not-found
 * prepare failure (the statement IS a SELECT — the framework gate assigns
 * UNKNOWN because the binder threw) from a legitimately non-SELECT statement
 * that the gate correctly rejects (#52).
 */
export function isSelectShaped(sql: string): boolean {
  const stripped = stripStringLiterals(sql)
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return /^\s*(select|with)\b/i.test(stripped);
}
