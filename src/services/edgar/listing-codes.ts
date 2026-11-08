/**
 * @fileoverview Ticker spellings market-data vendors write that `company_tickers.json` does not
 * list — an exchange code after a period (`UEC.N`, `7203.T`), a preferred class run together
 * (`CFGPH`), a root listed only as share classes (`GLOP`) — and the readings `resolveCik` maps
 * them onto listed symbols with, plus the sentence the tools that resolve through it add to a
 * not-found message for a non-US listing (#235).
 * @module services/edgar/listing-codes
 */

import type { CikMatch } from './types.js';

/** US venue codes: the symbol before one is the one EDGAR lists (`UEC.N` → UEC). */
export const US_VENUE_CODES: ReadonlySet<string> = new Set(['N', 'O', 'OQ', 'A', 'P', 'K', 'PK']);

/** Codes of non-US exchanges, under which EDGAR lists no issuer. */
export const NON_US_EXCHANGE_CODES: ReadonlySet<string> = new Set(['ME', 'L', 'HK', 'T', 'TO']);

/**
 * The sentence a tool's not-found message adds when the input, typed in uppercase, ends in a
 * non-US exchange code (`7203.T`); `undefined` for every other input.
 */
export function nonUsListingNote(input: string): string | undefined {
  if (input !== input.toUpperCase()) return;
  const dot = input.lastIndexOf('.');
  if (dot <= 0) return;
  const code = input.slice(dot + 1);
  if (!NON_US_EXCHANGE_CODES.has(code)) return;
  return `The .${code} suffix marks a non-US listing; EDGAR indexes SEC registrants by US ticker, name, or CIK.`;
}

/** The ticker index the readings look symbols up in, keyed by uppercase symbol and padded CIK. */
export interface ListingIndex {
  readonly byCik: ReadonlyMap<string, CikMatch>;
  readonly byTicker: ReadonlyMap<string, CikMatch>;
}

/**
 * The listing an uppercase symbol names: the symbol itself, else a dotted share class in the
 * hyphenated form `company_tickers.json` lists it under (`BRK.B` → BRK-B, #110).
 */
export function listedSymbol(
  symbol: string,
  byTicker: ListingIndex['byTicker'],
): CikMatch | undefined {
  return (
    byTicker.get(symbol) ??
    (symbol.includes('.') ? byTicker.get(symbol.replaceAll('.', '-')) : undefined)
  );
}

/**
 * Read a ticker spelling the index does not list, for input typed in uppercase whose exact and
 * dotted-class lookups ({@link listedSymbol}) both missed:
 *
 * - `<symbol>.<code>`, a {@link US_VENUE_CODES} code: the symbol, when it is listed or a dotted
 *   class (`UEC.N` → UEC, `BIP.PA.N` → BIP-PA)
 * - `<base>P<letter>` or `<base>PR<letter>`, a base of two or more letters: the listed class
 *   `<base>-P<letter>` (`CFGPH` → CFG-PH, `PCGPRE` → PCG-PE)
 * - a root listed only as hyphenated classes: their company, one match per CIK the classes
 *   belong to (`GLOP` → GasLog Partners LP)
 * - `<symbol>.<code>`, a {@link NON_US_EXCHANGE_CODES} code: no match, since EDGAR lists no
 *   issuer under one (`7203.T`)
 *
 * Every match a reading returns carries `reading`, the note naming what the input was read as.
 * `undefined` when no reading applies — the input is not uppercase, has none of these shapes, or
 * names nothing listed — so it goes on to the name passes as before.
 */
export function readTickerSpelling(
  input: string,
  index: ListingIndex,
): CikMatch | CikMatch[] | undefined {
  if (input !== input.toUpperCase()) return;
  if (nonUsListingNote(input) !== undefined) return [];

  const dot = input.lastIndexOf('.');
  if (dot > 0) {
    if (!US_VENUE_CODES.has(input.slice(dot + 1))) return;
    const listed = listedSymbol(input.slice(0, dot), index.byTicker);
    return listed && readAs(input, listed, labelOf(listed));
  }

  if (!/^[A-Z]+$/.test(input)) return;
  return runTogetherClass(input, index.byTicker) ?? classRootCompanies(input, index);
}

/** `<base>P<letter>` or `<base>PR<letter>` → the listed `<base>-P<letter>`, base 2+ letters. */
function runTogetherClass(input: string, byTicker: ListingIndex['byTicker']): CikMatch | undefined {
  const end = input.length;
  const baseEnd =
    input[end - 2] === 'P' ? end - 2 : input.slice(end - 3, end - 1) === 'PR' ? end - 3 : 0;
  if (baseEnd < 2) return;
  const listed = byTicker.get(`${input.slice(0, baseEnd)}-P${input.slice(-1)}`);
  return listed && readAs(input, listed, labelOf(listed));
}

/**
 * The companies whose hyphenated classes share `root` as their prefix, for a root with no
 * listing of its own: each CIK's preferred listing, its classes named in the note.
 */
function classRootCompanies(
  root: string,
  { byCik, byTicker }: ListingIndex,
): CikMatch | CikMatch[] | undefined {
  const prefix = `${root}-`;
  const byCompany = new Map<string, { first: CikMatch; classes: string[] }>();
  for (const [symbol, match] of byTicker) {
    if (!symbol.startsWith(prefix)) continue;
    const company = byCompany.get(match.cik);
    if (company) company.classes.push(symbol);
    else byCompany.set(match.cik, { first: match, classes: [symbol] });
  }
  const matches = [...byCompany].map(([cik, { first, classes }]) => {
    const company = byCik.get(cik) ?? first;
    return readAs(root, company, `${company.name ?? `CIK ${cik}`} (${classes.sort().join(', ')})`);
  });
  if (matches.length === 0) return;
  return matches.length === 1 ? matches[0] : matches;
}

/** A listing's symbol, and its company's name when the index carries one. */
function labelOf(listed: CikMatch): string {
  return `${listed.ticker}${listed.name ? ` (${listed.name})` : ''}`;
}

/** A copy of `match` noting how `input` was read; the indexed entry is never written. */
function readAs(input: string, match: CikMatch, readAsText: string): CikMatch {
  return { ...match, reading: `${input} read as ${readAsText}` };
}
