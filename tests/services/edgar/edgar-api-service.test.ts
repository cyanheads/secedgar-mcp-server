/**
 * @fileoverview Tests for EdgarApiService helpers — `pickPreferredTicker` (CIK
 * tie-breaker), `normalizeCompanySuffix` (corporate-suffix comparison form),
 * `trigramSimilarity`/`suggestCompanies` (near-match suggestions),
 * `buildTickerCache` MF-ticker merge behaviour via the private indexing logic, and
 * `parseSeriesFilingFeed` (fund series → its own filings).
 * @module tests/services/edgar/edgar-api-service
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeCompanySuffix,
  parseSeriesFilingFeed,
  pickPreferredTicker,
  suggestCompanies,
  trigramSimilarity,
} from '@/services/edgar/edgar-api-service.js';
import type { CikMatch } from '@/services/edgar/types.js';

const match = (ticker: string, cik = '0000000001', name?: string): CikMatch => ({
  cik,
  name: name ?? `Entity ${ticker}`,
  ticker,
});

// ---------------------------------------------------------------------------
// pickPreferredTicker
// ---------------------------------------------------------------------------

describe('pickPreferredTicker', () => {
  it('prefers hyphen-free ticker over hyphenated preferred-share variant', () => {
    const common = match('JPM');
    const preferred = match('JPM-PA');
    expect(pickPreferredTicker(common, preferred)).toBe(common);
    expect(pickPreferredTicker(preferred, common)).toBe(common);
  });

  it('reduces to common stock when SEC lists many preferred variants in any order', () => {
    const entries = [
      match('JPM-PA'),
      match('JPM'),
      match('JPM-PB'),
      match('JPM-PC'),
      match('JPM-PK'),
    ];
    const winner = entries.reduce((acc, next) => pickPreferredTicker(acc, next));
    expect(winner.ticker).toBe('JPM');
  });

  it('preserves common stock when listed first ahead of debt-security tickers', () => {
    const entries = [match('PRU'), match('PFH'), match('PRH'), match('PRS')];
    const winner = entries.reduce((acc, next) => pickPreferredTicker(acc, next));
    expect(winner.ticker).toBe('PRU');
  });

  it('keeps the incumbent for multi-class issuers (both hyphenated)', () => {
    const a = match('BRK-A');
    const b = match('BRK-B');
    expect(pickPreferredTicker(a, b)).toBe(a);
    expect(pickPreferredTicker(b, a)).toBe(b);
  });

  it('replaces a hyphenated incumbent with a hyphen-free challenger', () => {
    const result = [match('JPM-PA'), match('JPM')].reduce((acc, next) =>
      pickPreferredTicker(acc, next),
    );
    expect(result.ticker).toBe('JPM');
  });

  it('defers to the entry with a defined ticker when one is missing', () => {
    const a: CikMatch = { cik: '0000000001', name: 'A' };
    const b = match('AAPL');
    expect(pickPreferredTicker(a, b)).toBe(b);
    expect(pickPreferredTicker(b, a)).toBe(b);
  });

  it('returns b when both entries lack a ticker', () => {
    const a: CikMatch = { cik: '1', name: 'A' };
    const b: CikMatch = { cik: '1', name: 'B' };
    expect(pickPreferredTicker(a, b)).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// normalizeCompanySuffix (#107)
// ---------------------------------------------------------------------------

describe('normalizeCompanySuffix', () => {
  it.each([
    ['corp', 'beacon financial corp', 'beacon financial corporation'],
    ['corporation', 'beacon financial corporation', 'beacon financial corporation'],
    ['inc', 'apple inc', 'apple incorporated'],
    ['incorporated', 'apple incorporated', 'apple incorporated'],
    ['co', 'toro co', 'toro company'],
    ['company', 'toro company', 'toro company'],
    ['ltd', 'canon ltd', 'canon limited'],
    ['limited', 'canon limited', 'canon limited'],
  ])('expands the terminal %s token to its canonical long form', (_bucket, input, expected) => {
    expect(normalizeCompanySuffix(input)).toBe(expected);
  });

  it('keeps the four buckets distinct so different registrants never compare equal', () => {
    // TORO CO (CIK 0000737758) and TORO CORP. (CIK 0001941131) share a base name.
    expect(normalizeCompanySuffix('toro co')).not.toBe(normalizeCompanySuffix('toro corp.'));
    expect(normalizeCompanySuffix('blue owl capital inc.')).not.toBe(
      normalizeCompanySuffix('blue owl capital corp'),
    );
    expect(normalizeCompanySuffix('acme ltd')).not.toBe(normalizeCompanySuffix('acme co'));
  });

  it('strips a trailing period or comma as part of recognizing the suffix token', () => {
    expect(normalizeCompanySuffix('toro corp.')).toBe('toro corporation');
    expect(normalizeCompanySuffix('society pass incorporated.')).toBe('society pass incorporated');
    expect(normalizeCompanySuffix('acme inc,')).toBe('acme incorporated');
  });

  it('leaves a long-form suffix word sitting mid-name untouched', () => {
    expect(normalizeCompanySuffix('american water works company, inc.')).toBe(
      'american water works company, incorporated',
    );
    expect(normalizeCompanySuffix('precision optics corporation, inc.')).toBe(
      'precision optics corporation, incorporated',
    );
  });

  it('leaves a terminal token that merely contains a suffix untouched', () => {
    expect(normalizeCompanySuffix('sanrio company, ltd./adr')).toBe('sanrio company, ltd./adr');
  });

  it('returns a name with no recognized terminal suffix unchanged', () => {
    expect(normalizeCompanySuffix('microsoft corp holdings')).toBe('microsoft corp holdings');
    expect(normalizeCompanySuffix('ibm')).toBe('ibm');
    expect(normalizeCompanySuffix('')).toBe('');
  });

  it('does not fold the limited-partnership family into the ltd/limited bucket', () => {
    expect(normalizeCompanySuffix('brookfield lp')).toBe('brookfield lp');
    expect(normalizeCompanySuffix('brookfield llc')).toBe('brookfield llc');
    expect(normalizeCompanySuffix('brookfield plc')).toBe('brookfield plc');
  });
});

// ---------------------------------------------------------------------------
// trigramSimilarity
// ---------------------------------------------------------------------------

describe('trigramSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(trigramSimilarity('microsoft corp', 'microsoft corp')).toBe(1);
  });

  it('returns 0 for completely unrelated strings', () => {
    // Short random strings share no trigrams
    expect(trigramSimilarity('xyz', 'abc')).toBe(0);
  });

  it('returns a high score for a one-character typo', () => {
    const score = trigramSimilarity('microsfot corp', 'microsoft corp');
    expect(score).toBeGreaterThan(0.7);
  });

  it('returns a moderate score for word-order transposition', () => {
    const score = trigramSimilarity('morgan jp', 'jp morgan');
    expect(score).toBeGreaterThan(0.4);
  });

  it('returns a low-to-zero score for very different names', () => {
    const score = trigramSimilarity('apple', 'exxon mobil');
    expect(score).toBeLessThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// suggestCompanies
// ---------------------------------------------------------------------------

describe('suggestCompanies', () => {
  const entries: CikMatch[] = [
    { cik: '0000789019', name: 'MICROSOFT CORP', ticker: 'MSFT' },
    { cik: '0000320193', name: 'APPLE INC', ticker: 'AAPL' },
    { cik: '0000051143', name: 'IBM', ticker: 'IBM' },
    { cik: '0000037996', name: 'AMAZON COM INC', ticker: 'AMZN' },
  ];

  it('returns MICROSOFT for a misspelled query', () => {
    const suggestions = suggestCompanies('microsfot corp', entries);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]).toMatchObject({ cik: '0000789019', ticker: 'MSFT' });
  });

  it('returns an empty array when no entry clears the threshold', () => {
    const suggestions = suggestCompanies('zzzzzzzzz completely unrelated', entries);
    expect(suggestions).toHaveLength(0);
  });

  it('deduplicates by CIK', () => {
    const dupeEntries: CikMatch[] = [
      { cik: '0000789019', name: 'MICROSOFT CORP', ticker: 'MSFT' },
      { cik: '0000789019', name: 'MICROSOFT CORPORATION', ticker: 'MSFT' },
    ];
    const suggestions = suggestCompanies('microsfot', dupeEntries);
    expect(suggestions.filter((s) => s.cik === '0000789019')).toHaveLength(1);
  });

  it('caps results at TRIGRAM_TOP_N (3)', () => {
    const manyEntries: CikMatch[] = Array.from({ length: 10 }, (_, i) => ({
      cik: `000000000${i + 1}`,
      name: `MICROSOFT ${i}`,
      ticker: `MS${i}`,
    }));
    const suggestions = suggestCompanies('microsoft', manyEntries);
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });

  it('skips entries without a name field', () => {
    const mixedEntries: CikMatch[] = [
      { cik: '0001067839', ticker: 'QQQ' }, // MF entry — no name
      { cik: '0000789019', name: 'MICROSOFT CORP', ticker: 'MSFT' },
    ];
    // Should not crash and should return only named entries
    const suggestions = suggestCompanies('microsfot', mixedEntries);
    for (const s of suggestions) {
      expect(s.cik).not.toBe('0001067839');
    }
  });

  // --- Ticker scoring alongside name scoring (#111) ---

  // Rows verbatim from company_tickers.json — the near-ticker shapes are real.
  const tickerEntries: CikMatch[] = [
    { cik: '0001624794', name: 'CSW INDUSTRIALS, INC.', ticker: 'CSW' },
    { cik: '0000017313', name: 'CAPITAL SOUTHWEST CORP', ticker: 'CSWC' },
    { cik: '0001367859', name: 'Citizens Community Bancorp Inc.', ticker: 'CZWI' },
    { cik: '0000857855', name: 'UNITED COMMUNITY BANKS INC', ticker: 'UCB' },
    { cik: '0000789019', name: 'MICROSOFT CORP', ticker: 'MSFT' },
  ];

  it('suggests the near-ticker registrant for a ticker-shaped miss (#111)', () => {
    const suggestions = suggestCompanies('CSWI', tickerEntries);
    expect(suggestions[0]).toMatchObject({ cik: '0001624794', ticker: 'CSW' });
  });

  it('ranks a strong ticker match ahead of unrelated candidates (#111)', () => {
    const suggestions = suggestCompanies('UCBI', tickerEntries);
    expect(suggestions[0]).toMatchObject({ cik: '0000857855', ticker: 'UCB' });
    expect(suggestions.map((s) => s.cik)).not.toContain('0000789019');
  });

  it('scores an entry with a ticker but no name without throwing (#111)', () => {
    const tickerOnly: CikMatch[] = [{ cik: '0001624794', ticker: 'CSW' }];
    const suggestions = suggestCompanies('CSWI', tickerOnly);
    expect(suggestions).toEqual([{ cik: '0001624794', ticker: 'CSW' }]);
  });

  it('scores an entry with a name but no ticker without throwing (#111)', () => {
    // Former-name entries (#42) have a name and no ticker.
    const nameOnly: CikMatch[] = [{ cik: '0001326801', name: 'facebook inc' }];
    expect(suggestCompanies('facebok', nameOnly)).toEqual([
      { cik: '0001326801', name: 'facebook inc' },
    ]);
  });

  it('contributes one suggestion for a candidate scoring on both name and ticker (#111)', () => {
    const both: CikMatch[] = [{ cik: '0000789019', name: 'MSFT CORP', ticker: 'MSFT' }];
    expect(suggestCompanies('msft corp', both)).toHaveLength(1);
  });

  it('does not let ticker noise displace name candidates for a name-shaped query (#111)', () => {
    const suggestions = suggestCompanies('microsfot corp', tickerEntries);
    expect(suggestions[0]).toMatchObject({ cik: '0000789019', ticker: 'MSFT' });
  });

  it('still returns nothing when neither name nor ticker clears the threshold (#111)', () => {
    expect(suggestCompanies('zzzzzzzzz completely unrelated', tickerEntries)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildTickerCache — MF ticker merge behaviour (tested via the public
// exports + direct entry construction, since buildTickerCache is private)
// ---------------------------------------------------------------------------

describe('buildTickerCache — MF entry behaviour (structural assertions via CikMatch)', () => {
  it('MF CikMatch carries seriesId and classId', () => {
    const mfEntry: CikMatch = {
      cik: '0000036405',
      ticker: 'VOO',
      seriesId: 'S000002839',
      classId: 'C000092055',
    };
    expect(mfEntry.seriesId).toBe('S000002839');
    expect(mfEntry.classId).toBe('C000092055');
    expect(mfEntry.name).toBeUndefined(); // no name field for MF entries
  });

  it('operating-company CikMatch does not carry seriesId/classId', () => {
    const equityEntry: CikMatch = {
      cik: '0000320193',
      name: 'APPLE INC',
      ticker: 'AAPL',
    };
    expect(equityEntry.seriesId).toBeUndefined();
    expect(equityEntry.classId).toBeUndefined();
  });

  it('QQQ CIK 1067839 overlap: pickPreferredTicker resolves between two tickers cleanly', () => {
    // QQQ appears in both company_tickers.json and company_tickers_mf.json.
    // pickPreferredTicker handles the byCik collision for the operating-company
    // entry; the MF entry goes into byTicker only.
    const operating: CikMatch = { cik: '0001067839', name: 'INVESCO QQQ TRUST', ticker: 'QQQ' };
    const mf: CikMatch = { cik: '0001067839', ticker: 'QQQ', seriesId: 'S000017..' };
    // Operating entry has a name, so it should win in byCik (hyphen-free tie, incumbent rule).
    expect(pickPreferredTicker(operating, mf).name).toBe('INVESCO QQQ TRUST');
  });
});

// ---------------------------------------------------------------------------
// Former-name entry behaviour
// ---------------------------------------------------------------------------

describe('former-name entries', () => {
  it('former-name entry has a name field and no ticker', () => {
    const formerEntry: CikMatch = {
      cik: '0001326801',
      name: 'facebook inc',
    };
    expect(formerEntry.name).toBe('facebook inc');
    expect(formerEntry.ticker).toBeUndefined();
    expect(formerEntry.cik).toBe('0001326801');
  });

  it('former-name entry feeds suggestCompanies for near-match support', () => {
    const entries: CikMatch[] = [{ cik: '0001326801', name: 'facebook inc' }];
    const suggestions = suggestCompanies('facebok', entries);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]).toMatchObject({ cik: '0001326801' });
  });
});

// ---------------------------------------------------------------------------
// Series filing feed (fund series → its own filings)
// ---------------------------------------------------------------------------

/** EDGAR's company-browse Atom feed, trimmed to the elements the parser reads. */
const SERIES_FEED = `<?xml version="1.0" encoding="ISO-8859-1" ?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <company-info>
    <cik>36405</cik>
    <conformed-name>VANGUARD INDEX FUNDS</conformed-name>
    <formerly-names count="1"><names><name>VANGUARD INDEX TRUST</name></names></formerly-names>
  </company-info>
  <entry>
    <content type="text/xml">
      <accession-number>0000036405-26-000325</accession-number>
      <filing-date>2026-05-28</filing-date>
      <filing-type>NPORT-P</filing-type>
    </content>
  </entry>
  <entry>
    <content type="text/xml">
      <accession-number>0002071691-26-015790</accession-number>
      <filing-date>2026-07-13</filing-date>
      <filing-type>NPORT-P/A</filing-type>
    </content>
  </entry>
</feed>`;

describe('parseSeriesFilingFeed', () => {
  it('zero-pads the registrant CIK the feed reports bare', () => {
    expect(parseSeriesFilingFeed(SERIES_FEED).registrantCik).toBe('0000036405');
  });

  it('names the registrant the series belongs to', () => {
    expect(parseSeriesFilingFeed(SERIES_FEED).registrantName).toBe('VANGUARD INDEX FUNDS');
  });

  it('reads one row per filing, amendments of the form included', () => {
    expect(parseSeriesFilingFeed(SERIES_FEED).filings).toEqual([
      {
        accessionNumber: '0000036405-26-000325',
        filingDate: '2026-05-28',
        form: 'NPORT-P',
      },
      {
        accessionNumber: '0002071691-26-015790',
        filingDate: '2026-07-13',
        form: 'NPORT-P/A',
      },
    ]);
  });

  it('reports an unknown series as an empty feed rather than throwing', () => {
    const empty = parseSeriesFilingFeed(
      '<?xml version="1.0" ?><feed xmlns="http://www.w3.org/2005/Atom"><author><name>Webmaster</name></author></feed>',
    );
    expect(empty.filings).toEqual([]);
    expect(empty.registrantCik).toBeUndefined();
    expect(empty.registrantName).toBeUndefined();
  });

  it('skips an entry with no accession number instead of emitting a blank row', () => {
    const partial = SERIES_FEED.replace(
      '<accession-number>0000036405-26-000325</accession-number>',
      '',
    );
    expect(parseSeriesFilingFeed(partial).filings).toHaveLength(1);
  });

  it('ignores an HTML error page served in place of the feed', () => {
    expect(parseSeriesFilingFeed('<html><body>Not found</body></html>').filings).toEqual([]);
  });
});
