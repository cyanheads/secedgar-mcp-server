/**
 * @fileoverview A caller's `forms` filter reads as the form types it names: trimmed,
 * uppercased, blanks dropped, and no filter at all when nothing is left (#194).
 * @module tests/mcp-server/tools/form-filter
 */

import { describe, expect, it } from 'vitest';
import { normalizeFormFilter } from '@/mcp-server/tools/form-filter.js';

describe('normalizeFormFilter', () => {
  it.each([
    ['absent', undefined],
    ['an empty list', []],
    ['one empty element', ['']],
    ['one whitespace-only element', ['   ']],
    ['tabs and line breaks', ['\t', '\r\n', ' \n ']],
    ['several blanks', ['', '  ', '']],
  ])('reads %s as no filter', (_, forms) => {
    expect(normalizeFormFilter(forms)).toBeUndefined();
  });

  it.each([
    [['10-K'], ['10-K']],
    [[' 10-K '], ['10-K']],
    [['\t10-q\n'], ['10-Q']],
    [['10-k'], ['10-K']],
    [['10-k/a'], ['10-K/A']],
    [['', '10-K'], ['10-K']],
    [
      ['8-K', '  ', ' def 14a'],
      ['8-K', 'DEF 14A'],
    ],
    [
      ['sc 13d', 'SCHEDULE 13G'],
      ['SC 13D', 'SCHEDULE 13G'],
    ],
    [
      ['10-K', '10-k'],
      ['10-K', '10-K'],
    ],
  ])('reads %j as %j', (forms, expected) => {
    expect(normalizeFormFilter(forms)).toEqual(expected);
  });

  it('keeps every non-blank element, in order', () => {
    const forms = ['s-1', ' ', 'N-PORT', '4', '', '13F-HR'];
    expect(normalizeFormFilter(forms)).toEqual(['S-1', 'N-PORT', '4', '13F-HR']);
  });

  it('leaves the caller’s list untouched', () => {
    const forms = [' 10-k ', ''];
    normalizeFormFilter(forms);
    expect(forms).toEqual([' 10-k ', '']);
  });
});
