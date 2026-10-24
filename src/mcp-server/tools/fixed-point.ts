/**
 * @fileoverview Fixed-point rendering of parsed numeric output without rounding its digits.
 * @module mcp-server/tools/fixed-point
 */

/** Expand a finite number's shortest decimal representation, padding prices to two places. */
export function fixedPoint(value: number, minimumFractionDigits: 0 | 2 = 0): string {
  const sign = value < 0 ? '-' : '';
  let text = String(Math.abs(value));
  const exponentAt = text.indexOf('e');
  if (exponentAt !== -1) {
    const coefficient = text.slice(0, exponentAt);
    const dotAt = coefficient.indexOf('.');
    const digits = coefficient.replace('.', '');
    const point = (dotAt === -1 ? coefficient.length : dotAt) + Number(text.slice(exponentAt + 1));
    text =
      point <= 0
        ? `0.${'0'.repeat(-point)}${digits}`
        : point >= digits.length
          ? digits.padEnd(point, '0')
          : `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  if (minimumFractionDigits > 0) {
    const dotAt = text.indexOf('.');
    text = dotAt === -1 ? `${text}.00` : text.padEnd(dotAt + 1 + minimumFractionDigits, '0');
  }
  return sign + text;
}
