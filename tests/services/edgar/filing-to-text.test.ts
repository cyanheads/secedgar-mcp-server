/**
 * @fileoverview Tests for filing-to-text service — HTML to plain text conversion, truncation,
 * windowing, heading detection, and extraction cache.
 * @module tests/services/edgar/filing-to-text
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFilingTool } from '@/mcp-server/tools/definitions/get-filing.tool.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
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

// Only the service singleton is mocked, for the one `get_filing` round trip
// below; every conversion and heading test runs the real module.
vi.mock('@/services/edgar/edgar-api-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/edgar/edgar-api-service.js')>()),
  getEdgarApiService: vi.fn(),
}));

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
      'the line before ends on a lowercase word',
      'For liquidity, see\nItem 7 "Liquidity and Capital Resources."\n',
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

describe('detectHeadings — heading scans stay linear on long lines (#136)', () => {
  const cpuMs = (text: string): number => {
    const start = process.threadCpuUsage();
    detectHeadings(text);
    const used = process.threadCpuUsage(start);
    return (used.user + used.system) / 1000;
  };
  const bestOf3 = (text: string) => Math.min(cpuMs(text), cpuMs(text), cpuMs(text));
  const fill = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length));

  it.each([
    ['wrapped Item lines under prose lines', (n: number) => fill('see\nItem 1 Business\n', n)],
    [
      'one long prose line before an Item line',
      (n: number) => `${'a'.repeat(n)}\nItem 1 Business\n`,
    ],
    ['an Item marker before a long whitespace run', (n: number) => `Item 1${' '.repeat(n)}X\n`],
    // The page-number strip and the all-caps arm each went quadratic on these.
    ['an all-caps line with a long whitespace run', (n: number) => `ABCDEFGHIJ${' '.repeat(n)}X\n`],
    [
      'an all-caps start, a long whitespace run, then lowercase',
      (n: number) => `ABCDEFGHIJ${' '.repeat(n)}x\n`,
    ],
  ])('%s', (_label, build) => {
    detectHeadings(build(5_000)); // warm the JIT
    const t5k = Math.max(bestOf3(build(5_000)), 0.25);
    bestOf3(build(20_000));
    const t80k = bestOf3(build(80_000));

    expect(t80k / t5k).toBeLessThan(64);
    expect(t80k).toBeLessThan(200);
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
    expect(detectHeadings(text, 2).map((h) => h.heading)).toEqual([
      'PART I',
      'Item 1. Financial Statements',
    ]);
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
  /** Thread CPU milliseconds for one conversion — wall clock is noise under a parallel suite. */
  const cpuMs = (input: string): number => {
    const start = process.threadCpuUsage();
    filingToExtract(input);
    const used = process.threadCpuUsage(start);
    return (used.user + used.system) / 1000;
  };
  /** Best of three, so one scheduler hiccup cannot fail the ratio. */
  const bestOf3 = (input: string) => Math.min(cpuMs(input), cpuMs(input), cpuMs(input));
  const fill = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length));

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
  ])('%s', (_label, build) => {
    filingToExtract(build(5_000)); // warm the JIT
    // Floored so a sub-millisecond baseline cannot inflate the ratio on noise.
    const t5k = Math.max(bestOf3(build(5_000)), 0.25);
    bestOf3(build(20_000));
    const t80k = bestOf3(build(80_000));

    // Measured at 1–17 ms for 80k. A lazy `<TEXT>([\s\S]*?)</TEXT>` regex scan
    // takes ~470 ms on the no-closer shape alone, a 230× span ratio.
    expect(t80k / t5k).toBeLessThan(64);
    expect(t80k).toBeLessThan(200);
  });
});
