/**
 * @fileoverview The ticker-spelling readings and the non-US listing note (#235), tabled at their
 * own seam: every venue and non-US code, both run-together forms and their base-length bound,
 * class roots of one and of several companies, the uppercase-only rule, and linear time over
 * caller-sized input. `resolveCik`'s placement of the readings (after the exact and dotted-class
 * lookups, before the name passes) is pinned against the live registry shape in
 * `edgar-api-service.resolve-cik.test.ts`.
 * @module tests/services/edgar/listing-codes
 */

import { describe, expect, it } from 'vitest';
import {
  type ListingIndex,
  listedSymbol,
  NON_US_EXCHANGE_CODES,
  nonUsListingNote,
  readTickerSpelling,
  US_VENUE_CODES,
} from '@/services/edgar/listing-codes.js';
import type { CikMatch } from '@/services/edgar/types.js';

/** An index built the way `buildTickerCache` builds one: byCik keeps the first unhyphenated row. */
function indexOf(rows: CikMatch[]): ListingIndex {
  const byTicker = new Map<string, CikMatch>();
  const byCik = new Map<string, CikMatch>();
  for (const row of rows) {
    if (row.ticker) byTicker.set(row.ticker, row);
    const held = byCik.get(row.cik);
    if (!held || (held.ticker?.includes('-') && !row.ticker?.includes('-')))
      byCik.set(row.cik, row);
  }
  return { byTicker, byCik };
}

const UEC = { cik: '0001334933', ticker: 'UEC', name: 'URANIUM ENERGY CORP' };
const BIP_PA = {
  cik: '0001406234',
  ticker: 'BIP-PA',
  name: 'Brookfield Infrastructure Partners L.P.',
};
const CFG = { cik: '0000759944', ticker: 'CFG', name: 'CITIZENS FINANCIAL GROUP INC/RI' };
const CFG_PH = { ...CFG, ticker: 'CFG-PH' };
const C_PN = { cik: '0000831001', ticker: 'C-PN', name: 'CITIGROUP INC' };
const BAC = { cik: '0000070858', ticker: 'BAC', name: 'BANK OF AMERICA CORP /DE/' };
const MER_PK = { ...BAC, ticker: 'MER-PK' };
const VOO = { cik: '0000036405', ticker: 'VOO', seriesId: 'S000002839', classId: 'C000092055' };
const INDEX = indexOf([
  UEC,
  BIP_PA,
  CFG,
  CFG_PH,
  C_PN,
  BAC,
  MER_PK,
  VOO,
  { cik: '0001598655', ticker: 'GLOP-PC', name: 'GasLog Partners LP' },
  { cik: '0001598655', ticker: 'GLOP-PA', name: 'GasLog Partners LP' },
  // Two companies' classes under one root, a shape the live file does not hold today.
  { cik: '0000000001', ticker: 'TWIN-PA', name: 'First Twin Corp' },
  { cik: '0000000002', ticker: 'TWIN-PB', name: 'Second Twin Corp' },
  { cik: '0000000001', ticker: 'TWIN-PC', name: 'First Twin Corp' },
  // A class row with no name, which no live row has.
  { cik: '0000000003', ticker: 'BARE-A' },
]);

describe('nonUsListingNote', () => {
  it.each([...NON_US_EXCHANGE_CODES])('names the .%s suffix as a non-US listing', (code) => {
    expect(nonUsListingNote(`7203.${code}`)).toBe(
      `The .${code} suffix marks a non-US listing; EDGAR indexes SEC registrants by US ticker, name, or CIK.`,
    );
  });

  it.each([
    ['a US venue code', 'UEC.N'],
    // Listed class suffixes that are also exchange codes elsewhere stay off the list.
    ['PA, a listed class suffix', 'MS.PA'],
    ['V, a listed class suffix', 'ABC.V'],
    ['no period', 'VOD'],
    ['a leading period', '.T'],
    ['a trailing period', 'VOD.L.'],
    ['lowercase', '7203.t'],
    ['mixed case', 'Vod.L'],
  ])('adds nothing for %s (%s)', (_label, input) => {
    expect(nonUsListingNote(input)).toBeUndefined();
  });
});

describe('listedSymbol', () => {
  it('answers a listed symbol, then a dotted class in its hyphenated form (#110)', () => {
    expect(listedSymbol('UEC', INDEX.byTicker)).toBe(UEC);
    expect(listedSymbol('BIP.PA', INDEX.byTicker)).toBe(BIP_PA);
    expect(listedSymbol('BIP.PB', INDEX.byTicker)).toBeUndefined();
    expect(listedSymbol('ZZZZ', INDEX.byTicker)).toBeUndefined();
  });
});

describe('readTickerSpelling', () => {
  describe('a US venue code after a listed symbol', () => {
    it.each([...US_VENUE_CODES])('drops .%s and reads the symbol', (code) => {
      expect(readTickerSpelling(`UEC.${code}`, INDEX)).toEqual({
        ...UEC,
        reading: `UEC.${code} read as UEC (URANIUM ENERGY CORP)`,
      });
    });

    it('reads a dotted class before the code as its hyphenated listing', () => {
      expect(readTickerSpelling('BIP.PA.N', INDEX)).toEqual({
        ...BIP_PA,
        reading: 'BIP.PA.N read as BIP-PA (Brookfield Infrastructure Partners L.P.)',
      });
    });

    it('names a fund symbol alone, since the fund file carries no name', () => {
      expect(readTickerSpelling('VOO.P', INDEX)).toEqual({ ...VOO, reading: 'VOO.P read as VOO' });
    });

    it.each([
      ['a symbol the index does not list', 'ZZZZ.N'],
      ['a code outside the venue list', 'UEC.Q'],
      ['a run-together spelling before the code', 'CFGPH.N'],
    ])('leaves %s to the name passes (%s)', (_label, input) => {
      expect(readTickerSpelling(input, INDEX)).toBeUndefined();
    });

    it('returns a copy and never writes the indexed entry', () => {
      readTickerSpelling('UEC.N', INDEX);
      expect(INDEX.byTicker.get('UEC')).not.toHaveProperty('reading');
    });
  });

  describe('a non-US exchange code', () => {
    it.each([...NON_US_EXCHANGE_CODES])(
      'answers .%s with no match, even on a listed symbol',
      (code) => {
        expect(readTickerSpelling(`UEC.${code}`, INDEX)).toEqual([]);
      },
    );
  });

  describe('a preferred class run together', () => {
    it.each([
      ['CFGPH', 'P'],
      ['CFGPRH', 'PR'],
    ])('reads %s, the %s form, as the listed class', (input) => {
      expect(readTickerSpelling(input, INDEX)).toEqual({
        ...CFG_PH,
        reading: `${input} read as CFG-PH (CITIZENS FINANCIAL GROUP INC/RI)`,
      });
    });

    it.each([
      ['a one-letter base', 'CPN'],
      ['a one-letter base in the PR form', 'CPRN'],
      ['a class the index does not list', 'CFGPZ'],
      ['too short for a base and a class', 'PA'],
    ])('reads nothing for %s (%s)', (_label, input) => {
      expect(readTickerSpelling(input, INDEX)).toBeUndefined();
    });
  });

  describe('a root listed only as classes', () => {
    it('reads one company’s classes as its preferred listing, naming them in order', () => {
      expect(readTickerSpelling('GLOP', INDEX)).toEqual({
        cik: '0001598655',
        ticker: 'GLOP-PC',
        name: 'GasLog Partners LP',
        reading: 'GLOP read as GasLog Partners LP (GLOP-PA, GLOP-PC)',
      });
    });

    it('reads a class of another company’s ticker as that company', () => {
      // MER-PK belongs to Bank of America, whose own listing is BAC.
      expect(readTickerSpelling('MER', INDEX)).toEqual({
        ...BAC,
        reading: 'MER read as BANK OF AMERICA CORP /DE/ (MER-PK)',
      });
    });

    it('lists every company classes of one root belong to, each naming its own', () => {
      expect(readTickerSpelling('TWIN', INDEX)).toEqual([
        {
          cik: '0000000001',
          ticker: 'TWIN-PA',
          name: 'First Twin Corp',
          reading: 'TWIN read as First Twin Corp (TWIN-PA, TWIN-PC)',
        },
        {
          cik: '0000000002',
          ticker: 'TWIN-PB',
          name: 'Second Twin Corp',
          reading: 'TWIN read as Second Twin Corp (TWIN-PB)',
        },
      ]);
    });

    it('names a company the index carries no name for by its CIK', () => {
      expect(readTickerSpelling('BARE', INDEX)).toMatchObject({
        reading: 'BARE read as CIK 0000000003 (BARE-A)',
      });
    });

    it('reads nothing for a root with no classes', () => {
      expect(readTickerSpelling('NOPE', INDEX)).toBeUndefined();
    });
  });

  it.each(['uec.n', 'Uec.N', 'cfgph', 'Glop', 'vod.l'])(
    'reads nothing for %s, which is not typed in uppercase',
    (input) => {
      expect(readTickerSpelling(input, INDEX)).toBeUndefined();
    },
  );

  it.each(['APPLE INC', 'U.S. BANCORP', 'AMAZON.COM', '7203', 'BRK-B.X'])(
    'reads nothing for %s, which has no reading’s shape',
    (input) => {
      expect(readTickerSpelling(input, INDEX)).toBeUndefined();
    },
  );
});

describe('readTickerSpelling — linear in the input’s length (#235)', () => {
  const fill = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length));

  /**
   * Thread CPU milliseconds one call takes, timed over a batch sized to hold the work near 320k
   * characters per measurement, least of five: wall clock is noise under a parallel suite, and a
   * 5k call alone is too short to time.
   */
  function perCallCpuMs(input: string): number {
    const batch = Math.max(1, Math.round(320_000 / input.length));
    let least = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 5; round++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < batch; i++) readTickerSpelling(input, INDEX);
      const used = process.threadCpuUsage(start);
      least = Math.min(least, (used.user + used.system) / 1000 / batch);
    }
    return least;
  }

  /**
   * Doubles n from 5,000 to 320,000, checking the CPU bound at each size before building the
   * next, so a quadratic shape fails fast instead of hanging, then holds the 64× span's ratio
   * under 256, where a quadratic scan reaches 4,096.
   */
  function expectLinear(build: (n: number) => string): void {
    const small = build(5_000);
    readTickerSpelling(small, INDEX); // warm the JIT
    const t5k = Math.max(perCallCpuMs(small), 0.001);
    let last = t5k;
    for (let n = 10_000; n <= 320_000; n *= 2) {
      last = perCallCpuMs(build(n));
      expect(last, `${n} characters`).toBeLessThan(100);
    }
    expect(last / t5k).toBeLessThan(256);
  }

  it.each([
    ['a long digit run', (n: number) => fill('7', n)],
    ['a long letter run, read as a root', (n: number) => fill('A', n)],
    ['a run-together class shape', (n: number) => `${fill('A', n)}PRA`],
    ['periods with no code after the last', (n: number) => fill('.', n)],
    ['dotted segments before a venue code', (n: number) => `${fill('A.', n)}N`],
    ['dotted segments before a non-US code', (n: number) => `${fill('A.', n)}T`],
    ['one long line ending in a break', (n: number) => `${fill('§1 x', n)}\ny`],
    ['breaks throughout', (n: number) => fill('  \r\n', n)],
  ])('%s (5k → 320k)', (_label, build) => {
    expectLinear(build);
  });
});
