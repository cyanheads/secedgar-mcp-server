/**
 * @fileoverview `escapeInline` reads back under a CommonMark parse as the text it was given, in
 * every slot a `format()` puts it, matches `escapeMarkdownInline` byte for byte where it makes
 * no cut, and runs in time linear in its input (mcp-ts-core#809).
 * @module tests/mcp-server/tools/escape-inline
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it } from 'vitest';
import { escapeInline } from '@/mcp-server/tools/escape-inline.js';
import { readCommonMark } from '../../support/commonmark.js';

const run = ' '.repeat(40);
const nbsp = ' '.repeat(40);
const tabs = '\t'.repeat(40);
const ideographic = '　'.repeat(40);

/** `inner` between the open and close tokens `readCommonMark` names for `type`. */
function wrap(type: string, inner: string): string {
  return `⟨${type}_open⟩\n\n${inner}\n\n⟨${type}_close⟩`;
}

/**
 * Asserts `value`, escaped, reads back as itself (CR and CRLF as LF) in a paragraph, after a
 * label, in a list item, and in a block quote with every line prefixed `> `; a one-line value
 * also in an ATX heading and a GFM table cell.
 */
function expectReadsBack(value: string): void {
  const escaped = escapeInline(value);
  const text = value.replace(/\r\n?/g, '\n');
  const quote = escaped
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  expect(readCommonMark(escaped), 'paragraph').toBe(text);
  expect(readCommonMark(`Value: ${escaped}`), 'after a label').toBe(`Value: ${text}`);
  expect(readCommonMark(`- ${escaped}`), 'list item').toBe(
    wrap('bullet_list', wrap('list_item', text)),
  );
  expect(readCommonMark(quote), 'block quote').toBe(wrap('blockquote', text));
  if (text.includes('\n')) return;
  expect(readCommonMark(`# ${escaped}`), 'heading').toBe(wrap('heading', text));
  expect(readCommonMark(`| h |\n| --- |\n| ${escaped} |`), 'table cell').toBe(
    wrap(
      'table',
      `${wrap('thead', wrap('tr', wrap('th', 'h')))}\n\n${wrap('tbody', wrap('tr', wrap('td', text)))}`,
    ),
  );
}

/** A seeded generator (mulberry32), so every run draws the same samples. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` strings of 1 to 24 tokens each, drawn from `tokens` by a generator seeded with `seed`. */
function samples(tokens: readonly string[], count: number, seed: number): string[] {
  const random = seeded(seed);
  const pick = () => tokens[Math.floor(random() * tokens.length)]!;
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + Math.floor(random() * 24) }, pick).join(''),
  );
}

/** Characters and runs the escaper reads as syntax, line structure, or edge whitespace. */
const SYNTAX = [
  'a',
  'Z',
  '7',
  'é',
  '😀',
  '_',
  '\\',
  '<',
  '>',
  '&',
  '#',
  '-',
  '+',
  '*',
  '`',
  '|',
  '~',
  '[',
  ']',
  ')',
  '=',
  ':',
  '.',
  '!',
  '/',
  '@',
  ';',
  '&amp;',
  '&#32;',
  '1. ',
  '# ',
  '- ',
  '<b>',
  'a@b.c>',
  '\n',
  '\r\n',
  '\r',
  '\v',
];
const SHORT_RUNS = [' ', '\t', ' ', '　', ' ', ' '.repeat(31), '\t'.repeat(15)];
const LONG_RUNS = [
  ' '.repeat(32),
  run,
  '\t'.repeat(33),
  ' '.repeat(32),
  '　'.repeat(48),
  ' \t 　'.repeat(10),
];
/** The run `escapeInline` cuts after: 32 or more of these whitespace characters inside a line. */
const CUT_RUN = /[^\S\v\r\n]{32,}/u;

describe('escapeInline', () => {
  it.each([
    ['mid-line', `a${run}b`],
    ['opening the text', `${run}lead`],
    ['ending the text', `trail${run}`],
    ['right before a line break', `a${run}\nb`],
    ['right before CRLF', `a${run}\r\nb`],
    ['before a final line break', `a${run}\n`],
    ['before a line break and a list marker', `a${run}\n- b`],
    ['on a line of its own', `a\n${run}\nb`],
    ['between two lines that each hold one', `a${run}b\nc${run}d`],
    ['before each block marker', `a${run}# h${run}> q${run}1. x${run}- y${run}+ z${run}===`],
    ['before a thematic break and a table delimiter', `a${run}---${run}:-:`],
    ['before a # run, in a heading', `a${run}###`],
    ['before a # run too long for a heading', `a${run}#######`],
    ['between emphasis markers', `*x*${run}*y*`],
    ['between backslashes', `a\\${run}\\b`],
    ['between underscores', `a_${run}_b`],
    ['between raw HTML tags', `<b>x</b>${run}<b>y</b>`],
    ['after <, before an email autolink tail', `x<${run}a@b.c>`],
    ['after <, before a tag tail', `x<${run}b>`],
    ['between entities', `AT&amp;T${run}&amp;`],
    ['inside a numeric reference', `&#32${run};`],
    ['between & and an entity tail', `x&${run}#123;`],
    ['beside a vertical tab', `a${run}\vb\v${run}c`],
    ['beside characters outside the BMP', `😀${run}😀`],
    ['of NBSP', `x${nbsp}y`],
    ['of tabs', `x${tabs}y`],
    ['of U+3000', `x${ideographic}y`],
    ['mixing every whitespace class', `x${' \t 　  '.repeat(8)}y`],
  ])('reads back a run %s as its value in every slot', (_case, value) => {
    expectReadsBack(value);
  });

  it('writes a run of 32 or more inside a line as references and one of 31 literally', () => {
    expect(escapeInline(`at${' '.repeat(32)}cut`)).toBe(`at${'&#32;'.repeat(32)}cut`);
    expect(escapeInline(`x${' '.repeat(32)}# y`)).toBe(`x${'&#160;'.repeat(32)}\\# y`);
    expect(escapeInline(`below${' '.repeat(31)}cut`)).toBe(`below${' '.repeat(31)}cut`);
  });

  it.each([
    ['', ''],
    ['plain', 'Apple Inc.'],
    ['every inline syntax', 'a *b* _c_ `d` [e](f) <g> &amp; h|i ~j~ \\k'],
    ['block markers on each line', '# h\n> q\n1. x\n- y\n===\n:-:'],
    ['edge whitespace on each line', `  lead\ntrail \t\n${' '.repeat(31)}\n`],
    ['runs of 31', `${' '.repeat(31)}a${'\t'.repeat(31)}b${' '.repeat(31)}`],
    ['a run ending each line', `a${run}\nb${tabs}\r\nc${nbsp}\rd${ideographic}\n`],
    ['a run ending the text', `trail${run}`],
  ])('returns what escapeMarkdownInline returns for %s', (_case, value) => {
    expect(escapeInline(value)).toBe(escapeMarkdownInline(value));
  });

  it('matches escapeMarkdownInline byte for byte on seeded text whose runs are all under 32', () => {
    const texts = samples([...SYNTAX, ...SHORT_RUNS], 600, 809).filter((t) => !CUT_RUN.test(t));
    expect(texts.length).toBeGreaterThan(500);
    for (const text of texts)
      expect(escapeInline(text), JSON.stringify(text)).toBe(escapeMarkdownInline(text));
  });

  it('reads back as escapeMarkdownInline does, line for line, on seeded text holding cuts', () => {
    const texts = samples([...SYNTAX, ...SHORT_RUNS, ...LONG_RUNS], 600, 221).filter((t) =>
      CUT_RUN.test(t),
    );
    expect(texts.length).toBeGreaterThan(300);
    for (const text of texts) {
      const label = JSON.stringify(text);
      const ours = escapeInline(text);
      const theirs = escapeMarkdownInline(text);
      expect(ours.split('\n').length, label).toBe(theirs.split('\n').length);
      expect(readCommonMark(ours), label).toBe(readCommonMark(theirs));
      expect(readCommonMark(`- ${ours}`), label).toBe(readCommonMark(`- ${theirs}`));
    }
  });
});

/**
 * `escapeInline` runs in time linear in its input (mcp-ts-core#809). Each size doubles the
 * last and is checked before the next runs, so quadratic growth fails before the large sizes.
 */
describe('escapeInline CPU time (mcp-ts-core#809)', () => {
  /** Thread CPU budget per input character, roughly 10x what a loaded machine measures. */
  const BUDGET_NS_PER_CHAR = 1000;

  /** Least thread CPU microseconds per `escapeInline` call on `text`, over 3 batches of `reps` calls. */
  function escapeMicros(text: string, reps: number): number {
    escapeInline(text);
    let least = Number.POSITIVE_INFINITY;
    for (let batch = 0; batch < 3; batch++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < reps; i++) escapeInline(text);
      const spent = process.threadCpuUsage(start);
      least = Math.min(least, (spent.user + spent.system) / reps);
    }
    return least;
  }

  const shapes: Array<[string, (chars: number) => string]> = [
    ['mid-line', (chars) => `a${' '.repeat(chars)}b`],
    ['at a line start', (chars) => `${'\t'.repeat(chars)}x`],
    ['before a second line', (chars) => `a${' '.repeat(chars)}b\ny`],
    ['at the end', (chars) => `x${'　'.repeat(chars)}`],
    [
      'just under the cut',
      (chars) => `${' '.repeat(31)}x`.repeat(Math.ceil(chars / 32)).slice(0, chars),
    ],
    ['one long line ending in a line break', (chars) => `${'§1 x'.repeat(chars / 4)}\ny`],
    ['line breaks throughout', (chars) => '  \r\n'.repeat(chars / 4)],
  ];

  it.each(shapes)('escapes input %s in time linear in its length', (_shape, make) => {
    let smallest = 0;
    for (let chars = 5_000; chars <= 320_000; chars *= 2) {
      // Small inputs are timed per call over a batch, so each measurement covers about 40k characters.
      const micros = escapeMicros(make(chars), Math.ceil(40_000 / chars));
      expect(micros, `${chars} characters`).toBeLessThan((chars * BUDGET_NS_PER_CHAR) / 1000);
      if (chars === 5_000) smallest = micros;
      // Linear growth with 4x slack: the full 64x span may cost at most 256x the smallest size.
      expect(micros / smallest, `${chars} characters`).toBeLessThan((4 * chars) / 5_000);
    }
  });
});
