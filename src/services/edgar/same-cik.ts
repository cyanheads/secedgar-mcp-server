/**
 * @fileoverview Compare EDGAR identifiers independently of zero-padding.
 * @module services/edgar/same-cik
 */

/** True when two CIKs name the same filer, however each is zero-padded. */
export function sameCik(a: string, b: string): boolean {
  return a.replace(/^0+/, '') === b.replace(/^0+/, '');
}
