/**
 * @fileoverview The form types a caller's `forms` filter names, read once per call by
 * every tool that takes one.
 * @module mcp-server/tools/form-filter
 */

/**
 * Each element trimmed and uppercased, blanks dropped; `undefined` when nothing is left,
 * so a form client's blank element reads as no filter rather than a form named "" (#194).
 * EDGAR form types carry no lowercase letter, and EFTS matches them case-sensitively, so
 * the uppercase spelling is the one every route matches.
 */
export function normalizeFormFilter(forms: readonly string[] | undefined): string[] | undefined {
  const named = forms?.map((form) => form.trim().toUpperCase()).filter((form) => form !== '');
  return named?.length ? named : undefined;
}
