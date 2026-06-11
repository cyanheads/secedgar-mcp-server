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
  getExtractCache,
  hasExtractCache,
  setExtractCache,
  windowText,
} from '@/services/edgar/filing-to-text.js';

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
    expect(rf[0].offset).toBe(laterIndex);
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
});
