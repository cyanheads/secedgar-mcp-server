/**
 * @fileoverview USD amounts scale by their own magnitude so a non-zero amount never reads as
 * zero, sign before the `$`; per-share and exact amounts and other quantities keep every digit.
 * @module tests/mcp-server/tools/format-usd
 */

import { describe, expect, it } from 'vitest';
import { formatUsd, groupedDigits } from '@/mcp-server/tools/format-usd.js';

describe('formatUsd', () => {
  it.each([
    [0, '$0.00'],
    [-0, '$0.00'],
    [0.004, '$0.004'],
    [7, '$7.00'],
    [999.99, '$999.99'],
    [1000, '$1.00K'],
    [19500, '$19.50K'],
    [42538, '$42.54K'],
    [1_000_000, '$1.00M'],
    [10_878_242, '$10.88M'],
    [1_000_000_000, '$1.00B'],
    [383_285_000_000, '$383.29B'],
    [1_000_000_000_000, '$1.00T'],
    [1_200_000_000_000, '$1.20T'],
    [-0.5, '-$0.50'],
    [-375_000, '-$375.00K'],
    [-2_500_000_000, '-$2.50B'],
  ])('scales %s by its magnitude', (value, expected) => {
    expect(formatUsd(value)).toBe(expected);
  });

  it.each([
    [999_994, '$999.99K'],
    [999_999, '$1.00M'],
    [-999_999, '-$1.00M'],
    [999_999_999, '$1.00B'],
    [999_999_999_999.999, '$1.00T'],
    [999.999, '$999.999'],
  ])(
    'carries %s to the next scale only when rounding reaches 1000 of its own',
    (value, expected) => {
      expect(formatUsd(value)).toBe(expected);
    },
  );

  it.each([
    [6.13, '$6.13'],
    [6.1, '$6.10'],
    [0.004, '$0.004'],
    [0, '$0.00'],
    [-1.5, '-$1.50'],
    [56_000, '$56000.00'],
  ])('renders per-share %s to every digit, never scaled', (value, expected) => {
    expect(formatUsd(value, 'per-share')).toBe(expected);
  });

  it.each([
    [375_000, '$375,000'],
    [-375_000, '-$375,000'],
    [26_450_346_837.19, '$26,450,346,837.19'],
    [0.0004, '$0.0004'],
    [999, '$999'],
  ])('renders %s exactly, grouped', (value, expected) => {
    expect(formatUsd(value, 'exact')).toBe(expected);
  });
});

describe('groupedDigits', () => {
  it.each([
    [0, '0'],
    [123, '123'],
    [1234, '1,234'],
    [15_550_061_000, '15,550,061,000'],
    [0.0004, '0.0004'],
    [1234.5678, '1,234.5678'],
    [-0.5, '-0.5'],
    [-1_234_567.0004, '-1,234,567.0004'],
    [0.30000000000000004, '0.30000000000000004'],
    [1e21, '1,000,000,000,000,000,000,000'],
  ])('keeps every digit of %s, its integer part grouped', (value, expected) => {
    expect(groupedDigits(value)).toBe(expected);
  });
});
