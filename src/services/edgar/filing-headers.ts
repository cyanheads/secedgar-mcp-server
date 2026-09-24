/**
 * @fileoverview Parsers for a filing's SEC submission header. Each filing archive
 * ships `<accession>-index-headers.html`, which carries the original SGML header
 * twice: raw inside an HTML comment, and HTML-encoded inside a `<PRE>` block together
 * with one `<DOCUMENT>` block per file. The document blocks give every file its
 * canonical SEC TYPE (e.g. "10-K", "EX-21.1", "EX-101.INS", "GRAPHIC") — data the
 * directory listing at `index.json` does not provide (it returns icon hints like
 * "text.gif"). The raw header gives the submission's own form, filing date, and
 * period of report, which a filing outside the submissions feed's recent window has
 * nowhere else in reach. A filing whose index-headers page is missing still carries
 * the bare header as `<accession>.hdr.sgml`, which `parseSubmissionHeader` reads.
 * @module services/edgar/filing-headers
 */

export interface FilingDocumentHeader {
  description?: string | undefined;
  sequence?: string | undefined;
  type?: string | undefined;
}

/** Submission-level fields of the SEC header. Each is absent when the header omits it. */
export interface SubmissionHeader {
  /** `<FILING-DATE>` as YYYY-MM-DD — the filing date, not the acceptance timestamp. */
  filingDate?: string;
  /** `<TYPE>` — the submission's form type. */
  form?: string;
  /** `<PERIOD>` as YYYY-MM-DD — absent on forms with no period of report. */
  periodOfReport?: string;
}

/** Everything `index-headers.html` yields. */
export interface FilingHeaders {
  documents: Map<string, FilingDocumentHeader>;
  submission: SubmissionHeader;
}

const TAGS = ['TYPE', 'SEQUENCE', 'FILENAME', 'DESCRIPTION'] as const;

/**
 * Parse `index-headers.html` into the `filename → document header` map and the
 * submission-level header. Each `<DOCUMENT>` block is HTML-encoded inside `<PRE>`
 * (`&lt;DOCUMENT&gt;…&lt;/DOCUMENT&gt;`); the submission fields come from the raw
 * header in the page's comment block.
 */
export function parseFilingHeaders(text: string): FilingHeaders {
  const documents = new Map<string, FilingDocumentHeader>();
  for (const match of text.matchAll(/&lt;DOCUMENT&gt;([\s\S]*?)&lt;\/DOCUMENT&gt;/g)) {
    const block = match[1] ?? '';
    const fields: Partial<Record<(typeof TAGS)[number], string>> = {};
    for (const tag of TAGS) {
      const m = block.match(new RegExp(`&lt;${tag}&gt;\\s*([^\\r\\n]+)`));
      if (m?.[1]) fields[tag] = m[1].trim();
    }
    if (fields.FILENAME) {
      documents.set(fields.FILENAME, {
        type: fields.TYPE,
        sequence: fields.SEQUENCE,
        description: fields.DESCRIPTION,
      });
    }
  }
  return { documents, submission: parseSubmissionHeader(text) };
}

/**
 * Read `<TYPE>`, `<FILING-DATE>`, and `<PERIOD>` from a raw SGML submission header —
 * a `.hdr.sgml` file, or the raw copy inside `index-headers.html`. Only line-leading
 * raw tags before the first `</SEC-HEADER>` count, so the HTML-encoded copy and any
 * per-document `<TYPE>` after the header are never read. A date not in the header's
 * YYYYMMDD form is dropped rather than passed through.
 */
export function parseSubmissionHeader(text: string): SubmissionHeader {
  const end = text.indexOf('</SEC-HEADER>');
  const header = end === -1 ? text : text.slice(0, end);
  const tag = (name: string) =>
    header.match(new RegExp(`^<${name}>([^\\r\\n<]+)`, 'm'))?.[1]?.trim() || undefined;
  const isoDate = (value: string | undefined) =>
    value && /^\d{8}$/.test(value)
      ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`
      : undefined;

  const form = tag('TYPE');
  const filingDate = isoDate(tag('FILING-DATE'));
  const periodOfReport = isoDate(tag('PERIOD'));
  return {
    ...(form && { form }),
    ...(filingDate && { filingDate }),
    ...(periodOfReport && { periodOfReport }),
  };
}
