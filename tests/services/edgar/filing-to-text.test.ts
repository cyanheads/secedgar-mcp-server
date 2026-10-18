/**
 * @fileoverview Tests for filing-to-text service — HTML to plain text conversion, truncation,
 * windowing, heading detection, and extraction cache.
 * @module tests/services/edgar/filing-to-text
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFilingTool } from '@/mcp-server/tools/definitions/get-filing.tool.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import {
  clearExtractCache,
  detectHeadings,
  extractCacheSize,
  filingToExtract,
  filingToText,
  findSectionLine,
  foldForHeadingMatch,
  getExtractCache,
  hasExtractCache,
  headingKey,
  isTocHeading,
  matchSectionLine,
  setExtractCache,
  windowText,
  withoutSubItemLabel,
} from '@/services/edgar/filing-to-text.js';
import { at } from '../../support/assertions.js';

// Only the service singleton is mocked, for the `get_filing` round trips below;
// every conversion and heading test runs the real module.
vi.mock('@/services/edgar/edgar-api-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/edgar/edgar-api-service.js')>()),
  getEdgarApiService: vi.fn(),
}));

// The get_filing round trips reach SEC only through the mocked service; any
// other request is a test bug, so it fails instead of leaving the process.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      throw new Error(`Unmocked fetch: ${String(input)}`);
    }),
  );
});

afterEach(() => {
  clearExtractCache();
  vi.unstubAllGlobals();
});

describe('filingToText', () => {
  it('converts basic HTML to plain text', () => {
    const html = '<html><body><p>Hello world</p></body></html>';
    const { text, truncated, totalLength } = filingToText(html);
    expect(text).toContain('Hello world');
    expect(truncated).toBe(false);
    expect(totalLength).toBe(text.length);
  });

  it('strips links but preserves link text', () => {
    const html = '<a href="https://example.com">Click here</a>';
    const { text } = filingToText(html);
    expect(text).toContain('Click here');
    expect(text).not.toContain('https://example.com');
  });

  it('skips images', () => {
    const html = '<p>Before</p><img src="chart.png" alt="chart"><p>After</p>';
    const { text } = filingToText(html);
    expect(text).toContain('Before');
    expect(text).toContain('After');
    expect(text).not.toContain('chart.png');
  });

  it('converts tables to text', () => {
    const html =
      '<table><tr><th>Item</th><th>Value</th></tr><tr><td>Revenue</td><td>100M</td></tr></table>';
    const { text } = filingToText(html);
    expect(text).toContain('Revenue');
    expect(text).toContain('100M');
  });

  it('does not truncate when under limit', () => {
    const html = '<p>Short text</p>';
    const { text, truncated } = filingToText(html, 10000);
    expect(truncated).toBe(false);
    expect(text).toContain('Short text');
  });

  it('truncates at word boundary when over limit', () => {
    const html = `<p>${'word '.repeat(1000)}</p>`;
    const { text, truncated, totalLength } = filingToText(html, 50);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(50);
    expect(totalLength).toBeGreaterThan(50);
    // Should end at a complete word (truncated at a space boundary)
    expect(text.endsWith('word')).toBe(true);
  });

  it('handles truncation when no word boundary is found', () => {
    // A single very long "word" with no spaces
    const html = `<p>${'a'.repeat(200)}</p>`;
    const { text, truncated } = filingToText(html, 50);
    expect(truncated).toBe(true);
    expect(text.length).toBe(50);
  });

  it('does not truncate when limit is undefined', () => {
    const html = `<p>${'content '.repeat(500)}</p>`;
    const { truncated } = filingToText(html);
    expect(truncated).toBe(false);
  });

  it('reports correct totalLength regardless of truncation', () => {
    const html = `<p>${'test '.repeat(100)}</p>`;
    const full = filingToText(html);
    const truncatedResult = filingToText(html, 20);
    expect(truncatedResult.totalLength).toBe(full.totalLength);
  });

  it('handles empty HTML', () => {
    const { text, truncated, totalLength } = filingToText('');
    expect(text).toBe('');
    expect(truncated).toBe(false);
    expect(totalLength).toBe(0);
  });
});

describe('filingToExtract', () => {
  it('returns full extracted text for given HTML', () => {
    const html = '<p>Hello extraction</p>';
    const result = filingToExtract(html);
    expect(result).toContain('Hello extraction');
  });

  it('is deterministic — byte-identical text across calls', () => {
    const html = '<p>Deterministic content</p>';
    const first = filingToExtract(html);
    const second = filingToExtract(html);
    expect(first).toBe(second);
  });
});

describe('hasExtractCache / getExtractCache / setExtractCache', () => {
  const entry = (text: string, document = 'doc.htm') => ({ text, document });

  it('hasExtractCache returns false before any set', () => {
    expect(hasExtractCache('no-such-key')).toBe(false);
  });

  it('hasExtractCache returns true after setExtractCache', () => {
    setExtractCache('k1', entry('value1'));
    expect(hasExtractCache('k1')).toBe(true);
  });

  it('getExtractCache returns undefined for missing key', () => {
    expect(getExtractCache('missing')).toBeUndefined();
  });

  it('getExtractCache returns the text and its source document after setExtractCache', () => {
    setExtractCache('k2', entry('value2', '0000899681-00-000406.txt'));
    expect(getExtractCache('k2')).toEqual({ text: 'value2', document: '0000899681-00-000406.txt' });
  });

  it('getExtractCache returns same value on repeated calls (LRU refresh, not eviction)', () => {
    setExtractCache('k3', entry('value3'));
    expect(getExtractCache('k3')?.text).toBe('value3');
    expect(getExtractCache('k3')?.text).toBe('value3');
  });
});

describe('LRU eviction', () => {
  const entry = (text: string) => ({ text, document: 'doc.htm' });

  it('evicts the oldest entry when capacity (8) is exceeded', () => {
    // Fill to capacity
    for (let i = 0; i < 8; i++) {
      setExtractCache(`lru-key-${i}`, entry(`value-${i}`));
    }
    expect(extractCacheSize()).toBe(8);
    expect(hasExtractCache('lru-key-0')).toBe(true);

    // Add a 9th entry — lru-key-0 is oldest and should be evicted
    setExtractCache('lru-key-8', entry('value-8'));
    expect(extractCacheSize()).toBe(8);
    expect(hasExtractCache('lru-key-0')).toBe(false);
    expect(hasExtractCache('lru-key-8')).toBe(true);
  });

  it('accessing an entry refreshes it (moves it to MRU position)', () => {
    for (let i = 0; i < 8; i++) {
      setExtractCache(`refresh-key-${i}`, entry(`value-${i}`));
    }
    // Access key-0 to move it to MRU
    getExtractCache('refresh-key-0');

    // Adding a 9th should evict key-1 (now oldest), not key-0
    setExtractCache('refresh-key-8', entry('new-value'));
    expect(hasExtractCache('refresh-key-0')).toBe(true);
    expect(hasExtractCache('refresh-key-1')).toBe(false);
  });
});

describe('windowText', () => {
  const FULL = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi';

  it('returns full text when it fits within limit', () => {
    const { text, truncated, totalLength } = windowText(FULL, 0, 10000);
    expect(text).toBe(FULL);
    expect(truncated).toBe(false);
    expect(totalLength).toBe(FULL.length);
  });

  it('truncates at word boundary and sets next_offset', () => {
    // Limit of 10 on "alpha beta gamma delta..."
    // slice(0,10) = "alpha beta" — ends at space at index 9, so word boundary at 10 or 9
    const { text, truncated, nextOffset } = windowText(FULL, 0, 11);
    expect(truncated).toBe(true);
    expect(text).toBe('alpha beta');
    expect(nextOffset).toBe(10);
  });

  it('starts at effectiveOffset', () => {
    // "alpha beta " = 11 chars; starting at 11 gives "gamma delta..."
    const { text } = windowText(FULL, 11, 5);
    expect(text.startsWith('gamma')).toBe(true);
  });

  it('paging with next_offset produces no gaps and no overlap', () => {
    const limit = 20;
    let offset = 0;
    const parts: string[] = [];
    let iterations = 0;
    while (true) {
      const { text, truncated, nextOffset } = windowText(FULL, offset, limit);
      parts.push(text);
      if (!truncated) break;
      // nextOffset points to the boundary char (space/newline) — joining produces the full string
      offset = nextOffset!;
      if (++iterations > 100) throw new Error('infinite loop guard');
    }
    // Pages join without separator: the boundary space/newline is the start of the next page
    expect(parts.join('')).toBe(FULL);
  });

  it('returns truncated: false when slice reaches end of document', () => {
    const tail = FULL.slice(FULL.length - 10);
    const { text, truncated } = windowText(FULL, FULL.length - 10, 100);
    expect(truncated).toBe(false);
    expect(text).toBe(tail);
  });

  it('same offset produces byte-identical text', () => {
    const r1 = windowText(FULL, 5, 15);
    const r2 = windowText(FULL, 5, 15);
    expect(r1.text).toBe(r2.text);
    expect(r1.truncated).toBe(r2.truncated);
    expect(r1.nextOffset).toBe(r2.nextOffset);
  });

  it('paging reconstructs the full text when joining pages', () => {
    // Use a simple string where word boundaries are predictable
    const doc = 'one two three four five six seven eight nine ten eleven twelve';
    const limit = 8;
    let offset = 0;
    const pages: string[] = [];
    let guard = 0;
    while (true) {
      const { text, truncated, nextOffset } = windowText(doc, offset, limit);
      pages.push(text);
      if (!truncated) break;
      // nextOffset points to the boundary whitespace — joining produces the full string
      offset = nextOffset!;
      if (++guard > 50) throw new Error('infinite loop');
    }
    // Pages join without separator (boundary whitespace is start of next page)
    expect(pages.join('')).toBe(doc);
  });
});

describe('detectHeadings', () => {
  it('detects ITEM headings from 10-K / 10-Q structure', () => {
    const text = `Some preamble text here.\n\nITEM 1 BUSINESS\n\nSome business content.\n\nITEM 1A RISK FACTORS\n\nRisk content.`;
    const headings = detectHeadings(text);
    const texts = headings.map((h) => h.heading);
    expect(texts).toContain('ITEM 1 BUSINESS');
    expect(texts).toContain('ITEM 1A RISK FACTORS');
  });

  it('detects all-caps headings from registration statements', () => {
    const text = `RISK FACTORS\n\nThis section describes risks.\n\nUSE OF PROCEEDS\n\nWe intend to use...`;
    const headings = detectHeadings(text);
    const texts = headings.map((h) => h.heading);
    expect(texts).toContain('RISK FACTORS');
    expect(texts).toContain('USE OF PROCEEDS');
  });

  it('records correct character offsets', () => {
    const text = `Intro.\n\nRISK FACTORS\n\nContent.`;
    const headings = detectHeadings(text);
    const rf = headings.find((h) => h.heading === 'RISK FACTORS');
    expect(rf).toBeDefined();
    // Verify text at the offset is the heading
    expect(text.slice(rf!.offset, rf!.offset + 12)).toBe('RISK FACTORS');
  });

  it('keeps the later occurrence for duplicate heading text (TOC vs body dedup)', () => {
    const text = `RISK FACTORS\n\nSome toc line.\n\nRISK FACTORS\n\nActual risk section content.`;
    const headings = detectHeadings(text);
    const rf = headings.filter((h) => h.heading === 'RISK FACTORS');
    // Deduplicated to one entry
    expect(rf).toHaveLength(1);
    // Should be the later (body) occurrence
    const laterIndex = text.lastIndexOf('RISK FACTORS');
    expect(at(rf, 0).offset).toBe(laterIndex);
  });

  it('returns every detected heading — the outline cut belongs to get_filing (#169)', () => {
    // 60 distinct all-caps headings
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(`SECTION ${String.fromCharCode(65 + (i % 26))} PART ${i}`);
    }
    const text = lines.join('\n\n');
    expect(detectHeadings(text).map((h) => h.heading)).toEqual(lines);
  });

  it('does not match short lowercase lines as headings', () => {
    const text = `some regular paragraph text here.\nanother line of text.\nYet another line.`;
    const headings = detectHeadings(text);
    expect(headings).toHaveLength(0);
  });

  it('returns headings sorted by offset', () => {
    const text = `Item 7. Management's Discussion\n\nMD&A content.\n\nCONSOLIDATED BALANCE SHEETS\n\nBalance data.\n\nItem 9. Changes in Accountants\n\nContent.`;
    const headings = detectHeadings(text);
    const offsets = headings.map((h) => h.offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(headings.length).toBeGreaterThanOrEqual(3);
  });
});

describe('detectHeadings — mixed-case Item/Part headings (#71)', () => {
  const NBSP = '\u00A0';

  it('detects mixed-case Item headings with non-breaking-space separators (styled 10-K)', () => {
    // Modern styled filings render "Item 1A.<NBSP><NBSP>Risk Factors" mixed-case.
    const text = `Preamble text.\n\nItem 1.${NBSP}${NBSP}Business\n\nBusiness content.\n\nItem 1A.${NBSP}${NBSP}Risk Factors\n\nRisk content.`;
    const texts = detectHeadings(text).map((h) => h.heading);
    expect(texts).toContain(`Item 1.${NBSP}${NBSP}Business`);
    expect(texts).toContain(`Item 1A.${NBSP}${NBSP}Risk Factors`);
  });

  it('detects mixed-case Item headings with regular-space separators', () => {
    const text = `Intro.\n\nItem 7. Management's Discussion and Analysis of Financial Condition and Results of Operations\n\nMD&A content.`;
    const headings = detectHeadings(text);
    expect(headings.some((h) => h.heading.startsWith('Item 7.'))).toBe(true);
  });

  it('detects mixed-case Part headings', () => {
    const text = `Some intro line.\n\nPart II\n\nContent under part two.`;
    const texts = detectHeadings(text).map((h) => h.heading);
    expect(texts).toContain('Part II');
  });

  it('ignores bare "Item N." TOC marker lines (no title on the line)', () => {
    // TOC tables render the item number cell as its own line, title on the next.
    const text = `Item 1.\nBusiness\n1\nItem 1A.\nRisk Factors\n5\n`;
    expect(detectHeadings(text)).toHaveLength(0);
  });

  it('ignores unwrapped body paragraphs that start with "Item N."', () => {
    const text = `Item 5. ${'word '.repeat(60)}end of a long unwrapped paragraph.`;
    expect(detectHeadings(text)).toHaveLength(0);
  });

  it('dedups case-insensitively, keeping the later occurrence (TOC "Part I" vs body "PART I")', () => {
    const text = `Part I\n\nTOC content in between.\n\nPART I\n\nBody content.`;
    const headings = detectHeadings(text);
    const partOne = headings.filter((h) => h.heading.toLowerCase() === 'part i');
    expect(partOne).toHaveLength(1);
    expect(at(partOne, 0).heading).toBe('PART I');
    expect(at(partOne, 0).offset).toBe(text.lastIndexOf('PART I'));
  });

  it('still detects all-caps ITEM headings alongside mixed-case forms', () => {
    const text = `ITEM 1A. RISK FACTORS\n\nOld-style content.\n\nItem 7.${NBSP}Management's Discussion\n\nNew-style content.`;
    const texts = detectHeadings(text).map((h) => h.heading);
    expect(texts).toContain('ITEM 1A. RISK FACTORS');
    expect(texts).toContain(`Item 7.${NBSP}Management's Discussion`);
  });
});

describe('detectHeadings — bare Item markers and running page headers (#105)', () => {
  /** A 20-F renders each Item as a marker line, a blank line, then the title. */
  const bodyItem = (marker: string, title: string) => `${marker}\n\n${title}\n\nSection body.\n\n`;

  it('joins a bare Item marker with the title on the following line', () => {
    const text = `Intro paragraph.\n\n${bodyItem('Item 3.', 'Key Information')}`;
    const texts = detectHeadings(text).map((h) => h.heading);
    expect(texts).toContain('Item 3. Key Information');
  });

  it('keys the joined heading to the marker offset, not the title offset', () => {
    const text = `Intro paragraph.\n\n${bodyItem('Item 3.', 'Key Information')}`;
    const item3 = detectHeadings(text).filter((h) => h.heading === 'Item 3. Key Information');
    const { offset } = at(item3, 0);
    expect(text.slice(offset, offset + 7)).toBe('Item 3.');
    expect(offset).toBe(text.indexOf('Item 3.'));
  });

  it('dedups a TOC occurrence carrying a page number against the body occurrence', () => {
    // TOC: marker, blank line, title + trailing page number. Body: same, no page number.
    const text =
      `Item 3.\n\n   Key Information      3  \n\n` +
      `Item 4.\n\n   Information on the Company      42  \n\n` +
      `${bodyItem('Item 3.', 'Key Information')}`;
    const item3 = detectHeadings(text).filter((h) => h.heading === 'Item 3. Key Information');
    expect(item3).toHaveLength(1);
    expect(at(item3, 0).offset).toBe(text.lastIndexOf('Item 3.'));
  });

  it('dedups a TOC occurrence against a body occurrence that ends in a period', () => {
    const text =
      `Item 16J\n\n   Insider Trading Policies      122  \n\n` +
      `${bodyItem('Item 16J', 'Insider Trading Policies.')}`;
    const entries = detectHeadings(text).filter((h) => h.heading.startsWith('Item 16J'));
    expect(entries).toHaveLength(1);
    expect(at(entries, 0).heading).toBe('Item 16J Insider Trading Policies.');
    expect(at(entries, 0).offset).toBe(text.lastIndexOf('Item 16J'));
  });

  it('detects lettered-suffix markers past "c" and unpunctuated markers (20-F Items)', () => {
    const text =
      `PART III\n\n` +
      bodyItem('Item 4A', 'Unresolved Staff Comments') +
      bodyItem('Item 16D', 'Exemptions from the Listing Standards for Audit Committees') +
      bodyItem('Item 16K', 'Cybersecurity');
    const texts = detectHeadings(text).map((h) => h.heading);
    expect(texts).toContain('PART III');
    expect(texts).toContain('Item 4A Unresolved Staff Comments');
    expect(texts).toContain('Item 16D Exemptions from the Listing Standards for Audit Committees');
    expect(texts).toContain('Item 16K Cybersecurity');
  });

  it('joins a tight marker/title pair when no page-number cell sits under the title', () => {
    // A 20-F body renders some Items with no blank line after the marker
    // ("Item 16K\nCybersecurity"), unlike the TOC row that ends in a page number.
    const text = `Body prose.\n\nItem 16K\nCybersecurity\n\nRisk Management and Strategy.\n`;
    const texts = detectHeadings(text).map((h) => h.heading);
    expect(texts).toContain('Item 16K Cybersecurity');
  });

  it('rejects a tight marker/title pair followed by a page-number cell (TOC row)', () => {
    const text = `Item 16K\nCybersecurity\n122\nItem 17.\nFinancial Statements\n124\n`;
    expect(detectHeadings(text)).toHaveLength(0);
  });

  it('rejects a bare marker whose next line is only a page number', () => {
    const text = `Item 3.\n\n      3  \n\nItem 4.\n\n      42  \n`;
    expect(detectHeadings(text)).toHaveLength(0);
  });

  it('rejects a bare marker with no following line (heading at end of document)', () => {
    const text = `Some closing body text.\n\nItem 19.`;
    expect(detectHeadings(text)).toHaveLength(0);
  });

  it('rejects a bare marker followed only by blank lines', () => {
    const text = `Some closing body text.\n\nItem 19.\n\n   \n\n`;
    expect(detectHeadings(text)).toHaveLength(0);
  });

  it('rejects a bare marker whose next line is another marker', () => {
    const text = `Item 17.\n\nItem 18.\n\nFinancial Statements\n\nBody.`;
    const texts = detectHeadings(text).map((h) => h.heading);
    expect(texts).toContain('Item 18. Financial Statements');
    expect(texts).not.toContain('Item 17. Item 18.');
  });

  it('rejects a bare marker whose next line reads as body prose (over the length bound)', () => {
    const text = `Item 5.\n\n${'word '.repeat(60)}end of a long unwrapped paragraph.\n\n`;
    expect(detectHeadings(text)).toHaveLength(0);
  });

  it('does not fuse consecutive all-caps lines into one composite heading', () => {
    const text = `TABLE OF CONTENTS\n\nPART I\n\nBody content here.`;
    const texts = detectHeadings(text).map((h) => h.heading);
    expect(texts).toContain('PART I');
    expect(texts.every((h) => !h.includes('\n'))).toBe(true);
  });

  it('collapses a running page header repeated across the document to one entry', () => {
    const page = `TABLE OF CONTENTS\n\nSome page body text.\n\n`;
    const text = `${page.repeat(8)}${bodyItem('Item 3.', 'Key Information')}`;
    const headings = detectHeadings(text);
    const texts = headings.map((h) => h.heading);
    expect(texts.filter((h) => h === 'TABLE OF CONTENTS')).toHaveLength(1);
    expect(at(headings, 0)).toEqual({ heading: 'TABLE OF CONTENTS', offset: 0 });
    expect(texts).toContain('Item 3. Key Information');
  });

  it('keeps the first occurrence of a repeated heading that carries real text', () => {
    // An S-1 stamps the notes section's own heading on every page of it. The
    // heading is furniture AND the section start, so the first occurrence is the
    // section start and the rest are furniture.
    const NOTES = 'NOTES TO THE CONSOLIDATED FINANCIAL STATEMENTS';
    const text = `Opening prose.\n\n${`${NOTES}\n\nNote body.\n\n`.repeat(6)}`;
    const notes = detectHeadings(text).filter((h) => h.heading === NOTES);
    expect(notes).toHaveLength(1);
    expect(at(notes, 0).offset).toBe(text.indexOf(NOTES));
  });

  it('drops every occurrence of a repeated bare Part marker, keeping none', () => {
    // A bare marker carries no navigable text, so its first occurrence is worth
    // no more than the rest — unlike a repeated heading with a title.
    const text = `TABLE OF CONTENTS\n\nPART I\n\nPage body.\n\n`.repeat(6);
    const headings = detectHeadings(text);
    const texts = headings.map((h) => h.heading);
    expect(texts).not.toContain('PART I');
    expect(texts.filter((h) => h === 'TABLE OF CONTENTS')).toHaveLength(1);
    expect(at(headings, 0)).toEqual({ heading: 'TABLE OF CONTENTS', offset: 0 });
    expect(texts.every((h) => !h.includes('\n'))).toBe(true);
  });

  it('keeps a heading that repeats only as TOC + body (under the running-header bound)', () => {
    const text = `RISK FACTORS\n\nTOC line.\n\nRISK FACTORS\n\nBody content.`;
    const texts = detectHeadings(text).map((h) => h.heading);
    expect(texts).toContain('RISK FACTORS');
  });

  it('counts distinct offsets, not raw matches, when judging a running header', () => {
    // An all-caps "ITEM 1 BUSINESS" line satisfies two of the detection arms, so
    // a per-match count would read these three occurrences as six.
    const occurrence = `ITEM 1 BUSINESS\n\nSome page body text.\n\n`;
    const texts = detectHeadings(occurrence.repeat(3)).map((h) => h.heading);
    expect(texts).toContain('ITEM 1 BUSINESS');
  });

  it('detects Items nested under a Part heading, both as outline entries', () => {
    const text =
      `PART I\n\n` +
      bodyItem('Item 1.', 'Identity of Directors, Senior Management and Advisers') +
      bodyItem('Item 2.', 'Offer Statistics and Expected Timetable') +
      `PART II\n\n` +
      bodyItem('Item 13.', 'Defaults, Dividend Arrearages and Delinquencies');
    const headings = detectHeadings(text);
    const texts = headings.map((h) => h.heading);
    expect(texts).toEqual([
      'PART I',
      'Item 1. Identity of Directors, Senior Management and Advisers',
      'Item 2. Offer Statistics and Expected Timetable',
      'PART II',
      'Item 13. Defaults, Dividend Arrearages and Delinquencies',
    ]);
  });

  it('suppresses a bare Item marker that recurs as a running page header', () => {
    // A 10-Q stamps "PART I / Item 1" at the foot of every page, so the marker's
    // "title" is whatever prose the next page happens to open with. Each composite
    // is unique, so only the marker line itself identifies the furniture.
    const page = (n: number) =>
      `Page body ${n}.\n\n${n}\n\nPART I\n\nItem 1\n\n \n\nCarried-over paragraph ${n}.\n\n`;
    const text = `${bodyItem('Item 1.', 'Financial Statements')}${[1, 2, 3, 4, 5, 6]
      .map(page)
      .join('')}`;
    const texts = detectHeadings(text).map((h) => h.heading);
    expect(texts.filter((h) => h.startsWith('Item 1 Carried-over'))).toHaveLength(0);
    expect(texts).toContain('Item 1. Financial Statements');
  });

  it('detects an all-caps heading whose words are separated by a non-breaking space', () => {
    const text = `Body prose.\n\nMICROSOFT CORPORATION\n\nSignature block.\n`;
    expect(detectHeadings(text).map((h) => h.heading)).toContain('MICROSOFT CORPORATION');
  });

  it('does not fuse two all-caps lines separated by a single newline', () => {
    const text = `INDEX TO FINANCIAL STATEMENTS\nCONSOLIDATED BALANCE SHEETS\n\nBody.`;
    const texts = detectHeadings(text).map((h) => h.heading);
    expect(texts).toContain('INDEX TO FINANCIAL STATEMENTS');
    expect(texts).toContain('CONSOLIDATED BALANCE SHEETS');
  });
});

describe('detectHeadings — a wrapped sentence that starts a line with an Item marker (#136)', () => {
  /** The shape of Apple's 1996 10-K: a cross-reference wrapped onto the start of a line. */
  const WRAPPED_10K = [
    'PART I',
    '',
    'Item 1. Business',
    '',
    'Further discussion may be found under Part II, Item 7 of this Form 10-K under the ',
    'subheading "Inventory and Supply," and in Part II, ',
    'Item 8 on this Form 10-K in the Notes to Consolidated Financial ',
    'Statements under the subheading "Concentrations." ',
    '',
    'Item 8. Financial Statements and Supplementary Data',
    '',
    'INDEX TO CONSOLIDATED FINANCIAL STATEMENTS',
    '',
  ].join('\n');

  it('leaves the wrapped line out of the outline and keeps the real heading', () => {
    expect(detectHeadings(WRAPPED_10K)).toEqual([
      { heading: 'PART I', offset: 0 },
      { heading: 'Item 1. Business', offset: 8 },
      {
        heading: 'Item 8. Financial Statements and Supplementary Data',
        offset: WRAPPED_10K.indexOf('Item 8.'),
      },
      {
        heading: 'INDEX TO CONSOLIDATED FINANCIAL STATEMENTS',
        offset: WRAPPED_10K.indexOf('INDEX TO'),
      },
    ]);
  });

  it.each([
    [
      'the word after the marker is lowercase',
      'Proxy matters.\n\nItem 1 is the election of directors.\n',
    ],
    [
      'the line before ends on a comma',
      'as described in Part III,\nItem 13 - Certain Relationships.\n',
    ],
  ])('drops an unpunctuated marker when %s', (_label, text) => {
    expect(detectHeadings(text)).toEqual([]);
  });

  // Characterization: each heading is detected by the pre-change patterns too.
  it.each([
    ['a punctuated Item directly under PART I', 'PART I\nItem 1. Business\n', 'Item 1. Business'],
    ['an unpunctuated Item directly under PART I', 'PART I\nItem 1 Business\n', 'Item 1 Business'],
    [
      'an unpunctuated Item with a capitalized title',
      'Notes.\n\nItem 6 Selected Financial Data\n',
      'Item 6 Selected Financial Data',
    ],
    [
      'a dash after the marker',
      'None.\n\nItem 1 - Legal Proceedings\n',
      'Item 1 - Legal Proceedings',
    ],
    [
      'a 20-F lettered marker',
      'Text.\n\nItem 16J Insider Trading Policies\n',
      'Item 16J Insider Trading Policies',
    ],
    [
      'a punctuated Item under a running page header',
      'Table of Contents\nItem 7. Management’s Discussion and Analysis\n',
      'Item 7. Management’s Discussion and Analysis',
    ],
    [
      'an unpunctuated Item under a running page header',
      'Table of Contents\nItem 5 — Other information\n',
      'Item 5 — Other information',
    ],
  ])('keeps %s', (_label, text, heading) => {
    expect(detectHeadings(text).map((h) => h.heading)).toContain(heading);
  });

  it('lands get_filing section "item 8" on the real heading, not the wrapped line', async () => {
    const accession = '0000320193-96-000023';
    const sgml = `<DOCUMENT>\n<TYPE>10-K\n<TEXT>\n${WRAPPED_10K}</TEXT>\n</DOCUMENT>\n`;
    vi.mocked(getEdgarApiService).mockReturnValue({
      findFilingCiks: vi.fn(async () => ['0000320193']),
      tryGetFilingIndex: vi.fn(async () => ({
        directory: {
          name: '000032019396000023',
          item: [
            { name: `${accession}.txt`, type: 'text', size: '', 'last-modified': '1996-12-19' },
          ],
        },
      })),
      tryGetFilingDocument: vi.fn(async () => sgml),
      tryGetFilingHeaders: vi.fn(async () => null),
      tryGetSubmissionHeader: vi.fn(async () => null),
      getSubmissions: vi.fn(async () => ({
        cik: '0000320193',
        name: 'APPLE COMPUTER INC',
        tickers: [],
        exchanges: [],
        filings: {
          recent: {
            accessionNumber: [accession],
            filingDate: ['1996-12-19'],
            form: ['10-K'],
            primaryDocument: [''],
            primaryDocDescription: [''],
            reportDate: ['1996-09-27'],
          },
          files: [],
        },
      })),
    } as never);

    const result = await runToolContract(getFilingTool, {
      accession_number: accession,
      cik: '320193',
      section: 'item 8',
    });

    expect(result.isError).toBeFalsy();
    const content = (result.structuredContent as { content: string }).content;
    expect(content.startsWith('Item 8. Financial Statements and Supplementary Data')).toBe(true);
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

/**
 * Asserts that `run` stays linear over `build(n)`. Doubles n from 5,000 to
 * `maxChars`, checking `boundMs` of thread CPU at each size before building the
 * next, so a quadratic shape fails in seconds instead of hanging the suite, then
 * holds the full-span ratio under four times the span: 256 over 5k → 320k, 64
 * over 5k → 80k, where a quadratic scan reaches the span squared.
 */
function expectLinear(
  run: (text: string) => unknown,
  build: (n: number) => string,
  maxChars: number,
  boundMs: number,
): void {
  const small = build(5_000);
  run(small); // warm the JIT
  // Floored so a sub-millisecond baseline cannot inflate the ratio on noise.
  const t5k = Math.max(
    bestOf3CpuMs(() => run(small)),
    0.25,
  );
  let last = t5k;
  for (let n = 10_000; n <= maxChars; n *= 2) {
    const text = build(n);
    last = bestOf3CpuMs(() => run(text));
    expect(last, `${n} characters`).toBeLessThan(boundMs);
  }
  expect(last / t5k).toBeLessThan((4 * maxChars) / 5_000);
}

describe('detectHeadings — heading scans stay linear on long lines (#136)', () => {
  it.each([
    ['wrapped Item lines under prose lines', (n: number) => fill('see\nItem 1 Business\n', n)],
    [
      'one long prose line before an Item line',
      (n: number) => `${'a'.repeat(n)}\nItem 1 Business\n`,
    ],
    ['an Item marker before a long whitespace run', (n: number) => `Item 1${' '.repeat(n)}X\n`],
    // The page-number strip went quadratic on this one; the all-caps arm's form
    // ending lowercase is timed with the #165/#170 scans.
    ['an all-caps line with a long whitespace run', (n: number) => `ABCDEFGHIJ${' '.repeat(n)}X\n`],
    ['one ITEM line holding a long digit run', (n: number) => `ITEM ${'1'.repeat(n)}\ny`],
    ['one long line ending in a break', (n: number) => `${fill('§1 x', n)}\ny`],
    ['breaks throughout', (n: number) => fill('  \r\n', n)],
  ])('%s (5k → 320k)', (_label, build) => {
    expectLinear(detectHeadings, build, 320_000, 200);
  });
});

/**
 * Serve one plain-text SGML submission through the mocked EDGAR service, so a
 * `get_filing` round trip runs the real conversion, heading detection, and
 * `section` resolution over `text`.
 */
function serveTextFiling(accession: string, form: string, text: string): void {
  const sgml = `<DOCUMENT>\n<TYPE>${form}\n<TEXT>\n${text}</TEXT>\n</DOCUMENT>\n`;
  vi.mocked(getEdgarApiService).mockReturnValue({
    findFilingCiks: vi.fn(async () => ['0000789019']),
    tryGetFilingIndex: vi.fn(async () => ({
      directory: {
        name: accession.replace(/-/g, ''),
        item: [{ name: `${accession}.txt`, type: 'text', size: '', 'last-modified': '2026-06-05' }],
      },
    })),
    tryGetFilingDocument: vi.fn(async () => sgml),
    tryGetFilingHeaders: vi.fn(async () => null),
    tryGetSubmissionHeader: vi.fn(async () => null),
    getSubmissions: vi.fn(async () => ({
      cik: '0000789019',
      name: 'MICROSOFT CORP',
      tickers: [],
      exchanges: [],
      filings: {
        recent: {
          accessionNumber: [accession],
          filingDate: ['2026-06-05'],
          form: [form],
          primaryDocument: [''],
          primaryDocDescription: [''],
          reportDate: [''],
        },
        files: [],
      },
    })),
  } as never);
}

/** Every text block a tool result renders to `content[]`, joined. */
function contentText(result: { content?: unknown }): string {
  return ((result.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');
}

describe('detectHeadings — dotted 8-K Item headings (#165)', () => {
  const NBSP = ' ';
  /** Item 5.02's title as Form 8-K prints it, period included: past the 140-character bound. */
  const TITLE_502 =
    'Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers; Compensatory Arrangements of Certain Officers.';
  /**
   * The shape of Microsoft's 8-K 0001193125-26-258667: a cover page, then an
   * NBSP-spaced `Item 5.02.` marker, a blank line, and the title.
   */
  const MSFT_8K = [
    ' ',
    '',
    'UNITED STATES',
    '',
    'SECURITIES AND EXCHANGE COMMISSION',
    '',
    'WASHINGTON, D.C. 20549',
    '',
    'FORM 8-K',
    '',
    'CURRENT REPORT',
    '',
    'PURSUANT TO SECTION 13 OR 15(D)',
    '',
    'OF THE SECURITIES EXCHANGE ACT OF 1934',
    '',
    'Date of Report (Date of earliest event reported) June 2, 2026',
    '',
    '----------------------------------------',
    '',
    `Item${NBSP}5.02.`,
    '',
    TITLE_502,
    '',
    '(b) On June 2, 2026, a member of the Board of Directors informed the Company of his decision not to stand for re-election.',
    '',
    '----------------------------------------',
    '',
    'SIGNATURE',
    '',
    'Pursuant to the requirements of the Securities Exchange Act of 1934, the registrant has duly caused this report to be signed.',
    '',
  ].join('\n');

  it('joins a separated dotted marker with its 146-character title', () => {
    expect(TITLE_502).toHaveLength(146);
    const offsetOf = (s: string) => MSFT_8K.indexOf(s);
    expect(detectHeadings(MSFT_8K)).toEqual([
      { heading: 'UNITED STATES', offset: offsetOf('UNITED STATES') },
      {
        heading: 'SECURITIES AND EXCHANGE COMMISSION',
        offset: offsetOf('SECURITIES AND EXCHANGE COMMISSION'),
      },
      { heading: 'CURRENT REPORT', offset: offsetOf('CURRENT REPORT') },
      { heading: `Item${NBSP}5.02. ${TITLE_502}`, offset: offsetOf(`Item${NBSP}5.02.`) },
      { heading: 'SIGNATURE', offset: offsetOf('SIGNATURE') },
    ]);
  });

  it('joins a tight dotted marker/title pair', () => {
    const text =
      'Body prose.\n\nItem 5.07\nSubmission of Matters to a Vote of Security Holders.\n\nThe shareholders voted.\n';
    expect(detectHeadings(text)).toEqual([
      {
        heading: 'Item 5.07 Submission of Matters to a Vote of Security Holders.',
        offset: text.indexOf('Item 5.07'),
      },
    ]);
  });

  it.each([
    ['separated by spaces', 'Item 2.02    Results of Operations and Financial Condition.'],
    ['separated by a dash', 'Item 2.02 - Results of Operations and Financial Condition.'],
    ['carrying the 146-character Item 5.02 title', `Item 5.02 ${TITLE_502}`],
    ['abutting its title', 'Item 9.01Financial Statements and Exhibits.'],
    ['abutting its title after a period', `Item 5.02.${TITLE_502}`],
    ['carrying a paragraph suffix', 'Item 9.01(d).    Financial Statements and Exhibits.'],
    [
      'carrying a paragraph suffix abutting its title',
      'Item 9.01(d).Financial Statements and Exhibits.',
    ],
  ])('detects a same-line dotted Item heading %s', (_label, line) => {
    const text = `Preceding paragraph.\n\n${line}\n\nFollowing paragraph.\n`;
    expect(detectHeadings(text)).toEqual([{ heading: line, offset: text.indexOf(line) }]);
  });

  it.each([
    ['a dotted code', 'ITEM 2.02', 'Results of Operations and Financial Condition.'],
    ['an integer code', 'ITEM 3.', 'Key Information'],
  ])(
    'keeps one entry for an all-caps marker line joined to its title (%s)',
    (_label, marker, title) => {
      // The all-caps arm matches the marker line alone, and the bare-marker scan
      // joins it to its title at the same offset — one heading, listed once.
      const text = `Body prose.\n\n${marker}\n\n${title}\n\nItem body.\n`;
      expect(detectHeadings(text)).toEqual([
        { heading: `${marker} ${title}`, offset: text.indexOf(marker) },
      ]);
    },
  );

  it('leaves no bare TOC marker behind when the body marker joins its title', () => {
    // The TOC row's marker cell sits over a page number, so it never joins; dedup
    // folds it into the body's bare match, which then gives way to the joined one.
    const text =
      'ITEM 2.02\n\n 3 \n\nBody prose.\n\nITEM 2.02\n\nResults of Operations\n\nItem body.\n';
    expect(detectHeadings(text)).toEqual([
      { heading: 'ITEM 2.02 Results of Operations', offset: text.lastIndexOf('ITEM 2.02') },
    ]);
  });

  // Characterization: none of these is a heading before or after #165.
  it.each([
    [
      'a dotted code outside the current 8-K table with a title past the bound',
      `Item 7.09 ${'Word '.repeat(30)}end.`,
    ],
    ['the same code with that title on the next line', `Item 7.09\n\n${'Word '.repeat(30)}end.`],
    ['a dotted marker alone at the end of the document', 'Item 5.02.'],
    ['a dotted marker over a page-number line', 'Item 5.02.\n\n 3 \n'],
    [
      'an unpunctuated dotted marker under a line ending in a comma',
      'as described in our Current Report,\nItem 9.01 Financial Statements and Exhibits.',
    ],
    ['a dotted marker followed by a lowercase word', 'Item 2.02 is incorporated by reference.'],
  ])('leaves out %s', (_label, body) => {
    expect(detectHeadings(`Preceding paragraph.\n\n${body}\n`)).toEqual([]);
  });

  // The current-8-K bound is 160: the longest title the sampled 8-Ks print is
  // Item 5.02's 146, and a same-line paragraph runs to hundreds of characters.
  const PARAGRAPH =
    'On June 2, 2026, the Board of Directors of the Company appointed a new Chief Financial Officer, effective July 1, 2026, and approved the compensation arrangements described below, including a base salary, an annual bonus target, and an equity award.';

  it.each([
    ['a paragraph on the marker line', `Item 5.02(b) ${PARAGRAPH}`],
    ['a paragraph under the marker', `Item 5.02.\n\n${PARAGRAPH}`],
    ['a paragraph just past the bound', `Item 5.02 ${'Word '.repeat(32)}end.`],
  ])('leaves out a current 8-K Item with %s', (_label, body) => {
    expect(body.length).toBeGreaterThan(170);
    expect(detectHeadings(`Preceding paragraph.\n\n${body}\n`)).toEqual([]);
  });

  it('keeps a current 8-K title at the bound', () => {
    const title = `${'Word '.repeat(31)}endss`;
    expect(title).toHaveLength(160);
    for (const line of [`Item 5.02 ${title}`, `Item 5.02.\n\n${title}`]) {
      const text = `Preceding paragraph.\n\n${line}\n\nFollowing paragraph.\n`;
      expect(detectHeadings(text).map((h) => h.offset)).toEqual([text.indexOf('Item 5.02')]);
    }
  });

  it('lands get_filing section "Item 5.02" and "item 5" on the 8-K item; "item 5.0" misses', async () => {
    const accession = '0001193125-26-258667';
    serveTextFiling(accession, '8-K', MSFT_8K);

    for (const section of ['Item 5.02', 'item 5']) {
      const result = await runToolContract(getFilingTool, {
        accession_number: accession,
        cik: '789019',
        section,
      });
      expect(result.isError).toBeFalsy();
      const content = (result.structuredContent as { content: string }).content;
      expect(content.startsWith(`Item${NBSP}5.02.\n\n${TITLE_502}`)).toBe(true);
      expect(contentText(result)).toContain(`Item${NBSP}5.02.\n\n${TITLE_502}`);
    }

    const miss = await runToolContract(getFilingTool, {
      accession_number: accession,
      cik: '789019',
      section: 'item 5.0',
    });
    expect(miss.isError).toBe(true);
    expect(contentText(miss)).toContain(`] Item${NBSP}5.02. ${TITLE_502}`);
  });
});

describe('detectHeadings — dashed, numbered, and titled Part headings (#170)', () => {
  it.each([
    ['a hyphen', 'NON-GAAP FINANCIAL MEASURES'],
    ['an em dash after a Part numeral', 'PART II — OTHER INFORMATION'],
    ['a note number and an em dash', 'NOTE 1 — ACCOUNTING POLICIES'],
    ['a two-digit note number and an en dash', 'NOTE 10 – DEBT'],
    ['a number with a letter suffix', 'SCHEDULE 14A'],
    ['a possessive after a word-final S', 'NOTE 15 — STOCKHOLDERS’ EQUITY'],
    ['an in-word apostrophe', "MANAGEMENT'S DISCUSSION AND ANALYSIS"],
    ['a curly possessive', 'INDEPENDENT AUDITORS’ REPORT'],
  ])('detects an all-caps heading carrying %s', (_label, line) => {
    const text = `Preceding paragraph.\n\n${line}\n\nFollowing paragraph.\n`;
    expect(detectHeadings(text)).toEqual([{ heading: line, offset: text.indexOf(line) }]);
  });

  // Characterization: none of these is a heading before or after #170.
  it.each([
    ['a currency table row', 'USD 2,929'],
    ['a numeric table row', 'EMEA 2,222 2,365 2,096'],
    ['a footnoted holder row', 'FMR LLC(4)'],
    ['a cover-page address', 'WASHINGTON, D.C. 20549'],
    ['a cover-page statute line', 'PURSUANT TO SECTION 13 OR 15(D)'],
    ['a three-digit number', 'NOTE 100 — OTHER MATTERS'],
    ['a statement caption ending in a colon', 'CURRENT ASSETS:'],
    ['a longer colon caption', 'CASH FLOWS FROM OPERATING ACTIVITIES:'],
    ['a line closing on an apostrophe', 'RIGHTS OF STOCKHOLDERS’'],
    ['an apostrophe after a word not ending in S', 'THE COMPANY’ RESULTS'],
    ['a line opening on a quote', '‘RISK FACTORS’'],
  ])('leaves out %s', (_label, line) => {
    expect(detectHeadings(`Preceding paragraph.\n\n${line}\n\nFollowing paragraph.\n`)).toEqual([]);
  });

  it.each([
    ['an em dash', 'Part II — Other Information'],
    ['a period', 'Part I. Financial Information'],
    ['a colon', 'Part II: Other Information'],
    ['whitespace alone', 'Part II Other Information'],
  ])('detects a titled Part line separated by %s', (_label, line) => {
    const text = `Preceding paragraph.\n\n${line}\n\nFollowing paragraph.\n`;
    expect(detectHeadings(text)).toEqual([{ heading: line, offset: text.indexOf(line) }]);
  });

  // Characterization: none of these is a heading before or after #170.
  it.each([
    [
      'under a line ending in a comma',
      'as described in our Annual Report on Form 10-K,\nPart II Other Information',
    ],
    [
      'under a line ending in a semicolon',
      'see the discussion above;\nPart I Financial Information',
    ],
    ['followed by a lowercase word', 'Part II of this report describes legal matters.'],
    ['with a title past the 140-character bound', `Part II ${'Word '.repeat(30)}end.`],
  ])('leaves out a Part line %s', (_label, body) => {
    expect(detectHeadings(`Preceding paragraph.\n\n${body}\n`)).toEqual([]);
  });

  /**
   * The shape of Apple's 10-Q 0000320193-26-000020: a TOC rendered one cell
   * per line, with bare Part rows, then titled Part headings in the body.
   */
  const APPLE_10Q = [
    'TABLE OF CONTENTS',
    '',
    'Page',
    'Part I',
    'Item 1.',
    'Financial Statements',
    '1',
    'Item 2.',
    'Management’s Discussion and Analysis of Financial Condition and Results of Operations',
    '13',
    'Part II',
    'Item 1.',
    'Legal Proceedings',
    '20',
    'Item 5.',
    'Other Information',
    '25',
    '',
    '----------------------------------------',
    '',
    'PART I — FINANCIAL INFORMATION',
    '',
    'Item 1.    Financial Statements',
    '',
    'CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS (Unaudited)',
    'Statement body.',
    '',
    'Item 2.    Management’s Discussion and Analysis of Financial Condition and Results of Operations',
    '',
    'MD&A body.',
    '',
    'PART II — OTHER INFORMATION',
    '',
    'Item 1.    Legal Proceedings',
    'Digital Markets Act Investigations',
    'Legal body.',
    '',
    'Item 5.    Other Information',
    '',
    'Other body.',
    '',
  ].join('\n');

  it('drops a bare TOC Part row in favor of the later titled Part heading', () => {
    const at10q = (s: string) => ({ heading: s, offset: APPLE_10Q.indexOf(s) });
    expect(detectHeadings(APPLE_10Q)).toEqual([
      at10q('TABLE OF CONTENTS'),
      at10q('PART I — FINANCIAL INFORMATION'),
      at10q('Item 1.    Financial Statements'),
      at10q(
        'Item 2.    Management’s Discussion and Analysis of Financial Condition and Results of Operations',
      ),
      at10q('PART II — OTHER INFORMATION'),
      at10q('Item 1.    Legal Proceedings'),
      at10q('Item 5.    Other Information'),
    ]);
  });

  it('keeps a bare Part with no later titled heading for its numeral', () => {
    const text =
      'PART I — FINANCIAL INFORMATION\n\nBody.\n\nPart I\n\nPart II\n\nBody.\n\nPART III — OTHER INFORMATION\n\nBody.\n';
    expect(detectHeadings(text).map((h) => h.heading)).toEqual([
      'PART I — FINANCIAL INFORMATION',
      'Part I',
      'Part II',
      'PART III — OTHER INFORMATION',
    ]);
  });

  it('detects every NOTE N — TITLE heading in a run of notes', () => {
    const notes = [
      'NOTE 1 — ACCOUNTING POLICIES',
      'NOTE 2 — REVENUE',
      'NOTE 10 — DEBT',
      'NOTE 15 — STOCKHOLDERS’ EQUITY',
    ];
    const text = notes.map((n) => `${n}\n\nNote body.\n\n`).join('');
    expect(detectHeadings(text)).toEqual(
      notes.map((heading) => ({ heading, offset: text.indexOf(heading) })),
    );
  });

  it('lands get_filing section "part ii" and "part i" on the body Part headings', async () => {
    const accession = '0000320193-26-000020';
    serveTextFiling(accession, '10-Q', APPLE_10Q);

    for (const [section, heading] of [
      ['part ii', 'PART II — OTHER INFORMATION'],
      ['part i', 'PART I — FINANCIAL INFORMATION'],
    ] as const) {
      const result = await runToolContract(getFilingTool, {
        accession_number: accession,
        cik: '320193',
        section,
      });
      expect(result.isError).toBeFalsy();
      const content = (result.structuredContent as { content: string }).content;
      expect(content.startsWith(`${heading}\n`)).toBe(true);
      expect(contentText(result)).toContain(`${heading}\n`);
    }
  });

  it.each([
    ['a comma', 'as described in our Annual Report on Form 10-K,\nPART II — OTHER INFORMATION'],
    ['a semicolon', 'see the discussion above;\nPART I — FINANCIAL INFORMATION'],
  ])('leaves out an all-caps titled Part line under a line ending in %s', (_label, body) => {
    expect(detectHeadings(`Preceding paragraph.\n\n${body}\n\nFollowing paragraph.\n`)).toEqual([]);
  });

  it.each([
    ['an em dash', 'Part II — Item 5. Market for Registrant’s Common Equity'],
    ['no separator', 'Part II Item 5 Market for Registrant’s Common Equity'],
    ['all caps', 'PART II — ITEM 5. MARKET FOR REGISTRANT’S COMMON EQUITY'],
  ])('leaves out a Part cross-reference row whose title is an Item marker (%s)', (_label, row) => {
    expect(detectHeadings(`Preceding paragraph.\n\n${row}\n\nFollowing paragraph.\n`)).toEqual([]);
  });

  /** A bank 10-K's cross-reference index, printed after the body it points into. */
  const CROSS_REFERENCED_10K = [
    'PART II',
    '',
    'Item 5. Market for Registrant’s Common Equity',
    '',
    'Market prose.',
    '',
    'CROSS-REFERENCE INDEX',
    '',
    'Part II — Item 5. Market for Registrant’s Common Equity',
    '',
  ].join('\n');

  it('keeps the bare body Part that a later cross-reference row names', () => {
    expect(detectHeadings(CROSS_REFERENCED_10K)).toEqual([
      { heading: 'PART II', offset: 0 },
      { heading: 'Item 5. Market for Registrant’s Common Equity', offset: 9 },
      { heading: 'CROSS-REFERENCE INDEX', offset: CROSS_REFERENCED_10K.indexOf('CROSS') },
    ]);
  });

  it('lands get_filing section "part ii" on the body Part, not the cross-reference row', async () => {
    const accession = '0000019617-26-000010';
    serveTextFiling(accession, '10-K', CROSS_REFERENCED_10K);

    const result = await runToolContract(getFilingTool, {
      accession_number: accession,
      cik: '19617',
      section: 'part ii',
    });
    expect(result.isError).toBeFalsy();
    const content = (result.structuredContent as { content: string }).content;
    expect(content.startsWith('PART II\n\nItem 5.')).toBe(true);
    expect(contentText(result)).toContain('PART II\n\nItem 5.');
  });
});

describe('detectHeadings — an all-caps line is a heading only within the title bound (#170)', () => {
  /**
   * The shape of Alternative Ballistics' S-1 0001493152-26-046881: a risk-factor
   * coda set in capitals, 308 characters, a possessive in it.
   */
  const CODA =
    'IN ADDITION TO THE ABOVE RISKS, BUSINESSES ARE OFTEN SUBJECT TO RISKS NOT FORESEEN OR FULLY APPRECIATED BY MANAGEMENT. IN REVIEWING THIS FILING, POTENTIAL INVESTORS SHOULD KEEP IN MIND THAT OTHER POSSIBLE RISKS MAY ADVERSELY IMPACT THE COMPANY’S BUSINESS OPERATIONS AND THE VALUE OF THE COMPANY’S SECURITIES.';
  const S1 = [
    'RISK FACTORS',
    '',
    'Risk prose.',
    '',
    CODA,
    '',
    '26',
    '',
    'USE OF PROCEEDS',
    '',
    'Proceeds prose.',
    '',
    'OUR BUSINESS',
    '',
    'Business prose.',
    '',
  ].join('\n');

  it('leaves a paragraph-length all-caps line out of the outline', () => {
    expect(CODA).toHaveLength(308);
    expect(detectHeadings(S1).map((h) => h.heading)).toEqual([
      'RISK FACTORS',
      'USE OF PROCEEDS',
      'OUR BUSINESS',
    ]);
  });

  const atBound = `${'WORD '.repeat(27)}ENDSS`;

  it('keeps an all-caps line at the 140-character bound and drops one a character past it', () => {
    expect(atBound).toHaveLength(140);
    for (const [line, kept] of [
      [atBound, true],
      [`${atBound}S`, false],
    ] as const) {
      const text = `Preceding paragraph.\n\n${line}\n\nFollowing paragraph.\n`;
      expect(detectHeadings(text)).toEqual(kept ? [{ heading: line, offset: 22 }] : []);
    }
  });

  const NBSP = ' ';
  /**
   * The shape of Amazon's 8-K 0001104659-26-107526: the whole table of contents
   * on one line, each row's page cell, then the exhibit list.
   */
  const AMAZON_TOC = [
    'ITEM 8.01. OTHER EVENTS. 3',
    'ITEM 9.01. FINANCIAL STATEMENTS AND EXHIBITS. 4',
    'SIGNATURES 5',
    'EXHIBIT 1.1',
    `${NBSP} ${NBSP} EXHIBIT 4.1`,
    `${NBSP} ${NBSP} EXHIBIT 4.2`,
    `${NBSP} ${NBSP} EXHIBIT 23.1 ${NBSP}`,
  ].join(`${NBSP} ${NBSP} ${NBSP}`);

  it.each([
    [
      'a second Item marker',
      'ITEM 2.02 RESULTS OF OPERATIONS AND FINANCIAL CONDITION ITEM 7.01 REGULATION FD DISCLOSURE ITEM 8.01 OTHER EVENTS ITEM 9.01 FINANCIAL STATEMENTS AND EXHIBITS SIGNATURES EXHIBIT INDEX',
    ],
    ['a second Item marker after a page cell', AMAZON_TOC],
    ['one Item marker and a page cell mid-line', 'ITEM 8.01. OTHER EVENTS. 3     SIGNATURES 4'],
    ['a mixed-case row and a page cell mid-line', 'Item 8.01 Other Events  1     Signatures  2'],
  ])('leaves out an Item line that runs a table of contents together: %s', (_label, line) => {
    const text = `Preceding paragraph.\n\n${line}\n\nSIGNATURES\n`;
    expect(detectHeadings(text)).toEqual([
      { heading: 'SIGNATURES', offset: text.lastIndexOf('SIGNATURES') },
    ]);
  });

  it('lands get_filing "item 8" and "item 9" on the body Items past a run-together TOC line', async () => {
    const accession = '0001104659-26-107526';
    const text = [
      'TABLE OF CONTENTS',
      '',
      AMAZON_TOC,
      '',
      'ITEM 8.01. OTHER EVENTS.',
      '',
      'Notes prose.',
      '',
      'ITEM 9.01. FINANCIAL STATEMENTS AND EXHIBITS.',
      '',
      '(d) Exhibits.',
      '',
    ].join('\n');
    serveTextFiling(accession, '8-K', text);

    for (const [section, heading] of [
      ['item 8', 'ITEM 8.01. OTHER EVENTS.'],
      ['item 9', 'ITEM 9.01. FINANCIAL STATEMENTS AND EXHIBITS.'],
    ] as const) {
      const result = await runToolContract(getFilingTool, {
        accession_number: accession,
        cik: '1018724',
        section,
      });
      expect(result.isError).toBeFalsy();
      const content = (result.structuredContent as { content: string }).content;
      expect(content.startsWith(`${heading}\n`)).toBe(true);
      expect(contentText(result)).toContain(`${heading}\n`);
    }
  });

  /**
   * The shape of Modine's DEF 14A 0001104659-26-115309: a special meeting's one
   * proposal, an all-caps ITEM line whose title runs 183 characters in mixed
   * capitals.
   */
  const PROPOSAL_ITEM =
    'ITEM 1 – TO APPROVE THE PROPOSAL TO AMEND THE Amended and Restated Articles of Incorporation of modine manufacturing company to Change the Name of the COMPANY to Modexus Solutions, Inc.';

  it('keeps an all-caps ITEM line whose title runs past the bound but holds one Item', () => {
    expect(PROPOSAL_ITEM).toHaveLength(185);
    const text = `Preceding paragraph.\n\n${PROPOSAL_ITEM}\n\nFollowing paragraph.\n`;
    expect(detectHeadings(text)).toEqual([{ heading: PROPOSAL_ITEM, offset: 22 }]);
  });

  it('lands get_filing "item 1" and "proposal" on that ITEM line, in structuredContent and content[]', async () => {
    const accession = '0001104659-26-115309';
    const text = `PROXY STATEMENT\n\nMeeting prose.\n\n${PROPOSAL_ITEM}\n\nOur Board has approved the amendment.\n`;
    serveTextFiling(accession, 'DEF 14A', text);

    for (const section of ['item 1', 'proposal']) {
      const result = await runToolContract(getFilingTool, {
        accession_number: accession,
        cik: '67347',
        section,
      });
      expect(result.isError).toBeFalsy();
      const content = (result.structuredContent as { content: string }).content;
      expect(content.startsWith(`${PROPOSAL_ITEM}\n`)).toBe(true);
      expect(contentText(result)).toContain(`${PROPOSAL_ITEM}\n\nOur Board has approved`);
    }
  });

  // Characterization: the current 8-K bound covers the all-caps form too.
  it('keeps an all-caps 8-K Item 5.02 line with its 146-character title', () => {
    const line =
      'ITEM 5.02 DEPARTURE OF DIRECTORS OR CERTAIN OFFICERS; ELECTION OF DIRECTORS; APPOINTMENT OF CERTAIN OFFICERS; COMPENSATORY ARRANGEMENTS OF CERTAIN OFFICERS.';
    const text = `Preceding paragraph.\n\n${line}\n\nFollowing paragraph.\n`;
    expect(detectHeadings(text)).toEqual([{ heading: line, offset: 22 }]);
  });

  it('lands get_filing section "business" on OUR BUSINESS, not the paragraph that mentions businesses', async () => {
    const accession = '0001493152-26-046881';
    serveTextFiling(accession, 'S-1', S1);

    const result = await runToolContract(getFilingTool, {
      accession_number: accession,
      cik: '1834868',
      section: 'business',
    });
    expect(result.isError).toBeFalsy();
    const content = (result.structuredContent as { content: string }).content;
    expect(content.startsWith('OUR BUSINESS\n')).toBe(true);
    expect(contentText(result)).toContain('OUR BUSINESS\n\nBusiness prose.');
  });
});

describe('detectHeadings — a trailing number is dropped only as a page cell (#172)', () => {
  it.each([
    ['a proposal number', 'PROPOSAL NO. 1'],
    ['an article number', 'ARTICLE 5'],
    ['a note number after a word', 'SEGMENT NOTE 3'],
  ])('keeps %s on an all-caps heading', (_label, line) => {
    const text = `Preceding paragraph.\n\n${line}\n\nFollowing paragraph.\n`;
    expect(detectHeadings(text)).toEqual([{ heading: line, offset: text.indexOf(line) }]);
  });

  it('keeps a year that ends the title under a bare Item marker', () => {
    const text =
      'Preceding paragraph.\n\nItem 1.\n\nDisclosure Under the Securities Exchange Act of 1934\n\nBody.\n';
    expect(detectHeadings(text)).toEqual([
      {
        heading: 'Item 1. Disclosure Under the Securities Exchange Act of 1934',
        offset: text.indexOf('Item 1.'),
      },
    ]);
  });

  /** The shape of GT Biopharma's DEF 14A 0001493152-26-046861: a numbered heading per proposal. */
  const PROXY = [
    'PROXY STATEMENT',
    '',
    'Meeting prose.',
    '',
    'PROPOSAL NO. 1',
    '',
    'APPROVAL OF AN AMENDMENT TO OUR CHARTER',
    '',
    'Proposal prose.',
    '',
    'PROPOSAL NO. 2',
    '',
    'APPROVAL OF AN INCREASE IN AUTHORIZED SHARES',
    '',
    'Proposal prose.',
    '',
    'PROPOSAL NO. 3',
    '',
    'APPROVAL OF THE ISSUANCE OF SHARES',
    '',
    'Proposal prose.',
    '',
  ].join('\n');

  it('lists each numbered proposal as its own entry, in structuredContent and content[]', async () => {
    const proposals = ['PROPOSAL NO. 1', 'PROPOSAL NO. 2', 'PROPOSAL NO. 3'];
    expect(
      detectHeadings(PROXY)
        .map((h) => h.heading)
        .filter((h) => h.startsWith('PROPOSAL')),
    ).toEqual(proposals);

    const accession = '0001493152-26-046861';
    serveTextFiling(accession, 'DEF 14A', `${PROXY}${'Closing prose. '.repeat(80)}\n`);
    const result = await runToolContract(getFilingTool, {
      accession_number: accession,
      cik: '109657',
      content_limit: 1000,
    });
    expect(result.isError).toBeFalsy();
    const outline = (result.structuredContent as { outline: Array<{ heading: string }> }).outline;
    expect(outline.map((h) => h.heading).filter((h) => h.startsWith('PROPOSAL'))).toEqual(
      proposals,
    );
    for (const p of proposals) expect(contentText(result)).toContain(`] ${p}\n`);
  });

  // Characterization: a page number set off by a tab or two or more spaces is
  // still a TOC row's page cell, dropped so the row dedups against the body.
  it.each([
    ['two or more spaces', 'RISK FACTORS      12'],
    ['a tab', 'RISK FACTORS\t12'],
  ])('drops a page number set off by %s', (_label, tocRow) => {
    const text = `${tocRow}\n\nTOC line.\n\nRISK FACTORS\n\nBody.\n`;
    expect(detectHeadings(text)).toEqual([
      { heading: 'RISK FACTORS', offset: text.lastIndexOf('RISK FACTORS') },
    ]);
  });

  it.each([
    ['two or more spaces', 'RISK FACTORS      PAGE 12'],
    ['a tab', 'RISK FACTORS\tPAGE 12'],
  ])('drops a page cell written with a Page word, set off by %s', (_label, tocRow) => {
    const text = `${tocRow}\n\nTOC line.\n\nRISK FACTORS\n\nBody.\n`;
    expect(detectHeadings(text)).toEqual([
      { heading: 'RISK FACTORS', offset: text.lastIndexOf('RISK FACTORS') },
    ]);
  });

  const NBSP = ' ';
  /**
   * The shape of First Bancorp's 8-K 0000765207-26-000110: TOC rows whose page
   * cell reads "Page 1" after an NBSP run, then the body Items.
   */
  const FIRST_BANCORP_8K = [
    'TABLE OF CONTENTS',
    '',
    '',
    `Item 8.01 Other Events${NBSP.repeat(12)}Page 1`,
    '',
    '',
    `Item 9.01 Financial Statements and Exhibits.${NBSP.repeat(8)}Page 1`,
    '',
    '',
    `Signatures ${NBSP.repeat(20)}Page 2`,
    '',
    '----------------------------------------',
    '',
    'Item 8.01 Other Events.',
    '',
    'On September 24, 2026, the Registrant issued a press release.',
    '',
    'Item 9.01 Financial Statements, Pro Forma Financial Information and Exhibits.',
    '',
    '(d) Exhibits.',
    '',
  ].join('\n');

  it('drops a "Page N" TOC cell, so the TOC row dedups against its body Item', () => {
    expect(detectHeadings(FIRST_BANCORP_8K)).toEqual([
      { heading: 'TABLE OF CONTENTS', offset: 0 },
      {
        heading: 'Item 9.01 Financial Statements and Exhibits.',
        offset: FIRST_BANCORP_8K.indexOf('Item 9.01 Financial Statements and'),
      },
      {
        heading: 'Item 8.01 Other Events.',
        offset: FIRST_BANCORP_8K.indexOf('Item 8.01 Other Events.'),
      },
      {
        heading: 'Item 9.01 Financial Statements, Pro Forma Financial Information and Exhibits.',
        offset: FIRST_BANCORP_8K.indexOf('Item 9.01 Financial Statements,'),
      },
    ]);
  });

  it('lands get_filing "item 8" on the body Item, and the outline shows no page cell', async () => {
    const accession = '0000765207-26-000110';
    serveTextFiling(accession, '8-K', `${FIRST_BANCORP_8K}${'Closing prose. '.repeat(80)}\n`);

    const landing = await runToolContract(getFilingTool, {
      accession_number: accession,
      cik: '765207',
      section: 'item 8',
    });
    expect(landing.isError).toBeFalsy();
    const content = (landing.structuredContent as { content: string }).content;
    expect(content.startsWith('Item 8.01 Other Events.\n')).toBe(true);
    expect(contentText(landing)).toContain('Item 8.01 Other Events.\n\nOn September 24');

    const firstPage = await runToolContract(getFilingTool, {
      accession_number: accession,
      cik: '765207',
      content_limit: 1000,
    });
    const outline = (firstPage.structuredContent as { outline: Array<{ heading: string }> })
      .outline;
    expect(outline.map((h) => h.heading)).toContain('Item 9.01 Financial Statements and Exhibits.');
    expect(outline.some((h) => h.heading.includes('Page'))).toBe(false);
    const rendered = contentText(firstPage).split('--- BEGIN SEC FILING CONTENT')[0] ?? '';
    expect(rendered).toContain('] Item 9.01 Financial Statements and Exhibits.\n');
    expect(rendered).not.toContain('Page');
  });
});

describe('detectHeadings — a same-line Item heading that opens on one NBSP (#176)', () => {
  const NBSP = ' ';
  const TITLE_101 = 'Item 1.01. Entry into a Material Definitive Agreement.';
  /**
   * The shape of Horizon Space's 8-K 0001929980-26-000542: NBSP spacer lines,
   * then an Item 1.01 line whose extracted text opens on a stray NBSP, while the
   * later Items open on the marker.
   */
  const HSPO_8K = [
    'CURRENT REPORT',
    '',
    'Check the appropriate box below. ☐',
    '',
    NBSP,
    '',
    `${NBSP}${TITLE_101}`,
    '',
    NBSP,
    '',
    'Business Combination Agreement',
    '',
    'On October 12, 2026, the company entered into a business combination agreement.',
    '',
    'Item 7.01 Regulation FD Disclosure.',
    '',
    'On October 12, 2026, the company issued a joint press release.',
    '',
    'Item 9.01 Financial Statements and Exhibits.',
    '',
    'SIGNATURES',
    '',
  ].join('\n');

  it('lists the Item at its marker, not at the NBSP', () => {
    expect(detectHeadings(HSPO_8K)).toEqual([
      { heading: 'CURRENT REPORT', offset: 0 },
      { heading: TITLE_101, offset: HSPO_8K.indexOf(TITLE_101) },
      {
        heading: 'Item 7.01 Regulation FD Disclosure.',
        offset: HSPO_8K.indexOf('Item 7.01'),
      },
      {
        heading: 'Item 9.01 Financial Statements and Exhibits.',
        offset: HSPO_8K.indexOf('Item 9.01'),
      },
      { heading: 'SIGNATURES', offset: HSPO_8K.indexOf('SIGNATURES') },
    ]);
    expect(HSPO_8K.charAt(HSPO_8K.indexOf(TITLE_101) - 1)).toBe(NBSP);
  });

  it.each([
    ['both Item arms match', 'ITEM 1.01. ENTRY INTO A MATERIAL DEFINITIVE AGREEMENT.'],
    // A parenthesized code fails the mixed-case arm, so only the all-caps arm reads this line.
    [
      'only the all-caps arm matches',
      'ITEM 7(A). QUANTITATIVE AND QUALITATIVE DISCLOSURES ABOUT MARKET RISK',
    ],
  ])('lists an all-caps NBSP-led Item line that %s once, at its marker', (_label, line) => {
    const text = `Cover prose.\n\n${NBSP}${line}\n\nAgreement prose.\n`;
    expect(detectHeadings(text)).toEqual([{ heading: line, offset: text.indexOf(line) }]);
  });

  // Characterization: what stays out — the pre-change patterns detect none of
  // these lines, and the NBSP exception leaves them out too.
  it.each([
    [
      'a bare mixed-case marker',
      `${NBSP}Item 2.02.\n\nResults of Operations and Financial Condition`,
    ],
    ['a bare all-caps marker', `${NBSP}ITEM 2.02\n\nResults of Operations and Financial Condition`],
    ['a bare all-caps marker over a page cell', `${NBSP}ITEM 1.    3`],
    ['a Part line', `${NBSP}Part I`],
    ['a titled all-caps Part line', `${NBSP}PART II — OTHER INFORMATION`],
    ['an all-caps line', `${NBSP}RISK FACTORS`],
    ['an Item indented by an ASCII space', ` ${TITLE_101}`],
    ['an Item indented by two NBSPs', `${NBSP}${NBSP}${TITLE_101}`],
    ['a tab-indented Item', `\t${TITLE_101}`],
    [
      'a wrapped cross-reference under a comma line',
      `see the discussion in Part II,\n${NBSP}Item 8 Financial Statements and Supplementary Data`,
    ],
    [
      'an unpunctuated marker before a lowercase word',
      `${NBSP}Item 1 is the election of directors.`,
    ],
  ])('leaves out %s', (_label, lines) => {
    const text = `Cover prose.\n\n${lines}\n\nSIGNATURES\n`;
    expect(detectHeadings(text)).toEqual([
      { heading: 'SIGNATURES', offset: text.indexOf('SIGNATURES') },
    ]);
  });

  it('lands get_filing section "item 1.01" on the marker with no line notice, and lists it in the outline', async () => {
    const accession = '0001929980-26-000542';
    serveTextFiling(accession, '8-K', `${HSPO_8K}${'Closing prose. '.repeat(80)}\n`);

    const landing = await runToolContract(getFilingTool, {
      accession_number: accession,
      cik: '1946021',
      section: 'item 1.01',
    });
    expect(landing.isError).toBeFalsy();
    const sc = landing.structuredContent as { content: string; notice?: string };
    expect(sc.content.startsWith(`${TITLE_101}\n`)).toBe(true);
    expect(sc.notice).toBeUndefined();
    expect(contentText(landing)).toContain(`${TITLE_101}\n\n${NBSP}\n\nBusiness Combination`);

    const firstPage = await runToolContract(getFilingTool, {
      accession_number: accession,
      cik: '1946021',
      content_limit: 1000,
    });
    const outline = (
      firstPage.structuredContent as { outline: Array<{ heading: string; offset: number }> }
    ).outline;
    expect(outline.map((h) => h.heading)).toEqual([
      'CURRENT REPORT',
      TITLE_101,
      'Item 7.01 Regulation FD Disclosure.',
      'Item 9.01 Financial Statements and Exhibits.',
      'SIGNATURES',
    ]);
    const rendered = contentText(firstPage).split('--- BEGIN SEC FILING CONTENT')[0] ?? '';
    const entry = at(outline, 1);
    expect(rendered).toContain(`  [${entry.offset}] ${TITLE_101}\n`);

    // The outline offset, passed as offset, starts the page on the marker.
    const fromOutline = await runToolContract(getFilingTool, {
      accession_number: accession,
      cik: '1946021',
      offset: entry.offset,
    });
    const page = (fromOutline.structuredContent as { content: string }).content;
    expect(page.startsWith(`${TITLE_101}\n`)).toBe(true);
  });
});

describe('detectHeadings — the NBSP-led Item scans stay linear (#176)', () => {
  const NBSP = ' ';

  // A long digit run never crosses Bun's slower regex mode, so it carries the full 64× span.
  it('one NBSP-led all-caps ITEM line holding a long digit run (5k → 320k)', () => {
    expectLinear(detectHeadings, (n) => `${NBSP}ITEM ${'1'.repeat(n)}\ny`, 320_000, 400);
  });

  it.each([
    [
      'one long NBSP-led Item line ending in a break',
      (n: number) => `${NBSP}Item 1 ${fill('§1 x', n)}\ny`,
    ],
    ['one long NBSP-led all-caps ITEM line', (n: number) => `${NBSP}ITEM 1 ${fill('WORD ', n)}\ny`],
    [
      'an NBSP-led marker before a long whitespace run',
      (n: number) => `${NBSP}Item 1${' '.repeat(n)}X\n`,
    ],
    ['NBSP lines throughout', (n: number) => fill(`${NBSP}\r\n`, n)],
    ['NBSP-led Item lines throughout', (n: number) => fill(`${NBSP}Item 1.01 X\r\n`, n)],
    ['NBSP-led Part lines throughout', (n: number) => fill(`${NBSP}Part II —  \r\n`, n)],
  ])('%s (5k → 80k)', (_label, build) => {
    expectLinear(detectHeadings, build, 80_000, 200);
  });
});

describe('detectHeadings — the widened heading scans stay linear (#165, #170)', () => {
  it.each([
    ['a dotted marker before a long whitespace run', (n: number) => `Item 5.02${' '.repeat(n)}1\n`],
    [
      'a dotted marker and suffix before a long whitespace run',
      (n: number) => `Item 9.01(d).${' '.repeat(n)}1\n`,
    ],
    ['a Part marker before a long whitespace run', (n: number) => `Part II${' '.repeat(n)}1\n`],
    [
      'a Part marker and separator before a long whitespace run',
      (n: number) => `Part II —${' '.repeat(n)}1\n`,
    ],
    ['repeated dotted markers with no title', (n: number) => fill('Item 5.02.\n\n', n)],
    ['repeated Part markers', (n: number) => fill('Part II\n', n)],
    ['repeated open paragraph suffixes', (n: number) => `Item 9.01${fill('(d', n)}\n`],
    ['repeated titled Part lines', (n: number) => fill('PART II — OTHER INFORMATION\n', n)],
    ['one long same-line 8-K Item', (n: number) => `Item 5.02 ${fill('Word ', n)}\n`],
    // The all-caps bounds are checked after the match (#170).
    ['one long all-caps paragraph line', (n: number) => `${fill('THE COMPANY’S RISK — ', n)}\n`],
    ['one long all-caps ITEM line', (n: number) => `ITEM 5.02 ${fill('WORD ', n)}\n`],
    [
      'repeated all-caps paragraph lines past the bound',
      (n: number) => fill(`${'WORD '.repeat(40)}\n`, n),
    ],
    [
      'repeated Part cross-reference rows',
      (n: number) => fill('Part II — Item 5. Market for Common Equity\n', n),
    ],
    [
      'repeated all-caps Part lines under comma lines',
      (n: number) => fill('as described,\nPART II — OTHER INFORMATION\n', n),
    ],
    ['one numbered heading after a long space run', (n: number) => `ARTICLE${' '.repeat(n)}5\n`],
    ['repeated numbered headings', (n: number) => fill('PROPOSAL NO. 1\n\n', n)],
    // The run-together TOC test on both Item arms.
    [
      'one long ITEM line of near-miss later markers',
      (n: number) => `ITEM 1 ${fill(' ITEM X', n)}\n`,
    ],
    ['one long ITEM line of single-spaced numbers', (n: number) => `ITEM 1 ${fill('A 1 ', n)}\n`],
    [
      'an ITEM line, a number, then a long whitespace run',
      (n: number) => `ITEM 1 A 1${' '.repeat(n)}\n`,
    ],
    ['one long ITEM line of Page words', (n: number) => `ITEM 1 A${fill('  Page', n)} x\n`],
    [
      'repeated Item lines, each a number before a whitespace run',
      (n: number) => fill(`Item 1 Business 3${' '.repeat(40)}\n`, n),
    ],
    // The page cell's optional Page word.
    ['a heading, then repeated Page words', (n: number) => `RISK FACTORS${fill('  Page', n)} 1x\n`],
    [
      'a Page word before a long whitespace run',
      (n: number) => `RISK FACTORS  Page${' '.repeat(n)}x\n`,
    ],
  ])('%s', (_label, build) => {
    expectLinear(detectHeadings, build, 320_000, 800);
  });

  // The all-caps arm alternated its class with `[^\S\n]` under one quantifier,
  // which fell off a cliff past about 100,000 characters (25 ms at 160,000
  // against 0.4 ms at 80,000, about 50 ms at 320,000); one class scans flat.
  it.each([
    ['an all-caps line, then lowercase', (n: number) => `NOTE ${fill('AB CD ', n)}x\n`],
    [
      'an all-caps line of number and possessive tokens, then lowercase',
      (n: number) => `NOTE ${fill('1 S’ ', n)}x\n`,
    ],
    [
      'an all-caps start and a long whitespace run, then lowercase',
      (n: number) => `ABCDEFGHIJ${' '.repeat(n)}x\n`,
    ],
  ])('%s stays flat past 100,000 characters', (_label, build) => {
    expectLinear(detectHeadings, build, 320_000, 20);
  });
});

describe('foldForHeadingMatch (#106)', () => {
  const NBSP = ' ';

  it('collapses Unicode whitespace runs to a single plain space', () => {
    expect(foldForHeadingMatch(`Item 7.${NBSP}${NBSP}${NBSP}${NBSP}Management`)).toBe(
      'item 7. management',
    );
  });

  it('folds typographic quotes to their ASCII counterparts', () => {
    expect(foldForHeadingMatch('‘Management’s’ “Discussion”')).toBe(`'management's' "discussion"`);
  });

  it('trims and lowercases', () => {
    expect(foldForHeadingMatch('  ITEM 1A. Risk Factors \n')).toBe('item 1a. risk factors');
  });

  it('is idempotent — folding an already-folded string is a no-op', () => {
    const once = foldForHeadingMatch(`Item 7.${NBSP}Management’s Discussion`);
    expect(foldForHeadingMatch(once)).toBe(once);
  });

  it('does not widen matching — a straight-quote needle folds to the same form as a curly heading', () => {
    const heading = `Item 7.${NBSP}${NBSP}Management’s Discussion and Analysis`;
    expect(foldForHeadingMatch(heading).includes(foldForHeadingMatch("item 7. management's"))).toBe(
      true,
    );
    expect(foldForHeadingMatch(heading).includes(foldForHeadingMatch('item 8'))).toBe(false);
  });
});

describe('headingKey — the separator between a marker and its title (#174)', () => {
  const NBSP = ' ';

  it.each([
    ['a period', 'Item 1A. Risk Factors'],
    ['a period and an en dash', 'Item 1A. – Risk Factors'],
    ['an em dash', 'ITEM 1A — RISK FACTORS'],
    ['a hyphen', 'Item 1A - Risk Factors'],
    ['a colon', 'Item 1A: Risk Factors'],
    ['a period and an NBSP run', `Item 1A.${NBSP}${NBSP}Risk Factors.`],
  ])(
    'keys an Item marker and its title past %s as the marker, one space, the title',
    (_label, heading) => {
      expect(headingKey(heading)).toBe('item 1a risk factors');
    },
  );

  it.each([
    ['PART II. OTHER INFORMATION', 'part ii other information'],
    ['Part II — Other Information', 'part ii other information'],
    [
      'Item 9.01. Financial Statements and Exhibits.',
      'item 9.01 financial statements and exhibits',
    ],
    ['Item 9.01(d).    Exhibits', 'item 9.01(d) exhibits'],
  ])('keys %s as %s', (heading, key) => {
    expect(headingKey(heading)).toBe(key);
  });

  // Characterization: a key with no separator to fold, a bare marker, and a
  // heading with no marker keep the key they had.
  it.each([
    ['Item 1A Risk Factors', 'item 1a risk factors'],
    ['ITEM 3.', 'item 3'],
    ['Part II', 'part ii'],
    ['Item 9.01(d).', 'item 9.01(d)'],
    ['RISK FACTORS.', 'risk factors'],
    ['3D. RISK FACTORS', '3d. risk factors'],
    ['Items 1 and 2. Business and Properties', 'items 1 and 2. business and properties'],
  ])('keeps the key of %s', (heading, key) => {
    expect(headingKey(heading)).toBe(key);
  });

  it('dedups a TOC Item against its body Item when only the separator differs', () => {
    // The shape of Worthington Steel's 10-Q 0001968487-26-000036.
    const text =
      `Item 1A.\n\nRisk Factors\n\n${NBSP}\n\n56\n\n${NBSP}\n\nItem 2.\n\nUse of Proceeds\n\n${NBSP}\n\n57\n\n` +
      '----------------------------------------\n\n' +
      'Item 1A. – Risk Factors\n\nThe following information supplements the risk factors.\n\n' +
      'Item 2. – Use of Proceeds\n\nNone.\n';
    expect(detectHeadings(text)).toEqual([
      { heading: 'Item 1A. – Risk Factors', offset: text.indexOf('Item 1A. –') },
      { heading: 'Item 2. – Use of Proceeds', offset: text.indexOf('Item 2. –') },
    ]);
  });
});

describe('findSectionLine — a section the outline omits, by the document’s own lines (#166)', () => {
  const NBSP = ' ';
  const body = (...lines: string[]) => `${lines.join('\n')}\n`;

  it('lands on a line equal to the needle, folded', () => {
    const text = body(
      'Item 2. Management’s Discussion and Analysis',
      'Overview prose.',
      'Liquidity and Capital Resources',
      'The Company believes its balances of cash…',
    );
    expect(findSectionLine(text, 'liquidity and capital resources')).toBe(
      text.indexOf('Liquidity and Capital Resources'),
    );
  });

  it('folds whitespace, quotes, and terminal punctuation on both sides', () => {
    const text = body('Prose.', `Management’s${NBSP}${NBSP}Outlook.`, 'More prose.');
    expect(findSectionLine(text, "management's outlook")).toBe(text.indexOf('Management’s'));
    expect(findSectionLine(text, 'Management’s Outlook.')).toBe(text.indexOf('Management’s'));
  });

  it('lands on the first character of an indented line', () => {
    const text = body('Prose.', '    Competition', 'The market is intense.');
    expect(findSectionLine(text, 'competition')).toBe(text.indexOf('Competition'));
  });

  it('prefers an equal line over an earlier line that starts with the needle', () => {
    const text = body(
      'Competition Among Our Suppliers Is Discussed Below',
      'Prose.',
      'Competition',
      'The market for our products is competitive.',
    );
    expect(findSectionLine(text, 'Competition')).toBe(text.lastIndexOf('Competition'));
  });

  it('says whether the line it lands on equals the needle or only starts with it (#177)', () => {
    const prefixOnly = body('Prose.', 'Human Capital Management', 'Our people.');
    const both = body('Human Capital Management', 'Prose.', 'Human Capital', 'Our people.');
    expect(matchSectionLine(prefixOnly, 'human capital')).toEqual({
      offset: prefixOnly.indexOf('Human Capital Management'),
      equal: false,
    });
    expect(matchSectionLine(both, 'human capital')).toEqual({
      offset: both.indexOf('Human Capital\n'),
      equal: true,
    });
    expect(matchSectionLine(prefixOnly, 'segment information')).toBe(undefined);
  });

  it('never takes a lowercase line in the prefix tier — the equal heading wins over the bullet', () => {
    const text = body(
      '•',
      'competition in our market and our ability to retain and grow market share;',
      'Prose.',
      'Competition',
      'We compete with large vendors.',
    );
    expect(findSectionLine(text, 'Competition')).toBe(text.lastIndexOf('Competition'));
    expect(findSectionLine(body('•', 'competition in our market and more;'), 'Competition')).toBe(
      undefined,
    );
  });

  it('lands a prefix-tier needle on the first line it starts, not a later (continued) repeat', () => {
    const text = body(
      'Table of Contents',
      'Consolidated Schedule of Investments as of June 30, 2026',
      '(in thousands, except share and per share amounts)',
      'Holdings.',
      'Consolidated Schedule of Investments as of June 30, 2026 (continued)',
      'More holdings.',
    );
    expect(findSectionLine(text, 'Consolidated Schedule of Investments')).toBe(
      text.indexOf('Consolidated Schedule of Investments as of June 30, 2026\n'),
    );
  });

  it.each([
    ['continues past the needle mid-word', 'Competitiveness Overview'],
    ['runs past the 140-character bound', `Competition ${'word '.repeat(30)}end.`],
    ['opens lowercase', 'competition is intense in every market we serve'],
  ])('leaves out a prefix line that %s', (_label, line) => {
    expect(findSectionLine(body('Prose.', line, 'More prose.'), 'Competition')).toBe(undefined);
  });

  it('skips a TOC row followed by a page-number line, landing on the body line', () => {
    const text = body(
      'Market and Industry Data',
      '81',
      'Use of Proceeds',
      '82',
      'Dividend Policy',
      '84',
      'Prose.',
      'Use of Proceeds',
      'We estimate that we will receive net proceeds…',
    );
    expect(findSectionLine(text, 'Use of Proceeds')).toBe(text.lastIndexOf('Use of Proceeds'));
  });

  it('skips a prefix-tier TOC row whose page number is set off by two or more spaces', () => {
    const text = body(
      'Liquidity Risk Management    52',
      'Prose.',
      'Liquidity Risk Management Framework',
      'Liquidity risk is the risk that…',
    );
    expect(findSectionLine(text, 'Liquidity Risk Management')).toBe(
      text.indexOf('Liquidity Risk Management Framework'),
    );
  });

  it('keeps a line ending in a year after a single space — not a TOC row', () => {
    const text = body('Prose.', 'Schedule of Investments as of June 30, 2026', 'Holdings.');
    expect(findSectionLine(text, 'Schedule of Investments')).toBe(text.indexOf('Schedule'));
  });

  it('answers undefined when only TOC rows match', () => {
    expect(findSectionLine(body('Use of Proceeds', '82', 'Prose.'), 'Use of Proceeds')).toBe(
      undefined,
    );
  });

  it('skips an HTML TOC row whose page cell sits below spacer lines', () => {
    // The shape of Microsoft's FY2026 10-K TOC: one cell per line, NBSP spacers between.
    const text = body(
      'Legal Proceedings',
      '',
      NBSP,
      '',
      '31',
      '',
      'Prose.',
      'Legal Proceedings',
      'We are subject to claims.',
    );
    expect(findSectionLine(text, 'Legal Proceedings')).toBe(text.lastIndexOf('Legal Proceedings'));
  });

  it('never lands on a lowercase line, even one equal to the needle', () => {
    const text = body(
      'The Company is party to claims arising in the ordinary course of',
      'business.',
    );
    expect(findSectionLine(text, 'Business')).toBe(undefined);
  });

  it.each([
    ['no line matches', 'Segment Information'],
    ['the needle folds to nothing', '.'],
  ])('answers undefined when %s', (_label, section) => {
    expect(findSectionLine(body('Prose.', '', 'More prose.', ''), section)).toBe(undefined);
  });

  it('matches the last line of a text with no trailing newline', () => {
    expect(findSectionLine('Prose.\nCompetition', 'competition')).toBe(7);
  });
});

describe('findSectionLine — no landing on a TOC row, a cross-reference, or a longer title (#166)', () => {
  const NBSP = ' ';
  const body = (...lines: string[]) => `${lines.join('\n')}\n`;

  it('skips a TOC Part row whose Item row below it ends in a page cell', () => {
    // The shape of Microsoft's FY2026 10-K: TOC cells one per line with NBSP
    // spacers, then the body's Part IV page carrying the Part as a page header.
    const text = body(
      'Item 14.',
      '',
      NBSP,
      '',
      'Principal Accountant Fees and Services',
      '',
      '92',
      '',
      'PART IV',
      '',
      NBSP,
      '',
      'Item 15.',
      '',
      NBSP,
      '',
      'Exhibit and Financial Statement Schedules',
      '',
      NBSP,
      '',
      '93',
      '',
      '----------------------------------------',
      '',
      'Item 14 prose.',
      '',
      '92',
      '',
      '----------------------------------------',
      '',
      'PART IV',
      '',
      'Item 15',
      '',
      NBSP,
      '',
      'PART IV',
      '',
      'ITEM 15. EXHIBIT AND FINANCIAL STATEMENT SCHEDULES',
      '',
      '(a)',
      'Financial Statements and Schedules',
    );
    expect(findSectionLine(text, 'part iv')).toBe(text.indexOf('PART IV\n\nItem 15\n'));
  });

  it('skips a TOC Part row whose Item row carries its page number on the same line', () => {
    const text = body(
      'PART IV',
      'Item 15.    Exhibits    93',
      'Item 16.    Form 10-K Summary    100',
      '',
      'Body prose.',
      '',
      'PART IV',
      'Item 15. Exhibits',
      'The exhibits are listed below.',
    );
    expect(findSectionLine(text, 'part iv')).toBe(text.lastIndexOf('PART IV'));
  });

  it('skips a TOC Part row whose Item row wraps onto a line ending in its page number', () => {
    // The shape of Aware's 2005 plain-text 10-K: centered Parts, dotted leaders.
    const text = body(
      '                    PART II',
      '',
      "Item 5.     Market for Registrant's Common Equity, Related Stockholder Matters and Issuer Purchases",
      '            of Equity Securities......................  12',
      'Item 6.     Selected Financial Data...................  12',
      '',
      '                    PART II',
      '',
      "ITEM 5. MARKET FOR REGISTRANT'S COMMON EQUITY",
      '',
      'Our common stock trades on the Nasdaq National Market.',
    );
    expect(findSectionLine(text, 'part ii')).toBe(text.lastIndexOf('PART II'));
  });

  it.each([
    ['a lettered page number', 'F-3'],
    ['a roman page number', 'ii'],
    ['a page number after a Page word', 'Page 3'],
  ])('skips a TOC row whose next line holds %s', (_label, page) => {
    const text = body(
      'Index',
      'Consolidated Balance Sheets',
      page,
      'Prose.',
      'Consolidated Balance Sheets',
      'Assets and liabilities follow.',
    );
    expect(findSectionLine(text, 'Consolidated Balance Sheets')).toBe(
      text.lastIndexOf('Consolidated Balance Sheets'),
    );
  });

  it.each([
    ['a lettered page number', 'Consolidated Balance Sheets    F-3'],
    ['a Page word and number', `Consolidated Balance Sheets${NBSP.repeat(8)}Page 3`],
  ])('skips a TOC row ending in %s set off by spaces', (_label, tocRow) => {
    // The body title is a prefix line too, so only the TOC-row test separates them.
    const text = body(
      tocRow,
      'Prose.',
      'Consolidated Balance Sheets as of June 30, 2026',
      'Assets and liabilities follow.',
    );
    expect(findSectionLine(text, 'Consolidated Balance Sheets')).toBe(
      text.lastIndexOf('Consolidated Balance Sheets'),
    );
  });

  it('skips a TOC title cell followed by the next row’s Item marker (no page column)', () => {
    const text = body(
      'Item 1.',
      'Business Overview',
      'Item 1A.',
      'Risk Factors',
      '',
      'Body prose.',
      '',
      'Business Overview',
      'We make widgets.',
    );
    expect(findSectionLine(text, 'business overview')).toBe(text.lastIndexOf('Business Overview'));
  });

  // Characterization: a body Part heading sits directly over its first Item.
  it('keeps a body Part line over its first Item when no page cell follows', () => {
    const text = body('Prose.', '', 'PART IV', '', 'Item 15. Exhibits', '', 'Exhibit prose.');
    expect(findSectionLine(text, 'part iv')).toBe(text.indexOf('PART IV'));
  });

  it.each([
    [
      'a line before it ending in a comma',
      'see the discussion in Part II,\nItem 8 on this Form 10-K in the Notes to Consolidated Financial Statements.',
      'item 8',
    ],
    [
      'a lowercase word after an unpunctuated Item marker',
      'Prose.\n\nItem 8 is incorporated herein by reference.',
      'item 8',
    ],
    [
      'a line before it ending in a semicolon',
      'as set out in our Annual Report;\nLiquidity and Capital Resources are discussed below.',
      'Liquidity and Capital Resources',
    ],
  ])('leaves out a wrapped cross-reference with %s', (_label, text, section) => {
    expect(findSectionLine(body(text), section)).toBe(undefined);
  });

  it.each([
    ['a capitalized word', 'Business Combinations.'],
    [
      'a capitalized word and a dashed cross-reference',
      'Business Overview—Governmental regulations and their effect on our business—Financial Provision for Rehabilitation.”',
    ],
    ['a capitalized word across a run of spaces', `Competition${NBSP}${NBSP}Among Vendors`],
  ])('leaves out a prefix line that continues with %s — a longer title', (_label, line) => {
    const section = line.startsWith('Competition') ? 'Competition' : 'business';
    expect(findSectionLine(body('Prose.', line, 'More prose.'), section)).toBe(undefined);
  });

  // Characterization: a suffix set off by punctuation or opening lowercase
  // continues the needle's own heading, and so does any suffix after a needle
  // of several words.
  it.each([
    ['a parenthesis', 'Consolidated Balance Sheets (continued)'],
    ['a capitalized word, after several words', 'Consolidated Balance Sheets Parent Company'],
    ['a dash', 'Consolidated Balance Sheets—Parent Company Only'],
    ['a lowercase date phrase', 'Consolidated Balance Sheets as of June 30, 2026'],
    ['an all-caps title', 'CONSOLIDATED BALANCE SHEETS AND RELATED NOTES'],
  ])('keeps a prefix line whose suffix opens with %s', (_label, line) => {
    const text = body('Prose.', line, 'Assets and liabilities follow.');
    expect(findSectionLine(text, 'Consolidated Balance Sheets')).toBe(text.indexOf(line));
  });
});

describe('isTocHeading — a detected heading on a table-of-contents row (#174)', () => {
  const NBSP = ' ';
  /** The detected heading whose text is `heading`, from the real detector. */
  const detected = (text: string, heading: string) => {
    const hit = detectHeadings(text).find((h) => h.heading === heading);
    if (hit === undefined) throw new Error(`not detected: ${heading}`);
    return hit;
  };

  it('flags a same-line Item heading whose row ends in a page cell', () => {
    // The shape of First Bancorp's 8-K 0000765207-26-000110.
    const text =
      'Item 9.01 Financial Statements and Exhibits.        Page 1\n\n\nSignatures        Page 2\n\n' +
      '----------------------------------------\n\n' +
      'Item 9.01 Financial Statements, Pro Forma Financial Information and Exhibits.\n\n(d) Exhibits.\n';
    expect(isTocHeading(text, detected(text, 'Item 9.01 Financial Statements and Exhibits.'))).toBe(
      true,
    );
    const body = 'Item 9.01 Financial Statements, Pro Forma Financial Information and Exhibits.';
    expect(isTocHeading(text, detected(text, body))).toBe(false);
  });

  it('flags a bare all-caps marker over a title cell and a page cell', () => {
    // The shape of DRDGOLD's 20-F 0001628280-26-064355: one TOC cell per line.
    const text =
      'ITEM 3.\nKEY INFORMATION\n6\n3A.\n[Reserved]\n6\n\n' +
      'ITEM 3. KEY INFORMATION\n\n3A. [Reserved]\n\nNot applicable.\n';
    expect(isTocHeading(text, detected(text, 'ITEM 3.'))).toBe(true);
    expect(isTocHeading(text, detected(text, 'ITEM 3. KEY INFORMATION'))).toBe(false);
  });

  it('flags a marker joined to a title whose page cell sits below spacer lines', () => {
    // The shape of Worthington Steel's 10-Q 0001968487-26-000036.
    const text = `Item 1A.\n\nRisk Factors\n\n${NBSP}\n\n56\n\n${NBSP}\n\nItem 2.\n\nUse of Proceeds\n\n57\n`;
    const toc = { heading: 'Item 1A. Risk Factors', offset: 0 };
    expect(detectHeadings(text)).toContainEqual(toc);
    expect(isTocHeading(text, toc)).toBe(true);
    const bodyText = 'Item 1A.\n\nRisk Factors\n\nThe following information supplements…\n';
    expect(isTocHeading(bodyText, detected(bodyText, 'Item 1A. Risk Factors'))).toBe(false);
  });

  it('flags a TOC title that wraps onto a line ending in its page cell', () => {
    // The shape of Aware's 2005 plain-text 10-K 0001188112-05-000453.
    const title =
      "Item 5.     Market for Registrant's Common Equity, Related Stockholder Matters and Issuer Purchases";
    const text = `${title}\n            of Equity Securities.......................  12\nItem 6.     Selected Financial Data........  12\n`;
    expect(isTocHeading(text, detected(text, title))).toBe(true);
  });

  // Characterization: a body heading set over a page number reads as a TOC row —
  // `section` still lands on it when nothing else in its tier matches.
  it('flags a body heading set directly over a page number', () => {
    // The shape of CCC's 10-K 0000950170-25-026848 at its Item 6.
    const text = `Index prose.\n\n${NBSP}\n\nItem 6. Reserved.\n\n36\n\n----------------------------------------\n`;
    expect(isTocHeading(text, detected(text, 'Item 6. Reserved.'))).toBe(true);
  });

  it('judges an NBSP-led Item heading (#176) on its own row, from the marker offset', () => {
    const toc = `Intro.\n${NBSP}Item 1.01. Entry into a Material Definitive Agreement.      3\n`;
    const body = `Intro.\n${NBSP}Item 1.01. Entry into a Material Definitive Agreement.\n\nThe Company entered…\n`;
    const heading = 'Item 1.01. Entry into a Material Definitive Agreement.';
    expect(detected(toc, heading).offset).toBe(toc.indexOf('Item 1.01.'));
    expect(isTocHeading(toc, detected(toc, heading))).toBe(true);
    expect(isTocHeading(body, detected(body, heading))).toBe(false);
  });

  it.each([
    ['a heading on the last line', 'Prose.\n\nRISK FACTORS', 'RISK FACTORS'],
    ['a bare marker with nothing after it', 'Prose.\n\nPART II\n', 'PART II'],
  ])('answers false for %s', (_label, text, heading) => {
    expect(isTocHeading(text, detected(text, heading))).toBe(false);
  });
});

describe('withoutSubItemLabel — a leading 20-F sub-item label on a folded key (#175)', () => {
  it.each([
    ['3d. risk factors', 'risk factors'],
    ['12a. other matters', 'other matters'],
    ['b. business overview', 'business overview'],
    ['l. john doerr', 'john doerr'],
    ['a. c. markkula, jr', 'c. markkula, jr'],
  ])('strips the label from %s', (key, unlabelled) => {
    expect(withoutSubItemLabel(key)).toBe(unlabelled);
  });

  it.each([
    ['item 3. key information'],
    ['123a. three digits'],
    ['ab. two letters'],
    ['3d.risk factors'],
    ['3. a bare number'],
    ['note 3d. a label mid-key'],
    ['risk factors'],
  ])('leaves %s alone', (key) => {
    expect(withoutSubItemLabel(key)).toBe(undefined);
  });
});

describe('findSectionLine — a line carrying a leading 20-F sub-item label (#175)', () => {
  const NBSP = ' ';
  const body = (...lines: string[]) => `${lines.join('\n')}\n`;

  it.each([
    ['a digit-led label', '3D. RISK FACTORS', 'risk factors'],
    ['a letter label', 'B. Business Overview', 'business overview'],
    ['a label set off by NBSPs', `3D.${NBSP}${NBSP}Risk Factors`, 'Risk Factors'],
  ])('lands on a line equal to the value past %s, at the label', (_label, line, section) => {
    const text = body(
      'Not applicable.',
      '',
      line,
      'In conducting our business, we face many risks.',
    );
    expect(matchSectionLine(text, section)).toEqual({ offset: text.indexOf(line), equal: true });
  });

  it('lands a several-word value on a labelled line it starts', () => {
    const text = body('Prose.', 'D. Risk Factors Relating to Our Industry', 'Risks follow.');
    expect(matchSectionLine(text, 'risk factors')).toEqual({
      offset: text.indexOf('D. Risk'),
      equal: false,
    });
  });

  it('skips a labelled TOC row, landing on the labelled body line', () => {
    const text = body(
      '3D. Risk Factors      6',
      '3E. Other Matters      9',
      'Prose.',
      '3D. RISK FACTORS',
      'In conducting our business, we face many risks.',
    );
    expect(findSectionLine(text, 'risk factors')).toBe(text.indexOf('3D. RISK'));
  });

  it('judges the one-word rule on the line after its label', () => {
    // Regencell's 20-F 0001213900-26-107581 prints "B. Business Overview": a
    // longer Title Case title, so `business` misses there, while a lowercase
    // continuation keeps a one-word value's prefix landing.
    const regencell = body('Prose.', 'B. Business Overview', 'Our Business Plan', 'Our goal…');
    expect(findSectionLine(regencell, 'business')).toBe(undefined);
    const text = body('Prose.', 'C. Competition in our markets', 'We compete with large vendors.');
    expect(matchSectionLine(text, 'competition')).toEqual({
      offset: text.indexOf('C. Competition'),
      equal: false,
    });
  });

  it('matches a line opening on an initial only by the rest of the line', () => {
    const text = body('Directors', 'L. John Doerr', 'Director since 2009.');
    expect(findSectionLine(text, 'john doerr')).toBe(text.indexOf('L. John'));
    expect(findSectionLine(text, 'john')).toBe(undefined);
    expect(findSectionLine(text, 'doerr')).toBe(undefined);
  });

  // Characterization: the value is compared as given, so a labelled value still
  // matches its own line, and a label never strips from the value's side.
  it('matches a labelled value against its own line, and never strips the value', () => {
    const text = body('Prose.', '3D. RISK FACTORS', 'Risks follow.');
    expect(findSectionLine(text, '3D. RISK FACTORS')).toBe(text.indexOf('3D.'));
    expect(findSectionLine(body('Prose.', 'Risk Factors', 'Risks.'), 'D. Risk Factors')).toBe(
      undefined,
    );
  });
});

describe('findSectionLine — the whole-document scan stays linear (#166)', () => {
  it.each([
    ['one line with no newline', (n: number) => fill('Competitor ', n)],
    ['many short lines, each a near miss', (n: number) => fill('Competitor\n', n)],
    ['many prefix candidates over page-number lines', (n: number) => fill('Competition x\n1\n', n)],
    [
      'a prefix candidate before a long whitespace run',
      (n: number) => `Competition${' '.repeat(n)}x\n`,
    ],
    [
      'a prefix candidate, a long whitespace run, then a number',
      (n: number) => `Competition${' '.repeat(n)}52\n`,
    ],
    ['repeated NBSP-spaced candidates', (n: number) => fill(`Competition${' '.repeat(40)}x\n`, n)],
    [
      'TOC rows over NBSP spacer runs',
      (n: number) => fill(`Competition\n${' \n'.repeat(50)}5\n`, n),
    ],
    [
      'an equal line over one long NBSP spacer run, then a page number',
      (n: number) => `Competition\n${' \n'.repeat(n / 2)}5\n`,
    ],
    [
      'an equal line, then a long whitespace run with no newline',
      (n: number) => `Competition\n${' '.repeat(n)}`,
    ],
    // The TOC walk, the cross-reference guards, and the longer-title test (#166).
    [
      'equal lines over bare markers, titles, and spacer runs',
      (n: number) => fill(`Competition\n${' \n'.repeat(20)}Item 15.\n${' \n'.repeat(20)}X\n`, n),
    ],
    ['equal lines under comma lines', (n: number) => fill('see below,\nCompetition\n', n)],
    [
      'prefix lines with long whitespace runs before a capital',
      (n: number) => fill(`Competition${' '.repeat(60)}Among x\n`, n),
    ],
    ['an equal line under one long prose line', (n: number) => `${'a'.repeat(n)},\nCompetition\n`],
    [
      'TOC rows ending in and over Page cells',
      (n: number) => fill('Competition  Page 1\nPage 2\n', n),
    ],
    [
      'a prefix candidate, a Page word, then a long whitespace run',
      (n: number) => `Competition  Page${' '.repeat(n)}1x\n`,
    ],
  ])('%s', (_label, build) => {
    expectLinear((text) => findSectionLine(text, 'Competition'), build, 320_000, 200);
  });
});

describe('the heading key, the label strip, and the TOC-row test stay linear (#174, #175)', () => {
  const NBSP = ' ';
  const lineScan = (text: string) => findSectionLine(text, 'risk factors');

  // A long digit run never crosses Bun's slower regex mode, so it carries the full 64× span.
  it('a line scan over an Item line holding a long digit run (5k → 320k)', () => {
    expectLinear(lineScan, (n) => `Item 1. ${'1'.repeat(n)}\ny`, 320_000, 200);
  });

  it.each([
    ['one long line ending in a break', (n: number) => `${fill('§1 x', n)}\ny`],
    ['breaks throughout', (n: number) => fill('  \r\n', n)],
    ['a long run of periods, then a letter', (n: number) => `${'.'.repeat(n)}x\n`],
    ['an Item marker before a long run of periods', (n: number) => `Item 1${'.'.repeat(n)}x\n`],
    ['an Item marker before repeated separators', (n: number) => `Item 1A. ${fill('– ', n)}x\n`],
    ['labelled prefix lines throughout', (n: number) => fill('3D. RISK FACTORS SUMMARY\n', n)],
    ['labelled TOC rows throughout', (n: number) => fill('3D. Risk Factors\n6\n', n)],
    ['one long labelled line', (n: number) => `3D. ${fill('RISK ', n)}\n`],
    ['repeated label tokens on one line', (n: number) => `${fill('3D. ', n)}x\n`],
  ])('a line scan over %s (5k → 80k)', (_label, build) => {
    expectLinear(lineScan, build, 80_000, 200);
  });

  it.each([
    ['repeated Item headings with separators', (n: number) => fill('Item 1A. – Risk Factors\n', n)],
    ['repeated labelled all-caps headings', (n: number) => fill('D. RISK FACTORS\n', n)],
  ])('heading detection over %s (5k → 80k)', (_label, build) => {
    expectLinear(detectHeadings, build, 80_000, 200);
  });

  it.each([
    [
      'a bare marker over long spacer runs',
      'Item 1.',
      (n: number) =>
        `Item 1.\n${fill(`${NBSP}\n`, n / 2)}Risk Factors\n${fill(`${NBSP}\n`, n / 2)}5\n`,
    ],
    [
      'a titled heading over a long wrapped line',
      'Item 1. Business',
      (n: number) => `Item 1. Business\n${fill('of x ', n)}  5\n`,
    ],
  ])('the TOC-row test over %s (5k → 80k)', (_label, heading, build) => {
    expectLinear((text) => isTocHeading(text, { heading, offset: 0 }), build, 80_000, 200);
  });
});

/**
 * A 10-Q shaped like Apple's 0000320193-26-000020 around its MD&A: a TOC row
 * per cell, the Item 2 heading, then mixed-case subheadings the outline omits.
 */
const MDA_10Q = [
  'TABLE OF CONTENTS',
  '',
  'Item 2.',
  'Management’s Discussion and Analysis of Financial Condition and Results of Operations',
  '13',
  'Liquidity and Capital Resources',
  '17',
  '',
  '----------------------------------------',
  '',
  'Item 2.    Management’s Discussion and Analysis of Financial Condition and Results of Operations',
  '',
  'Overview prose about the quarter.',
  '',
  'USE OF PROCEEDS',
  'Proceeds prose.',
  '',
  'Liquidity and Capital Resources',
  'The Company believes its balances of cash are sufficient.',
  '',
  'Critical Accounting Estimates',
  'Estimates prose.',
  '',
].join('\n');

describe('get_filing section — the line fallback after every heading tier (#166)', () => {
  it('lands on a subheading line in structuredContent and content[]', async () => {
    const accession = '0000320193-26-000020';
    serveTextFiling(accession, '10-Q', MDA_10Q);

    for (const section of ['Liquidity and Capital Resources', 'critical accounting estimates']) {
      const result = await runToolContract(getFilingTool, {
        accession_number: accession,
        cik: '320193',
        section,
      });
      expect(result.isError).toBeFalsy();
      const content = (result.structuredContent as { content: string }).content;
      expect(foldForHeadingMatch(content.split('\n')[0] ?? '')).toBe(foldForHeadingMatch(section));
      expect(content).toContain('prose');
      expect(contentText(result)).toContain(content.slice(0, 80));
    }
  });

  it('a heading match wins over an earlier equal line', async () => {
    const accession = '0000320193-26-000020';
    serveTextFiling(accession, '10-Q', `Use of Proceeds\n\nCover prose.\n\n${MDA_10Q}`);

    const result = await runToolContract(getFilingTool, {
      accession_number: accession,
      cik: '320193',
      section: 'use of proceeds',
    });
    expect(result.isError).toBeFalsy();
    const content = (result.structuredContent as { content: string }).content;
    expect(content.startsWith('USE OF PROCEEDS\nProceeds prose.')).toBe(true);
  });

  it('still throws section_not_found with the outline when no heading or line matches', async () => {
    const accession = '0000320193-26-000020';
    serveTextFiling(accession, '10-Q', MDA_10Q);

    const miss = await runToolContract(getFilingTool, {
      accession_number: accession,
      cik: '320193',
      section: 'Segment Information',
    });
    expect(miss.isError).toBe(true);
    const text = contentText(miss);
    expect(text).toContain("Section 'Segment Information' not found in this document.");
    expect(text).toContain('] USE OF PROCEEDS');
    expect(text).toContain('exactly as the document prints it');
  });

  /**
   * An S-1 shaped like Arxis' 0001193125-26-419718 and a 10-K like CCC's
   * 0000950170-25-026848: a mixed-case `Business` heading the outline never
   * lists, a note heading that merely contains the word, a `Compensation`
   * table-row label, and the Item 11 heading.
   */
  const NOTE_AND_ITEM_DOC = [
    'Business',
    '',
    'We are a leading designer of propulsion systems.',
    '',
    'Compensation',
    '',
    '$',
    '',
    '47,505',
    '',
    'NOTE 3. BUSINESS COMBINATIONS',
    '',
    'MagCanica prose.',
    '',
    'Item 11. Executive Compensation',
    '',
    'Compensation prose.',
    '',
  ].join('\n');

  it('lands on an equal line ahead of a heading that only contains the value (#177)', async () => {
    const accession = '0001193125-26-419718';
    serveTextFiling(accession, 'S-1', NOTE_AND_ITEM_DOC);

    const result = await runToolContract(getFilingTool, {
      accession_number: accession,
      cik: '2093536',
      section: 'business',
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { content: string; notice?: string };
    expect(sc.content.startsWith('Business\n\nWe are a leading designer')).toBe(true);
    const notice =
      "No detected heading equals section 'business', so this page starts at the first document line that does, ahead of headings that only contain it.";
    expect(sc.notice).toBe(notice);
    expect(contentText(result)).toContain(notice);
  });

  // Characterization: an Item heading that only contains the value still beats
  // the earlier equal line, a table-row label here.
  it('keeps an Item heading that contains the value ahead of an equal line (#177)', async () => {
    const accession = '0000950170-25-026848';
    serveTextFiling(accession, '10-K', NOTE_AND_ITEM_DOC);

    const result = await runToolContract(getFilingTool, {
      accession_number: accession,
      cik: '1818201',
      section: 'compensation',
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { content: string; notice?: string };
    expect(sc.content.startsWith('Item 11. Executive Compensation\n\nCompensation prose.')).toBe(
      true,
    );
    expect(sc.notice).toBeUndefined();
  });

  /**
   * A proxy statement shaped like Goldman Sachs' DEF 14A 0001193125-26-117433:
   * its ITEM headings are ballot proposals, and its lines equal to a value are
   * table cells (the Pay versus Performance header "Summary" / "Compensation").
   */
  const PROXY_DOC = [
    'EXECUTIVE SUMMARY',
    '',
    'This summary highlights information from our Proxy Statement.',
    '',
    'COMPENSATION DISCUSSION AND ANALYSIS',
    '',
    'This CD&A describes our executive compensation philosophy.',
    '',
    'Year',
    '',
    'Summary',
    'Compensation',
    '',
    'Table Total for PEO ($)',
    '',
    'ITEM 2. AN ADVISORY VOTE TO APPROVE EXECUTIVE COMPENSATION (SAY ON PAY)',
    '',
    'Say on pay prose.',
    '',
  ].join('\n');

  it.each([
    ['summary', 'EXECUTIVE SUMMARY\n'],
    ['compensation', 'COMPENSATION DISCUSSION AND ANALYSIS\n'],
  ])(
    'lands a proxy statement\'s "%s" on the first heading containing it, ahead of an equal line and a later ITEM proposal',
    async (section, start) => {
      const page = await sectionPage('0001193125-26-117433', 'DEF 14A', PROXY_DOC, section);
      expect(page.content.startsWith(start)).toBe(true);
      expect(page.notice).toBeUndefined();
    },
  );
});

/** A `get_filing` section page over `text`, served as a plain-text submission. */
async function sectionPage(accession: string, form: string, text: string, section: string) {
  serveTextFiling(accession, form, text);
  const result = await runToolContract(getFilingTool, {
    accession_number: accession,
    cik: '1',
    section,
  });
  expect(result.isError).toBeFalsy();
  const sc = result.structuredContent as { content: string; notice?: string };
  return { content: sc.content, notice: sc.notice, rendered: contentText(result) };
}

describe('get_filing section — a body heading ahead of a table-of-contents row (#174)', () => {
  const NBSP = ' ';

  /** A 20-F shaped like DRDGOLD's 0001628280-26-064355: one TOC cell per line, then the body. */
  const TWENTY_F = [
    'TABLE OF CONTENTS',
    'ITEM 3.',
    'KEY INFORMATION',
    '6',
    '3A.',
    '[Reserved]',
    '6',
    '3D.',
    'Risk Factors',
    '6',
    'ITEM 19.',
    'EXHIBITS',
    '120',
    '',
    '----------------------------------------',
    '',
    'ITEM 3. KEY INFORMATION',
    '',
    '3A. [Reserved]',
    '',
    '3D. RISK FACTORS',
    'In conducting our business, we face many risks.',
    '',
    'ITEM 19. EXHIBITS',
    '',
    'The exhibits are listed below.',
    '',
  ].join('\n');

  it.each([
    ['item 3', 'ITEM 3. KEY INFORMATION\n\n3A. [Reserved]'],
    ['key information', 'ITEM 3. KEY INFORMATION\n\n3A. [Reserved]'],
    ['item 19', 'ITEM 19. EXHIBITS\n\nThe exhibits are listed below.'],
  ])(
    'lands "%s" on the body heading, past the bare TOC marker and title cell',
    async (section, start) => {
      const page = await sectionPage('0001628280-26-064355', '20-F', TWENTY_F, section);
      expect(page.content.startsWith(start)).toBe(true);
      expect(page.notice).toBeUndefined();
      expect(page.rendered).toContain(page.content.slice(0, 80));
    },
  );

  it('lands "risk factors" on a 10-Q body Item whose separator the TOC row lacks', async () => {
    // The shape of Worthington Steel's 10-Q 0001968487-26-000036.
    const text =
      `Item 1A.\n\nRisk Factors\n\n${NBSP}\n\n56\n\n${NBSP}\n\nItem 2.\n\nUse of Proceeds\n\n${NBSP}\n\n57\n\n` +
      '----------------------------------------\n\n' +
      'Item 1A. – Risk Factors\n\nThe following information supplements the risk factors.\n\n' +
      'Item 2. – Use of Proceeds\n\nNone.\n';
    for (const [section, start] of [
      ['risk factors', 'Item 1A. – Risk Factors\n\nThe following'],
      ['item 2', 'Item 2. – Use of Proceeds\n\nNone.'],
    ] as const) {
      const page = await sectionPage('0001968487-26-000036', '10-Q', text, section);
      expect(page.content.startsWith(start)).toBe(true);
      expect(page.notice).toBeUndefined();
    }
  });

  it('keeps a body Part whose running header prints another separator form', async () => {
    const pageHeader = (n: number) =>
      `----------------------------------------\n\nPart I. Financial Information\n\nPage ${n} prose.\n\n`;
    const text =
      'Part I – Financial Information      2\n\n' +
      'Part II – Other Information      30\n\n' +
      '----------------------------------------\n\n' +
      'PART I – FINANCIAL INFORMATION\n\nItem 1. Financial Statements\n\nStatements prose.\n\n' +
      [1, 2, 3, 4, 5].map(pageHeader).join('') +
      'PART II – OTHER INFORMATION\n\nItem 1. Legal Proceedings\n\nLegal prose.\n';
    expect(detectHeadings(text).filter((h) => /^part i\b/i.test(h.heading))).toEqual([
      { heading: 'PART I – FINANCIAL INFORMATION', offset: text.indexOf('PART I –') },
      { heading: 'Part I. Financial Information', offset: text.indexOf('Part I.') },
    ]);
    for (const section of ['part i', 'financial information']) {
      const page = await sectionPage('0000000001-26-000001', '10-Q', text, section);
      expect(page.content.startsWith('PART I – FINANCIAL INFORMATION\n\nItem 1.')).toBe(true);
      expect(page.notice).toBeUndefined();
    }
  });

  /** An 8-K shaped like First Bancorp's 0000765207-26-000110: TOC rows worded apart from the body. */
  const EIGHT_K = [
    'Item 8.01 Other Events            Page 1',
    '',
    'Item 9.01 Financial Statements and Exhibits.        Page 1',
    '',
    'Signatures                     Page 2',
    '',
    '----------------------------------------',
    '',
    'Item 8.01 Other Events.',
    '',
    'On September 24, 2026, the Registrant issued a press release.',
    '',
    'Item 9.01 Financial Statements, Pro Forma Financial Information and Exhibits.',
    '',
    '(d) Exhibits.',
    '',
  ].join('\n');

  it('lands "item 9" on the body Item, past a TOC row worded differently', async () => {
    const page = await sectionPage('0000765207-26-000110', '8-K', EIGHT_K, 'item 9');
    expect(page.content.startsWith('Item 9.01 Financial Statements, Pro Forma')).toBe(true);
    expect(page.notice).toBeUndefined();
  });

  // Characterization: the TOC row that dedups against its body Item (#172) stays off.
  it('keeps "item 8" on the body Item', async () => {
    const page = await sectionPage('0000765207-26-000110', '8-K', EIGHT_K, 'item 8');
    expect(page.content.startsWith('Item 8.01 Other Events.\n\nOn September 24')).toBe(true);
    expect(page.notice).toBeUndefined();
  });

  // Characterization: a body heading set over a page number reads as a TOC row,
  // and still lands as its tier's only match (CCC's 10-K 0000950170-25-026848).
  it('lands on a heading that reads as a TOC row when nothing else in its tier matches', async () => {
    const text = [
      'Item 5. Market for Registrant’s Common Equity',
      '',
      'Our common stock trades on the Nasdaq.',
      '',
      'Item 6. Reserved.',
      '',
      '36',
      '',
      '----------------------------------------',
      '',
      'Item 7. Management’s Discussion and Analysis',
      '',
      'MD&A prose.',
      '',
    ].join('\n');
    const page = await sectionPage('0000950170-25-026848', '10-K', text, 'item 6');
    expect(page.content.startsWith('Item 6. Reserved.\n\n36')).toBe(true);
    expect(page.notice).toBeUndefined();
  });
});

describe('get_filing section — a leading 20-F sub-item label (#175)', () => {
  /** A 20-F shaped like DRDGOLD's 0001628280-26-064355 and Regencell's 0001213900-26-107581. */
  const TWENTY_F = [
    'ITEM 3. KEY INFORMATION',
    '',
    '3D. RISK FACTORS',
    'In conducting our business, we face many risks.',
    '',
    'ITEM 4. INFORMATION ON THE COMPANY',
    '',
    'B. Business Overview',
    '',
    'Our Business Plan',
    '',
    'Our goal is to save lives.',
    '',
  ].join('\n');
  const LINE_NOTICE = (section: string) =>
    `No detected heading matches section '${section}', so this page starts at the first document line that does.`;

  it.each([
    ['risk factors', '3D. RISK FACTORS\nIn conducting'],
    ['business overview', 'B. Business Overview\n\nOur Business Plan'],
  ])(
    'lands "%s" on the labelled line, in structuredContent and content[]',
    async (section, start) => {
      const page = await sectionPage('0001628280-26-064355', '20-F', TWENTY_F, section);
      expect(page.content.startsWith(start)).toBe(true);
      expect(page.notice).toBe(LINE_NOTICE(section));
      expect(page.rendered).toContain(LINE_NOTICE(section));
      expect(page.rendered).toContain(page.content.slice(0, 40));
    },
  );

  // Characterization: a labelled value matches its own line as given.
  it('lands the labelled value "3D. RISK FACTORS" on its own line', async () => {
    const page = await sectionPage('0001628280-26-064355', '20-F', TWENTY_F, '3D. RISK FACTORS');
    expect(page.content.startsWith('3D. RISK FACTORS\nIn conducting')).toBe(true);
    expect(page.notice).toBe(LINE_NOTICE('3D. RISK FACTORS'));
  });

  it('still misses "business" on a longer Title Case title after a label', async () => {
    serveTextFiling('0001213900-26-107581', '20-F', TWENTY_F);
    const miss = await runToolContract(getFilingTool, {
      accession_number: '0001213900-26-107581',
      cik: '1',
      section: 'business',
    });
    expect(miss.isError).toBe(true);
    expect(contentText(miss)).toContain("Section 'business' not found in this document.");
  });
});

describe('filingToExtract — nesting depth and SGML page markers (#118)', () => {
  const ELLIPSIS = '[…]';
  const nest = (open: string, close: string, depth: number, inner = 'x') =>
    `<html><body>before ${open.repeat(depth)}${inner}${close.repeat(depth)} after</body></html>`;

  /** A legacy SGML text document whose `<PAGE>` markers the parser never closes. */
  const sgmlDocument = (pages: number) =>
    `<DOCUMENT>\n<TYPE>10-K\n<TEXT>\n${Array.from(
      { length: pages },
      (_, i) => `page ${i + 1} text\n<PAGE>\n`,
    ).join('')}END\n</TEXT>\n</DOCUMENT>\n`;

  // Characterization: pinned against the pre-#118 conversion, which had no depth
  // limit and parsed <PAGE> as an element — a shallow document must not move.
  it('leaves a shallow HTML filing and its outline unchanged', () => {
    const html =
      '<html><body><p>PART I</p><p>Item 1. Business</p><div><span>We make <b>widgets</b>.</span></div><table><tr><td>Revenue</td><td>100</td></tr></table><p>Item 1A. Risk Factors</p><p>Risks <font>abound</font>.</p></body></html>';
    const text = filingToExtract(html);

    expect(text).toBe(
      'PART I\n\nItem 1. Business\n\nWe make widgets.\n\nRevenue100\n\nItem 1A. Risk Factors\n\nRisks abound.',
    );
    expect(detectHeadings(text)).toEqual([
      { heading: 'PART I', offset: 0 },
      { heading: 'Item 1. Business', offset: 8 },
      { heading: 'Item 1A. Risk Factors', offset: 56 },
    ]);
  });

  it('keeps a short SGML text document line for line, each <PAGE> marker a line break (#136)', () => {
    const sgml =
      '<DOCUMENT>\n<TYPE>10-K\n<TEXT>\nITEM 1.  BUSINESS\n\nThe company sells computers.\n<PAGE>   2\nITEM 2.  PROPERTIES\n\nHeadquarters in Cupertino.\n<PAGE>   3\nITEM 3.  LEGAL PROCEEDINGS\n\nNone.\n</TEXT>\n</DOCUMENT>\n';

    expect(filingToExtract(sgml)).toBe(
      '10-K\n\n\nITEM 1.  BUSINESS\n\nThe company sells computers.\n\n   2\nITEM 2.  PROPERTIES\n\nHeadquarters in Cupertino.\n\n   3\nITEM 3.  LEGAL PROCEEDINGS\n\nNone.\n',
    );
  });

  it('cuts 30,000 nested <span> at the depth limit instead of overflowing the stack', () => {
    expect(filingToExtract(nest('<span>', '</span>', 30_000))).toBe(`before ${ELLIPSIS} after`);
  });

  it('cuts 30,000 nested <div> at the depth limit instead of overflowing the stack', () => {
    expect(filingToExtract(nest('<div>', '</div>', 30_000))).toBe(`before\n${ELLIPSIS}\nafter`);
  });

  it('cuts 30,000 unclosed <font>x runs at the depth limit instead of overflowing the stack', () => {
    const text = filingToExtract(`<html><body>before ${'<font>x'.repeat(30_000)}</body></html>`);

    expect(text.startsWith('before x')).toBe(true);
    expect(text.endsWith(ELLIPSIS)).toBe(true);
    // One `x` per level the walk reached — the cut is a bounded depth, not a failure.
    expect(text.length).toBeLessThan(1_000);
  });

  it('cuts 30,000 nested lists — the shape with the shallowest stack budget', () => {
    expect(filingToExtract(nest('<ul><li>', '</li></ul>', 30_000))).toContain(ELLIPSIS);
  });

  it('keeps nesting under the limit whole, with no ellipsis', () => {
    expect(filingToExtract(nest('<span>', '</span>', 400, 'deep'))).toBe('before deep after');
  });

  it('marks the cut once nesting passes the limit', () => {
    expect(filingToExtract(nest('<span>', '</span>', 600, 'deep'))).toBe(
      `before ${ELLIPSIS} after`,
    );
  });

  it('applies the same limit through filingToText', () => {
    const { text, truncated } = filingToText(nest('<div>', '</div>', 30_000));

    expect(text).toBe(`before\n${ELLIPSIS}\nafter`);
    expect(truncated).toBe(false);
  });

  it('converts an 800-page SGML text document whole — every page, no ellipsis', () => {
    const text = filingToExtract(sgmlDocument(800));

    for (const page of [1, 400, 511, 512, 513, 800]) {
      expect(text).toContain(`page ${page} text`);
    }
    expect(text.match(/page \d+ text/g)).toHaveLength(800);
    expect(text).toContain('END');
    expect(text).not.toContain(ELLIPSIS);
  });
});

describe('filingToExtract — plain-text SGML bodies keep their lines (#136)', () => {
  const wrap = (body: string, type = '10-K') =>
    `<DOCUMENT>\n<TYPE>${type}\n<TEXT>\n${body}</TEXT>\n</DOCUMENT>\n`;

  /** The shape of a 1990s 10-K body: flush headings, an EDGAR ASCII table, page markers. */
  const LEGACY_10K = wrap(
    [
      'PART I',
      '',
      'Item 1.  Business',
      '',
      '     The Company designs personal computers.',
      '',
      '<TABLE>',
      '<CAPTION>',
      '                          1996       1995',
      '<S>                     <C>        <C>',
      'Net sales               $9,833     $11,062',
      '</TABLE>',
      '<PAGE>   2',
      "Item 7.  Management's Discussion and Analysis",
      '',
      '     Net sales fell & margins < 20%; see <Note 4.',
      '',
    ].join('\n'),
  );

  it('keeps line structure, so the outline lists the Part and Items', () => {
    const text = filingToExtract(LEGACY_10K);

    expect(detectHeadings(text).map((h) => h.heading)).toEqual([
      'PART I',
      'Item 1.  Business',
      "Item 7.  Management's Discussion and Analysis",
    ]);
    expect(detectHeadings(text).at(-1)?.offset).toBe(text.indexOf('Item 7.'));
    // The <PAGE> marker's page number stays on a line of its own.
    expect(text).toContain('\n   2\nItem 7.');
  });

  it('drops the SGML table tags and keeps the columns aligned', () => {
    const text = filingToExtract(LEGACY_10K);

    expect(text).toContain('\n                          1996       1995\n');
    expect(text).toContain('\nNet sales               $9,833     $11,062\n');
    for (const tag of ['<TABLE>', '<CAPTION>', '<S>', '<C>', '</TABLE>', 'CAPTION']) {
      expect(text).not.toContain(tag);
    }
  });

  it('keeps a literal &, <, and > of the source text verbatim', () => {
    const text = filingToExtract(LEGACY_10K);
    expect(text).toContain('     Net sales fell & margins < 20%; see <Note 4.\n');
    expect(filingToExtract(wrap('AT&amp;T  a < b > c\n'))).toContain('AT&amp;T  a < b > c\n');
  });

  it('drops EX-27 field tags, <PP&E> and <PERIOD-TYPE> included, one value per line', () => {
    const ex27 = wrap(
      '<ARTICLE> 5\n<MULTIPLIER> 1,000\n<PERIOD-TYPE> YEAR\n<PP&E> 1,234\n<TOTAL-ASSETS> 9,999\n',
      'EX-27',
    );
    expect(filingToExtract(ex27)).toBe('EX-27\n\n\n 5\n 1,000\n YEAR\n 1,234\n 9,999\n');
  });

  it('keeps every plain document of a submission line for line', () => {
    const submission =
      wrap('ITEM 1.  BUSINESS\n\nBody text.\n') +
      wrap('EXHIBIT 21\n\nSUBSIDIARIES OF THE REGISTRANT\n', 'EX-21');
    const text = filingToExtract(submission);

    expect(text).toContain('\nITEM 1.  BUSINESS\n\nBody text.\n');
    expect(text).toContain('\nEXHIBIT 21\n\nSUBSIDIARIES OF THE REGISTRANT\n');
  });
});

describe('filingToExtract — input with no plain <TEXT> body converts as before (#136)', () => {
  // Characterization: each expected string is the pre-#136 conversion of the same input.
  it('an SGML-wrapped HTML document', () => {
    const sgml =
      '<DOCUMENT>\n<TYPE>10-K\n<SEQUENCE>1\n<FILENAME>form10k.htm\n<TEXT>\n<HTML>\n<BODY>\n<P>PART I</P>\n<P>Item 1.  Business</P>\n<P>We design\npersonal computers.</P>\n<TABLE><TR><TD>Net sales</TD><TD>9,833</TD></TR></TABLE>\n</BODY>\n</HTML>\n</TEXT>\n</DOCUMENT>\n';
    const text = filingToExtract(sgml);

    expect(text).toBe(
      'PART I\n\nItem 1. Business\n\nWe design personal computers.\n\nNet sales9,833',
    );
    expect(detectHeadings(text)).toEqual([
      { heading: 'PART I', offset: 0 },
      { heading: 'Item 1. Business', offset: 8 },
    ]);
  });

  it('an inline SVG <text> element — the wrapper match is case-sensitive', () => {
    const html =
      '<html><body><p>Revenue by segment</p><svg viewBox="0 0 10 10"><text x="0" y="5">Americas\nsegment</text></svg><p>See note 4.</p></body></html>';
    expect(filingToExtract(html)).toBe('Revenue by segment\n\nAmericas segment\n\nSee note 4.');
  });

  it.each([
    ['<html>', '10-K line one line two'],
    ['<BODY>', 'line one line two'],
    ['<p>', '10-K\n\nline one line two'],
    ['<DIV>', '10-K\nline one line two'],
    ['<br>', '10-K\nline one line two'],
    ['<FONT size=2>', '10-K line one line two'],
    ['<tr>', '10-K line one line two'],
    ['<TD>', '10-K line one line two'],
    ['<XML>', '10-K line one line two'],
  ])('a <TEXT> body opening %s reads as HTML', (opener, expected) => {
    const sgml = `<DOCUMENT>\n<TYPE>10-K\n<TEXT>\n${opener}line one\nline two\n</TEXT>\n</DOCUMENT>\n`;
    expect(filingToExtract(sgml)).toBe(expected);
  });
});

describe('filingToExtract — every document of a submission holding an HTML document (#159)', () => {
  const SEC_HEADER =
    '<SEC-DOCUMENT>0000950134-00-009775.txt : 20001115\n<SEC-HEADER>0000950134-00-009775.hdr.sgml : 20001115\nACCESSION NUMBER:\t\t0000950134-00-009775\nCONFORMED SUBMISSION TYPE:\t10-Q\n</SEC-HEADER>\n';
  const doc = (type: string, filename: string, body: string) =>
    `<DOCUMENT>\n<TYPE>${type}\n<FILENAME>${filename}\n<TEXT>\n${body}</TEXT>\n</DOCUMENT>\n`;
  const submission = (...docs: string[]) => `${SEC_HEADER}${docs.join('')}</SEC-DOCUMENT>\n`;

  const HTML_10Q = doc(
    '10-Q',
    'd81726e10-q.htm',
    '<HTML><BODY><P>PART I</P><P>Item 1. Financial Statements</P><P>Revenue rose.</P></BODY></HTML>\n',
  );
  const EX_10 = doc(
    'EX-10.1',
    'd81726ex10-1.txt',
    '<PAGE>   1\n                    EXHIBIT 10.1\n\nFOURTEENTH AMENDMENT TO THE PARTNERSHIP AGREEMENT\n\nThis amendment is made\nas of September 12, 2000.\n',
  );
  const EX_27 = doc(
    'EX-27',
    'art5sept00.frm',
    '<TABLE> <S> <C>\n<ARTICLE> 5\n<CASH> 1,234\n</TABLE>\n',
  );
  const HTML_EX99 = doc(
    'EX-99',
    'd81726ex99.htm',
    '<HTML><BODY><P>EXHIBIT 99</P><P>Press release.</P></BODY></HTML>\n',
  );
  const GRAPHIC = doc(
    'GRAPHIC',
    'logo.jpg',
    'begin 644 logo.jpg\nM_]C_X``02D9)1@`!`@$`2`!(``#_\n`\nend\n',
  );
  // Encoded bytes that spell `<BR`, so the payload passes the HTML test.
  const PDF = doc(
    '10-Q',
    'd81726e10-q_pdf.pdf',
    '<PDF>\nbegin 666 DOC.PDF\nM)5!$1BTQ<BR\\_3#0H\n`\nend\n',
  );

  const HTML_10Q_TEXT = 'PART I\n\nItem 1. Financial Statements\n\nRevenue rose.';
  const EX_10_TEXT =
    '\n\n   1\n                    EXHIBIT 10.1\n\nFOURTEENTH AMENDMENT TO THE PARTNERSHIP AGREEMENT\n\nThis amendment is made\nas of September 12, 2000.\n';

  it('converts each plain exhibit after the HTML document, line for line, in document order', () => {
    const text = filingToExtract(submission(HTML_10Q, EX_10, EX_27));

    expect(text).toBe(`${HTML_10Q_TEXT}\n\n${EX_10_TEXT}\n\n\n  \n 5\n 1,234\n\n`);
    // The SEC header sits outside every document, as it always did for these submissions.
    expect(text).not.toContain('ACCESSION NUMBER');
  });

  it('keeps a plain exhibit between two HTML documents in its place', () => {
    expect(filingToExtract(submission(HTML_10Q, EX_10, HTML_EX99))).toBe(
      `${HTML_10Q_TEXT}\n\n${EX_10_TEXT}\n\nEXHIBIT 99\n\nPress release.`,
    );
  });

  it('keeps an HTML exhibit of bare <P>/<TABLE> fragments, with no <body>, in its place', () => {
    const fragments = doc(
      'EX-10.2',
      'd81726ex10-2.htm',
      '<P>EXHIBIT 10.2</P>\n<TABLE><TR><TD>Monthly rent</TD><TD>$1,000</TD></TR></TABLE>\n',
    );
    expect(filingToExtract(submission(HTML_10Q, fragments, HTML_EX99))).toBe(
      `${HTML_10Q_TEXT}\n\nEXHIBIT 10.2\n\nMonthly rent$1,000\n\nEXHIBIT 99\n\nPress release.`,
    );
  });

  it('keeps an <HTML> exhibit that never opens a <BODY>', () => {
    const noBody = doc(
      'EX-21',
      'd81726ex21.htm',
      '<HTML><P>SUBSIDIARIES OF THE REGISTRANT</P></HTML>\n',
    );
    expect(filingToExtract(submission(HTML_10Q, noBody))).toBe(
      `${HTML_10Q_TEXT}\n\nSUBSIDIARIES OF THE REGISTRANT`,
    );
  });

  // Characterization: the #159 conversion of the same input.
  it('leaves out an XML document with no <body>, by its .xml extension', () => {
    const form4 = doc(
      '4',
      'primary_doc.xml',
      '<XML>\n<ownershipDocument><issuerName>ACME</issuerName></ownershipDocument>\n</XML>\n',
    );
    expect(filingToExtract(submission(HTML_10Q, form4))).toBe(HTML_10Q_TEXT);
  });

  it('leaves out uuencoded payloads, a PDF that reads as HTML included', () => {
    expect(filingToExtract(submission(HTML_10Q, EX_10, PDF, GRAPHIC))).toBe(
      `${HTML_10Q_TEXT}\n\n${EX_10_TEXT}`,
    );
  });

  it('leaves out the machine-readable files of a modern full submission', () => {
    const modern = submission(
      HTML_10Q,
      doc(
        'EX-101.SCH',
        'abc-20260902.xsd',
        '<XBRL>\n<xs:schema>XBRL SCHEMA LABEL</xs:schema>\n</XBRL>\n',
      ),
      doc('XML', 'report.css', '/* Updated 2009-11-04 */\n.report { color: black; }\n'),
      doc('JSON', 'MetaLinks.json', '{\n "version": "2.2"\n}\n'),
      doc('XML', 'FilingSummary.xml', '<XML>\n<FilingSummary>SUMMARY</FilingSummary>\n</XML>\n'),
      EX_10,
    );
    expect(filingToExtract(modern)).toBe(`${HTML_10Q_TEXT}\n\n${EX_10_TEXT}`);
  });

  it("lists the primary document's headings first, so an exhibit cannot crowd them past the cap", () => {
    const text = filingToExtract(submission(HTML_10Q, EX_10));

    expect(detectHeadings(text)).toEqual([
      { heading: 'PART I', offset: 0 },
      { heading: 'Item 1. Financial Statements', offset: 8 },
      {
        heading: 'FOURTEENTH AMENDMENT TO THE PARTNERSHIP AGREEMENT',
        offset: text.indexOf('FOURTEENTH'),
      },
    ]);
    expect(
      detectHeadings(text)
        .slice(0, 2)
        .map((h) => h.heading),
    ).toEqual(['PART I', 'Item 1. Financial Statements']);
  });

  // Characterization: each expected string is the #136 conversion of the same input.
  it('a single HTML document with uuencoded graphics converts as before', () => {
    expect(filingToExtract(submission(HTML_10Q, GRAPHIC))).toBe(HTML_10Q_TEXT);
  });

  it('a submission of HTML documents only converts as before', () => {
    expect(filingToExtract(submission(HTML_10Q, HTML_EX99))).toBe(
      `${HTML_10Q_TEXT}\n\nEXHIBIT 99\n\nPress release.`,
    );
  });

  it('a plain-only submission converts whole, SEC header included, as before', () => {
    const plain = submission(
      doc('10-K', '0001.txt', 'ITEM 1.  BUSINESS\n\nThe company sells computers.\n'),
      doc('EX-21', '0002.txt', 'EXHIBIT 21\n\nSUBSIDIARIES OF THE REGISTRANT\n'),
    );
    expect(filingToExtract(plain)).toBe(
      '0000950134-00-009775.txt : 20001115 0000950134-00-009775.hdr.sgml : 20001115 ACCESSION NUMBER: 0000950134-00-009775 CONFORMED SUBMISSION TYPE: 10-Q 10-K 0001.txt\n\n\nITEM 1.  BUSINESS\n\nThe company sells computers.\n\n\nEX-21 0002.txt\n\n\nEXHIBIT 21\n\nSUBSIDIARIES OF THE REGISTRANT\n',
    );
  });
});

describe('filingToExtract — the XBRL renderer files of a full submission stay out (#160)', () => {
  const doc = (type: string, filename: string, body: string) =>
    `<DOCUMENT>\n<TYPE>${type}\n<SEQUENCE>1\n<FILENAME>${filename}\n<DESCRIPTION>${type}\n<TEXT>\n${body}</TEXT>\n</DOCUMENT>\n`;
  const submission = (...docs: string[]) =>
    `<SEC-DOCUMENT>0001045810-26-000078.txt : 20260902\n<SEC-HEADER>0001045810-26-000078.hdr.sgml : 20260902\nCONFORMED SUBMISSION TYPE:\t8-K\n</SEC-HEADER>\n${docs.join('')}</SEC-DOCUMENT>\n`;

  // An inline-XBRL primary is typed by its form, not XML.
  const PRIMARY = doc(
    '8-K',
    'nvda-20260902.htm',
    '<XBRL>\n<html><body><div>Item 8.01 Other Events</div><div>The company announced a dividend.</div></body></html>\n</XBRL>\n',
  );
  const EX_99 = doc(
    'EX-99.1',
    'q2fy27pr.htm',
    '<html><body><p>NVIDIA Announces Results</p></body></html>\n',
  );
  const FILED_TEXT =
    'Item 8.01 Other Events\nThe company announced a dividend.\n\nNVIDIA Announces Results';

  it('cuts the renderer viewer pages, script, and stylesheet, keeping the filed documents', () => {
    const text = filingToExtract(
      submission(
        PRIMARY,
        EX_99,
        doc(
          'XML',
          'R1.htm',
          '<html><head><title></title></head><body><table><tr><th>Document and Entity Information</th></tr><tr><td>Entity Central Index Key</td><td>0001045810</td></tr></table></body></html>\n',
        ),
        // The renderer script of 2011-era filings writes `<body>` in a string literal.
        doc(
          'XML',
          'Show.js',
          "Show.page = function () { return '<body>' + 'More' + '</body>'; };\n",
        ),
        doc('XML', 'report.css', '.report { color: black; }\n'),
      ),
    );
    expect(text).toBe(FILED_TEXT);
  });

  // Characterization: the #159 conversion of the same input.
  it('a full submission with no renderer files converts as before', () => {
    expect(filingToExtract(submission(PRIMARY, EX_99))).toBe(FILED_TEXT);
  });

  it('keeps a filed document by its type, whatever its file name', () => {
    const renamed = doc(
      'EX-99.1',
      'R1.htm',
      '<html><body><p>NVIDIA Announces Results</p></body></html>\n',
    );
    expect(filingToExtract(submission(PRIMARY, renamed))).toBe(FILED_TEXT);
  });
});

describe('filingToExtract — <TEXT> body scan worst cases stay linear (#136, #159, #160)', () => {
  it.each([
    ['repeated opener, no closer', (n: number) => fill('<TEXT>', n)],
    ['nested openers', (n: number) => `${fill('<TEXT>', n / 2)}x${fill('</TEXT>', n / 2)}`],
    ['overlapping opener prefixes', (n: number) => fill('<TEX<TEXT', n)],
    ['unclosed tag openers in a plain body', (n: number) => `<TEXT>${fill('<a', n)}</TEXT>`],
    ['HTML-signal prefixes in a plain body', (n: number) => `<TEXT>${fill('<pa<bod', n)}</TEXT>`],
    ['dense SGML tags in a plain body', (n: number) => `<TEXT>${fill('<S>x <C>\n', n)}</TEXT>`],
    // With a <body> in the input, each plain body goes in a <body> of its own (#159).
    ['repeated opener, no closer, after a <body>', (n: number) => `<body>${fill('<TEXT>', n)}`],
    [
      'thousands of plain documents after a <body>',
      (n: number) =>
        `<body>${fill('<DOCUMENT>\n<FILENAME>a.txt\n<TEXT>\nx\n</TEXT>\n</DOCUMENT>\n', n)}`,
    ],
    [
      'thousands of machine-readable documents after a <body>',
      (n: number) =>
        `<body>${fill('<DOCUMENT>\n<FILENAME>a.xsd\n<TEXT>\nx\n</TEXT>\n</DOCUMENT>\n', n)}`,
    ],
    [
      'thousands of uuencoded documents after a <body>',
      (n: number) => `<body>${fill('<DOCUMENT>\n<TEXT>\nbegin 644 a.gif\nM\n</TEXT>\n', n)}`,
    ],
    [
      'repeated <FILENAME> openers on one line after a <body>',
      (n: number) => `<body>${fill('<FILENAME>', n)}<TEXT>x</TEXT>`,
    ],
    [
      'a whitespace run before a <PDF> tag after a <body>',
      (n: number) => `<body><TEXT>${' '.repeat(n)}${fill('<PDF> ', n)}</TEXT>`,
    ],
    ['<body> prefixes with no closing >', (n: number) => `${fill('<bod', n)}<TEXT>x</TEXT>`],
    // Renderer files are cut by their <TYPE> (#160).
    [
      'thousands of renderer viewer pages after a <body>',
      (n: number) =>
        `<body>${fill('<DOCUMENT>\n<TYPE>XML\n<TEXT>\n<html><body>x</body></html>\n</TEXT>\n', n)}`,
    ],
    [
      'repeated <TYPE> openers on one line after a <body>',
      (n: number) => `<body>${fill('<TYPE>', n)}<TEXT>x</TEXT>`,
    ],
    [
      'thousands of HTML fragment documents with no <body> after a <body>',
      (n: number) => `<body>${fill('<DOCUMENT>\n<TEXT>\n<P>x</P>\n</TEXT>\n', n)}`,
    ],
    [
      '<body prefixes in an HTML fragment after a <body>',
      (n: number) => `<body><TEXT><P>${fill('<bod', n)}</TEXT>`,
    ],
  ])('%s (5k → 80k)', (_label, build) => {
    // Measured at 1–17 ms for 80k. A lazy `<TEXT>([\s\S]*?)</TEXT>` regex scan
    // takes ~470 ms on the no-closer shape alone, a 230× span ratio.
    expectLinear(filingToExtract, build, 80_000, 200);
  });

  // A long digit run carries the full 64× span; so do the line-break shapes.
  it.each([
    ['a plain body holding a long digit run', (n: number) => `<TEXT>${'1'.repeat(n)}</TEXT>`],
    [
      'a plain body of one long line ending in a break',
      (n: number) => `<TEXT>${fill('§1 x', n)}\ny</TEXT>`,
    ],
    ['a plain body with breaks throughout', (n: number) => `<TEXT>${fill('  \r\n', n)}</TEXT>`],
  ])('%s (5k → 320k)', (_label, build) => {
    expectLinear(filingToExtract, build, 320_000, 200);
  });
});
