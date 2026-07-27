/**
 * @fileoverview Tests for the shared XML node helpers — prefix-insensitive tag matching,
 * blank-vs-absent handling, attribute reads, and the two value coercions.
 * @module tests/services/edgar/xml-nodes
 */

import type { Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { describe, expect, it } from 'vitest';
import {
  childAttr,
  childText,
  childTexts,
  findTag,
  findTags,
  parseNumber,
  toIsoDate,
} from '@/services/edgar/xml-nodes.js';

function doc(xml: string) {
  return parseDocument(xml, { xmlMode: true, decodeEntities: true }).children;
}

function root(xml: string): Element {
  const el = findTag(doc(xml), 'root');
  if (!el) throw new Error('fixture has no <root>');
  return el;
}

describe('findTag / findTags', () => {
  it('matches a tag written under a namespace prefix', () => {
    const el = findTag(
      doc('<ns1:infoTable><ns1:cusip>037833100</ns1:cusip></ns1:infoTable>'),
      'infotable',
    );
    expect(el?.name).toBe('ns1:infoTable');
  });

  it('matches regardless of the case the filer used', () => {
    expect(findTag(doc('<INFOTABLE/>'), 'infoTable')).toBeDefined();
  });

  it('returns undefined rather than null when the tag is absent', () => {
    expect(findTag(doc('<a/>'), 'b')).toBeUndefined();
  });

  it('collects every match in document order', () => {
    const els = findTags(doc('<r><x>1</x><y><x>2</x></y><x>3</x></r>'), 'x');
    expect(els.map((e) => e.children[0]?.type === 'text' && e.children[0].data)).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('stops at the given nodes when recursion is disabled', () => {
    const parsed = doc('<r><y><x/></y></r>');
    const r = findTag(parsed, 'r');
    expect(findTag(r?.children ?? [], 'x', false)).toBeUndefined();
    expect(findTag(r?.children ?? [], 'x', true)).toBeDefined();
  });
});

describe('childText / childTexts', () => {
  it('trims surrounding whitespace', () => {
    expect(childText(root('<root><v>\n  hello \n</v></root>'), 'v')).toBe('hello');
  });

  it('treats a whitespace-only element as absent, not as an empty string', () => {
    expect(childText(root('<root><v>   </v></root>'), 'v')).toBeUndefined();
  });

  it('decodes entities the filer escaped', () => {
    expect(childText(root('<root><v>S&amp;P 500</v></root>'), 'v')).toBe('S&P 500');
  });

  it('skips blank entries when collecting repeated values', () => {
    expect(childTexts(root('<root><c>A</c><c> </c><c>B</c></root>'), 'c')).toEqual(['A', 'B']);
  });
});

describe('childAttr', () => {
  it('reads an attribute off the first matching descendant', () => {
    expect(
      childAttr(
        root('<root><identifiers><isin value="US0378331005"/></identifiers></root>'),
        'isin',
        'value',
      ),
    ).toBe('US0378331005');
  });

  it('returns undefined when the attribute is empty', () => {
    expect(childAttr(root('<root><isin value=""/></root>'), 'isin', 'value')).toBeUndefined();
  });
});

describe('parseNumber', () => {
  it('tolerates thousands separators', () => {
    expect(parseNumber('1,234,567.89')).toBe(1234567.89);
  });

  it('keeps a negative value rather than dropping the sign', () => {
    expect(parseNumber('-42.5')).toBe(-42.5);
  });

  it('rejects a non-numeric string instead of returning NaN', () => {
    expect(parseNumber('N/A')).toBeUndefined();
    expect(parseNumber(undefined)).toBeUndefined();
  });

  it('reads a zero as a value, not as absent', () => {
    expect(parseNumber('0')).toBe(0);
  });
});

describe('toIsoDate', () => {
  it('normalizes the MM/DD/YYYY cover-page format', () => {
    expect(toIsoDate('03/13/2026')).toBe('2026-03-13');
  });

  it('passes an already-ISO date through', () => {
    expect(toIsoDate('2026-03-13')).toBe('2026-03-13');
  });

  it('rejects a format it cannot place rather than guessing', () => {
    expect(toIsoDate('13/03/26')).toBeUndefined();
    expect(toIsoDate('March 13, 2026')).toBeUndefined();
    expect(toIsoDate(undefined)).toBeUndefined();
  });
});
