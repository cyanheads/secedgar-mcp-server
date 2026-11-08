/**
 * @fileoverview `escapeMarkdownInline` (`@cyanheads/mcp-ts-core/utils`), which every `format()`
 * runs on text it did not author, reads back under a CommonMark parse as the text it was given in
 * every slot a `format()` puts it, a whitespace run of any length included, and runs in time
 * linear in its input.
 * @module tests/mcp-server/tools/markdown-escaping
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it } from 'vitest';
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
  const escaped = escapeMarkdownInline(value);
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
/** A run of 32 or more whitespace characters inside a line: any but U+000B, CR, and LF. */
const LONG_RUN = /[^\S\v\r\n]{32,}/u;

describe('escapeMarkdownInline', () => {
  it.each([
    ['mid-line', `a${run}b`],
    ['opening the text', `${run}lead`],
    ['ending the text', `trail${run}`],
    ['right before a line break', `a${run}\nb`],
    ['right before CRLF', `a${run}\r\nb`],
    ['right before CR', `a${run}\rb`],
    ['before a final line break', `a${run}\n`],
    ['before a line break and a list marker', `a${run}\n- b`],
    ['on a line of its own', `a\n${run}\nb`],
    ['between two lines that each hold one', `a${run}b\nc${run}d`],
    ['before each block marker', `a${run}# h${run}> q${run}1. x${run}- y${run}+ z${run}===`],
    ['before a thematic break and a table delimiter', `a${run}---${run}:-:`],
    ['before a # run, in a heading', `a${run}###`],
    ['before a # run too long for a heading', `a${run}#######`],
    ['before a backtick run', `a${run}\`\`\`\` b`],
    ['between backtick runs', `\`\`\`${run}\`\`\`\``],
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

  it('reads back seeded text holding long runs as its value in a paragraph and a list item', () => {
    const texts = samples([...SYNTAX, ...SHORT_RUNS, ...LONG_RUNS], 600, 221).filter((t) =>
      LONG_RUN.test(t),
    );
    expect(texts.length).toBeGreaterThan(300);
    for (const text of texts) {
      const label = JSON.stringify(text);
      const escaped = escapeMarkdownInline(text);
      const value = text.replace(/\r\n?/g, '\n');
      expect(readCommonMark(escaped), label).toBe(value);
      expect(readCommonMark(`- ${escaped}`), label).toBe(
        wrap('bullet_list', wrap('list_item', value)),
      );
    }
  });
});

/**
 * `escapeMarkdownInline` runs in time linear in its input. Each size doubles the last and is
 * checked before the next runs, so a cost beyond linear fails before the large sizes.
 */
describe('escapeMarkdownInline CPU time', () => {
  /** Thread CPU budget per input character, roughly 10x what a loaded machine measures. */
  const BUDGET_NS_PER_CHAR = 1000;
  const SMALLEST = 5_000;
  const LARGEST = 320_000;

  /** Least thread CPU microseconds per call on `text`, over 3 batches of `reps` calls. */
  function escapeMicros(text: string, reps: number): number {
    escapeMarkdownInline(text);
    let least = Number.POSITIVE_INFINITY;
    for (let batch = 0; batch < 3; batch++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < reps; i++) escapeMarkdownInline(text);
      const spent = process.threadCpuUsage(start);
      least = Math.min(least, (spent.user + spent.system) / reps);
    }
    return least;
  }

  const shapes: Array<[string, (chars: number) => string]> = [
    ['a whitespace run mid-line', (chars) => `a${' '.repeat(chars)}b`],
    ['a whitespace run at a line start', (chars) => `${'\t'.repeat(chars)}x`],
    ['a whitespace run before a second line', (chars) => `a${' '.repeat(chars)}b\ny`],
    ['a whitespace run at the end', (chars) => `x${'　'.repeat(chars)}`],
    ['one long line ending in a line break', (chars) => `${'x '.repeat(chars / 2)}\ny`],
    ['line breaks throughout', (chars) => '  \r\n'.repeat(chars / 4)],
    ['a backtick run', (chars) => `a${'`'.repeat(chars)}b`],
  ];

  it.each(shapes)('escapes %s in time linear in its length', (_shape, make) => {
    let smallest = 0;
    for (let chars = SMALLEST; chars <= LARGEST; chars *= 2) {
      // Small inputs are timed per call over a batch, so each measurement covers about 40k characters.
      const micros = escapeMicros(make(chars), Math.ceil(40_000 / chars));
      expect(micros, `${chars} characters`).toBeLessThan((chars * BUDGET_NS_PER_CHAR) / 1000);
      if (chars === SMALLEST) smallest = micros;
      // Linear growth with 4x slack at every size, so 256x the smallest at the 64x span.
      expect(micros / smallest, `${chars} characters`).toBeLessThan((4 * chars) / SMALLEST);
    }
  });
});
