/**
 * @fileoverview Tests for EdgarApiService helpers — currently focused on the
 * `byCik` index tie-breaker (`pickPreferredTicker`) so cikToTicker enrichment
 * picks common stock over preferred-share, debt-security, and multi-class
 * variants regardless of SEC's company_tickers.json entry order.
 * @module tests/services/edgar/edgar-api-service
 */

import { describe, expect, it } from 'vitest';
import { pickPreferredTicker } from '@/services/edgar/edgar-api-service.js';
import type { CikMatch } from '@/services/edgar/types.js';

const match = (ticker: string, cik = '0000000001'): CikMatch => ({
  cik,
  name: `Entity ${ticker}`,
  ticker,
});

describe('pickPreferredTicker', () => {
  it('prefers hyphen-free ticker over hyphenated preferred-share variant', () => {
    const common = match('JPM');
    const preferred = match('JPM-PA');
    expect(pickPreferredTicker(common, preferred)).toBe(common);
    expect(pickPreferredTicker(preferred, common)).toBe(common);
  });

  it('reduces to common stock when SEC lists many preferred variants in any order', () => {
    // Order-insensitive reduction: JPM is hyphen-free and beats every JPM-Px.
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
    // Prudential CIK has tickers PRU, PFH, PRH, PRS — all hyphen-free, so rule
    // 1 never fires. Rule 2 (incumbent wins) keeps the first-seen entry. SEC
    // consistently lists common stock first, so PRU stays in the index.
    const entries = [match('PRU'), match('PFH'), match('PRH'), match('PRS')];
    const winner = entries.reduce((acc, next) => pickPreferredTicker(acc, next));
    expect(winner.ticker).toBe('PRU');
  });

  it('keeps the incumbent for multi-class issuers (both hyphenated)', () => {
    // Berkshire-shaped: both classes are legitimate common stock, both
    // hyphenated. Whichever SEC lists first wins; both BRK-A and BRK-B are
    // valid answers for the CIK.
    const a = match('BRK-A');
    const b = match('BRK-B');
    expect(pickPreferredTicker(a, b)).toBe(a);
    expect(pickPreferredTicker(b, a)).toBe(b);
  });

  it('replaces a hyphenated incumbent with a hyphen-free challenger', () => {
    // A hypothetical SEC update prepending a preferred variant must not pin the
    // index to it once the common-stock entry is seen.
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
    // Both have no ticker → the function falls through the `!a.ticker` branch
    // and returns b. The exact loser doesn't matter; the call must be stable,
    // not throw, and not crash subsequent reductions.
    const a: CikMatch = { cik: '1', name: 'A' };
    const b: CikMatch = { cik: '1', name: 'B' };
    expect(pickPreferredTicker(a, b)).toBe(b);
  });
});
