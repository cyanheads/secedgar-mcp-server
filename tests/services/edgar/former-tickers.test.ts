/**
 * @fileoverview The former-ticker index and its two readings (#237), tabled at their own seam:
 * holders ordered newest first whatever the row order, an unlisted symbol read as its most
 * recent holder (named by its current listing when it has one, else by its title as last
 * listed), earlier holders named after it, the dotted-class spelling of a hyphenated former
 * symbol, a listed symbol's earlier holders, and the current holder never named as an earlier
 * one. `resolveCik`'s placement of the readings is pinned in
 * `edgar-api-service.resolve-cik.test.ts`. Rows are copied from the committed asset, bar the
 * synthetic `ONE` holders and Flyte's VJET row, a pair a later ticker file lists again.
 * @module tests/services/edgar/former-tickers
 */

import { describe, expect, it } from 'vitest';
import {
  buildFormerTickerIndex,
  type FormerTickerLookup,
  type FormerTickerRow,
  readFormerTicker,
  withEarlierHolders,
} from '@/services/edgar/former-tickers.js';
import type { CikMatch } from '@/services/edgar/types.js';

const ROWS: FormerTickerRow[] = [
  // Out of month order on purpose: the index orders each symbol's holders itself.
  ['STR', '0000751652', '2020-05', 'DOMINION QUESTAR CORP'],
  ['STR', '0001949543', '2025-08', 'Sitio Royalties Corp.'],
  ['STR', '0001703785', '2023-01', 'Sitio Royalties Corp.'],
  ['AMRK', '0001591588', '2025-12', 'A-Mark Precious Metals, Inc.'],
  ['MRO', '0000101778', '2024-12', 'MARATHON OIL CORP'],
  ['AAIC-PB', '0001209028', '2023-12', 'Arlington Asset Investment Corp.'],
  ['XOM', '0000034088', '2026-04', 'EXXON MOBIL CORP'],
  ['GOLD', '0000756894', '2025-04', 'BARRICK GOLD CORP'],
  ['GOLD', '0001175580', '2019-07', 'Randgold Resources Limited'],
  ['VJET', '0001582581', '2024-04', 'voxeljet AG'],
  // A pair whose CIK holds the symbol again today: never an earlier holder.
  ['VJET', '0001716621', '2023-02', 'Flyte Aviation, Inc.'],
];

const GOLD_COM: CikMatch = { cik: '0001591588', ticker: 'GOLD', name: 'Gold.com, Inc.' };
const BARRICK: CikMatch = { cik: '0000756894', ticker: 'B', name: 'BARRICK MINING CORP' };
const EXXON_HOLDINGS: CikMatch = {
  cik: '0002115436',
  ticker: 'XOM',
  name: 'ExxonMobil Holdings Corp',
};
const FLYTE: CikMatch = { cik: '0001716621', ticker: 'VJET', name: 'Flyte Aviation, Inc.' };
const MSFT: CikMatch = { cik: '0000789019', ticker: 'MSFT', name: 'MICROSOFT CORP' };

function lookupOf(listings: CikMatch[], rows: FormerTickerRow[] = ROWS): FormerTickerLookup {
  return {
    byCik: new Map(listings.map((m) => [m.cik, m])),
    byTicker: new Map(listings.map((m) => [m.ticker as string, m])),
    formerTickers: buildFormerTickerIndex(rows),
  };
}

const LOOKUP = lookupOf([GOLD_COM, BARRICK, EXXON_HOLDINGS, FLYTE, MSFT]);

describe('buildFormerTickerIndex', () => {
  it('orders each symbol’s holders newest first, whatever the row order', () => {
    const index = buildFormerTickerIndex(ROWS);
    expect(index.get('STR')?.map((h) => h.cik)).toEqual(['0001949543', '0001703785', '0000751652']);
    expect(index.get('AMRK')).toEqual([
      { cik: '0001591588', month: '2025-12', title: 'A-Mark Precious Metals, Inc.' },
    ]);
  });

  it('is empty for no rows', () => {
    expect(buildFormerTickerIndex([]).size).toBe(0);
  });
});

describe('readFormerTicker', () => {
  it('reads an unlisted symbol as its holder, named by the holder’s current listing', () => {
    expect(readFormerTicker('AMRK', LOOKUP)).toEqual({
      ...GOLD_COM,
      reading:
        "AMRK read as a former ticker of Gold.com, Inc. (GOLD, CIK 0001591588) as late as 2025-12 in SEC's ticker file",
    });
  });

  it('names a holder with no listing today by its title as last listed, with no ticker', () => {
    expect(readFormerTicker('MRO', LOOKUP)).toEqual({
      cik: '0000101778',
      name: 'MARATHON OIL CORP',
      reading:
        "MRO read as a former ticker of MARATHON OIL CORP (CIK 0000101778) as late as 2024-12 in SEC's ticker file",
    });
  });

  it('resolves to the most recent of several holders and names the earlier ones after it', () => {
    const match = readFormerTicker('STR', LOOKUP);
    expect(match?.cik).toBe('0001949543');
    expect(match?.reading).toBe(
      "STR read as a former ticker of Sitio Royalties Corp. (CIK 0001949543) as late as 2025-08 in SEC's ticker file; earlier the ticker of Sitio Royalties Corp. (CIK 0001703785) as late as 2023-01 and of DOMINION QUESTAR CORP (CIK 0000751652) as late as 2020-05",
    );
  });

  it('lists three or more earlier holders with a serial comma', () => {
    const lookup = lookupOf(
      [],
      [
        ['ONE', '0000000004', '2026-01', 'Fourth Co'],
        ['ONE', '0000000003', '2024-01', 'Third Co'],
        ['ONE', '0000000002', '2022-01', 'Second Co'],
        ['ONE', '0000000001', '2020-01', 'First Co'],
      ],
    );
    expect(readFormerTicker('ONE', lookup)?.reading).toBe(
      "ONE read as a former ticker of Fourth Co (CIK 0000000004) as late as 2026-01 in SEC's ticker file; earlier the ticker of Third Co (CIK 0000000003) as late as 2024-01, of Second Co (CIK 0000000002) as late as 2022-01, and of First Co (CIK 0000000001) as late as 2020-01",
    );
  });

  it('reads a dotted spelling of a hyphenated former symbol, naming the input as typed', () => {
    expect(readFormerTicker('AAIC.PB', LOOKUP)).toMatchObject({
      cik: '0001209028',
      reading:
        "AAIC.PB read as a former ticker of Arlington Asset Investment Corp. (CIK 0001209028) as late as 2023-12 in SEC's ticker file",
    });
  });

  it('matches any case and names the input as typed', () => {
    expect(readFormerTicker('amrk', LOOKUP)?.reading).toMatch(
      /^amrk read as a former ticker of Gold\.com, Inc\. \(GOLD, CIK 0001591588\)/,
    );
  });

  it('is undefined for a symbol the asset does not hold', () => {
    expect(readFormerTicker('ZZZZ', LOOKUP)).toBeUndefined();
    expect(readFormerTicker('ZZZZ.A', LOOKUP)).toBeUndefined();
    expect(readFormerTicker('', LOOKUP)).toBeUndefined();
  });

  it('never writes the indexed listing', () => {
    readFormerTicker('AMRK', LOOKUP);
    expect(LOOKUP.byCik.get(GOLD_COM.cik)).not.toHaveProperty('reading');
  });
});

describe('withEarlierHolders', () => {
  it('names a listed symbol’s earlier holder, its CIK, and the month', () => {
    expect(withEarlierHolders(EXXON_HOLDINGS, LOOKUP)).toEqual({
      ...EXXON_HOLDINGS,
      reading:
        "XOM was earlier the ticker of EXXON MOBIL CORP (CIK 0000034088) as late as 2026-04 in SEC's ticker file",
    });
  });

  it('names each earlier holder newest first, one listed today under another symbol', () => {
    expect(withEarlierHolders(GOLD_COM, LOOKUP).reading).toBe(
      "GOLD was earlier the ticker of BARRICK MINING CORP (B, CIK 0000756894) as late as 2025-04 and of Randgold Resources Limited (CIK 0001175580) as late as 2019-07 in SEC's ticker file",
    );
  });

  it('never names the current holder as an earlier one', () => {
    expect(withEarlierHolders(FLYTE, LOOKUP).reading).toBe(
      "VJET was earlier the ticker of voxeljet AG (CIK 0001582581) as late as 2024-04 in SEC's ticker file",
    );
  });

  it('returns the match itself for a symbol with no earlier holder', () => {
    expect(withEarlierHolders(MSFT, LOOKUP)).toBe(MSFT);
    const onlyCurrent = lookupOf(
      [FLYTE],
      [['VJET', '0001716621', '2023-02', 'Flyte Aviation, Inc.']],
    );
    expect(withEarlierHolders(FLYTE, onlyCurrent)).toBe(FLYTE);
  });
});
