/**
 * @fileoverview Tests for filing-to-text service — HTML to plain text conversion and truncation.
 * @module tests/services/edgar/filing-to-text
 */

import { describe, expect, it } from 'vitest';
import { filingToText } from '@/services/edgar/filing-to-text.js';

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
