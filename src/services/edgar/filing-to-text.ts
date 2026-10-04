/**
 * @fileoverview Convert SEC filing HTML to readable plain text, with extraction caching and
 * offset/section windowing support.
 * @module services/edgar/filing-to-text
 */

import type { HtmlToTextOptions } from 'html-to-text';
import { convert } from 'html-to-text';

/**
 * html-to-text walks the DOM recursively, so markup nested deeply enough overflows
 * the stack (#118). `maxDepth` stops the walk and prints `ellipsis` in place of
 * what lies below. The bound has to hold on both runtimes this server ships under:
 * a fresh Node process overflows at about 1,360 levels of nested lists (its most
 * stack-hungry shape) and Bun near 13,000, so 512 leaves Node over 2.5× headroom
 * while sitting far above real filings — HTML documents measure under 25 levels,
 * and a legacy text document under 100 once its `<PAGE>` markers are neutralized
 * (see {@link neutralizePageMarkers}). `limits` deep-merges with the library's
 * defaults, so its 16,777,216-character `maxInputLength` still applies.
 */
const CONVERT_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'table', options: { uppercaseHeaderCells: false } },
  ],
  limits: { maxDepth: 512, ellipsis: '[…]' },
};

/**
 * Replace legacy SGML `<PAGE>` markers with a line break before parsing. The
 * parser never closes them, so each page nests one level below the last and a
 * text document's depth grows with its page count — an 800-page document would
 * be cut at {@link CONVERT_OPTIONS}' depth limit partway through. The marker
 * contributes no text of its own; in a plain-text body the line break stands
 * where the page broke (see {@link preservePlainTextBodies}).
 */
function neutralizePageMarkers(html: string): string {
  return html.replace(/<PAGE>/gi, '\n');
}

/** EDGAR writes the SGML body wrapper uppercase; an inline SVG `<text>` element is not one. */
const TEXT_OPEN = '<TEXT>';
const TEXT_CLOSE = '</TEXT>';
/**
 * A `<TEXT>` body holds HTML when one of these tags opens anywhere in it. The
 * list is broad on purpose: misreading HTML as plain text would wreck it, while
 * misreading plain text as HTML is only the pre-#136 conversion. `\b` keeps the
 * SGML tags plain bodies carry (`<PAGE>`, `<PDF>`, EX-27's `<PP&E>` and
 * `<PERIOD-TYPE>`) from tripping `<p`, and `<table` is absent because EDGAR
 * ASCII tables are `<TABLE>`. `<xml` keeps XML bodies (Form 4 and the like in a
 * full submission) on the HTML path.
 */
const HTML_BODY_RE = /<(?:html|body|p|div|br|font|tr|td|xml)\b/i;
/** Any tag a plain body carries — `<TABLE>`, `<CAPTION>`, `<S>`, `<C>`, `<FN>`, EX-27 fields. */
const SGML_TAG_RE = /<[A-Za-z/!?][^<>]*>/g;
/** html-to-text converts only `<body>` elements when the input holds one. */
const BODY_TAG_RE = /<body\b/i;
/**
 * A uuencoded payload — a GRAPHIC, ZIP, or EXCEL document, or a PDF behind its
 * `<PDF>` tag. Most classify as plain; a PDF's encoded lines can also spell out
 * an HTML-looking tag (`<BR`) and pass {@link HTML_BODY_RE}.
 */
const UUENCODED_BODY_RE = /^\s*(?:<PDF>\s*)?begin [0-7]{3,4} /;
const FILENAME_TAG = '<FILENAME>';
const TYPE_TAG = '<TYPE>';
/**
 * The submission `<TYPE>` EDGAR gives the files its XBRL renderer generates —
 * the `R1.htm`, `R2.htm`, … viewer pages, `Show.js`, `report.css`, and
 * `FilingSummary.xml`, all described `IDEA: XBRL DOCUMENT`. No filed document
 * carries it: an inline-XBRL primary is typed by its form, an exhibit `EX-…`.
 */
const RENDERER_TYPE = 'XML';
/**
 * Plain-text documents a modern full submission carries that no one reads as
 * text: XBRL schemas and linkbases, and the EDGAR renderer's stylesheet,
 * script, and metadata files.
 */
const MACHINE_READABLE_EXTENSIONS = new Set(['xml', 'xsd', 'css', 'js', 'json']);

/**
 * Render one plain-text `<TEXT>` body as a `<pre>` block: every tag dropped,
 * then `&`, `<`, and `>` escaped so the parser reads the rest as text. Tags are
 * dropped rather than left to the parser because it formats `<TABLE>` and
 * `<CAPTION>` as blocks, which breaks the `<pre>` whitespace, and a stray `<word`
 * in prose would swallow the text up to the next `>`. Dropping them matches what
 * the parser already did with tags it does not know, so the text content is
 * unchanged; only the lines and the column-aligning spaces survive now.
 */
function plainTextBodyAsPre(body: string): string {
  const text = body
    .replace(SGML_TAG_RE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<pre>${text}</pre>`;
}

/**
 * The value on the last `tag` line of a document header — the input between the
 * previous `</TEXT>` and this document's `<TEXT>`, so its last `<TYPE>` and
 * `<FILENAME>` are this document's.
 */
function headerValue(header: string, tag: string): string | undefined {
  const at = header.lastIndexOf(tag);
  if (at === -1) return;
  const lineEnd = header.indexOf('\n', at);
  return header.slice(at + tag.length, lineEnd === -1 ? undefined : lineEnd).trim();
}

/**
 * Whether a body to wrap in a submission that holds an HTML document is text to
 * keep — not a uuencoded payload, and not a machine-readable file by its
 * `<FILENAME>` extension.
 */
function isReadableDocument(body: string, header: string): boolean {
  if (UUENCODED_BODY_RE.test(body)) return false;
  const filename = headerValue(header, FILENAME_TAG) ?? '';
  const dot = filename.lastIndexOf('.');
  return dot === -1 || !MACHINE_READABLE_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase());
}

/**
 * Wrap every plain-text SGML `<TEXT>` body in `<pre>` so the conversion keeps
 * its line breaks (#136). The parser collapses each newline run to a space, and a
 * plain-text filing body lost the line structure `detectHeadings` anchors on —
 * a pre-2001 full submission or a 2000s ASCII primary document came back with an
 * empty outline. A body holding HTML is left untouched, so input with no plain
 * body reaches the parser byte-identical and converts exactly as before.
 *
 * When the input holds a `<body>` element, the parser converts only `<body>`
 * elements, so a submission with an HTML document lost its plain exhibits (#159).
 * There each plain `<pre>` goes inside a `<body>` of its own, and so does an HTML
 * document with no `<body>` tag (a run of `<P>`/`<TABLE>` fragments), so every
 * document converts in order, separated by the same block break the parser
 * already puts between two HTML documents. A uuencoded payload or a machine-readable file
 * stays outside, dropped as before, and so does the SEC header, as it always was
 * for these submissions. A renderer file ({@link RENDERER_TYPE}) is cut from the
 * input, since its viewer pages carry `<body>` elements of their own (#160).
 * Input with no `<body>` — a plain-only submission — converts whole, header
 * included, as before.
 *
 * One forward scan: a body runs from `<TEXT>` to the first `</TEXT>` after it,
 * and an opener with no closer after it ends the scan, since no later opener can
 * have one either.
 */
function preservePlainTextBodies(sgml: string): string {
  const bodyElementsOnly = BODY_TAG_RE.test(sgml);
  let out = '';
  let copied = 0;
  let from = 0;
  for (;;) {
    const open = sgml.indexOf(TEXT_OPEN, from);
    if (open === -1) break;
    const bodyStart = open + TEXT_OPEN.length;
    const close = sgml.indexOf(TEXT_CLOSE, bodyStart);
    if (close === -1) break;
    const body = sgml.slice(bodyStart, close);
    let replacement: string | undefined;
    if (!bodyElementsOnly) {
      if (!HTML_BODY_RE.test(body)) replacement = plainTextBodyAsPre(body);
    } else {
      const header = sgml.slice(from, open);
      if (headerValue(header, TYPE_TAG)?.toUpperCase() === RENDERER_TYPE) replacement = '';
      else if (!HTML_BODY_RE.test(body)) {
        if (isReadableDocument(body, header)) {
          replacement = `<body>${plainTextBodyAsPre(body)}</body>`;
        }
      } else if (!BODY_TAG_RE.test(body) && isReadableDocument(body, header)) {
        replacement = `<body>${body}</body>`;
      }
    }
    if (replacement !== undefined) {
      out += sgml.slice(copied, bodyStart) + replacement;
      copied = close;
    }
    from = close + TEXT_CLOSE.length;
  }
  return copied === 0 ? sgml : out + sgml.slice(copied);
}

/** One cached extraction: the text and the archive document it was read from. */
export interface CachedExtract {
  /**
   * The document the text came from. Under a primary-document key this can
   * differ from the index's primary — `get_filing` reads the full submission
   * when the archive does not serve the primary (#158) — so a cache hit reports
   * the same document the miss did.
   */
  document: string;
  text: string;
}

/**
 * Bounded LRU cache for extracted filing text.
 * SEC filings are immutable — cache indefinitely up to the bound.
 * Entries can be multi-megabyte strings, so the bound is kept tight.
 */
const EXTRACT_CACHE_MAX = 8;
/** Internal structure: insertion-ordered Map (oldest first) used as an LRU. */
const extractCache = new Map<string, CachedExtract>();

function cacheGet(key: string): CachedExtract | undefined {
  const value = extractCache.get(key);
  if (value === undefined) return;
  // Refresh: move to end (most recently used)
  extractCache.delete(key);
  extractCache.set(key, value);
  return value;
}

function cacheSet(key: string, value: CachedExtract): void {
  if (extractCache.has(key)) extractCache.delete(key);
  // Evict oldest when at capacity
  if (extractCache.size >= EXTRACT_CACHE_MAX) {
    const oldest = extractCache.keys().next().value as string | undefined;
    if (oldest !== undefined) extractCache.delete(oldest);
  }
  extractCache.set(key, value);
}

/** Strip Inline XBRL markup that produces noise in text conversion. */
function stripInlineXbrl(html: string): string {
  // Remove <ix:header>...</ix:header> block (hidden XBRL metadata, context, references)
  let cleaned = html.replace(/<ix:header\b[\s\S]*?<\/ix:header>/gi, '');
  // Unwrap remaining ix:* tags (nonFraction, nonNumeric, continuation) — keep their text content
  cleaned = cleaned.replace(/<\/?ix:[^>]*>/gi, '');
  return cleaned;
}

/**
 * Extract full plain text from a filing document — HTML, or an SGML submission,
 * every readable document in order with plain-text `<TEXT>` bodies keeping their
 * lines (see {@link preservePlainTextBodies}). Pure and deterministic — the same
 * input always yields the same string. Caching is the caller's responsibility via
 * `getExtractCache`/`setExtractCache` (keyed `accession:document`), which lets a
 * cache hit skip the document fetch as well as this conversion.
 */
export function filingToExtract(html: string): string {
  return convert(
    preservePlainTextBodies(neutralizePageMarkers(stripInlineXbrl(html))),
    CONVERT_OPTIONS,
  );
}

/** Return true if the cache has an entry for cacheKey (allows skipping the document fetch). */
export function hasExtractCache(cacheKey: string): boolean {
  return extractCache.has(cacheKey);
}

/**
 * Retrieve a cached extraction by key, or undefined if not cached.
 * Used by the handler to skip both the fetch AND the conversion on a cache hit.
 */
export function getExtractCache(cacheKey: string): CachedExtract | undefined {
  return cacheGet(cacheKey);
}

/** Store an extraction in the cache (used by handler after a successful fetch). */
export function setExtractCache(cacheKey: string, entry: CachedExtract): void {
  cacheSet(cacheKey, entry);
}

/** Exposed for tests: evict all entries from the extraction cache. */
export function clearExtractCache(): void {
  extractCache.clear();
}

/** Exposed for tests: return current cache size. */
export function extractCacheSize(): number {
  return extractCache.size;
}

/** A detected heading with its character offset into the extracted text. */
export interface FilingHeading {
  heading: string;
  offset: number;
}

/**
 * Regexes that match SEC document headings, anchored to start-of-line:
 * - All-caps forms — "ITEM N" / "ITEM NA" lines (10-K, 10-Q structure) and
 *   all-caps lines of 9+ characters (registration statement TOC headings like
 *   "RISK FACTORS"; older filings).
 * - Mixed-case Item/Part forms — modern styled filings render headings as
 *   "Item 1A. Risk Factors" / "Part II" spans (#71). The Item arm requires a
 *   title after the marker on the same line and bounds the tail so unwrapped
 *   body paragraphs that begin with "Item ..." don't register.
 * - Bare Item markers — a marker alone on its line, title supplied further
 *   down (see {@link titleAfterMarkerLine}).
 *
 * Every whitespace match is horizontal-only (`[^\S\n]`, alternated with the
 * literal members where a character class cannot nest one): a heading is one
 * line, and a `\s` that matches `\n` fuses a run of consecutive all-caps lines
 * into one composite match (#105). Horizontal whitespace is not the same as
 * space-or-tab — filings put non-breaking spaces both between a marker and its
 * title and inside an all-caps heading (`MICROSOFT<NBSP>CORPORATION`), so the
 * all-caps arm has to admit them without admitting `\n`.
 *
 * The Item suffix spans the full 20-F range (`Item 16A`–`Item 16K`, not just
 * `[a-c]`) and the marker's trailing period is optional — 20-F filers write
 * the lettered markers unpunctuated.
 *
 * Both all-caps alternatives already absorb trailing whitespace, so that arm
 * ends at `$` with no `[^\S\n]*` of its own: the two quantifiers competing for one
 * whitespace run backtracked quadratically on a long run before a lowercase
 * letter — 3.5 s for an 80,000-character line.
 *
 * Heuristics — best-effort, not guaranteed to match all or only headings.
 */
const ALL_CAPS_HEADING_RE = /^(ITEM[^\S\n]+\d+[A-Z]?\b[^\n]*|[A-Z](?:[A-Z,()&./]|[^\S\n]){8,})$/gm;
const ITEM_PART_HEADING_RE =
  /^(item[^\S\n]+\d{1,2}[a-z]?\.?[^\S\n]+\S[^\n]{0,140}|part[^\S\n]+[ivx]{1,4}\b\.?)[^\S\n]*$/gim;
const BARE_ITEM_MARKER_RE = /^(item[^\S\n]+\d{1,2}[a-z]?\.?)[^\S\n]*$/gim;

/**
 * An Item marker with no period or colon after it, capturing the first
 * character of what follows. Non-global: a predicate, not a scanner.
 */
const UNPUNCTUATED_ITEM_RE = /^item[^\S\n]+\d{1,2}[a-z]?(?![.:\w])[^\S\n]*(\S)/i;
/** A line that ends mid-sentence — on a lowercase word, a comma, or a semicolon. */
const MID_SENTENCE_END_RE = /[a-z,;]$/;

/**
 * Whether an Item line that starts at `lineStart` is a wrapped sentence, not a
 * heading. Plain-text filings wrap prose at a fixed column, so a cross-reference
 * can land at the start of a line ("…and in Part II,\nItem 8 on this Form 10-K in
 * the Notes…"), where it matches the heading patterns and, as the earlier
 * occurrence, takes `section: "item 8"` ahead of the real heading (#136). A
 * heading puts a period or colon after its marker, or a capitalized title ("Item 6
 * Selected Financial Data", "Item 1 - Legal Proceedings"). An unpunctuated marker
 * reads as prose when the word after it starts lowercase ("Item 1 is the election
 * of…") or when the line before it ends mid-sentence.
 */
function isWrappedProse(text: string, lineStart: number, line: string): boolean {
  const marker = UNPUNCTUATED_ITEM_RE.exec(line);
  if (marker === null) return false;
  if (/[a-z]/.test(marker[1] ?? '')) return true;
  if (lineStart === 0) return false;
  const previousLine = text.slice(text.lastIndexOf('\n', lineStart - 2) + 1, lineStart - 1);
  return MID_SENTENCE_END_RE.test(previousLine.trimEnd());
}

/**
 * Sticky: the marker line's own newline, at least one blank line, then the first
 * non-blank line. The separated form — "Item 3.\n\nKey Information".
 */
const SEPARATED_TITLE_RE = /\n[^\S\n]*\n(?:[^\S\n]*\n)*[^\S\n]*(\S[^\n]*)/y;
/**
 * Sticky: the marker line's own newline, the immediately following line, and the
 * line after that. The tight form — "Item 16K\nCybersecurity" — which is also the
 * shape a TOC table takes when each cell lands on its own line. The second group
 * is what separates them: a TOC row puts its page-number cell directly under the
 * title ("Item 1.\nBusiness\n1\n"), a body heading does not (#71, #105).
 */
const TIGHT_TITLE_RE = /\n[^\S\n]*(\S[^\n]*)\n?([^\n]*)/y;
/** A whole line holding nothing but a page number — the TOC-cell tell. */
const PAGE_NUMBER_LINE_RE = /^[^\S\n]*\d{1,4}[^\S\n]*$/;
/**
 * A trailing bare page number, as a TOC line carries it ("Key Information      3").
 * The lookbehind starts a try only where a whitespace run begins; a try from
 * inside the run rescanned the rest of it, quadratic on a long run.
 */
const PAGE_NUMBER_TAIL_RE = /(?<![^\S\n])[^\S\n]+\d{1,4}[^\S\n]*$/;
/** Same bound the same-line Item arm uses — past it the line reads as body prose. */
const MAX_TITLE_CHARS = 140;
/**
 * A line repeated this many times is page furniture (a running header), not a
 * heading. The two populations sit far apart: a heading printed once in the TOC
 * and once in the body occurs twice, while a running header occurs about once
 * per page — 129 "TABLE OF CONTENTS" lines in C3is' FY2025 20-F, 47 "PART I"
 * lines in a 10-Q.
 *
 * What the furniture costs the outline depends on its shape, so it is handled
 * two ways (#105):
 * - A bare marker ({@link BARE_MARKER_HEADING_RE} — "Item 1", "PART I") carries
 *   no navigable text, so no occurrence of it earns an entry and every one is
 *   dropped.
 * - Anything else keeps its FIRST occurrence and drops the rest. A filing that
 *   runs a section's own heading across every page of that section ("NOTES TO
 *   THE CONSOLIDATED FINANCIAL STATEMENTS" through an S-1's financial
 *   statements) prints it first at the section start, so the first occurrence is
 *   the section and the remainder is furniture. Keep-later — the rule for a
 *   heading under the bound — would instead land it on the section's last page.
 */
const RUNNING_HEADER_MIN_OCCURRENCES = 5;

/**
 * A heading that is nothing but a structural marker, with no title of its own:
 * the `part …` arm of {@link ITEM_PART_HEADING_RE}, or an Item marker that
 * reached the outline unjoined. Non-global on purpose — a predicate, not a
 * scanner, so it carries no `lastIndex`.
 */
const BARE_MARKER_HEADING_RE = /^(?:item[^\S\n]+\d{1,2}[a-z]?|part[^\S\n]+[ivx]{1,4})\.?$/i;

/** Drop a TOC line's trailing page number so it dedups against the body heading. */
function stripPageNumberTail(heading: string): string {
  return heading.replace(PAGE_NUMBER_TAIL_RE, '');
}

/**
 * Dedup key for one detected heading. {@link foldForHeadingMatch} covers the
 * whitespace and quote differences a filing prints between its TOC and its body;
 * terminal sentence punctuation is the remaining one (C3is' 20-F writes
 * "Item 16J Insider Trading Policies" in the TOC and "…Policies." in the body).
 * Key-only — the entry keeps the document's own heading text.
 */
function headingKey(heading: string): string {
  return foldForHeadingMatch(heading).replace(/[.,;:]+$/, '');
}

/**
 * The title for a bare Item marker whose line ends at `markerLineEnd`, or
 * undefined when the following lines supply none.
 *
 * A blank line between marker and title admits the pair outright. Without one,
 * the pair is a TOC row's marker and title cells just as plausibly as a heading,
 * so it is admitted only when no page-number cell sits under the title — the
 * three-tight-line shape #71's bare-marker guard was written to reject. The test
 * is one-way: it rejects a TOC row, it does not certify a heading. Anything else
 * that puts a marker on its own line — a page footer, an unwrapped body
 * paragraph — is admitted too, taking the next line as its title; the entry's
 * offset is the marker's, so `section` still lands in the right place.
 */
function titleAfterMarkerLine(text: string, markerLineEnd: number): string | undefined {
  SEPARATED_TITLE_RE.lastIndex = markerLineEnd;
  const separated = SEPARATED_TITLE_RE.exec(text)?.[1];
  if (separated !== undefined) return usableTitle(separated);

  TIGHT_TITLE_RE.lastIndex = markerLineEnd;
  const tight = TIGHT_TITLE_RE.exec(text);
  if (tight === null) return;
  const [, title = '', lineBelow = ''] = tight;
  if (PAGE_NUMBER_LINE_RE.test(lineBelow)) return;
  return usableTitle(title);
}

/**
 * A candidate title line reduced to heading text, or undefined when it is not a
 * title at all — empty, a bare page number, the next marker, or long enough to
 * read as body prose.
 */
function usableTitle(raw: string): string | undefined {
  const title = stripPageNumberTail(raw).trim();
  if (title.length === 0 || title.length > MAX_TITLE_CHARS) return;
  if (/^\d+$/.test(title)) return;
  if (/^(?:item|part)\b/i.test(title)) return;
  return title;
}

/**
 * Detect headings in extracted text and return them with their offsets, sorted
 * by offset. Deduplicates by {@link headingKey}, keeping the later occurrence
 * (handles TOC vs body duplicate headings — the body occurrence is the more
 * useful landing spot), and drops running page headers. Caps output at
 * maxEntries.
 */
export function detectHeadings(text: string, maxEntries = 50): FilingHeading[] {
  const matches: Array<{ heading: string; index: number }> = [];
  const add = (heading: string, index: number): void => {
    const trimmed = stripPageNumberTail(heading).trim();
    if (trimmed.length > 0) matches.push({ heading: trimmed, index });
  };

  for (const re of [ALL_CAPS_HEADING_RE, ITEM_PART_HEADING_RE]) {
    re.lastIndex = 0;
    for (let match = re.exec(text); match !== null; match = re.exec(text)) {
      const heading = match[1];
      if (heading !== undefined && !isWrappedProse(text, match.index, heading)) {
        add(heading, match.index);
      }
    }
  }

  // Bare marker, title on a later line — the shape every Item takes in a 20-F
  // rendered one cell per line, in both the TOC and the body (#105).
  const bareMarkers: Array<{ marker: string; index: number; lineEnd: number }> = [];
  BARE_ITEM_MARKER_RE.lastIndex = 0;
  for (
    let match = BARE_ITEM_MARKER_RE.exec(text);
    match !== null;
    match = BARE_ITEM_MARKER_RE.exec(text)
  ) {
    const marker = match[1];
    if (marker === undefined) continue;
    bareMarkers.push({
      marker: marker.trim(),
      index: match.index,
      lineEnd: match.index + match[0].length,
    });
  }

  // The running-header test below cannot reach these: a page-footer marker's
  // "title" is whatever prose the next page opens with, so every composite it
  // produces is a different string and only the marker line repeats. Count the
  // marker on its own, keyed by `foldForHeadingMatch` rather than `headingKey`:
  // a filing that stamps a bare `Item 1` on every page still writes `Item 1.`
  // for the real heading, and stripping the period would merge the two forms
  // and suppress that as well.
  const markerCounts = new Map<string, number>();
  for (const { marker } of bareMarkers) {
    const key = foldForHeadingMatch(marker);
    markerCounts.set(key, (markerCounts.get(key) ?? 0) + 1);
  }

  for (const { marker, index, lineEnd } of bareMarkers) {
    if ((markerCounts.get(foldForHeadingMatch(marker)) ?? 0) >= RUNNING_HEADER_MIN_OCCURRENCES) {
      continue;
    }
    const title = titleAfterMarkerLine(text, lineEnd);
    if (title !== undefined) add(`${marker} ${title}`, index);
  }

  matches.sort((a, b) => a.index - b.index);

  // Distinct offsets, not raw match count: an all-caps "ITEM 1 BUSINESS" line
  // satisfies both the all-caps and the mixed-case arm, and counting it twice
  // would read three occurrences of one heading as page furniture.
  const positions = new Map<string, Set<number>>();
  for (const { heading, index } of matches) {
    const key = headingKey(heading);
    const seen = positions.get(key) ?? new Set<number>();
    seen.add(index);
    positions.set(key, seen);
  }

  // Keep the later occurrence of a heading (body vs TOC dedup heuristic — also
  // collapses "Part I" TOC vs "PART I" body). Page furniture inverts that: it
  // keeps the first occurrence, or none at all when it is a bare marker.
  // `matches` is offset-sorted, so the first write wins for furniture and the
  // last for everything else.
  const byHeading = new Map<string, FilingHeading>();
  for (const { heading, index } of matches) {
    const key = headingKey(heading);
    if ((positions.get(key)?.size ?? 0) >= RUNNING_HEADER_MIN_OCCURRENCES) {
      if (BARE_MARKER_HEADING_RE.test(heading)) continue;
      if (!byHeading.has(key)) byHeading.set(key, { heading, offset: index });
      continue;
    }
    byHeading.set(key, { heading, offset: index });
  }
  return [...byHeading.values()].sort((a, b) => a.offset - b.offset).slice(0, maxEntries);
}

/**
 * Fold a heading or a `section` needle into a comparison form: typographic
 * quotes become their ASCII counterparts and every Unicode whitespace run
 * (`\s` covers NBSP and the other space separators) collapses to one plain
 * space, then the result is trimmed and lowercased. EDGAR HTML routinely puts
 * NBSP runs and curly quotes inside headings, so a caller re-sending an
 * outline heading through a UI that normalizes either one otherwise never
 * byte-matches the heading it came from (#106). {@link detectHeadings} keys its
 * dedup on the same fold, for the same reason.
 *
 * Comparison-time only — {@link FilingHeading.heading}, the rendered outline,
 * and every character offset keep the document's own bytes.
 */
export function foldForHeadingMatch(value: string): string {
  return value
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Convert filing HTML to plain text, optionally truncating to a character limit. */
export function filingToText(
  html: string,
  limit?: number,
): { text: string; truncated: boolean; totalLength: number } {
  const full = filingToExtract(html);
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

/**
 * Window a pre-extracted full text string starting at effectiveOffset, up to limit chars,
 * truncating at a word boundary. Returns the window plus paging metadata.
 */
export function windowText(
  full: string,
  effectiveOffset: number,
  limit: number,
): { text: string; truncated: boolean; totalLength: number; nextOffset?: number } {
  const totalLength = full.length;
  const slice = full.slice(effectiveOffset, effectiveOffset + limit);
  if (effectiveOffset + limit >= totalLength) {
    // End of document reached — no truncation. (Arithmetic check, not slice.length < limit:
    // a window ending exactly at the document end would otherwise probe past the slice and
    // spuriously report truncation.)
    return { text: slice, truncated: false, totalLength };
  }

  // Truncate at word boundary within the slice
  let end = slice.length;
  while (end > 0 && slice[end] !== ' ' && slice[end] !== '\n') {
    end--;
  }
  if (end === 0) end = slice.length;

  const text = slice.slice(0, end);
  const nextOffset = effectiveOffset + text.length;
  return { text, truncated: true, totalLength, nextOffset };
}
