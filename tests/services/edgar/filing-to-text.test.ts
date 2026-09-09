/**
 * @fileoverview Tests for filing-to-text service — HTML to plain text conversion, truncation,
 * windowing, heading detection, and extraction cache.
 * @module tests/services/edgar/filing-to-text
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearExtractCache,
  detectHeadings,
  extractCacheSize,
  filingToExtract,
  filingToText,
  foldForHeadingMatch,
  getExtractCache,
  hasExtractCache,
  setExtractCache,
  windowText,
} from '@/services/edgar/filing-to-text.js';
import { at } from '../../support/assertions.js';

afterEach(() => {
  clearExtractCache();
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
  it('hasExtractCache returns false before any set', () => {
    expect(hasExtractCache('no-such-key')).toBe(false);
  });

  it('hasExtractCache returns true after setExtractCache', () => {
    setExtractCache('k1', 'value1');
    expect(hasExtractCache('k1')).toBe(true);
  });

  it('getExtractCache returns undefined for missing key', () => {
    expect(getExtractCache('missing')).toBeUndefined();
  });

  it('getExtractCache returns value after setExtractCache', () => {
    setExtractCache('k2', 'value2');
    expect(getExtractCache('k2')).toBe('value2');
  });

  it('getExtractCache returns same value on repeated calls (LRU refresh, not eviction)', () => {
    setExtractCache('k3', 'value3');
    expect(getExtractCache('k3')).toBe('value3');
    expect(getExtractCache('k3')).toBe('value3');
  });
});

describe('LRU eviction', () => {
  it('evicts the oldest entry when capacity (8) is exceeded', () => {
    // Fill to capacity
    for (let i = 0; i < 8; i++) {
      setExtractCache(`lru-key-${i}`, `value-${i}`);
    }
    expect(extractCacheSize()).toBe(8);
    expect(hasExtractCache('lru-key-0')).toBe(true);

    // Add a 9th entry — lru-key-0 is oldest and should be evicted
    setExtractCache('lru-key-8', 'value-8');
    expect(extractCacheSize()).toBe(8);
    expect(hasExtractCache('lru-key-0')).toBe(false);
    expect(hasExtractCache('lru-key-8')).toBe(true);
  });

  it('accessing an entry refreshes it (moves it to MRU position)', () => {
    for (let i = 0; i < 8; i++) {
      setExtractCache(`refresh-key-${i}`, `value-${i}`);
    }
    // Access key-0 to move it to MRU
    getExtractCache('refresh-key-0');

    // Adding a 9th should evict key-1 (now oldest), not key-0
    setExtractCache('refresh-key-8', 'new-value');
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

  it('caps output at maxEntries', () => {
    // Create 60 distinct all-caps headings
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(`SECTION ${String.fromCharCode(65 + (i % 26))} PART ${i}`);
    }
    const text = lines.join('\n\n');
    const headings = detectHeadings(text, 50);
    expect(headings.length).toBeLessThanOrEqual(50);
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
    const notes = detectHeadings(text, 200).filter((h) => h.heading === NOTES);
    expect(notes).toHaveLength(1);
    expect(at(notes, 0).offset).toBe(text.indexOf(NOTES));
  });

  it('drops every occurrence of a repeated bare Part marker, keeping none', () => {
    // A bare marker carries no navigable text, so its first occurrence is worth
    // no more than the rest — unlike a repeated heading with a title.
    const text = `TABLE OF CONTENTS\n\nPART I\n\nPage body.\n\n`.repeat(6);
    const headings = detectHeadings(text, 200);
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
    const texts = detectHeadings(text, 200).map((h) => h.heading);
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
