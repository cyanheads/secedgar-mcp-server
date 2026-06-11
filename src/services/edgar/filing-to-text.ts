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
 * Regex that matches SEC document headings:
 * - "ITEM N" / "ITEM NA" lines (10-K, 10-Q structure)
 * - All-caps lines of 9+ characters (registration statement TOC headings like "RISK FACTORS")
 *
 * Anchored to start-of-line, captures the line text up to a natural end.
 * Heuristic — best-effort, not guaranteed to match all or only headings.
 */
const HEADING_RE = /^(ITEM\s+\d+[A-Z]?\b[^\n]*|[A-Z][A-Z\s,()&./]{8,})\s*$/gm;

/**
 * Detect headings in extracted text and return them with their offsets.
 * Deduplicates by heading text, keeping the later occurrence (handles TOC vs body
 * duplicate headings — body occurrence is the more useful landing spot).
 * Caps output at maxEntries.
 */
export function detectHeadings(text: string, maxEntries = 50): FilingHeading[] {
  const byHeading = new Map<string, number>();
  HEADING_RE.lastIndex = 0;
  for (let match = HEADING_RE.exec(text); match !== null; match = HEADING_RE.exec(text)) {
    // For identical heading text, keep the later occurrence (body vs TOC dedup heuristic)
    const heading = match[1];
    if (heading !== undefined) byHeading.set(heading.trim(), match.index);
  }
  const results: FilingHeading[] = [];
  for (const [heading, offset] of byHeading) {
    results.push({ heading, offset });
    if (results.length >= maxEntries) break;
  }
  return results;
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
