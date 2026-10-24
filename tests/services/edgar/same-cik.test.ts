/**
 * @fileoverview Zero-padding-independent CIK comparison.
 * @module tests/services/edgar/same-cik
 */
import { describe, expect, it } from 'vitest';
import { sameCik } from '@/services/edgar/same-cik.js';

describe('sameCik', () => {
  it.each([
    ['0000320193', '320193', true],
    ['320193', '0000320193', true],
    ['0000320193', '0000320193', true],
    ['0000320193', '0000920760', false],
  ])('compares %s and %s', (a, b, expected) => {
    expect(sameCik(a, b)).toBe(expected);
  });
});
