/**
 * @fileoverview company_tickers.json fixtures shared by the tests that sync the ticker
 * layer into a real store and read it back: the file as first synced and as refreshed
 * after SEC renamed one filer and dropped another.
 * @module tests/support/ticker-files
 */

export type TickerEntry = { cik_str: number; ticker: string; title: string };

/** Rows every file lists, so the deletions under test stay within a refresh's quarter. */
const PAD_ENTRIES: TickerEntry[] = Array.from({ length: 6 }, (_, i) => ({
  cik_str: 9000000 + i,
  ticker: `PAD${i}`,
  title: `Pad ${i} Inc.`,
}));

/** company_tickers.json holding the pad rows and `entries`, keyed by index as SEC serves it. */
export const tickerFile = (...entries: TickerEntry[]) =>
  Object.fromEntries([...PAD_ENTRIES, ...entries].map((entry, i) => [String(i), entry]));

export const AAPL_ENTRY: TickerEntry = { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' };

/** The first sync: AMRK (0001591588) and MRO (0000101778) beside Apple. */
export const FILE_A = tickerFile(
  AAPL_ENTRY,
  { cik_str: 1591588, ticker: 'AMRK', title: 'A-Mark Precious Metals, Inc.' },
  { cik_str: 101778, ticker: 'MRO', title: 'MARATHON OIL CORP' },
);

/** The refresh: 0001591588 listed as GOLD, without MRO. */
export const FILE_B = tickerFile(AAPL_ENTRY, {
  cik_str: 1591588,
  ticker: 'GOLD',
  title: 'Gold.com, Inc.',
});
