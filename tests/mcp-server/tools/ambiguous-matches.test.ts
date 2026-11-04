/**
 * @fileoverview The one cut every ambiguity error shows: the first 10 candidates, rendered
 * for the message and carried as `data.matches`, the full count as `data.total_matches`, and
 * the sentence a partial list ends with (#229) — including a total an upstream reports as a
 * floor (#230). Each tool's own tests prove only its wiring; this table is the wording.
 * @module tests/mcp-server/tools/ambiguous-matches
 */

import { describe, expect, it } from 'vitest';
import { ambiguousMatches } from '@/mcp-server/tools/ambiguous-matches.js';

const BLUE_OWL = [
  { cik: '0001823945', name: 'BLUE OWL CAPITAL INC.', ticker: 'OWL' },
  { cik: '0001655888', name: 'Blue Owl Capital Corp', ticker: 'OBDC' },
];

/** `n` distinct candidates, CIKs `0000000000`, `0000000001`, …, in that order. */
const candidates = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    cik: String(i).padStart(10, '0'),
    name: `Company ${i}`,
    ticker: `T${i}`,
  }));

const sentence = (shown: number, total: string) =>
  ` Showing ${shown} of ${total} matches; for one not listed, retry with a fuller name, its ticker, or its CIK.`;

/** The sentence for a single-token input (`search_filings`' `ticker:`), which takes no name. */
const tokenSentence = (shown: number, total: string) =>
  ` Showing ${shown} of ${total} matches; for one not listed, retry with its ticker or CIK.`;

describe('ambiguousMatches', () => {
  it('lists a complete list whole, with its count and no sentence', () => {
    const result = ambiguousMatches(BLUE_OWL);

    expect(result.shown).toEqual(BLUE_OWL);
    expect(result.list).toBe(
      '0001823945 BLUE OWL CAPITAL INC. (OWL), 0001655888 Blue Owl Capital Corp (OBDC)',
    );
    expect(result.showing).toBe('');
    expect(result.data).toEqual({ matches: BLUE_OWL, total_matches: 2 });
    expect(result.data).not.toHaveProperty('total_matches_is_lower_bound');
  });

  it('renders a missing ticker as no parentheses and a missing name as Unknown', () => {
    const result = ambiguousMatches([
      { cik: '0006084276', name: 'Apple Bank for Savings' },
      { cik: '0001234567' },
    ]);

    expect(result.list).toBe('0006084276 Apple Bank for Savings, 0001234567 Unknown');
  });

  it('carries cik, name, and ticker alone in data.matches', () => {
    const fund = {
      cik: '0000036405',
      name: 'VANGUARD INDEX FUNDS',
      ticker: 'VOO',
      seriesId: 'S000002839',
      classId: 'C000092055',
      exchange: 'NYSE',
    };
    const result = ambiguousMatches([fund, BLUE_OWL[0]!]);

    expect(result.data.matches).toEqual([
      { cik: '0000036405', name: 'VANGUARD INDEX FUNDS', ticker: 'VOO' },
      BLUE_OWL[0],
    ]);
  });

  it('shows exactly 10 of 10 with no sentence', () => {
    const result = ambiguousMatches(candidates(10));

    expect(result.shown).toHaveLength(10);
    expect(result.data.total_matches).toBe(10);
    expect(result.showing).toBe('');
  });

  it('cuts 11 to the first 10 and says the list is partial', () => {
    const all = candidates(11);
    const result = ambiguousMatches(all);

    expect(result.shown).toHaveLength(10);
    expect(result.shown).toEqual(all.slice(0, 10));
    expect(result.data.matches).toEqual(all.slice(0, 10));
    expect(result.list.split(', ')).toHaveLength(10);
    expect(result.list).toContain('0000000009 Company 9 (T9)');
    expect(result.list).not.toContain('0000000010');
    expect(result.data.total_matches).toBe(11);
    expect(result.showing).toBe(sentence(10, '11'));
  });

  it.each([
    [15, '15'],
    [66, '66'],
    [4705, '4,705'],
  ])('reads %i candidates as "Showing 10 of %s"', (n, grouped) => {
    const result = ambiguousMatches(candidates(n));

    expect(result.showing).toBe(sentence(10, grouped));
    expect(result.data).toMatchObject({ total_matches: n });
    expect(result.data).not.toHaveProperty('total_matches_is_lower_bound');
  });

  it('takes an exact total from the caller beside the hits it has', () => {
    const result = ambiguousMatches(candidates(10), { total: { count: 598 } });

    expect(result.shown).toHaveLength(10);
    expect(result.showing).toBe(sentence(10, '598'));
    expect(result.data.total_matches).toBe(598);
    expect(result.data).not.toHaveProperty('total_matches_is_lower_bound');
  });

  it('reads a total reported as a floor as "at least", and says so in data', () => {
    const result = ambiguousMatches(candidates(10), { total: { count: 10000, lowerBound: true } });

    expect(result.showing).toBe(sentence(10, 'at least 10,000'));
    expect(result.data).toEqual({
      matches: candidates(10),
      total_matches: 10000,
      total_matches_is_lower_bound: true,
    });
  });

  it('says a floor equal to the hits listed is partial too', () => {
    const result = ambiguousMatches(candidates(3), { total: { count: 3, lowerBound: true } });

    expect(result.showing).toBe(sentence(3, 'at least 3'));
    expect(result.data).toMatchObject({ total_matches: 3, total_matches_is_lower_bound: true });
  });

  it('adds no sentence when an exact total equals the hits listed', () => {
    const result = ambiguousMatches(candidates(4), { total: { count: 4, lowerBound: false } });

    expect(result.showing).toBe('');
    expect(result.data.total_matches).toBe(4);
    expect(result.data).not.toHaveProperty('total_matches_is_lower_bound');
  });

  it('counts a short list against a larger total by the hits it shows', () => {
    const result = ambiguousMatches(candidates(3), { total: { count: 598 } });

    expect(result.shown).toHaveLength(3);
    expect(result.showing).toBe(sentence(3, '598'));
  });

  // A single-token input changes only the retry clause: the cut, list, and data are the same.
  it.each([
    [2, undefined, ''],
    [10, undefined, ''],
    [15, undefined, tokenSentence(10, '15')],
    [66, undefined, tokenSentence(10, '66')],
    [10, { count: 10000, lowerBound: true }, tokenSentence(10, 'at least 10,000')],
  ])('reads %i candidates of a single-token input (total %o) as %j', (n, total, showing) => {
    const all = candidates(n);
    const token = ambiguousMatches(all, { total, singleToken: true });
    const named = ambiguousMatches(all, { total });

    expect(token.showing).toBe(showing);
    expect(token.shown).toEqual(named.shown);
    expect(token.list).toBe(named.list);
    expect(token.data).toEqual(named.data);
  });

  it('keeps the fuller-name clause when singleToken is false', () => {
    const result = ambiguousMatches(candidates(15), { singleToken: false });

    expect(result.showing).toBe(sentence(10, '15'));
  });
});
