/**
 * @fileoverview Convert SEC filing HTML to readable plain text, with extraction caching and
 * offset/section windowing support.
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

/**
 * Bounded LRU cache for extracted filing text.
 * SEC filings are immutable — cache indefinitely up to the bound.
 * Entries can be multi-megabyte strings, so the bound is kept tight.
 */
const EXTRACT_CACHE_MAX = 8;
/** Internal structure: insertion-ordered Map (oldest first) used as an LRU. */
const extractCache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const value = extractCache.get(key);
  if (value === undefined) return;
  // Refresh: move to end (most recently used)
  extractCache.delete(key);
  extractCache.set(key, value);
  return value;
}

function cacheSet(key: string, value: string): void {
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
 * Extract full plain text from filing HTML. Pure and deterministic — the same HTML
 * always yields the same string. Caching is the caller's responsibility via
 * `getExtractCache`/`setExtractCache` (keyed `accession:document`), which lets a
 * cache hit skip the document fetch as well as this conversion.
 */
export function filingToExtract(html: string): string {
  return convert(stripInlineXbrl(html), CONVERT_OPTIONS);
}

/** Return true if the cache has an entry for cacheKey (allows skipping the document fetch). */
export function hasExtractCache(cacheKey: string): boolean {
  return extractCache.has(cacheKey);
}

/**
 * Retrieve a cached extraction by key, or undefined if not cached.
 * Used by the handler to skip both the fetch AND the conversion on a cache hit.
 */
export function getExtractCache(cacheKey: string): string | undefined {
  return cacheGet(cacheKey);
}

/** Store a pre-extracted string in the cache (used by handler after a successful fetch). */
export function setExtractCache(cacheKey: string, text: string): void {
  cacheSet(cacheKey, text);
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
 * Heuristics — best-effort, not guaranteed to match all or only headings.
 */
const ALL_CAPS_HEADING_RE =
  /^(ITEM[^\S\n]+\d+[A-Z]?\b[^\n]*|[A-Z](?:[A-Z,()&./]|[^\S\n]){8,})[^\S\n]*$/gm;
const ITEM_PART_HEADING_RE =
  /^(item[^\S\n]+\d{1,2}[a-z]?\.?[^\S\n]+\S[^\n]{0,140}|part[^\S\n]+[ivx]{1,4}\b\.?)[^\S\n]*$/gim;
const BARE_ITEM_MARKER_RE = /^(item[^\S\n]+\d{1,2}[a-z]?\.?)[^\S\n]*$/gim;

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
/** A trailing bare page number, as a TOC line carries it ("Key Information      3"). */
const PAGE_NUMBER_TAIL_RE = /[^\S\n]+\d{1,4}[^\S\n]*$/;
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
      if (heading !== undefined) add(heading, match.index);
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
  const full = convert(stripInlineXbrl(html), CONVERT_OPTIONS);
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
