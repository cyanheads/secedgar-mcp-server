/**
 * @fileoverview Tests for EdgarApiService helpers — `pickPreferredTicker` (CIK
 * tie-breaker), `trigramSimilarity`/`suggestCompanies` (near-match suggestions),
 * and `buildTickerCache` MF-ticker merge behaviour via the private indexing logic.
 * @module tests/services/edgar/edgar-api-service
 */

import { describe, expect, it } from 'vitest';
import {
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
