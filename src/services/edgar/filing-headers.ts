/**
 * @fileoverview Parser for SEC filing `<accession>-index-headers.html`. Each
 * filing archive ships an HTML page that re-encodes the original SGML submission
 * header inside a `<PRE>` block. The header lists every document with its
 * canonical SEC TYPE (e.g. "10-K", "EX-21.1", "EX-101.INS", "GRAPHIC") — data
 * the directory listing at `index.json` does not provide (it returns icon hints
 * like "text.gif").
 * @module services/edgar/filing-headers
 */

export interface FilingDocumentHeader {
  description?: string | undefined;
  sequence?: string | undefined;
  type?: string | undefined;
}

const TAGS = ['TYPE', 'SEQUENCE', 'FILENAME', 'DESCRIPTION'] as const;

/**
 * Parse `index-headers.html` into a `filename → header metadata` map.
 * Each `<DOCUMENT>` block is HTML-encoded inside `<PRE>` (`&lt;DOCUMENT&gt;…&lt;/DOCUMENT&gt;`).
 */
export function parseFilingHeaders(text: string): Map<string, FilingDocumentHeader> {
  const map = new Map<string, FilingDocumentHeader>();
  for (const match of text.matchAll(/&lt;DOCUMENT&gt;([\s\S]*?)&lt;\/DOCUMENT&gt;/g)) {
    const block = match[1] ?? '';
    const fields: Partial<Record<(typeof TAGS)[number], string>> = {};
    for (const tag of TAGS) {
      const m = block.match(new RegExp(`&lt;${tag}&gt;\\s*([^\\r\\n]+)`));
      if (m?.[1]) fields[tag] = m[1].trim();
    }
    if (fields.FILENAME) {
      map.set(fields.FILENAME, {
        type: fields.TYPE,
        sequence: fields.SEQUENCE,
        description: fields.DESCRIPTION,
      });
    }
  }
  return map;
}
