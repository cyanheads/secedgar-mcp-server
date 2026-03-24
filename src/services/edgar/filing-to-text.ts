/**
 * @fileoverview Convert SEC filing HTML to readable plain text.
 * @module services/edgar/filing-to-text
 */

import type { HtmlToTextOptions } from 'html-to-text';
import { convert } from 'html-to-text';

const CONVERT_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'table', options: { uppercaseHeaderCells: false } },
  ],
};

/** Convert filing HTML to plain text, optionally truncating to a character limit. */
export function filingToText(
  html: string,
  limit?: number,
): { text: string; truncated: boolean; totalLength: number } {
  const full = convert(html, CONVERT_OPTIONS);
  const totalLength = full.length;

  if (!limit || totalLength <= limit) {
    return { text: full, truncated: false, totalLength };
  }

  // Truncate at a word boundary
  let end = limit;
  while (end > 0 && full[end] !== ' ' && full[end] !== '\n') {
    end--;
  }
  if (end === 0) end = limit;

  return { text: full.slice(0, end), truncated: true, totalLength };
}
