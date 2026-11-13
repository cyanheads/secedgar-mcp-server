/**
 * @fileoverview Former ticker symbols (#237): symbol → CIK pairs a monthly Wayback Machine
 * capture of `company_tickers.json` lists and the file no longer does, from the committed
 * `data/former-tickers.json` asset (`bun run gen:former-tickers`). `resolveCik` reads an
 * unlisted symbol as the company that held it last, and names a listed symbol's earlier
 * holders beside its current one.
 * @module services/edgar/former-tickers
 */

import type { ListingIndex } from './listing-codes.js';
import type { CikMatch } from './types.js';

/**
 * One asset row: the symbol (uppercase), the holder's zero-padded CIK, the last capture month
 * listing the pair (`YYYY-MM` — a capture date, not a delisting date), and the holder's title
 * in that capture.
 */
export type FormerTickerRow = readonly [symbol: string, cik: string, month: string, title: string];

/** A former holder of a symbol. */
export interface FormerHolder {
  readonly cik: string;
  /** The last capture month listing the symbol for this holder, `YYYY-MM`. */
  readonly month: string;
  /** The holder's title as SEC listed it that month. */
  readonly title: string;
}

/** Symbol → its former holders, the most recent first. */
export type FormerTickerIndex = ReadonlyMap<string, readonly FormerHolder[]>;

/** The ticker index the former-ticker readings name holders from, with the former tickers. */
export interface FormerTickerLookup extends ListingIndex {
  readonly formerTickers: FormerTickerIndex;
}

/** Index the asset's rows by symbol, each symbol's holders ordered by month, newest first. */
export function buildFormerTickerIndex(rows: Iterable<FormerTickerRow>): FormerTickerIndex {
  const index = new Map<string, FormerHolder[]>();
  for (const [symbol, cik, month, title] of rows) {
    const holder = { cik, month, title };
    const holders = index.get(symbol);
    if (holders) holders.push(holder);
    else index.set(symbol, [holder]);
  }
  for (const holders of index.values()) {
    holders.sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
  }
  return index;
}

/**
 * Read `input` (any case) as a former ticker: the company that held the symbol last, as its
 * current listing when it has one (`AMRK` → Gold.com, Inc., GOLD) and else by its title as last
 * listed, with no ticker. The match's `reading` names that company, the month, and any earlier
 * holders. A dotted input also matches the hyphenated symbol, as the listed-symbol lookup does
 * (#110). `undefined` when the asset holds neither spelling.
 */
export function readFormerTicker(input: string, lookup: FormerTickerLookup): CikMatch | undefined {
  const symbol = input.toUpperCase();
  const holders =
    lookup.formerTickers.get(symbol) ??
    (symbol.includes('.') ? lookup.formerTickers.get(symbol.replaceAll('.', '-')) : undefined);
  const [latest, ...earlier] = holders ?? [];
  if (!latest) return;
  const company = lookup.byCik.get(latest.cik) ?? { cik: latest.cik, name: latest.title };
  const before =
    earlier.length > 0 ? `; earlier the ticker ${ofEach(earlier.map((h) => held(h, lookup)))}` : '';
  return {
    ...company,
    reading: `${input} read as a former ticker ${ofEach([held(latest, lookup)])} in SEC's ticker file${before}`,
  };
}

/**
 * A listed symbol's match, with a `reading` naming each earlier holder of the symbol the asset
 * records — the current holder's own CIK never counts (`XOM` keeps ExxonMobil Holdings Corp and
 * names EXXON MOBIL CORP). The match itself when there is none; the indexed entry is never written.
 */
export function withEarlierHolders(listed: CikMatch, lookup: FormerTickerLookup): CikMatch {
  const symbol = listed.ticker;
  if (symbol === undefined) return listed;
  const earlier = (lookup.formerTickers.get(symbol.toUpperCase()) ?? []).filter(
    (holder) => holder.cik !== listed.cik,
  );
  if (earlier.length === 0) return listed;
  return {
    ...listed,
    reading: `${symbol} was earlier the ticker ${ofEach(earlier.map((h) => held(h, lookup)))} in SEC's ticker file`,
  };
}

/** `Name (TICKER, CIK …) as late as YYYY-MM`: the holder's current listing when it has one. */
function held(holder: FormerHolder, { byCik }: ListingIndex): string {
  const listing = byCik.get(holder.cik);
  const name = listing?.name ?? holder.title;
  const ticker = listing?.ticker ? `${listing.ticker}, ` : '';
  return `${name} (${ticker}CIK ${holder.cik}) as late as ${holder.month}`;
}

/** `of A`, `of A and of B`, `of A, of B, and of C`. */
function ofEach(phrases: string[]): string {
  const each = phrases.map((phrase) => `of ${phrase}`);
  if (each.length <= 2) return each.join(' and ');
  return `${each.slice(0, -1).join(', ')}, and ${each.at(-1)}`;
}
