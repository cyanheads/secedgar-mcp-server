/**
 * @fileoverview Convert SEC filing HTML to readable plain text, with extraction caching and
 * offset/section windowing support.
 * @module services/edgar/filing-to-text
 */

import type { HtmlToTextOptions } from 'html-to-text';
import { convert } from 'html-to-text';
import { CURRENT_EIGHT_K_ITEMS } from './eight-k-items.js';

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
 * An Item marker's code: one or two digits with an optional letter suffix (the
 * 20-F's `16A`–`16K`), or a current Form 8-K item's two-digit decimal (`5.02`,
 * #165). Without the decimal, the `.02` of `Item 5.02` broke every Item pattern.
 */
const ITEM_CODE = String.raw`\d{1,2}(?:\.\d{2}|[a-z])?`;

/**
 * A title run straight into its Item code or Part numeral, with no period or
 * space between (#180): a capital followed by a lowercase letter, matched
 * case-sensitively inside the case-insensitive patterns (the `(?-i:)` modifier
 * group). The title's shape is what ends the marker — `Item 1Financial
 * Statements` is Item `1` and `Part IFinancial Information` Part `I`, while a
 * lettered code (`Item 16KCybersecurity`) and a longer numeral (`Part IVExhibits`)
 * read whole, and an all-caps run-in (`Item 1ARISK FACTORS`) matches nothing.
 * A fixed-width lookahead, so it adds no quantifier to a scan.
 */
const TITLE_RUN_IN = '(?-i:(?=[A-Z][a-z]))';

/**
 * Regexes that match SEC document headings, anchored to start-of-line:
 * - All-caps forms — "ITEM N" / "ITEM NA" lines (10-K, 10-Q structure) and
 *   all-caps lines of 9+ characters (registration statement TOC headings like
 *   "RISK FACTORS"; older filings). The all-caps line admits hyphens and en/em
 *   dashes ("NON-GAAP FINANCIAL MEASURES", "PART II — OTHER INFORMATION"),
 *   digits, and apostrophes; {@link isAllCapsHeadingText} then holds the last
 *   two to a section number and a possessive (#170). A colon stays out: every
 *   colon line it admitted across 26 sampled documents was a financial-statement
 *   caption ("CURRENT ASSETS:").
 * - Mixed-case Item/Part forms — modern styled filings render headings as
 *   "Item 1A. Risk Factors" / "Part II" spans (#71). The Item arm requires a
 *   title after the marker on the same line, and {@link sameLineTitleFits} bounds
 *   it so unwrapped body paragraphs that begin with "Item ..." don't register. A
 *   dotted 8-K marker may also abut its title or carry a paragraph suffix
 *   ("Item 9.01Financial Statements…", "Item 9.01(d).    Financial…"), and then
 *   the title must start with a letter, so a bare "Item 5.02." line never matches
 *   on its own (#165). Any other code may abut its title past its period ("Item
 *   2.Management’s Discussion…", "Item 1A.Risk Factors"), the title again
 *   opening on a letter, while a digit there stays part of the code ("Item
 *   2.02"; "Item 2.0 something" is no heading); with no period, a code or a Part
 *   numeral runs into a title only at {@link TITLE_RUN_IN}'s capital and
 *   lowercase letter ("Item 1Financial Statements", "Part IFinancial
 *   Information"), the shapes html-to-text leaves when marker and title are
 *   separate spans with no space between (#180). A Part line may carry a title
 *   after whitespace and an optional dash, colon, or period ("Part II — Other
 *   Information"), which must start uppercase (#170).
 * - Bare Item markers — a marker alone on its line, title supplied further
 *   down (see {@link titleAfterMarkerLine}).
 *
 * Every whitespace match is horizontal-only (`[^\S\n]`, or the class-set
 * difference `[\s--\n]` nested in the all-caps arm's class): a heading is one
 * line, and a `\s` that matches `\n` fuses a run of consecutive all-caps lines
 * into one composite match (#105). Horizontal whitespace is not the same as
 * space-or-tab — filings put non-breaking spaces both between a marker and its
 * title and inside an all-caps heading (`MICROSOFT<NBSP>CORPORATION`), so the
 * all-caps arm has to admit them without admitting `\n`. That arm is one class
 * (the `v` flag's set syntax) rather than an alternation of the class and
 * `[^\S\n]`: the quantified alternation kept a backtrack frame per character
 * and fell off a cliff past about 100,000 characters — a 160,000-character
 * all-caps line ending in a lowercase letter took 25 ms against 0.4 ms at
 * 80,000 — while a single class scans the line flat.
 *
 * The Item suffix spans the full 20-F range (`Item 16A`–`Item 16K`, not just
 * `[a-c]`) and the marker's trailing period is optional — 20-F filers write
 * the lettered markers unpunctuated.
 *
 * An indented line is no heading — admitting indentation fills the outline with
 * centered cover legends and promotes indented TOC rows — with one exception: a
 * same-line Item line, on either Item arm, may open on one NBSP (#176). An
 * `&nbsp;` ahead of a styled marker leaves the extracted line starting on
 * U+00A0 (Horizon Space's 8-K: "<NBSP>Item 1.01. Entry into a Material
 * Definitive Agreement."), and the line anchor kept that Item out of the
 * outline. A lookahead admits the NBSP only before an Item marker, and
 * {@link itemEntryOffset} records the entry at the marker and drops a line that
 * is a bare marker once its page cell is stripped. Part lines get no such
 * allowance: Microsoft's 2004 10-K stamps an NBSP-led "Part I" on every page,
 * and counting those would turn its body Parts into running-header furniture.
 *
 * Both all-caps alternatives already absorb trailing whitespace, so that arm
 * ends at `$` with no `[^\S\n]*` of its own: the two quantifiers competing for one
 * whitespace run backtracked quadratically on a long run before a lowercase
 * letter — 3.5 s for an 80,000-character line. The same-line Item title runs to
 * the end of the line for the same reason; its bound is checked afterwards.
 *
 * Capture groups: the all-caps scan's 2 is the all-caps line (not an `ITEM N`
 * line). The Item/Part scan's 2 is the Item code, 3 the Item title, and 4 the
 * Part title.
 *
 * Heuristics — best-effort, not guaranteed to match all or only headings.
 */
const ALL_CAPS_HEADING_RE =
  /^(?:\xA0(?=ITEM[^\S\n]+\d+[A-Z]?\b))?(ITEM[^\S\n]+\d+[A-Z]?\b[^\n]*|([A-Z][[A-Z0-9,\(\)\&.\/'’–—\-][\s--\n]]{8,}))$/gmv;
const ITEM_PART_HEADING_RE = new RegExp(
  String.raw`^(?:\xA0(?=item[^\S\n]))?(item[^\S\n]+(${ITEM_CODE})(?:\.?[^\S\n]+|(?<=\.\d{2})(?:\([a-z]\))?\.?[^\S\n]*(?=[a-z])|\.(?=[a-z])|${TITLE_RUN_IN})(\S[^\n]*)` +
    String.raw`|part[^\S\n]+[ivx]{1,4}(?:\b|${TITLE_RUN_IN})\.?(?:[^\S\n]*(?:[-–—:.][^\S\n]*)?([a-z][^\n]{0,140}))?)[^\S\n]*$`,
  'gim',
);
/** The one leading character a same-line Item heading may open on (#176). */
const NBSP = '\xA0';
const BARE_ITEM_MARKER_RE = new RegExp(
  String.raw`^(item[^\S\n]+(${ITEM_CODE})\.?)[^\S\n]*$`,
  'gim',
);

/**
 * An Item marker with no period or colon after it, capturing the first
 * character of what follows — the title's capital when the title runs straight
 * into the code ({@link TITLE_RUN_IN}, #180). Non-global: a predicate, not a
 * scanner.
 */
const UNPUNCTUATED_ITEM_RE = new RegExp(
  String.raw`^item[^\S\n]+${ITEM_CODE}(?:(?![.:\w])[^\S\n]*|${TITLE_RUN_IN})(\S)`,
  'i',
);
/**
 * A line that ends mid-sentence — on a comma or a semicolon. A line ending on a
 * lowercase word is no evidence: running page headers end that way ("Table of
 * Contents" above "Item 5 — Other information" at the top of a page).
 */
const MID_SENTENCE_END_RE = /[,;]$/;

/** Whether the line before the one starting at `lineStart` ends mid-sentence. */
function followsMidSentence(text: string, lineStart: number): boolean {
  if (lineStart === 0) return false;
  const previousLine = text.slice(text.lastIndexOf('\n', lineStart - 2) + 1, lineStart - 1);
  return MID_SENTENCE_END_RE.test(previousLine.trimEnd());
}

/** A whitespace-delimited token holding a digit must be a section number: `10`, `14A`, `2.`. */
const SECTION_NUMBER_TOKEN_RE = /^\d{1,2}[A-Z]?\.?$/;
/** An apostrophe inside a word ("MANAGEMENT'S") or after a word-final S ("STOCKHOLDERS’ EQUITY"). */
const HEADING_APOSTROPHE_RE = /(?<=[A-Z])['’](?=[A-Z])|(?<=S)['’](?=\s)/g;

/**
 * Whether an all-caps line's length, digits, and apostrophes fit a heading
 * (#170). The heading text runs at most {@link MAX_TITLE_CHARS} characters: past
 * it the line is a paragraph set in capitals (a 308-character risk-factor coda,
 * an 860-character tax legend), which the widened class otherwise admits. A
 * digit may appear only in a whitespace-delimited section-number token ("NOTE
 * 10", "SCHEDULE 14A"), so table rows ("EMEA 2,222 2,365"), footnoted names
 * ("FMR LLC(4)"), and cover-page lines ("WASHINGTON, D.C. 20549", "…ACT OF
 * 1934") stay out: digits admitted freely added 61 lines across 26 sampled
 * documents, 12 of them numeric table rows, against 20 and none under the token
 * rule. The digits are judged on the whole line, a TOC row's page cell
 * included. An apostrophe must sit inside a word or after a word-final S,
 * judged on the heading text the line yields, so a heading never opens or
 * closes on one.
 */
function isAllCapsHeadingText(line: string): boolean {
  const heading = stripPageNumberTail(line).trim();
  if (heading.length > MAX_TITLE_CHARS) return false;
  const tokens = line.trim().split(/\s+/);
  if (!tokens.every((token) => !/\d/.test(token) || SECTION_NUMBER_TOKEN_RE.test(token))) {
    return false;
  }
  return !/['’]/.test(heading.replace(HEADING_APOSTROPHE_RE, ''));
}

/**
 * A second Item marker after the one an Item line opens on: after whitespace, or
 * abutting the period, digit, or parenthesis that ends the cell before it
 * ("Item 2.Item 3.", "Item 9.01Item 9.02", "Properties 3Item 3.", #180). An
 * opening quote or parenthesis before it is a title citing another Item ("(Item
 * 408 of Regulation S-K)"), not a second cell. Non-global: a predicate.
 */
const LATER_ITEM_MARKER_RE = /(?:[^\S\n]|[.\d)])item[^\S\n]+\d/i;
/**
 * A TOC page cell inside a line rather than at its end: a page number, a
 * lettered page, or either after a `Page` word, set off by whitespace before it
 * and two or more whitespace characters before the next cell. Non-global: a
 * predicate.
 */
const MID_LINE_PAGE_CELL_RE =
  /[^\S\n](?:(?:Page|PAGE)[^\S\n]+)?(?:\d{1,4}|[A-Z]-\d{1,3})[^\S\n]{2,}\S/;

/**
 * Whether an Item line is a table of contents run together on one line: it
 * carries a second Item marker or a page cell mid-line. Amazon's 8-K
 * 0001104659-26-107526 prints its whole TOC as one 238-character line ("ITEM
 * 8.01. OTHER EVENTS. 3     ITEM 9.01. FINANCIAL STATEMENTS AND EXHIBITS. 4
 * SIGNATURES 5 …"), which as one heading took `item 8`, `item 9`, and
 * `exhibits` from the body Items. The test is on shape, not length: a proxy's
 * proposal heading runs as long ("ITEM 1 – TO APPROVE THE PROPOSAL TO AMEND
 * THE Amended and Restated Articles…", 185 characters) and is the meeting's one
 * heading. Across 104 cached filings, 244 all-caps and 568 mixed-case Item lines,
 * it flags only that TOC line.
 */
function isRunTogetherToc(line: string): boolean {
  return LATER_ITEM_MARKER_RE.test(line) || MID_LINE_PAGE_CELL_RE.test(line);
}

/** A title that opens on another Item or Part marker. Non-global: a predicate. */
const MARKER_OPENER_RE = /^(?:item|part)\b/i;

/**
 * Whether a titled Part line is a cross-reference rather than a heading: its
 * title opens on another marker — a cross-reference index row ("Part II — Item 5.
 * Market for Registrant’s Common Equity") — or it sits under a line ending
 * mid-sentence, a wrapped reference ("…described in our Form 10-K,\nPART II —
 * OTHER INFORMATION"). Either would take `section: "part ii"`, and the first
 * would also displace the bare body Part it names (`dropBarePartsTitledLater`).
 */
function isPartCrossReference(text: string, lineStart: number, title: string): boolean {
  return MARKER_OPENER_RE.test(title) || followsMidSentence(text, lineStart);
}

/**
 * Whether a same-line Item title fits the title bound. That arm has always
 * counted the bound after the title's first character (`\S[^\n]{0,140}`), one
 * more than a title on a line of its own.
 */
function sameLineTitleFits(code: string, title: string): boolean {
  return title.trimEnd().length <= maxTitleChars(code) + 1;
}

/**
 * The title bound for a current Form 8-K item. Item 5.02's title runs 146
 * characters, past {@link MAX_TITLE_CHARS} (#165), and is the longest any of 53
 * sampled 8-Ks prints; the 14-character margin admits a short trailing note
 * ("(continued)", a paragraph list) while a paragraph opening on the marker
 * line ("Item 5.02(b) On June 2, 2026, the Board…") runs to hundreds of
 * characters and stays out.
 */
const EIGHT_K_MAX_TITLE_CHARS = 160;

/**
 * The title bound for an Item code: {@link EIGHT_K_MAX_TITLE_CHARS} for a code
 * in the current Form 8-K item table, {@link MAX_TITLE_CHARS} for every other
 * marker. Keyed on the table rather than the dotted shape, so a dotted code
 * outside it ("Item 7.09") keeps the tighter bound.
 */
function maxTitleChars(code: string): number {
  return Object.hasOwn(CURRENT_EIGHT_K_ITEMS, code) ? EIGHT_K_MAX_TITLE_CHARS : MAX_TITLE_CHARS;
}

/**
 * Whether an Item line that starts at `lineStart` is a wrapped sentence, not a
 * heading. Plain-text filings wrap prose at a fixed column, so a cross-reference
 * can land at the start of a line ("…and in Part II,\nItem 8 on this Form 10-K in
 * the Notes…"), where it matches the heading patterns and, as the earlier
 * occurrence, takes `section: "item 8"` ahead of the real heading (#136). A
 * heading puts a period or colon after its marker, or a capitalized title ("Item 6
 * Selected Financial Data", "Item 1 - Legal Proceedings"). An unpunctuated marker
 * — a title run straight into the code included ("…in Part II,\nItem 8Financial
 * Statements of this report", #180) — reads as prose when the word after it
 * starts lowercase ("Item 1 is the election of…") or when the line before it ends
 * on a comma or semicolon.
 */
function isWrappedProse(text: string, lineStart: number, line: string): boolean {
  const marker = UNPUNCTUATED_ITEM_RE.exec(line);
  if (marker === null) return false;
  if (/[a-z]/.test(marker[1] ?? '')) return true;
  return followsMidSentence(text, lineStart);
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
 * A TOC row's page cell at the end of its line, set off by a tab or two or more
 * spaces ("Key Information      3", "Consolidated Balance Sheets    F-3"), its
 * number optionally after a `Page` word ("Item 8.01 Other Events      Page 1",
 * the cell First Bancorp's 8-K TOC prints, which otherwise kept the row from
 * deduping against its body Item and took `item 8`). One space is not enough: a
 * heading can end in its own number ("PROPOSAL NO. 1", "ARTICLE 5", "…Exchange
 * Act of 1934", "…as of June 30, 2026"), which a single-space rule stripped or
 * read as a TOC row (#172, #166). The lookbehind starts a try only where a
 * whitespace run begins; a try from inside the run rescanned the rest of it,
 * quadratic on a long run.
 */
const TOC_PAGE_TAIL_RE =
  /(?<![^\S\n])(?:[^\S\n]{2,}|\t)(?:(?:Page|PAGE)[^\S\n]+)?(?:\d{1,4}|[A-Z]-\d{1,3})[^\S\n]*$/;
/**
 * The title bound for an Item marker's title, a titled Part's title, and an
 * all-caps heading line — past it the line reads as body prose. The same-line
 * Item arm counts it after the title's first character, one more
 * ({@link sameLineTitleFits}), and a current 8-K item takes
 * {@link EIGHT_K_MAX_TITLE_CHARS}.
 */
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
 * A line or heading that is nothing but a structural marker, with no title of
 * its own: a bare Part line, or an Item marker alone on its line or reached the
 * outline unjoined. Non-global on purpose — a predicate, not a scanner, so it
 * carries no `lastIndex`.
 */
const BARE_MARKER_HEADING_RE = new RegExp(
  String.raw`^(?:item[^\S\n]+${ITEM_CODE}|part[^\S\n]+[ivx]{1,4})\.?$`,
  'i',
);
/** A bare Part heading, capturing its numeral. */
const BARE_PART_HEADING_RE = /^part[^\S\n]+([ivx]{1,4})\.?$/i;
/**
 * A Part heading with a title after its numeral ("PART II — OTHER INFORMATION",
 * "Part I. Financial Information"), capturing the numeral and the title, which
 * opens on a letter, or runs straight into the numeral (#180).
 */
const TITLED_PART_HEADING_RE = new RegExp(
  String.raw`^part[^\S\n]+([ivx]{1,4})(?:\b|${TITLE_RUN_IN})\.?[^\S\n]*(?:[-–—:.][^\S\n]*)?([a-z][^\n]*)`,
  'i',
);

/**
 * Drop each bare Part entry that a later titled heading for the same numeral
 * follows (#170). A 10-Q's TOC prints "Part II" as a bare row and its body prints
 * "PART II — OTHER INFORMATION"; the two keys differ, so dedup keeps both and
 * `section: "part ii"` lands on the TOC row, 50,000 characters early (Apple's
 * Q3 FY2026 10-Q). A bare Part with no later titled heading stays — it is the
 * only entry for that Part. A title must open uppercase and on neither marker,
 * the same test the detection arms apply ({@link isPartCrossReference}).
 */
function dropBarePartsTitledLater(headings: FilingHeading[]): FilingHeading[] {
  const titledLater = new Set<string>();
  const kept: FilingHeading[] = [];
  for (const entry of [...headings].reverse()) {
    const [, numeral, title = ''] = TITLED_PART_HEADING_RE.exec(entry.heading) ?? [];
    if (numeral !== undefined && /^[A-Z]/.test(title) && !MARKER_OPENER_RE.test(title)) {
      titledLater.add(numeral.toLowerCase());
    } else {
      const bare = BARE_PART_HEADING_RE.exec(entry.heading)?.[1]?.toLowerCase();
      if (bare !== undefined && titledLater.has(bare)) continue;
    }
    kept.push(entry);
  }
  return kept.reverse();
}

/** Drop a TOC line's trailing page cell so it dedups against the body heading. */
function stripPageNumberTail(heading: string): string {
  return heading.replace(TOC_PAGE_TAIL_RE, '');
}

/**
 * A folded key's Item or Part marker — an Item code with an optional 8-K
 * paragraph suffix, or a Part numeral — capturing the marker and the title
 * after it, past an optional period and one dash, colon, or period separator. A
 * bare marker captures an empty title.
 */
export const MARKER_TITLE_RE =
  /^(item \d{1,2}(?:\.\d{2}|[a-z])?(?:\([a-z]\))?|part [ivx]{1,4}\b)\.? ?(?:[-–—:.] ?)?(.*)$/;

/**
 * An Item or Part marker whose title runs straight into it ({@link TITLE_RUN_IN}),
 * capturing any leading whitespace and the marker as heading detection reads
 * it. Anchored: one try per key.
 */
const RUN_IN_MARKER_RE = new RegExp(
  String.raw`^(\s*(?:item[^\S\n]+\d{1,2}[a-z]?|part[^\S\n]+[ivx]{1,4}))${TITLE_RUN_IN}`,
  'i',
);

/**
 * `heading` with a space read in where its Item or Part marker runs straight
 * into its title ({@link RUN_IN_MARKER_RE}, #180) — "Part IFinancial
 * Information" → "Part I Financial Information" — so a test written for a
 * spaced marker reads the run-in one the way heading detection does. Any other
 * heading comes back unchanged.
 */
export function spaceRunInMarker(heading: string): string {
  return heading.replace(RUN_IN_MARKER_RE, '$1 ');
}

/** Terminal sentence punctuation on a folded key. */
const TERMINAL_PUNCTUATION_RE = /(?<![.,;:])[.,;:]+$/;

/**
 * Comparison key for a heading, a line, or a `section` needle — the dedup key
 * for detected headings and the operand of `section`'s exact tiers.
 * {@link foldForHeadingMatch} covers the whitespace and quote differences a
 * filing prints between its TOC and its body. Two remain:
 * - Terminal sentence punctuation: C3is' 20-F writes "Item 16J Insider Trading
 *   Policies" in the TOC and "…Policies." in the body.
 * - The separator between an Item or Part marker and its title: Worthington
 *   Steel's 10-Q prints "Item 1A. Risk Factors" in its TOC and "Item 1A. – Risk
 *   Factors" in its body, so both kept an entry and `section` landed on the TOC
 *   row (#174). A marker key is rebuilt as the marker, one space, and the title
 *   ("item 1a risk factors"), whatever period, dash, or colon stood between them.
 *   A title run straight into its marker gets the space read where heading
 *   detection ends the marker, before the fold lowercases the capital that marks
 *   it: "Item 1Financial Statements" keys as "item 1 financial statements", and
 *   dedups against a TOC row's "Item 1. Financial Statements" (#180).
 *
 * Key-only — the entry keeps the document's own heading text.
 */
export function headingKey(heading: string): string {
  const key = printedKey(spaceRunInMarker(heading));
  const [, marker, title] = MARKER_TITLE_RE.exec(key) ?? [];
  if (marker === undefined) return key;
  return title ? `${marker} ${title}` : marker;
}

/**
 * A heading's printed form for the running-header count: {@link headingKey}
 * short of the marker-separator fold. Page furniture repeats one printed form;
 * counted on the dedup key, a 10-Q's per-page "Part I. Financial Information"
 * pooled with its TOC row and body heading "PART I – FINANCIAL INFORMATION",
 * and the TOC row, first of the pool, took the body heading's place.
 */
function printedKey(heading: string): string {
  return foldForHeadingMatch(heading).replace(TERMINAL_PUNCTUATION_RE, '');
}

/**
 * A 20-F sub-item label opening a folded key: a digit-led one ("3d. ") or a
 * single letter ("b. "). Anchored, so it costs the same on any key.
 */
const SUB_ITEM_LABEL_RE = /^(?:\d{1,2}[a-z]|[a-z])\. /;

/**
 * A folded key with its leading 20-F sub-item label removed ("3d. risk factors"
 * → "risk factors"), or undefined when it opens on none (#175). 20-F filers label
 * sub-items ("3D. RISK FACTORS", "B. Business Overview"), so a plain-phrase
 * `section` never equalled the line. Comparison-time only: `section`'s exact and
 * line tiers compare a heading or line key both with and without its label,
 * while the caller's value is compared as given, and no labelled line becomes a
 * detected heading. A line opening on an initial ("L. John Doerr") strips the
 * same way, so it matches a value equal to the rest of the line.
 */
export function withoutSubItemLabel(key: string): string | undefined {
  const label = SUB_ITEM_LABEL_RE.exec(key);
  return label === null ? undefined : key.slice(label[0].length);
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
 * `maxChars` is the marker's title bound ({@link maxTitleChars}).
 */
function titleAfterMarkerLine(
  text: string,
  markerLineEnd: number,
  maxChars: number,
): string | undefined {
  SEPARATED_TITLE_RE.lastIndex = markerLineEnd;
  const separated = SEPARATED_TITLE_RE.exec(text)?.[1];
  if (separated !== undefined) return usableTitle(separated, maxChars);

  TIGHT_TITLE_RE.lastIndex = markerLineEnd;
  const tight = TIGHT_TITLE_RE.exec(text);
  if (tight === null) return;
  const [, title = '', lineBelow = ''] = tight;
  if (PAGE_NUMBER_LINE_RE.test(lineBelow)) return;
  return usableTitle(title, maxChars);
}

/**
 * A candidate title line reduced to heading text, or undefined when it is not a
 * title at all — empty, a bare page number, the next marker, or longer than
 * `maxChars`, where it reads as body prose.
 */
function usableTitle(raw: string, maxChars: number): string | undefined {
  const title = stripPageNumberTail(raw).trim();
  if (title.length === 0 || title.length > maxChars) return;
  if (/^\d+$/.test(title)) return;
  if (MARKER_OPENER_RE.test(title)) return;
  return title;
}

/**
 * The offset of the entry a heading match at `lineStart` records: the line
 * start, or past the one NBSP a same-line Item line may open on (#176). An
 * NBSP-led line yields no entry when its page cell stripped leaves a bare marker
 * ("ITEM 2.02", "Item 1.    3"), since the exception admits titled headings only.
 */
function itemEntryOffset(text: string, lineStart: number, heading: string): number | undefined {
  if (!text.startsWith(NBSP, lineStart)) return lineStart;
  if (BARE_MARKER_HEADING_RE.test(stripPageNumberTail(heading).trim())) return;
  return lineStart + 1;
}

/**
 * Detect every heading in extracted text and return them with their offsets,
 * sorted by offset. Deduplicates by {@link headingKey}, keeping the later
 * occurrence (handles TOC vs body duplicate headings — the body occurrence is
 * the more useful landing spot), drops running page headers, and drops a bare
 * Part entry that a later titled heading for the same Part follows. Uncapped:
 * `section` matches every heading, and the rendered outline makes its own cut.
 */
export function detectHeadings(text: string): FilingHeading[] {
  const matches: Array<{ heading: string; index: number }> = [];
  const add = (heading: string, index: number): void => {
    const trimmed = stripPageNumberTail(heading).trim();
    if (trimmed.length > 0) matches.push({ heading: trimmed, index });
  };

  // The guards read a line from its real start (`match.index`), the one NBSP an
  // Item line may open on included (#176); `itemEntryOffset` places the entry.
  ALL_CAPS_HEADING_RE.lastIndex = 0;
  for (
    let match = ALL_CAPS_HEADING_RE.exec(text);
    match !== null;
    match = ALL_CAPS_HEADING_RE.exec(text)
  ) {
    const [, heading, capsLine] = match;
    if (heading === undefined || isWrappedProse(text, match.index, heading)) continue;
    if (capsLine === undefined) {
      if (isRunTogetherToc(heading)) continue;
    } else {
      if (!isAllCapsHeadingText(capsLine)) continue;
      const partTitle = TITLED_PART_HEADING_RE.exec(capsLine)?.[2];
      if (partTitle !== undefined && isPartCrossReference(text, match.index, partTitle)) continue;
    }
    const offset = itemEntryOffset(text, match.index, heading);
    if (offset !== undefined) add(heading, offset);
  }

  ITEM_PART_HEADING_RE.lastIndex = 0;
  for (
    let match = ITEM_PART_HEADING_RE.exec(text);
    match !== null;
    match = ITEM_PART_HEADING_RE.exec(text)
  ) {
    const [, heading, itemCode, itemTitle = '', partTitle] = match;
    if (heading === undefined || isWrappedProse(text, match.index, heading)) continue;
    if (
      itemCode !== undefined &&
      (!sameLineTitleFits(itemCode, itemTitle) || isRunTogetherToc(heading))
    ) {
      continue;
    }
    if (
      partTitle !== undefined &&
      (!/^[A-Z]/.test(partTitle) || isPartCrossReference(text, match.index, partTitle))
    ) {
      continue;
    }
    const offset = itemEntryOffset(text, match.index, heading);
    if (offset !== undefined) add(heading, offset);
  }

  // Bare marker, title on a later line — the shape every Item takes in a 20-F
  // rendered one cell per line, in both the TOC and the body (#105).
  const bareMarkers: Array<{ marker: string; code: string; index: number; lineEnd: number }> = [];
  BARE_ITEM_MARKER_RE.lastIndex = 0;
  for (
    let match = BARE_ITEM_MARKER_RE.exec(text);
    match !== null;
    match = BARE_ITEM_MARKER_RE.exec(text)
  ) {
    const [, marker, code] = match;
    if (marker === undefined || code === undefined) continue;
    bareMarkers.push({
      marker: marker.trim(),
      code,
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

  for (const { marker, code, index, lineEnd } of bareMarkers) {
    if ((markerCounts.get(foldForHeadingMatch(marker)) ?? 0) >= RUNNING_HEADER_MIN_OCCURRENCES) {
      continue;
    }
    const title = titleAfterMarkerLine(text, lineEnd, maxTitleChars(code));
    if (title !== undefined) add(`${marker} ${title}`, index);
  }

  matches.sort((a, b) => a.index - b.index);

  // Distinct offsets, not raw match count: an all-caps "ITEM 1 BUSINESS" line
  // satisfies both the all-caps and the mixed-case arm, and counting it twice
  // would read three occurrences of one heading as page furniture.
  const positions = new Map<string, Set<number>>();
  for (const { heading, index } of matches) {
    const key = printedKey(heading);
    const seen = positions.get(key) ?? new Set<number>();
    seen.add(index);
    positions.set(key, seen);
  }

  // Keep the later occurrence of a heading (body vs TOC dedup heuristic — also
  // collapses "Part I" TOC vs "PART I" body). Page furniture inverts that: it
  // keeps the first occurrence, or none at all when it is a bare marker.
  // `matches` is offset-sorted, so the first write wins for furniture and the
  // last for everything else. Furniture keeps its first occurrence in a map of
  // its own, so a TOC row or body heading sharing its dedup key in another
  // separator form neither joins the count nor gives way to it.
  const byHeading = new Map<string, FilingHeading>();
  const furniture = new Map<string, FilingHeading>();
  for (const { heading, index } of matches) {
    const printed = printedKey(heading);
    if ((positions.get(printed)?.size ?? 0) >= RUNNING_HEADER_MIN_OCCURRENCES) {
      if (BARE_MARKER_HEADING_RE.test(heading)) continue;
      if (!furniture.has(printed)) furniture.set(printed, { heading, offset: index });
      continue;
    }
    byHeading.set(headingKey(heading), { heading, offset: index });
  }
  // An all-caps marker line ("ITEM 2.02") matches the all-caps arm on its own
  // and also joins the title below it; when both survive dedup at one offset,
  // the bare entry is the same heading listed twice.
  const entries = [...byHeading.values(), ...furniture.values()];
  const titledOffsets = new Set(
    entries.filter((h) => !BARE_MARKER_HEADING_RE.test(h.heading)).map((h) => h.offset),
  );
  const sorted = entries
    .filter((h) => !(BARE_MARKER_HEADING_RE.test(h.heading) && titledOffsets.has(h.offset)))
    .sort((a, b) => a.offset - b.offset);
  return dropBarePartsTitledLater(sorted);
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

/**
 * A TOC page cell on a line of its own: a page number, a lettered
 * financial-statement page ("F-3"), or a lowercase roman front-matter page
 * ("ii"), any of them optionally after a `Page` word ("Page 3"). Roman cells
 * count only on their own line — at the end of a line set off by spaces,
 * "Part    iv" would read as a page cell.
 */
const PAGE_CELL_LINE_RE =
  /^[^\S\n]*(?:(?:Page|PAGE)[^\S\n]+)?(?:\d{1,4}|[A-Z]-\d{1,3}|[ivxlc]{1,7})[^\S\n]*$/;
/**
 * A line opening on an Item or Part marker, bare, titled, or run straight into
 * its title ({@link TITLE_RUN_IN}, #180: "Item 1Financial Statements"). Non-global:
 * a predicate.
 */
const MARKER_LINE_RE = new RegExp(
  String.raw`^(?:item[^\S\n]+${ITEM_CODE}|part[^\S\n]+[ivx]{1,4})(?:\b|${TITLE_RUN_IN})`,
  'i',
);

/** A line with content and the index just past its newline. */
interface ContentLine {
  end: number;
  line: string;
}

/**
 * The first line at or after `from` holding anything but whitespace (NBSP
 * spacer rows count as whitespace), or undefined when none does. An HTML TOC
 * table renders each cell on its own line with spacer lines between ("Legal
 * Proceedings\n\n \n\n31"). A loop rather than a sticky `(?:[^\S\n]*\n)*`
 * regex, which kept a backtrack frame per spacer line and stepped up past about
 * 100,000 characters of them.
 */
function nextContentLine(text: string, from: number): ContentLine | undefined {
  for (let at = from; at < text.length; ) {
    const newline = text.indexOf('\n', at);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(at, end);
    if (/\S/.test(line)) return { end: end + 1, line };
    at = end + 1;
  }
  return;
}

/**
 * Whether `line`, whose newline ends just before `after`, is a TOC row. Its page
 * cell sits at its end ({@link TOC_PAGE_TAIL_RE}) or on the next line with
 * content ({@link PAGE_CELL_LINE_RE}), spacer lines passed over. A line that is
 * not itself a marker, followed directly by an Item/Part marker, is a title cell
 * of a TOC with no page column ("Business Overview" above the next row's "Item
 * 1A."). A marker line (a Part over its first Item) is a TOC row when that Item
 * row is: the Item line ends in a page cell, or the line below it holds one or
 * ends in one (a title cell, or a wrapped title: "Item 5. Market for…Issuer
 * Purchases / of Equity Securities.......  12"), or — a bare marker — the line
 * below its title holds one ("PART IV / Item 15. / Exhibit and Financial
 * Statement Schedules / 93"). A body Part sits over its Item too, but prose, not
 * a page cell, follows.
 */
function isTocRow(text: string, line: string, after: number): boolean {
  if (TOC_PAGE_TAIL_RE.test(line)) return true;
  const item = nextContentLine(text, after);
  if (item === undefined) return false;
  if (PAGE_CELL_LINE_RE.test(item.line)) return true;
  if (!MARKER_LINE_RE.test(item.line.trim())) return false;
  if (!MARKER_LINE_RE.test(line.trim())) return true;
  if (TOC_PAGE_TAIL_RE.test(item.line)) return true;
  const below = nextContentLine(text, item.end);
  if (below === undefined) return false;
  if (PAGE_CELL_LINE_RE.test(below.line) || TOC_PAGE_TAIL_RE.test(below.line)) return true;
  if (!BARE_MARKER_HEADING_RE.test(item.line.trim())) return false;
  const page = nextContentLine(text, below.end);
  return page !== undefined && PAGE_CELL_LINE_RE.test(page.line);
}

/**
 * Whether a detected heading sits on a table-of-contents row, so `section` ranks
 * it after every body heading of its tier (#174). The test runs on the heading's
 * title line: its own line, or for a bare marker or a marker joined to a later
 * title, the next line with content. That line is a TOC row by {@link isTocRow}
 * (the line tiers' own test), or when the next line with content ends in a page
 * cell — a TOC title wrapped onto a second line (Aware's "Item 5. Market for…
 * Issuer Purchases / of Equity Securities.......  12").
 *
 * A title can also wrap once with its page cell on a line of its own under the
 * wrap (#183): DRDGOLD's "ITEM 14." / "MATERIAL MODIFICATIONS TO THE RIGHTS OF
 * SECURITY HOLDERS AND USE OF" / "PROCEEDS" / "79". That reads as a TOC row only
 * when the title line, the continuation, and a page-cell line
 * ({@link PAGE_CELL_LINE_RE}) sit on three consecutive lines and the
 * continuation keeps the title line's case — no lowercase letter under an
 * all-caps title line, an opening lowercase one under a mixed-case title line
 * ("of Equity Securities"). A body heading over one line of body text and a page
 * number has the same three lines: across 26 sampled filings, the step without
 * those two conditions flagged 47 body headings ("Item 4. Mine Safety
 * Disclosures" / "Not applicable." / "31", spacer lines between or not), and
 * with them only DRDGOLD's TOC row and its title cell. One body shape still
 * reads as a TOC row: an all-caps heading over a one-word all-caps line and a
 * page number ("ITEM 4. MINE SAFETY DISCLOSURES" / "NONE" / "31").
 *
 * Three TOC shapes survive dedup: a body heading worded apart from its TOC row
 * (First Bancorp's 8-K: "Item 9.01 Financial Statements and Exhibits.    Page 1"
 * over the body's "…Pro Forma Financial Information and Exhibits."), a bare
 * all-caps marker over a title cell and a page cell (DRDGOLD's 20-F: "ITEM 3." /
 * "KEY INFORMATION" / "6"), and the title cell itself.
 *
 * The test reads a page number under a body heading the same way (CCC's 10-K sets
 * "Item 6. Reserved." over its page number), which is why a TOC row is only
 * ranked last in its tier rather than dropped: alone in the tier, it still lands.
 * A heading's offset can sit one past its line start (an NBSP-led Item, #176), so
 * the line is found from the newline before it.
 */
export function isTocHeading(text: string, heading: FilingHeading): boolean {
  const lineStart = text.lastIndexOf('\n', heading.offset - 1) + 1;
  const newline = text.indexOf('\n', heading.offset);
  const lineEnd = newline === -1 ? text.length : newline;
  const titledHere =
    !BARE_MARKER_HEADING_RE.test(heading.heading) &&
    text.startsWith(heading.heading, heading.offset);
  const title = titledHere
    ? { line: text.slice(lineStart, lineEnd), end: lineEnd + 1 }
    : nextContentLine(text, lineEnd + 1);
  if (title === undefined) return false;
  if (isTocRow(text, title.line, title.end)) return true;
  const below = nextContentLine(text, title.end);
  if (below === undefined) return false;
  if (TOC_PAGE_TAIL_RE.test(below.line)) return true;
  // The title wrapped once, its page cell on the line under the wrap (#183).
  if (below.end - below.line.length - 1 !== title.end) return false;
  const continuation = below.line.trimStart();
  const sameCase = /\p{Ll}/u.test(title.line)
    ? /^\p{Ll}/u.test(continuation)
    : !/\p{Ll}/u.test(continuation);
  if (!sameCase) return false;
  const pageEnd = text.indexOf('\n', below.end);
  return PAGE_CELL_LINE_RE.test(text.slice(below.end, pageEnd === -1 ? text.length : pageEnd));
}

/**
 * Whether a prefix line runs on past a one-word needle into a longer Title Case
 * title — the next word opens on a capital in a line that is not all caps. One
 * word heads many unrelated titles: `business` reached "Business Combinations.",
 * "Business Seasonality and Product Introductions", and a cross-reference line
 * "Business Overview—Governmental regulations…" across the sampled filings. A
 * needle of two or more words is specific enough to keep its continuation
 * ("Human Capital" → "Human Capital Management"), and a suffix opening
 * lowercase ("as of June 30, 2026") or on punctuation ("(continued)",
 * "—Parent Company Only") continues the needle's own heading. `key` is the
 * line's {@link headingKey}, which starts with `needle` — for a labelled line,
 * the key and the line both past the label (#175); folding maps every whitespace
 * run to one space, so the needle is exactly the line's first word.
 */
function continuesIntoLongerTitle(line: string, key: string, needle: string): boolean {
  if (needle.includes(' ') || key.charAt(needle.length) !== ' ') return false;
  if (!/\p{Ll}/u.test(line)) return false;
  return /^\p{Lu}/u.test(line.trim().split(/\s+/)[1] ?? '');
}

/**
 * Whether a line whose key is `key` is a prefix-tier landing for `needle`: the
 * key starts with it at a word boundary, runs at most {@link MAX_TITLE_CHARS}
 * characters, and does not run on into a longer title.
 */
function startsWithTitle(line: string, key: string, needle: string): boolean {
  return (
    key.length <= MAX_TITLE_CHARS &&
    key.startsWith(needle) &&
    !/[\p{L}\p{N}]/u.test(key.charAt(needle.length)) &&
    !continuesIntoLongerTitle(line, key, needle)
  );
}

/** The longest row label: a figure row's own, or one {@link labelsTableRow} reads past. */
const MAX_ROW_LABEL_CHARS = 60;

/**
 * Whether a line is a table row's figure cells: a lone currency or nil cell
 * (`$`, `-`, `–`, `—`), or a line whose text after its last letter holds a
 * digit and — when the line has a letter — opens on a dotted leader, a tab, or
 * two or more spaces, behind a label of at most {@link MAX_ROW_LABEL_CHARS}
 * characters ("Product sales.......  $4,759", "$ 7,746    $ `7,835" with a
 * stray backtick in a 2004 cell). One space never sets figures off: "The
 * effective rate was 21%." is prose. Past the label bound the line is a whole
 * table set on one line (AMC Robotics' S-1 MD&A "Revenue" over "Three months
 * ended June 30,  2026  2025  $ Change …"), which a heading may sit over. A nil
 * cell is the only figure some rows print (Worthington Steel's "Goodwill" over
 * "-"). One backward pass to the last letter.
 */
function isFigureRow(line: string): boolean {
  const content = line.trim();
  if (/^[$€£\-–—]$/.test(content)) return true;
  let lastLetter = content.length - 1;
  while (lastLetter >= 0 && !/\p{L}/u.test(content.charAt(lastLetter))) lastLetter--;
  const tail = content.slice(lastLetter + 1);
  if (!/\d/.test(tail)) return false;
  if (lastLetter === -1) return true;
  return lastLetter < MAX_ROW_LABEL_CHARS && /^(?:\.{2,}|[^\S\n]{2,}|\t)/.test(tail);
}

/**
 * Whether the line whose newline ends just before `after` labels a table row
 * (#184): the next line with content, spacer lines passed over, is a figure row
 * ({@link isFigureRow}), or is a label — at most {@link MAX_ROW_LABEL_CHARS}
 * characters, opening uppercase, ending on no `.`, `:`, `;`, or `,`, closing
 * quotes and brackets passed over ("See “Item 18. Financial Statements.”") —
 * whose next line with content is one (Microsoft's 2004 segment table: "Revenue"
 * / "Client" / "$ 9,350 …"). Reads at most two content lines.
 */
function labelsTableRow(text: string, after: number): boolean {
  const next = nextContentLine(text, after);
  if (next === undefined) return false;
  if (isFigureRow(next.line)) return true;
  const label = next.line.trim();
  if (
    label.length > MAX_ROW_LABEL_CHARS ||
    !/^\p{Lu}/u.test(label) ||
    /[.:;,]["'”’)\]]*$/.test(label)
  ) {
    return false;
  }
  const below = nextContentLine(text, next.end);
  return below !== undefined && isFigureRow(below.line);
}

/** A document line `section` names: where it starts, and the tier it ranks in. */
export interface SectionLine {
  /**
   * True for a line equal to the needle that labels no table row; false for a
   * table-row label equal to the needle, or a line that only starts with it —
   * the two `section` ranks after every heading containing the value (#184).
   */
  equal: boolean;
  offset: number;
}

/**
 * The document line `section` names — a mixed-case subheading ("Liquidity and
 * Capital Resources") that {@link detectHeadings} never lists (#166). Lines
 * compare by {@link headingKey} on both sides, in three tiers:
 * 1. A line equal to the needle that labels no table row.
 * 2. Only when tier 1 finds none: an equal line that labels a table row
 *    ({@link labelsTableRow}, #184). Every line equal to `revenue` in
 *    Microsoft's 2004 10-K labels one (the selected-data row, a segment table's
 *    label over a client label over figures), and as an equal line one took the
 *    value from the MD&A heading containing it; demoted rather than skipped, the
 *    income-statement "Total revenue" row still answers `total revenue`.
 * 3. Only when neither finds one: a line that starts with the needle at a word
 *    boundary and runs at most {@link MAX_TITLE_CHARS} characters — a heading
 *    with a date suffix ("Consolidated Schedule of Investments as of June 30,
 *    2026") — unless it runs on into a longer title
 *    ({@link continuesIntoLongerTitle}). Equality goes first because the prefix
 *    tier alone would take a bullet such as "Competition among vendors…" ahead
 *    of the "Competition" heading.
 *
 * The result says which tier hit, because `section` ranks them apart (#177): a
 * tier-1 line (`equal: true`) ahead of a heading that only contains the value,
 * a row label or prefix line (`equal: false`) after every heading. One pass
 * yields all three, so a caller needing each pays for one scan.
 *
 * Every tier also compares the line's key with a leading 20-F sub-item label
 * removed ({@link withoutSubItemLabel}, #175), so `risk factors` reaches "3D.
 * RISK FACTORS"; the longer-title test then judges the line after its label
 * ("B. Business Overview" keeps `business` out). The needle is never stripped,
 * so a labelled value still matches its own line. The landing is the line's
 * first character, label included.
 *
 * In every tier a line is skipped when it opens on a lowercase letter (a
 * wrapped sentence or bullet: "competition in our market…", a lone "business."
 * ending a wrapped paragraph), sits under a line ending mid-sentence or opens on
 * an unpunctuated Item marker followed by a lowercase word (a wrapped
 * cross-reference, the guards heading detection applies: "…in Part II,\nItem 8
 * on this Form 10-K…"), or is a TOC row ({@link isTocRow}). The first remaining
 * line of the best tier wins; its offset is the line's first non-blank
 * character. One forward pass over the text, the row-label test reading at most
 * two content lines past an equal line; a line too short to key as the needle is
 * never folded.
 */
export function matchSectionLine(text: string, section: string): SectionLine | undefined {
  const needle = headingKey(section);
  if (needle.length === 0) return;
  let labelHit: number | undefined;
  let prefixHit: number | undefined;
  for (let start = 0; start <= text.length; ) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(start, end);
    const lineStart = start;
    start = end + 1;
    // The key of a line whose marker runs into its title gains a space (#180).
    if (line.length + 1 < needle.length) continue;
    const key = headingKey(line);
    const unlabelled = withoutSubItemLabel(key);
    const equal = key === needle || unlabelled === needle;
    if (
      !equal &&
      (prefixHit !== undefined ||
        !(
          startsWithTitle(line, key, needle) ||
          (unlabelled !== undefined &&
            startsWithTitle(line.trimStart().replace(/^\S+\s+/, ''), unlabelled, needle))
        ))
    ) {
      continue;
    }
    const content = line.trimStart();
    if (/^\p{Ll}/u.test(content)) continue;
    if (followsMidSentence(text, lineStart) || isWrappedProse(text, lineStart, content)) continue;
    if (isTocRow(text, line, start)) continue;
    const offset = lineStart + line.length - content.length;
    if (!equal) prefixHit = offset;
    else if (!labelsTableRow(text, start)) return { equal, offset };
    else labelHit ??= offset;
  }
  const fallback = labelHit ?? prefixHit;
  return fallback === undefined ? undefined : { equal: false, offset: fallback };
}

/** The offset of the line {@link matchSectionLine} lands on, from its best tier. */
export function findSectionLine(text: string, section: string): number | undefined {
  return matchSectionLine(text, section)?.offset;
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
