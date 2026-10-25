/**
 * @fileoverview Reads `content[]` Markdown back through a real CommonMark
 *   parser (`markdown-it`), so a test asserts the text a client renders rather
 *   than the escape bytes the framework writes into error and trailer lines.
 * @module tests/support/commonmark
 */

import MarkdownIt, { type Token } from 'markdown-it';

// `default` is CommonMark plus the GFM table and strikethrough rules; raw HTML on, as a chat client parses it.
const parser = new MarkdownIt('default', { html: true });

/** A token's attributes as ` name="value"` pairs, so a link's href or an image's src stays in the text. */
function readAttrs(token: Token): string {
  return (token.attrs ?? []).map(([name, value]) => ` ${name}="${value}"`).join('');
}

function readInline(children: Token[]): string {
  let out = '';
  for (const token of children) {
    if (token.type === 'text' || token.type === 'text_special') out += token.content;
    else if (token.type === 'softbreak' || token.type === 'hardbreak') out += '\n';
    else if (token.nesting === 1) out += `⟨${token.tag}${readAttrs(token)}⟩`;
    else if (token.nesting === -1) out += `⟨/${token.tag}⟩`;
    else out += `⟨${token.type}:${token.content}${readAttrs(token)}⟩`;
  }
  return out;
}

/**
 * The text a CommonMark parse of `markdown` reads as: each paragraph's text
 * (line breaks as `\n`), joined by a blank line, with every node that is not
 * plain text named in place — `⟨strong⟩…⟨/strong⟩`, `⟨code_inline:x⟩`,
 * `⟨a href="…"⟩`, `⟨bullet_list_open⟩`, `⟨fence:…⟩` — so an expectation written
 * as plain text fails on any live syntax. Nothing the source holds is dropped:
 * a code block's or raw HTML block's text, and a link's or image's URL, stay in
 * the output, so an absence assertion cannot pass on text the parse hid.
 */
export function readCommonMark(markdown: string): string {
  const parts: string[] = [];
  for (const token of parser.parse(markdown, {})) {
    if (token.type === 'inline') parts.push(readInline(token.children ?? []));
    else if (token.type !== 'paragraph_open' && token.type !== 'paragraph_close') {
      parts.push(`⟨${token.type}${token.content ? `:${token.content}` : ''}⟩`);
    }
  }
  return parts.join('\n\n');
}
