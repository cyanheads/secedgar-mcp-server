/**
 * @fileoverview Text a `format()` did not author — SEC strings, caller input, SQL results —
 * escaped for `content[]` so a CommonMark parse reads it back as the `structuredContent`
 * value, in time linear in its length (mcp-ts-core#809).
 * @module mcp-server/tools/escape-inline
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/**
 * A run of 32 or more whitespace characters inside one line: every Unicode whitespace
 * character but U+000B, which `escapeMarkdownInline` keeps literal, and CR and LF, on which
 * it splits lines. 32 is a tuning constant; text without such a run is escaped whole.
 */
const LONG_WHITESPACE_RUN = /[^\S\v\r\n]{32,}/gu;

/**
 * `escapeMarkdownInline` (`@cyanheads/mcp-ts-core/utils`), linear in the length of `text`
 * (mcp-ts-core#809), reading back in the same slots: a paragraph, after a label, an ATX
 * heading, a list item, a block quote, or a GFM table cell. Text holding no run of 32 or more
 * whitespace characters within a line comes back byte for byte as `escapeMarkdownInline`
 * returns it.
 *
 * Otherwise `text` is cut just after each such run and every piece is escaped on its own,
 * which never changes what a parse reads back:
 * - Each piece but the last ends on its run, which the framework writes as numeric
 *   references (`&#32;`, `&#160;`), as it does a line's trailing whitespace; they read back
 *   as the same characters. U+000B stays outside the run, since its reference reads back as
 *   U+FFFD.
 * - The next piece opens on a character outside the run class. A block marker there (`#`,
 *   `>`, `-`, `1.`) gains a backslash and reads back as itself; the reference before it
 *   already keeps it from opening a block. A `#` run opening that piece keeps its last `#`
 *   unescaped, which is safe for the same reason: after the reference's `;` it cannot be an
 *   ATX closing sequence.
 * - The escapes that read a neighbour — `\`, `_`, `<`, and `&` — find whitespace across the
 *   cut in the whole text and nothing in the piece, and treat both alike.
 * - CR and LF stay outside the run, so a cut never splits CRLF, and a piece opening on a line
 *   break renders it as the whole text does: a hard break, or `&#10;` for a final one. Text
 *   whose every such run ends its line therefore comes back byte for byte.
 *
 * Remove this helper and call `escapeMarkdownInline` directly once the framework's escaper is
 * linear in its input.
 */
export function escapeInline(text: string): string {
  let escaped = '';
  let start = 0;
  for (const run of text.matchAll(LONG_WHITESPACE_RUN)) {
    const end = run.index + run[0].length;
    escaped += escapeMarkdownInline(text.slice(start, end));
    start = end;
  }
  return escaped + escapeMarkdownInline(text.slice(start));
}
