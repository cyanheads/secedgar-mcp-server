/**
 * @fileoverview USD amounts and other reported quantities as `content[]` text: a USD amount
 * scaled by its own magnitude so a non-zero amount never reads as zero, a per-share amount and
 * an exact amount to every digit, the sign before the `$`.
 * @module mcp-server/tools/format-usd
 */

import { fixedPoint } from '@/mcp-server/tools/fixed-point.js';

/** Each scale's divisor and suffix, largest first. */
const SCALES = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
] as const;

/**
 * A number's every digit (`fixedPoint`), its integer part grouped in threes:
 * `-1234567.0004` → `-1,234,567.0004`, `0.0004` → `0.0004`.
 */
export function groupedDigits(value: number): string {
  const digits = fixedPoint(Math.abs(value));
  const dotAt = digits.indexOf('.');
  const whole = BigInt(dotAt === -1 ? digits : digits.slice(0, dotAt)).toLocaleString('en-US');
  return `${value < 0 ? '-' : ''}${whole}${dotAt === -1 ? '' : digits.slice(dotAt)}`;
}

/**
 * A USD amount, its sign before the `$`.
 * - `scaled` (default): T, B, M, or K chosen by absolute value, two decimals (`42538` →
 *   `$42.54K`, `-2.5e9` → `-$2.50B`); under $1K every digit with at least two decimals
 *   (`0.004` → `$0.004`, `0` → `$0.00`).
 * - `per-share`: never scaled, every digit with at least two decimals (`6.1` → `$6.10`).
 * - `exact`: every digit, integer part grouped (`-375000` → `-$375,000`) — the exact amount
 *   printed beside a scaled one.
 */
export function formatUsd(
  value: number,
  style: 'scaled' | 'per-share' | 'exact' = 'scaled',
): string {
  const sign = value < 0 ? '-' : '';
  const magnitude = Math.abs(value);
  if (style === 'exact') return `${sign}$${groupedDigits(magnitude)}`;
  if (style === 'scaled') {
    let above: string | undefined;
    for (const [divisor, suffix] of SCALES) {
      if (magnitude >= divisor) {
        const figure = (magnitude / divisor).toFixed(2);
        // Two-decimal rounding can carry a figure to 1000 of its scale (999999 → 1000.00K),
        // which the scale above reads as 1.00. T has no scale above and keeps its thousands.
        return `${sign}$${figure === '1000.00' && above ? `1.00${above}` : `${figure}${suffix}`}`;
      }
      above = suffix;
    }
  }
  return `${sign}$${fixedPoint(magnitude, 2)}`;
}
