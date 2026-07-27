/**
 * @fileoverview Tests for the 8-K item-code decode tables — regime selection by
 * code shape, table coverage, and the submissions `items` field parser.
 * @module tests/services/edgar/eight-k-items
 */

import { describe, expect, it } from 'vitest';
import {
  CURRENT_EIGHT_K_ITEMS,
  decodeEightKItem,
  EIGHT_K_ITEM_CODES,
  LEGACY_EIGHT_K_ITEMS,
  parseEightKItems,
} from '@/services/edgar/eight-k-items.js';

describe('decodeEightKItem', () => {
  it('decodes a dotted code against the current regime', () => {
    expect(decodeEightKItem('2.02')).toEqual({
      code: '2.02',
      label: 'Results of Operations and Financial Condition',
      regime: 'current',
    });
  });

  it('decodes a bare integer against the legacy regime', () => {
    expect(decodeEightKItem('12')).toEqual({
      code: '12',
      label: 'Results of Operations and Financial Condition',
      regime: 'legacy',
    });
  });

  // The two regimes reuse the same integers for unrelated events, so shape — not
  // the filing date — has to pick the table. Decoding "5" against the current
  // regime, or "5.02" against the legacy one, would silently mislabel the event.
  it('keeps the regimes disjoint: 5 is Other Events, 5.02 is officer departures', () => {
    expect(decodeEightKItem('5')).toMatchObject({ label: 'Other Events', regime: 'legacy' });
    expect(decodeEightKItem('5.02')).toMatchObject({
      label:
        'Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers; Compensatory Arrangements of Certain Officers',
      regime: 'current',
    });
  });

  it('reports a shaped-but-undefined code without inventing a label', () => {
    const decoded = decodeEightKItem('9.99');
    expect(decoded.regime).toBe('current');
    expect(decoded.label).toBeUndefined();
  });

  it('reports an unrecognized shape with neither label nor regime', () => {
    expect(decodeEightKItem('2.02.1')).toEqual({ code: '2.02.1' });
  });

  it('decodes every code in the input enum', () => {
    for (const code of EIGHT_K_ITEM_CODES) {
      const decoded = decodeEightKItem(code);
      expect(decoded.label, `code ${code} has no label`).toBeTruthy();
      expect(decoded.regime, `code ${code} has no regime`).toBeTruthy();
    }
  });

  it('exposes both regimes in the enum with no overlap', () => {
    expect(EIGHT_K_ITEM_CODES).toHaveLength(
      Object.keys(CURRENT_EIGHT_K_ITEMS).length + Object.keys(LEGACY_EIGHT_K_ITEMS).length,
    );
    expect(new Set(EIGHT_K_ITEM_CODES).size).toBe(EIGHT_K_ITEM_CODES.length);
  });
});

describe('parseEightKItems', () => {
  it('splits the comma-separated submissions field', () => {
    expect(parseEightKItems('2.02,9.01')).toEqual(['2.02', '9.01']);
  });

  it('trims whitespace and drops empty segments', () => {
    expect(parseEightKItems('5, 7,')).toEqual(['5', '7']);
  });

  it('returns no codes for an absent or blank field', () => {
    expect(parseEightKItems(undefined)).toEqual([]);
    expect(parseEightKItems('')).toEqual([]);
  });
});
