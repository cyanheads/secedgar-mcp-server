/**
 * @fileoverview The walk over a filer's submissions archive pages
 * (`filings.files[]`) — every filing older than the submissions feed's `recent`
 * window, which SEC sizes at one year or 1,000 filings, whichever holds more. Every
 * tool that reaches past `recent` walks through here, so they share one page cap, one
 * rule for when `recent` already covers the range, and one way of reporting how far
 * the scan reached and whether pages it selected went unread.
 * @module services/edgar/submissions-archive
 */

import type { FilingsRecent, SubmissionsResponse } from './types.js';

/**
 * Most archive pages one call reads. A page runs 200–360 KB and costs one request
 * through the service's pacer; SEC answers a burst over its limit with a ten-minute
 * block, so a walk is bounded at this many requests beyond the submissions document.
 */
export const ARCHIVE_PAGE_SCAN_CAP = 10;

/** One entry of the archive-page manifest (`filings.files[]`). */
export type ArchivePageEntry = SubmissionsResponse['filings']['files'][number];

/** Where pages are read from — `EdgarApiService`, whose page cache and pacer every read goes through. */
export interface ArchivePageSource {
  fetchArchivePage(name: string): Promise<FilingsRecent>;
}

/** Which pages a walk selects and the order it reads them in. */
export interface ArchiveWalkOptions {
  /** Inclusive lower filing-date bound (YYYY-MM-DD). */
  filedAfter?: string | undefined;
  /** Inclusive upper filing-date bound (YYYY-MM-DD). */
  filedBefore?: string | undefined;
  /**
   * `newest-first` reads back in time from the newest selected page. `oldest-first`
   * reads forward in time from the page covering `filedAfter` — the order a caller
   * wants when the filing it looks for follows a known date and the first page
   * holding it ends the search.
   */
  order: 'newest-first' | 'oldest-first';
}

/** A page the walk read: its manifest entry and its filings. */
export interface ArchivePageRead {
  block: FilingsRecent;
  page: ArchivePageEntry;
}

/** A YYYY-MM-DD date moved by `days`, in UTC. */
function shiftDate(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/**
 * Pages overlapping `[filedAfter, filedBefore]`, ordered for the walk. A page is kept
 * unless its `[filingFrom, filingTo]` span lies wholly outside the bounds widened by a
 * day on each side; with no bounds every page is kept. The manifest's bounds can sit a
 * day off the page's own rows in either direction — JPMorgan's page 041 is listed to
 * 2021-02-17 but holds 42 filings dated 2021-02-18 — so an exact test would skip the
 * page holding a window's edge day (#137). The slack costs at most one extra page at
 * each bound; callers filter rows by their own filing dates.
 */
export function selectArchivePages(
  files: readonly ArchivePageEntry[],
  options: ArchiveWalkOptions,
): ArchivePageEntry[] {
  const { order } = options;
  const lower = options.filedAfter && shiftDate(options.filedAfter, -1);
  const upper = options.filedBefore && shiftDate(options.filedBefore, 1);
  const kept = files.filter(
    (page) => !(lower && page.filingTo < lower) && !(upper && page.filingFrom > upper),
  );
  return order === 'newest-first'
    ? kept.sort((a, b) => b.filingTo.localeCompare(a.filingTo))
    : kept.sort((a, b) => a.filingTo.localeCompare(b.filingTo));
}

/**
 * A walk over one filer's archive pages, read one at a time, at most
 * `ARCHIVE_PAGE_SCAN_CAP` of them. The caller reads `recent` itself first; when
 * `filedAfter` falls on or after `recent`'s oldest filing date, `recent` already
 * holds everything in range and the walk selects no page, so that call sends no
 * archive request. SEC keeps a filing day whole inside `recent` (a filer's window
 * can run past 1,000 rows to finish its oldest day), so no archive page holds a
 * filing dated on or after that day.
 *
 * Iterate it with `for await`; breaking out after any page ends the walk there.
 * Afterwards `scannedThrough` and `truncated` describe what was read.
 */
export class SubmissionsArchiveWalk implements AsyncIterable<ArchivePageRead> {
  private readonly pages: ArchivePageEntry[];
  private read = 0;
  private oldestRead: string | undefined;

  constructor(
    private readonly source: ArchivePageSource,
    submissions: SubmissionsResponse,
    options: ArchiveWalkOptions,
  ) {
    const recentOldest = submissions.filings.recent.filingDate.at(-1);
    const coveredByRecent = Boolean(
      options.filedAfter && recentOldest && options.filedAfter >= recentOldest,
    );
    this.pages = coveredByRecent ? [] : selectArchivePages(submissions.filings.files, options);
  }

  /** Pages read so far. */
  get pagesRead(): number {
    return this.read;
  }

  /** Oldest filing date the pages read so far reach (their earliest `filingFrom`). Undefined before any read. */
  get scannedThrough(): string | undefined {
    return this.oldestRead;
  }

  /** True while selected pages remain unread — the cap ended the walk, or the caller stopped it early. */
  get truncated(): boolean {
    return this.read < this.pages.length;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ArchivePageRead> {
    const limit = Math.min(this.pages.length, ARCHIVE_PAGE_SCAN_CAP);
    while (this.read < limit) {
      const page = this.pages[this.read] as ArchivePageEntry;
      const block = await this.source.fetchArchivePage(page.name);
      this.read++;
      if (!this.oldestRead || page.filingFrom < this.oldestRead) this.oldestRead = page.filingFrom;
      yield { block, page };
    }
  }
}
