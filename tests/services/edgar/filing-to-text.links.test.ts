/**
 * @fileoverview Tests for the in-document link pass of filing-to-text (#239): the
 * sentinel marking around `convert()` that records each link's and target's text
 * offset while leaving the extraction byte-identical, the inputs it refuses to
 * mark, its linear cost, and `linkedSectionStart`, which carries a `section`
 * landing on a table-of-contents row to the section the row links to.
 * @module tests/services/edgar/filing-to-text.links
 */

import { describe, expect, it } from 'vitest';
import {
  detectHeadings,
  type FilingHeading,
  filingToExtract,
  type InDocumentLink,
  isTocHeading,
  linkedSectionStart,
} from '@/services/edgar/filing-to-text.js';

/** `body` inside the `<html><body>` frame a filing's primary document carries. */
const page = (body: string) => `<html><body>${body}</body></html>`;

/** The extraction and the links `filingToExtract` records for `html`. */
function extractWithLinks(html: string): { links: InDocumentLink[]; text: string } {
  const links: InDocumentLink[] = [];
  const text = filingToExtract(html, links);
  return { links, text };
}

describe('filingToExtract — in-document links keep the extraction byte-identical (#239)', () => {
  /**
   * Each fixture's literal is the pre-#239 extraction, byte for byte. A sentinel
   * placed right after a start tag changes five of them (a blank line in the
   * first, a leading space in the second, third, eighth, and ninth); a mark
   * placed inside a comment, a script, or an attribute is never rendered, so its
   * link goes missing; the recorded links name where each mark landed.
   */
  it.each<[string, string, string, string[][]]>([
    [
      'an empty target div opening a block before the next one',
      page(
        '<div><a href="#t">Go</a></div><div>Before</div><div><div id="t"></div><div>After</div></div>',
      ),
      'Go\nBefore\nAfter',
      [['Go', 'After']],
    ],
    [
      'a target whose text opens on &#32;',
      page('<p><a href="#t">Go</a></p><div id="t">&#32;RAYONIER ADVANCED MATERIALS</div>'),
      'Go\n\nRAYONIER ADVANCED MATERIALS',
      [['Go', 'RAYONIER']],
    ],
    [
      'an empty link before a &#8203; cell',
      page(
        '<table><tr><td><a href="#t"> </a></td><td>&#8203;</td><td>Item 1. Business</td><td>4</td></tr></table><p>Cover</p><div id="t">Business body</div>',
      ),
      'Item 1. Business4\n\nCover\n\nBusiness body',
      [['Item 1.', 'Business body']],
    ],
    [
      '<a name> targets, an id winning over an earlier name',
      page(
        '<p><a href="#n">Named</a> <a href="#both">Both</a></p><p><a name="n"></a>Name target</p><p><a name="both"></a>Name copy</p><div id="both">Id target</div>',
      ),
      'Named Both\n\nName target\n\nName copy\n\nId target',
      [
        ['Named', 'Name target'],
        ['Both', 'Id target'],
      ],
    ],
    [
      'uppercase tags and attributes, the fragment matched case-sensitively',
      '<HTML><BODY><P><A HREF="#Up">Go</A></P><DIV ID="up">lower decoy</DIV><DIV ID="Up">Upper target</DIV></BODY></HTML>',
      'Go\n\nlower decoy\nUpper target',
      [['Go', 'Upper target']],
    ],
    [
      'a comment, a script with an uppercase closer, and a style before the text',
      page(
        '<p><a href="#t">Go</a></p><div id="t"><!-- <b>note</b> --><script>if (a < b) { s = "</div>"; }</SCRIPT><style>p { color: red; }</style>Target text</div>',
      ),
      'Go\n\nTarget text',
      [['Go', 'Target text']],
    ],
    [
      'a < that is text',
      page('<p><a href="#t">Go</a></p><div id="t">< 5 percent of revenue</div>'),
      'Go\n\n< 5 percent of revenue',
      [['Go', '< 5 percent']],
    ],
    [
      'character references with no ;',
      // `&#32R` is a space before R; `&#x9bN` is one reference, U+009B (rendered ›), not a tab and a b.
      page(
        '<p><a href="#t">Go</a></p><div id="t">&#32RAYONIER</div><p><a href="#u">Go too</a></p><div id="u">&#x9bNext</div>',
      ),
      'Go\n\nRAYONIER\n\nGo too\n\n›Next',
      [
        ['Go', 'RAYONIER'],
        ['Go too', '›Next'],
      ],
    ],
    [
      'named whitespace references, a miscased one, and an NBSP, which is text',
      page(
        '<p><a href="#t">Go</a> <a href="#u">Go too</a> <a href="#v">Go three</a></p><div id="t">&NewLine;&Tab;&ZeroWidthSpace;Target</div><div id="u">&tab;lower</div><div id="v">&nbsp;Kept</div>',
      ),
      'Go Go too Go three\n\nTarget\n&tab;lower\n Kept',
      [
        ['Go', 'Target'],
        ['Go too', '&tab;lower'],
        ['Go three', ' Kept'],
      ],
    ],
  ])('%s', (_label, html, literal, expected) => {
    const { links, text } = extractWithLinks(html);

    expect(text).toBe(literal);
    expect(filingToExtract(html)).toBe(literal);
    // Each expected string occurs once in the literal, so its index is where the mark belongs.
    expect(links).toEqual(
      expected.map(([link = '', target = '']) => ({
        offset: literal.indexOf(link),
        target: literal.indexOf(target),
      })),
    );
  });

  it('records the links in text order, each target past the table-of-contents row that links it', () => {
    const { links, text } = extractWithLinks(
      page(
        '<div><a href="#rf">RISK FACTORS</a></div><div>12</div><div><a href="#uop">USE OF PROCEEDS</a></div><div>81</div><div id="rf"></div><div>Risk Factors</div><div id="uop"></div><div>Use of Proceeds</div>',
      ),
    );

    expect(text).toBe('RISK FACTORS\n12\nUSE OF PROCEEDS\n81\n\nRisk Factors\n\nUse of Proceeds');
    expect(links).toEqual([
      { offset: 0, target: text.indexOf('Risk Factors') },
      { offset: text.indexOf('USE OF PROCEEDS'), target: text.indexOf('Use of Proceeds') },
    ]);
  });

  it('records nothing for a link whose fragment no element carries, or a target no link names', () => {
    const html = page(
      '<p><a href="#missing">Go</a> <a href="#">Top</a> <a href="other.htm#t">Elsewhere</a></p><div id="t">Target</div>',
    );
    const { links, text } = extractWithLinks(html);

    expect(text).toBe(filingToExtract(html));
    expect(links).toEqual([]);
  });

  it('records nothing for a target with no text after it', () => {
    const html = page(
      '<p><a href="#t">Go</a></p><p>Body</p><div id="t"></div><img src="card.jpg">',
    );
    const { links, text } = extractWithLinks(html);

    expect(text).toBe(filingToExtract(html));
    expect(text).toBe('Go\n\nBody\n\n');
    expect(links).toEqual([]);
  });

  it('leaves the plain extraction unmarked when no links array is passed', () => {
    const html = page('<p><a href="#t">Go</a></p><div id="t">Target</div>');

    expect(filingToExtract(html)).toBe('Go\n\nTarget');
  });
});

describe('filingToExtract — no links when marking could change the conversion (#239)', () => {
  const LINKED = '<p><a href="#t">Go</a></p><div id="t">Target</div>';

  it('records the link in the control document the cases below add a sentinel to', () => {
    const { links, text } = extractWithLinks(page(`${LINKED}<p>Plain text here</p>`));

    expect(links).toEqual([{ offset: 0, target: text.indexOf('Target') }]);
  });

  it.each([
    ['U+FDD0 written literally', '﷐'],
    ['U+FDD1 written literally', '﷑'],
    ['U+FDD0 as a hex reference', '&#xFDD0;'],
    ['U+FDD1 as an uppercase hex reference with no ;', '&#XFDD1'],
    ['U+FDD1 as a decimal reference with no ;', '&#64977'],
  ])('a document holding %s converts unmarked', (_label, sentinel) => {
    const html = page(`${LINKED}<p>Plain ${sentinel} text here</p>`);
    const { links, text } = extractWithLinks(html);

    expect(links).toEqual([]);
    expect(text).toBe(filingToExtract(html));
    expect(text.startsWith('Go\n\nTarget\n\nPlain ')).toBe(true);
  });

  /**
   * html-to-text cuts input past 16,777,216 characters without a word, so marked
   * input past that would convert differently from the input it marks. The bulk
   * is one comment, which the parser skips — a 16 MB conversion of it costs
   * about 50 ms, where 16 MB of text costs over 100.
   */
  describe('the 16,777,216-character input limit', () => {
    const MAX_CONVERT_INPUT_CHARS = 16_777_216;
    const HEAD = '<div><a href="#t">Go</a></div><div id="t">Target</div><!--';
    const TAIL = '-->';
    // Each of the two sentinels is an opener, a one-digit index, and a closer.
    const SENTINEL_CHARS = 2 * 3;
    /** A document whose marked input is `over` characters past the limit. */
    const sized = (over: number) =>
      HEAD +
      'a'.repeat(MAX_CONVERT_INPUT_CHARS - SENTINEL_CHARS - HEAD.length - TAIL.length + over) +
      TAIL;

    it('keeps the links when the marked input is exactly at the limit', () => {
      const html = sized(0);
      const { links, text } = extractWithLinks(html);

      expect(html.length + SENTINEL_CHARS).toBe(MAX_CONVERT_INPUT_CHARS);
      expect(text).toBe('Go\nTarget');
      expect(links).toEqual([{ offset: 0, target: 3 }]);
    });

    it('records no links when the marked input is one character past it', () => {
      const html = sized(1);
      const { links, text } = extractWithLinks(html);

      expect(html.length).toBeLessThan(MAX_CONVERT_INPUT_CHARS);
      expect(text).toBe('Go\nTarget');
      expect(links).toEqual([]);
    });
  });
});

/** `unit` repeated to at least `chars` characters. */
const fill = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length));

/**
 * Thread CPU milliseconds `run` takes, best of three: wall clock is noise under a
 * parallel suite, and one scheduler hiccup cannot fail a bound.
 */
function bestOf3CpuMs(run: () => unknown): number {
  const cpuMs = () => {
    const start = process.threadCpuUsage();
    run();
    const used = process.threadCpuUsage(start);
    return (used.user + used.system) / 1000;
  };
  return Math.min(cpuMs(), cpuMs(), cpuMs());
}

/** Calls the 5,000-character baseline is timed over, so one call's CPU reads above the clock's grain. */
const BASELINE_CALLS = 20;

/**
 * Asserts that `run` stays linear over `build(n)`. Times the 5,000-character input
 * per call over a batch, then doubles n to `maxChars`, checking `boundMs` of
 * thread CPU at each size before building the next, so a quadratic shape fails in
 * seconds instead of hanging the suite, and holds the full-span ratio under four
 * times the span: 256 over 5k → 320k, where a quadratic scan reaches the span
 * squared.
 */
function expectLinear(
  run: (text: string) => unknown,
  build: (n: number) => string,
  maxChars: number,
  boundMs: number,
): void {
  const small = build(5_000);
  run(small); // warm the JIT
  // Floored so a near-zero baseline cannot inflate the ratio on noise.
  const t5k = Math.max(
    bestOf3CpuMs(() => {
      for (let k = 0; k < BASELINE_CALLS; k++) run(small);
    }) / BASELINE_CALLS,
    0.05,
  );
  let last = t5k;
  for (let n = 10_000; n <= maxChars; n *= 2) {
    const text = build(n);
    last = bestOf3CpuMs(() => run(text));
    expect(last, `${n} characters`).toBeLessThan(boundMs);
  }
  expect(last / t5k).toBeLessThan((4 * maxChars) / 5_000);
}

describe('filingToExtract — the link pass stays linear (#239)', () => {
  /** A link and its target, the target waiting for the text the shape puts after it. */
  const LINKED = '<p><a href="#t">Go</a></p><div id="t">';
  /** About `n` characters of linked empty `<a name>` targets, every link ahead of every target. */
  const linkedNameTargets = (n: number) => {
    const count = Math.ceil(n / 40);
    let links = '';
    let targets = '';
    for (let i = 0; i < count; i++) {
      links += `<a href="#n${i}">L</a>`;
      targets += `<a name="n${i}"></a>`;
    }
    return links + targets;
  };
  /** The links a run records, so the timed call is the marked conversion. */
  const marked = (html: string) => filingToExtract(html, []);

  it.each([
    [
      'linked empty <a name> targets followed by text-free markup',
      (n: number) => `${linkedNameTargets(n)}${fill('<b></b>', n / 2)}x`,
    ],
    ['a waiting target, then tag openers with no >', (n: number) => `${LINKED}${fill('<a ', n)}`],
    [
      'nested tag openers, <a<a<a…>>>',
      (n: number) => `${LINKED}${fill('<a', n / 2)}${fill('>', n / 2)}x`,
    ],
    ['<!-- with no closer', (n: number) => `${LINKED}<!--${fill('x', n)}`],
    ['repeated <!-- openers', (n: number) => `${LINKED}${fill('<!--', n)}`],
    [
      '<script with no closer, near-miss closers throughout',
      (n: number) => `${LINKED}<script>${fill('</scrip ', n)}`,
    ],
    [
      '<style with no closer, near-miss closers throughout',
      (n: number) => `${LINKED}<style>${fill('</styl ', n)}`,
    ],
    ['a long &#x000… reference', (n: number) => `${LINKED}&#x${'0'.repeat(n)};Text`],
    ['repeated &#x0 references', (n: number) => `${LINKED}${fill('&#x0', n)}Text`],
    [
      'whitespace references while a target waits',
      (n: number) => `${LINKED}${fill('&#32;&Tab;', n)}x`,
    ],
    ['a tag with an unclosed quote', (n: number) => `${LINKED}<div title="${fill('x ', n)}>Text`],
    [
      'repeated tags with an unclosed quote',
      (n: number) => `${LINKED}${fill('<b title="x>', n)}Text`,
    ],
    ['one long line ending in a break', (n: number) => `${LINKED}${fill('§1 x', n)}\ny`],
    ['breaks throughout', (n: number) => `${LINKED}${fill('  \r\n', n)}x`],
    ['a long digit run', (n: number) => `${LINKED}${'1'.repeat(n)}`],
  ])(
    '%s (5k → 320k)',
    (_label, build) => {
      // Measured at 1–29 ms for 320k on Bun, the parser's own conversion included.
      expectLinear(marked, build, 320_000, 200);
    },
    0,
  );

  // These bodies run with a per-test timeout of 0: vitest cannot interrupt a synchronous body,
  // so its wall-clock timeout guards no hang and only fails linear work on a loaded machine;
  // the thread-CPU bounds are the check.
  it('marks 100,000 linked empty <a name> targets followed by a megabyte of markup with no text', () => {
    let links = '';
    let targets = '';
    for (let i = 0; i < 100_000; i++) {
      links += `<a href="#n${i}">L</a>`;
      targets += `<a name="n${i}"></a>`;
    }
    const html = `${links}${targets}${fill('<b></b>', 1_000_000)}x`;
    const recorded: InDocumentLink[] = [];

    // Measured near 310 ms on Bun, about 180 of it the parser's unmarked conversion.
    const cpuMs = bestOf3CpuMs(() => {
      recorded.length = 0;
      filingToExtract(html, recorded);
    });

    expect(recorded).toHaveLength(100_000);
    expect(new Set(recorded.map((link) => link.target)).size).toBe(1);
    expect(cpuMs).toBeLessThan(3_000);
  }, 0);

  it('stops at the first < with no > after it in a megabyte holding no >', () => {
    const html = `${LINKED}${fill('<a ', 1_000_000)}`;
    const recorded: InDocumentLink[] = [];

    const cpuMs = bestOf3CpuMs(() => {
      recorded.length = 0;
      filingToExtract(html, recorded);
    });

    // The target's text never comes, so the link has nowhere to land.
    expect(recorded).toEqual([]);
    expect(cpuMs).toBeLessThan(500);
  }, 0);
});

/** A link whose text starts at `link` and whose target's text starts at `target`, both found in `text`. */
function linkAt(text: string, link: string, target: string, from = 0): InDocumentLink {
  const offset = text.indexOf(link, from);
  const targetAt = text.indexOf(target, offset + link.length);
  expect(offset, link).toBeGreaterThanOrEqual(0);
  expect(targetAt, target).toBeGreaterThanOrEqual(0);
  return { offset, target: targetAt };
}

/** The detected heading equal to `heading`, asserted present. */
function headingNamed(text: string, heading: string): FilingHeading {
  const found = detectHeadings(text).find((h) => h.heading === heading);
  expect(found, heading).toBeDefined();
  return found as FilingHeading;
}

describe('linkedSectionStart — a table-of-contents row that links forward (#239)', () => {
  /** An all-caps TOC row per section over its page cell, then each section in mixed case. */
  const TITLED =
    'RISK FACTORS\n12\nUSE OF PROCEEDS\n81\n\nWe are offering shares of our stock to the public.\n' +
    '28\nRisk Factors\nInvesting in our stock involves risk.\n81\nUse of Proceeds\nWe will use the proceeds.\n';
  /** A TOC row of separate marker, title, and page cells, as an HTML TOC table renders them. */
  const JOINED =
    'Item 6.\n\nExhibits\n\n49\n\n \n\nSignatures\n\n50\n\nBody prose follows here for a while.\n\n' +
    'Exhibit Index\n\nExhibit 31.1\n\nSignatures\n\nPursuant to the requirements.\n';

  it('reads the fixtures as table-of-contents rows', () => {
    const risk = headingNamed(TITLED, 'RISK FACTORS');
    const exhibits = headingNamed(JOINED, 'Item 6. Exhibits');

    expect(isTocHeading(TITLED, risk)).toBe(true);
    expect(isTocHeading(JOINED, exhibits)).toBe(true);
    // The joined heading is a bare marker over its title, so its text is not at its offset.
    expect(JOINED.startsWith(exhibits.heading, exhibits.offset)).toBe(false);
  });

  it('carries a titled row whose link starts on the heading line to the line holding its target', () => {
    const risk = headingNamed(TITLED, 'RISK FACTORS');
    const links = [linkAt(TITLED, 'RISK FACTORS', 'Risk Factors')];

    expect(linkedSectionStart(TITLED, risk, links)).toBe(TITLED.indexOf('Risk Factors'));
  });

  it('counts a link starting on the page-cell line under a titled row', () => {
    const risk = headingNamed(TITLED, 'RISK FACTORS');
    const links = [linkAt(TITLED, '12', 'Risk Factors')];

    expect(linkedSectionStart(TITLED, risk, links)).toBe(TITLED.indexOf('Risk Factors'));
  });

  it.each([
    ['the marker line', 'Item 6.'],
    ['the joined title line', 'Exhibits'],
    ['the page-cell line under the title', '49'],
  ])('counts a link starting on %s of a bare marker joined to its title', (_label, linkText) => {
    const exhibits = headingNamed(JOINED, 'Item 6. Exhibits');
    const links = [linkAt(JOINED, linkText, 'Exhibit Index')];

    expect(linkedSectionStart(JOINED, exhibits, links)).toBe(JOINED.indexOf('Exhibit Index'));
  });

  it('does not count the next row’s link, past the page cell', () => {
    const risk = headingNamed(TITLED, 'RISK FACTORS');
    const exhibits = headingNamed(JOINED, 'Item 6. Exhibits');

    expect(
      linkedSectionStart(TITLED, risk, [linkAt(TITLED, 'USE OF PROCEEDS', 'Use of Proceeds')]),
    ).toBeUndefined();
    // Signatures' row sits under a spacer line after the page cell.
    expect(
      linkedSectionStart(JOINED, exhibits, [linkAt(JOINED, 'Signatures', 'Pursuant')]),
    ).toBeUndefined();
  });

  it('does not count a link on the line after a row with no page-cell line', () => {
    // The page cell sits at the row's end, so the row is its own line alone.
    const text =
      'RISK FACTORS      12\nUSE OF PROCEEDS      81\n\nWe are offering shares.\nRisk Factors\nUse of Proceeds\n';
    const risk = headingNamed(text, 'RISK FACTORS');

    expect(isTocHeading(text, risk)).toBe(true);
    expect(
      linkedSectionStart(text, risk, [linkAt(text, 'USE OF PROCEEDS', 'Use of Proceeds')]),
    ).toBeUndefined();
    expect(linkedSectionStart(text, risk, [linkAt(text, '12', 'Risk Factors')])).toBe(
      text.indexOf('Risk Factors'),
    );
  });

  it('never moves a landing for a link whose target is on or before the row', () => {
    const risk = headingNamed(TITLED, 'RISK FACTORS');
    const onRow = TITLED.indexOf('12');
    const before = { offset: 0, target: 0 };
    const toPageCell = { offset: 0, target: onRow };

    expect(linkedSectionStart(TITLED, risk, [before])).toBeUndefined();
    expect(linkedSectionStart(TITLED, risk, [toPageCell])).toBeUndefined();
  });

  it('passes a back-link over to a later forward link on the same row', () => {
    const risk = headingNamed(TITLED, 'RISK FACTORS');
    const links = [{ offset: 0, target: 0 }, linkAt(TITLED, '12', 'Risk Factors')];

    expect(linkedSectionStart(TITLED, risk, links)).toBe(TITLED.indexOf('Risk Factors'));
  });

  it('lands on the start of the line holding a target set mid-line', () => {
    const text =
      'EXECUTIVE COMPENSATION\n140\n\nCover prose for the offering.\nExecutive Compensation\nOur pay program.\n';
    const heading = headingNamed(text, 'EXECUTIVE COMPENSATION');
    // The target sits between the two words, as print layout splits a heading.
    const target = text.indexOf('Compensation\nOur');
    const links = [{ offset: 0, target }];

    expect(linkedSectionStart(text, heading, links)).toBe(text.indexOf('Executive Compensation'));
  });

  it('leaves a body heading alone, whatever its line links to', () => {
    const text =
      'Cover prose for the offering.\n\nRISK FACTORS\nInvesting in our stock involves risk.\n\nNotes\nA note.\n';
    const risk = headingNamed(text, 'RISK FACTORS');
    const links = [linkAt(text, 'RISK FACTORS', 'Notes')];

    expect(isTocHeading(text, risk)).toBe(false);
    expect(linkedSectionStart(text, risk, links)).toBeUndefined();
  });

  it('leaves a table-of-contents row alone when the document has no links', () => {
    expect(linkedSectionStart(TITLED, headingNamed(TITLED, 'RISK FACTORS'), [])).toBeUndefined();
  });

  it('carries the row of a converted filing through the links its extraction recorded', () => {
    const { links, text } = extractWithLinks(
      page(
        '<div><a href="#rf">RISK FACTORS</a></div><div>12</div><div><a href="#uop">USE OF PROCEEDS</a></div><div>81</div>' +
          '<div>We are offering shares of our stock to the public.</div>' +
          '<div id="rf"></div><div>28</div><div>Risk Factors</div><div>Investing in our stock involves risk.</div>' +
          '<div id="uop"></div><div>81</div><div>Use of Proceeds</div><div>We will use the proceeds.</div>',
      ),
    );

    expect(text).toBe(
      'RISK FACTORS\n12\nUSE OF PROCEEDS\n81\nWe are offering shares of our stock to the public.\n\n28\nRisk Factors\nInvesting in our stock involves risk.\n\n81\nUse of Proceeds\nWe will use the proceeds.',
    );
    expect(linkedSectionStart(text, headingNamed(text, 'RISK FACTORS'), links)).toBe(
      text.indexOf('28\nRisk Factors'),
    );
    expect(linkedSectionStart(text, headingNamed(text, 'USE OF PROCEEDS'), links)).toBe(
      text.indexOf('81\nUse of Proceeds'),
    );
  });
});
