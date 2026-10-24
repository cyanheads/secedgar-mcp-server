/**
 * @fileoverview Numeric text preserves the shortest decimal digits without exponent notation.
 * @module tests/mcp-server/tools/fixed-point
 */

import { describe, expect, it } from 'vitest';
import { fixedPoint } from '@/mcp-server/tools/fixed-point.js';

describe('fixedPoint', () => {
  it.each([
    [0.000049236691, '0.000049236691'],
    [0.000000123456, '0.000000123456'],
    [-0.000000123456, '-0.000000123456'],
    [0.30000000000000004, '0.30000000000000004'],
    [222.1932, '222.1932'],
    [342, '342'],
    [0, '0'],
    [1e21, '1000000000000000000000'],
    [1.234e21, '1234000000000000000000'],
    [Number.MIN_VALUE, `0.${'0'.repeat(323)}5`],
    [Number.MAX_VALUE, `17976931348623157${'0'.repeat(292)}`],
  ])('renders %s as fixed decimal digits', (value, expected) => {
    expect(fixedPoint(value)).toBe(expected);
  });

  it.each([
    [222.1932, '222.1932'],
    [342, '342.00'],
    [175.5, '175.50'],
    [0, '0.00'],
    [-0.0000001, '-0.0000001'],
    [1e21, '1000000000000000000000.00'],
  ])('pads price %s without rounding', (value, expected) => {
    expect(fixedPoint(value, 2)).toBe(expected);
  });
});
