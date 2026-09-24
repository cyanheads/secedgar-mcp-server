/**
 * @fileoverview The shared submissions-archive walk: page selection and order, the
 * rule that sends no archive request when `recent` covers the range, the page cap,
 * a caller stopping early, and the scan-depth / truncation it reports.
 * @module tests/services/edgar/submissions-archive
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ARCHIVE_PAGE_SCAN_CAP,
  type ArchivePageEntry,
  SubmissionsArchiveWalk,
  selectArchivePages,
} from '@/services/edgar/submissions-archive.js';
import type { FilingsRecent, SubmissionsResponse } from '@/services/edgar/types.js';

/** Fourteen yearly pages, newest first: 001 = 2014 … 014 = 2001. */
const FILES: ArchivePageEntry[] = Array.from({ length: 14 }, (_, i) => ({
  name: `page-${String(i + 1).padStart(3, '0')}`,
  filingCount: 1,
  filingFrom: `${2014 - i}-01-01`,
  filingTo: `${2014 - i}-12-31`,
}));

const EMPTY_BLOCK: FilingsRecent = {
  accessionNumber: [],
  filingDate: [],
  form: [],
  primaryDocDescription: [],
  primaryDocument: [],
  reportDate: [],
};

function submissions(recentDates: string[], files = FILES): SubmissionsResponse {
  return {
    cik: '0000000001',
    entityType: 'operating',
    exchanges: [],
    filings: {
      recent: { ...EMPTY_BLOCK, filingDate: recentDates, accessionNumber: recentDates },
      files,
    },
    fiscalYearEnd: null,
    name: 'Test Filer',
    sic: '',
    sicDescription: '',
    tickers: [],
  };
}

/** A page source that records the order of reads and how many ran at once. */
function recordingSource() {
  let inFlight = 0;
  const source = {
    maxInFlight: 0,
    fetchArchivePage: vi.fn(async (_name: string) => {
      inFlight++;
      source.maxInFlight = Math.max(source.maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return EMPTY_BLOCK;
    }),
  };
  return source;
}

async function drain(walk: SubmissionsArchiveWalk, stopAfter = Number.POSITIVE_INFINITY) {
  const names: string[] = [];
  for await (const { page } of walk) {
    names.push(page.name);
    if (names.length >= stopAfter) break;
  }
  return names;
}

const RECENT = ['2026-09-01', '2015-06-01'];

describe('selectArchivePages', () => {
  it('keeps pages overlapping the bounds, both inclusive, newest first', () => {
    const pages = selectArchivePages(FILES, {
      filedAfter: '2010-12-31',
      filedBefore: '2012-01-01',
      order: 'newest-first',
    });
    expect(pages.map((p) => p.name)).toEqual(['page-003', 'page-004', 'page-005']);
  });

  it('orders the same selection forward in time for oldest-first', () => {
    const pages = selectArchivePages(FILES, { filedAfter: '2010-06-30', order: 'oldest-first' });
    expect(pages.map((p) => p.name)).toEqual([
      'page-005',
      'page-004',
      'page-003',
      'page-002',
      'page-001',
    ]);
  });

  it('keeps every page with no bounds', () => {
    expect(selectArchivePages(FILES, { order: 'newest-first' })).toHaveLength(14);
  });

  // The manifest's page bounds can sit a day off the page's own rows (#137).
  describe('one-day manifest drift (#137)', () => {
    /** JPMorgan's pages 040 / 041: 041 is listed to 2021-02-17 but holds rows dated 2021-02-18. */
    const JPM_PAGES: ArchivePageEntry[] = [
      { name: 'jpm-040', filingCount: 2004, filingFrom: '2021-02-19', filingTo: '2021-04-18' },
      { name: 'jpm-041', filingCount: 2044, filingFrom: '2020-12-15', filingTo: '2021-02-17' },
      { name: 'jpm-042', filingCount: 2000, filingFrom: '2020-10-01', filingTo: '2020-12-13' },
    ];

    it('keeps a page whose listed end trails a window starting the next day', () => {
      const pages = selectArchivePages(JPM_PAGES, {
        filedAfter: '2021-02-18',
        filedBefore: '2021-02-18',
        order: 'newest-first',
      });
      // 041 holds the day; 040's listed start is one day past it and is kept too.
      expect(pages.map((p) => p.name)).toEqual(['jpm-040', 'jpm-041']);
    });

    it('keeps a page whose listed start leads a window ending the day before', () => {
      const pages = selectArchivePages(JPM_PAGES, {
        filedAfter: '2020-12-14',
        filedBefore: '2020-12-14',
        order: 'newest-first',
      });
      expect(pages.map((p) => p.name)).toEqual(['jpm-041', 'jpm-042']);
    });

    it('still drops a page two days or more outside the window', () => {
      const pages = selectArchivePages(JPM_PAGES, {
        filedAfter: '2021-02-20',
        filedBefore: '2021-03-01',
        order: 'newest-first',
      });
      expect(pages.map((p) => p.name)).toEqual(['jpm-040']);
    });

    it('widens across month and year ends', () => {
      const yearEnd: ArchivePageEntry[] = [
        { name: 'y', filingCount: 1, filingFrom: '2020-01-01', filingTo: '2020-12-31' },
      ];
      expect(
        selectArchivePages(yearEnd, { filedAfter: '2021-01-01', order: 'newest-first' }),
      ).toHaveLength(1);
      expect(
        selectArchivePages(yearEnd, { filedBefore: '2019-12-31', order: 'newest-first' }),
      ).toHaveLength(1);
      expect(
        selectArchivePages(yearEnd, { filedAfter: '2021-01-02', order: 'newest-first' }),
      ).toHaveLength(0);
    });
  });
});

describe('SubmissionsArchiveWalk', () => {
  it('reads pages one at a time, never in parallel', async () => {
    const source = recordingSource();
    const walk = new SubmissionsArchiveWalk(source, submissions(RECENT), {
      filedAfter: '2011-01-01',
      order: 'newest-first',
    });

    // page-005 ends 2010-12-31, a day before the bound, and is kept for manifest drift (#137).
    expect(await drain(walk)).toEqual(['page-001', 'page-002', 'page-003', 'page-004', 'page-005']);
    expect(source.maxInFlight).toBe(1);
    expect(walk.pagesRead).toBe(5);
    expect(walk.scannedThrough).toBe('2010-01-01');
    expect(walk.truncated).toBe(false);
  });

  it('selects no page when the lower bound falls on recent’s oldest date', async () => {
    const source = recordingSource();
    const walk = new SubmissionsArchiveWalk(source, submissions(RECENT), {
      filedAfter: '2015-06-01',
      order: 'oldest-first',
    });

    expect(await drain(walk)).toEqual([]);
    expect(source.fetchArchivePage).not.toHaveBeenCalled();
    expect(walk.scannedThrough).toBeUndefined();
    expect(walk.truncated).toBe(false);
  });

  it('selects no page when the lower bound is newer than recent’s oldest date', async () => {
    const source = recordingSource();
    // Page 001 claims to reach 2015-12-31, past recent's oldest row — still skipped.
    const walk = new SubmissionsArchiveWalk(source, submissions(RECENT), {
      filedAfter: '2015-07-01',
      order: 'newest-first',
    });

    expect(await drain(walk)).toEqual([]);
    expect(source.fetchArchivePage).not.toHaveBeenCalled();
  });

  it('walks the archive when the lower bound predates recent, and when recent is empty', async () => {
    const before = new SubmissionsArchiveWalk(recordingSource(), submissions(RECENT), {
      filedAfter: '2014-06-30',
      order: 'newest-first',
    });
    expect(await drain(before)).toEqual(['page-001']);

    const empty = new SubmissionsArchiveWalk(recordingSource(), submissions([]), {
      filedAfter: '2014-01-01',
      order: 'newest-first',
    });
    // page-002 ends 2013-12-31, within the one-day drift allowance (#137).
    expect(await drain(empty)).toEqual(['page-001', 'page-002']);
  });

  it(`stops at the ${ARCHIVE_PAGE_SCAN_CAP}-page cap and reports the rest unread`, async () => {
    const source = recordingSource();
    const walk = new SubmissionsArchiveWalk(source, submissions(RECENT), { order: 'newest-first' });

    const names = await drain(walk);
    expect(names).toHaveLength(ARCHIVE_PAGE_SCAN_CAP);
    expect(names.at(0)).toBe('page-001');
    expect(names.at(4)).toBe('page-005');
    expect(names.at(-1)).toBe('page-010');
    expect(walk.scannedThrough).toBe('2005-01-01');
    expect(walk.truncated).toBe(true);
  });

  it('reads exactly the cap without truncation when the selection is the cap', async () => {
    const walk = new SubmissionsArchiveWalk(
      recordingSource(),
      submissions(RECENT, FILES.slice(0, 10)),
      {
        order: 'newest-first',
      },
    );

    expect(await drain(walk)).toHaveLength(10);
    expect(walk.truncated).toBe(false);
  });

  it('ends where the caller stops, reporting the unread pages as truncated', async () => {
    const source = recordingSource();
    const walk = new SubmissionsArchiveWalk(source, submissions(RECENT), { order: 'newest-first' });

    expect(await drain(walk, 2)).toEqual(['page-001', 'page-002']);
    expect(source.fetchArchivePage).toHaveBeenCalledTimes(2);
    expect(walk.scannedThrough).toBe('2013-01-01');
    expect(walk.truncated).toBe(true);
  });

  it('walks forward from the page covering the lower bound, stopping on the first page it needs', async () => {
    const source = recordingSource();
    const walk = new SubmissionsArchiveWalk(source, submissions(RECENT), {
      filedAfter: '2004-12-31',
      order: 'oldest-first',
    });

    expect(await drain(walk, 1)).toEqual(['page-011']);
    // The page covering the bound is where the scan reaches back to.
    expect(walk.scannedThrough).toBe('2004-01-01');
    expect(walk.truncated).toBe(true);
  });

  it('selects nothing for a filer with no archive pages', async () => {
    const walk = new SubmissionsArchiveWalk(recordingSource(), submissions(RECENT, []), {
      order: 'newest-first',
    });

    expect(await drain(walk)).toEqual([]);
    expect(walk.truncated).toBe(false);
  });
});

describe('SubmissionsArchiveWalk — one-day manifest drift (#137)', () => {
  /** Apple-shaped: page 001 is listed to 2015-07-25, one day past its newest row (2015-07-24). */
  const APPLE_FILES: ArchivePageEntry[] = [
    { name: 'aapl-001', filingCount: 1249, filingFrom: '1994-01-26', filingTo: '2015-07-25' },
  ];

  it('reads a page whose listed end leads its rows, for a window just past them', async () => {
    const source = recordingSource();
    const walk = new SubmissionsArchiveWalk(
      source,
      submissions(['2026-09-22', '2015-07-27'], APPLE_FILES),
      {
        filedAfter: '2015-07-26',
        order: 'newest-first',
      },
    );

    // One extra page at the boundary; the caller's own row filter drops its rows.
    expect(await drain(walk)).toEqual(['aapl-001']);
  });

  it('leaves the recent-window skip in charge: a drifting page is never read once recent covers the bound', async () => {
    const source = recordingSource();
    const walk = new SubmissionsArchiveWalk(
      source,
      submissions(['2026-09-22', '2015-07-26'], APPLE_FILES),
      {
        filedAfter: '2015-07-26',
        order: 'newest-first',
      },
    );

    expect(await drain(walk)).toEqual([]);
    expect(source.fetchArchivePage).not.toHaveBeenCalled();
    expect(walk.truncated).toBe(false);
  });
});
