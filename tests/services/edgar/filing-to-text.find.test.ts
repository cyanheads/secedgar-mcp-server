/**
 * @fileoverview Tests for `findPhrase` (#238): the fold it shares with `section`
 *   matching, document offsets past folds that change a string's length, astral
 *   characters, non-overlapping matches, the listing limit with `total` and
 *   `before`, the empty cases, and CPU time linear in the text length.
 * @module tests/services/edgar/filing-to-text.find
 */

import { describe, expect, it } from 'vitest';
import { findPhrase, foldForHeadingMatch } from '@/services/edgar/filing-to-text.js';

/** U+00A0, which `\s` reads as whitespace. */
const NBSP = String.fromCharCode(0xa0);
/** U+0130's lowercase form: `i`, then U+0307 COMBINING DOT ABOVE — two code units for one. */
const DOTTED_I_LOWER = `i${String.fromCharCode(0x307)}`;

/** The listed occurrences of `phrase` in `text` from offset 0, as `[offset, end]` pairs. */
function spans(text: string, phrase: string): Array<[number, number]> {
  return findPhrase(text, phrase, 0, 20).listed.map((o) => [o.offset, o.end]);
}

describe('findPhrase — the fold', () => {
  it.each<[string, string, string, Array<[number, number]>]>([
    ['case', 'x NET REVENUE y', 'net revenue', [[2, 13]]],
    ['a non-breaking space in the text', `x net${NBSP}revenue y`, 'net revenue', [[2, 13]]],
    ['a line break and indentation in the text', 'x net\n    revenue y', 'net revenue', [[2, 17]]],
    [
      'whitespace runs, NBSP, and edge whitespace in the phrase',
      'x net revenue y',
      `  NET ${NBSP}\t revenue\n`,
      [[2, 13]],
    ],
    ['curly quotes in the text', 'the “company’s” plan', '"company\'s"', [[4, 15]]],
    ['curly quotes in the phrase', 'the "company\'s" plan', '“company’s”', [[4, 15]]],
    ['a substring of a longer word', 'revenues', 'revenue', [[0, 7]]],
  ])('ignores %s', (_label, text, phrase, expected) => {
    expect(spans(text, phrase)).toEqual(expected);
  });

  // A text already folded matches the phrase whole exactly when the phrase folds to it.
  it.each([
    'NET  revenue\nretention',
    `Net${NBSP}Revenue${NBSP}${NBSP}Retention`,
    '  “Quoted” and ‘single’  ',
    'MANAGEMENT’S DISCUSSION',
  ])('folds the phrase %j as foldForHeadingMatch does', (phrase) => {
    const folded = foldForHeadingMatch(phrase);
    expect(spans(folded, phrase)).toEqual([[0, folded.length]]);
  });

  it('does not match a phrase whose characters differ beyond case, whitespace, and quotes', () => {
    expect(findPhrase('net-revenue retention', 'net revenue retention', 0, 20).total).toBe(0);
  });
});

describe('findPhrase — document offsets', () => {
  it('reports offsets past a lowercase form longer than its source (U+0130)', () => {
    expect('İ'.toLowerCase()).toBe(DOTTED_I_LOWER);
    expect(spans('İİİ needle İİ needle', 'needle')).toEqual([
      [4, 10],
      [14, 20],
    ]);
  });

  it.each([
    ['the lowercase form', `${DOTTED_I_LOWER}stanbul`],
    ['the source form', 'İSTANBUL'],
  ])('matches U+0130 through %s, spanning its one code unit', (_label, phrase) => {
    expect(spans('ab İSTANBUL cd', phrase)).toEqual([[3, 11]]);
  });

  it('counts an astral character before a match as two code units', () => {
    expect(spans('😀😀 needle', 'needle')).toEqual([[5, 11]]);
  });

  it('folds an astral capital and spans both of its code units', () => {
    expect('𐐀'.toLowerCase()).toBe('𐐨');
    expect(spans('x 𐐀𐐁 y', '𐐨𐐩')).toEqual([[2, 6]]);
  });
});

describe('findPhrase — non-overlapping matches', () => {
  it.each<[string, string, Array<[number, number]>]>([
    [
      'aaaa',
      'aa',
      [
        [0, 2],
        [2, 4],
      ],
    ],
    ['aaa', 'aa', [[0, 2]]],
    ['aaaaa', 'aaa', [[0, 3]]],
    [
      'abababab',
      'abab',
      [
        [0, 4],
        [4, 8],
      ],
    ],
  ])('finds %j in %j at the non-overlapping offsets', (text, phrase, expected) => {
    expect(spans(text, phrase)).toEqual(expected);
  });

  it.each<[string, string, Array<[number, number]>]>([
    ['aaab', 'aab', [[1, 4]]],
    ['net net net revenue', 'net net revenue', [[4, 19]]],
  ])('finds %j where a partial match of %j restarts inside itself', (text, phrase, expected) => {
    expect(spans(text, phrase)).toEqual(expected);
  });

  it('counts the same occurrences from the document start whatever the search start', () => {
    expect(findPhrase('aaaa', 'aa', 1, 20)).toEqual({
      before: 1,
      listed: [{ offset: 2, end: 4 }],
      total: 2,
    });
  });
});

describe('findPhrase — the listing limit, total, and before', () => {
  // Occurrence k starts at 7k and ends at 7k + 6.
  const TEXT = 'needle '.repeat(30);
  const from = (k: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ offset: 7 * (k + i), end: 7 * (k + i) + 6 }));

  it('lists the first 20 and counts all 30', () => {
    expect(findPhrase(TEXT, 'needle', 0, 20)).toEqual({
      before: 0,
      listed: from(0, 20),
      total: 30,
    });
  });

  it('lists from the first occurrence starting at the search start', () => {
    expect(findPhrase(TEXT, 'needle', 35, 20)).toEqual({
      before: 5,
      listed: from(5, 20),
      total: 30,
    });
  });

  it('counts an occurrence starting before the search start as before it', () => {
    expect(findPhrase(TEXT, 'needle', 36, 20)).toEqual({
      before: 6,
      listed: from(6, 20),
      total: 30,
    });
  });

  it('lists fewer than the limit when fewer remain', () => {
    expect(findPhrase(TEXT, 'needle', 7 * 25, 20)).toEqual({
      before: 25,
      listed: from(25, 5),
      total: 30,
    });
  });

  it.each([
    ['inside the last occurrence', 7 * 29 + 1],
    ['past the end of the text', 10_000],
  ])('lists none and counts every occurrence before a search start %s', (_label, start) => {
    expect(findPhrase(TEXT, 'needle', start, 20)).toEqual({ before: 30, listed: [], total: 30 });
  });

  it('keeps the listing at the limit over a text whose every word is the phrase', () => {
    const matches = findPhrase('needle '.repeat(100_000), 'needle', 0, 20);
    expect(matches.total).toBe(100_000);
    expect(matches.listed).toHaveLength(20);
  });
});

describe('findPhrase — nothing to find', () => {
  it.each([
    ['an empty text', '', 'needle'],
    ['a text of whitespace alone', `  \n\t${NBSP} `, 'needle'],
    ['a phrase longer than the text', 'need', 'needle'],
    ['a phrase longer than the text once its whitespace folds', 'net   rev', 'net revenue'],
  ])('finds nothing in %s', (_label, text, phrase) => {
    expect(findPhrase(text, phrase, 0, 20)).toEqual({ before: 0, listed: [], total: 0 });
  });
});

/**
 * One forward pass over the folded text, so thread CPU per character stays flat.
 * Each size doubles the last and is checked before the next runs, so super-linear
 * growth fails before the large sizes; the smallest sizes are timed per call over
 * a batch, and each size keeps the least of three measurements.
 */
describe('findPhrase — CPU time, linear in the text length', () => {
  /** Thread CPU budget per text character, several times what either runtime measures. */
  const BUDGET_NS_PER_CHAR = 1000;

  /** Least thread CPU microseconds per call over 3 batches of `reps` calls. */
  function findMicros(text: string, phrase: string, reps: number): number {
    findPhrase(text, phrase, 0, 20);
    let least = Number.POSITIVE_INFINITY;
    for (let batch = 0; batch < 3; batch++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < reps; i++) findPhrase(text, phrase, 0, 20);
      const spent = process.threadCpuUsage(start);
      least = Math.min(least, (spent.user + spent.system) / reps);
    }
    return least;
  }

  const shapes: Array<[string, (chars: number) => string, string, number]> = [
    ['one repeated character', (chars) => 'a'.repeat(chars), `${'a'.repeat(199)}b`, 16_384],
    ['a long digit run', (chars) => '7'.repeat(chars), `${'7'.repeat(199)}8`, 16_384],
    ['every word the phrase', (chars) => 'needle '.repeat(Math.ceil(chars / 7)), 'needle', 5_000],
    [
      'one long line ending in a line break',
      (chars) => `${'§1 x'.repeat(chars / 4)}\ny`,
      '§1 x§1 y',
      5_000,
    ],
    ['line breaks throughout', (chars) => '  \r\n'.repeat(chars / 4), 'a b', 5_000],
    [
      'non-breaking spaces throughout',
      (chars) => `${NBSP}x`.repeat(chars / 2),
      `${NBSP}x${NBSP}y`,
      5_000,
    ],
    [
      'a lowercase form longer than its source',
      (chars) => 'İ'.repeat(chars),
      `${DOTTED_I_LOWER.repeat(99)}x`,
      5_000,
    ],
  ];

  it.each(shapes)(
    'scans a text of %s in time linear in its length',
    (_shape, make, phrase, first) => {
      let smallest = 0;
      for (let chars = first; chars <= first * 64; chars *= 2) {
        // Small texts are timed per call over a batch, each measurement covering about 64k characters.
        const micros = findMicros(make(chars), phrase, Math.ceil(65_536 / chars));
        expect(micros, `${chars} characters`).toBeLessThan((chars * BUDGET_NS_PER_CHAR) / 1000);
        if (chars === first) smallest = micros;
        // Linear growth with 4x slack: the full 64x span may cost at most 256x the smallest size.
        expect(micros / smallest, `${chars} characters`).toBeLessThan((4 * chars) / first);
      }
    },
  );
});
