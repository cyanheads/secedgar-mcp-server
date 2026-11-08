/**
 * @fileoverview Bounds on EdgarApiService's per-key document caches — submissions documents,
 * submissions archive pages, and full-index quarters. Each holds at most its
 * `CACHE_BYTE_LIMITS` share, weighing every entry by the service's own per-value and per-row
 * estimates; past it the entry used longest ago (a read counts as use) is dropped, an entry
 * heavier than the whole limit is not kept, and an expired entry is dropped when read. The
 * config and mirror modules are mocked and `globalThis.fetch` stubbed; every observable is
 * the requests sent.
 * @module tests/services/edgar/edgar-api-service.caches
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { config } = vi.hoisted(() => ({
  config: {
    userAgent: 'test test@example.com',
    rateLimitRps: 1000,
    rateLimitCooldownSeconds: 600,
    tickerCacheTtl: 3600,
    mirrorFallbackLive: true,
  },
}));

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));
vi.mock('@/services/edgar/mirror/index.js', () => ({ getEdgarMirror: () => undefined }));

import { CallScope } from '@/services/edgar/call-scope.js';
import {
  CACHE_BYTE_LIMITS,
  FILING_VALUE_BYTES,
  FULL_INDEX_ROW_BYTES,
  getEdgarApiService,
  initEdgarApiService,
  SUBMISSIONS_DOC_BYTES,
} from '@/services/edgar/edgar-api-service.js';

const scope = () => new CallScope(new AbortController().signal);

const T0 = new Date('2026-11-08T15:00:00.000Z').getTime();
const TTL_MS = config.tickerCacheTtl * 1000;

/** Serve each URL the body (or bare status) set for it; anything else rejects. Returns every URL requested, in order. */
function stubSec() {
  const bodies = new Map<string, string | number>();
  const requested: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requested.push(url);
      const body = bodies.get(url);
      if (body === undefined) throw new Error(`unrouted fetch: ${url}`);
      if (typeof body === 'number') return new Response(`status ${body}`, { status: body });
      return new Response(body, { status: 200 });
    }),
  );
  return { bodies, requested };
}

/** Run a service call to completion, letting the pacer's spacing elapse. */
async function run<T>(call: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(50);
  return call;
}

/** `count` filing-column values as a JSON array (the service counts values, not their content). */
const values = (count: number) => `[${count > 0 ? `${'0,'.repeat(count - 1)}0` : ''}]`;

/** The six indexed filing columns, `count` values in the first — the shape both readers accept. */
const filingColumns = (count: number) =>
  `{"accessionNumber":${values(count)},"filingDate":[],"form":[],"primaryDocument":[],"primaryDocDescription":[],"reportDate":[]}`;

const MASTER_IDX_HEAD =
  'Description:           Master Index of EDGAR Dissemination Feed\n\nCIK|Company Name|Form Type|Date Filed|Filename\n--------------------------------------------------------------------------------\n';
const MASTER_IDX_ROW =
  '1000045|NICHOLAS FINANCIAL INC|10-Q|1995-02-13|edgar/data/1000045/0000914317-95-000107.txt\n';

/**
 * One cache under test: its limit, a body the service weighs at `bytes` or just under it
 * (within one value or row), and the URL and service read for entry `i`.
 */
interface CacheCase {
  body: (bytes: number) => string;
  limit: number;
  name: string;
  read: (i: number) => Promise<unknown>;
  url: (i: number) => string;
}

const cik = (i: number) => String(i + 1).padStart(10, '0');
const pageName = (i: number) => `CIK${cik(i)}-submissions-001.json`;

const CASES: CacheCase[] = [
  {
    name: 'submissions documents',
    limit: CACHE_BYTE_LIMITS.submissions,
    body: (bytes) =>
      `{"tickers":[],"exchanges":[],"filings":{"recent":${filingColumns(
        Math.floor((bytes - SUBMISSIONS_DOC_BYTES) / FILING_VALUE_BYTES),
      )},"files":[]}}`,
    url: (i) => `https://data.sec.gov/submissions/CIK${cik(i)}.json`,
    read: (i) => getEdgarApiService().getSubmissions(cik(i), scope()),
  },
  {
    name: 'archive pages',
    limit: CACHE_BYTE_LIMITS.archivePages,
    body: (bytes) => filingColumns(Math.floor(bytes / FILING_VALUE_BYTES)),
    url: (i) => `https://data.sec.gov/submissions/${pageName(i)}`,
    read: (i) => getEdgarApiService().fetchArchivePage(pageName(i), scope()),
  },
  {
    name: 'full-index quarters',
    limit: CACHE_BYTE_LIMITS.fullIndex,
    body: (bytes) =>
      MASTER_IDX_HEAD + MASTER_IDX_ROW.repeat(Math.floor(bytes / FULL_INDEX_ROW_BYTES)),
    url: (i) => `https://www.sec.gov/Archives/edgar/full-index/1995/QTR${i + 1}/master.idx`,
    read: (i) => getEdgarApiService().fetchFullIndexQuarter(1995, i + 1, scope()),
  },
];

describe('EdgarApiService — per-key document caches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    initEdgarApiService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shares 448 MiB across the three caches', () => {
    const total = Object.values(CACHE_BYTE_LIMITS).reduce((sum, limit) => sum + limit, 0);
    expect(total).toBe(448 * 1024 * 1024);
  });

  it('holds the heaviest eight consecutive full-index quarters by weight', () => {
    /**
     * 1999Q1–2000Q4, the heaviest run of the eight quarters one pre-2001 browse reads: about
     * 657,200 rows, from each quarter's `master.idx` size at 94 bytes a line.
     */
    expect(657_200 * FULL_INDEX_ROW_BYTES).toBeLessThan(CACHE_BYTE_LIMITS.fullIndex);
  });

  describe.each(CASES)('$name', ({ body, limit, read, url }) => {
    /** Serve entries 0…n-1, each weighed at `bytes` or just under. */
    const serve = (bytes: number, entries: number) => {
      const sec = stubSec();
      const text = body(bytes);
      for (let i = 0; i < entries; i++) sec.bodies.set(url(i), text);
      return sec;
    };
    const readAll = async (...entries: number[]) => {
      for (const i of entries) await run(read(i));
    };

    it('holds entries up to its limit and, past it, drops the one used longest ago', async () => {
      // Three entries fit the limit; a fourth does not.
      const sec = serve(Math.floor(limit / 3), 4);

      await readAll(0, 1, 2, 3);
      await readAll(1, 2, 3);
      expect(sec.requested).toEqual([url(0), url(1), url(2), url(3)]);

      await readAll(0);
      expect(sec.requested).toEqual([url(0), url(1), url(2), url(3), url(0)]);
    });

    it('counts a read as use: the entry read most recently outlasts an older write', async () => {
      const sec = serve(Math.floor(limit / 3), 4);

      await readAll(0, 1, 2, 0, 3);
      await readAll(0, 2, 3);
      expect(sec.requested).toEqual([url(0), url(1), url(2), url(3)]);

      await readAll(1);
      expect(sec.requested.at(-1)).toBe(url(1));
      expect(sec.requested).toHaveLength(5);
    });

    it('drops an expired entry when it reads it, so a failed reread leaves none of the limit held', async () => {
      // Two entries fit the limit; a third does not.
      const sec = serve(Math.floor(limit / 2), 3);

      await readAll(0);
      vi.setSystemTime(T0 + TTL_MS / 2);
      await readAll(1);

      vi.setSystemTime(T0 + TTL_MS + 1);
      sec.bodies.set(url(0), 404);
      const reread = read(0).then(
        () => {
          throw new Error('expected the reread to reject');
        },
        (error: unknown) => error,
      );
      expect(await run(reread)).toMatchObject({ data: { status: 404 } });

      // With entry 0 gone, entry 2 fits beside entry 1 and nothing is dropped.
      await readAll(2, 1);
      expect(sec.requested).toEqual([url(0), url(1), url(0), url(2)]);
    });
  });

  it('keeps no entry heavier than its whole limit, and drops nothing to make room for it', async () => {
    const pages = CASES[1];
    if (!pages) throw new Error('archive-page case missing');
    const sec = stubSec();
    sec.bodies.set(pages.url(0), pages.body(Math.floor(pages.limit / 3)));
    sec.bodies.set(pages.url(1), pages.body(pages.limit + FILING_VALUE_BYTES));

    for (const i of [0, 1, 1, 0]) await run(pages.read(i));

    expect(sec.requested).toEqual([pages.url(0), pages.url(1), pages.url(1)]);
  });

  it('caches a full-index quarter with no rows', async () => {
    const quarters = CASES[2];
    if (!quarters) throw new Error('full-index case missing');
    const sec = stubSec();
    sec.bodies.set(quarters.url(0), MASTER_IDX_HEAD);

    expect(await run(quarters.read(0))).toEqual([]);
    expect(await run(quarters.read(0))).toEqual([]);
    expect(sec.requested).toEqual([quarters.url(0)]);
  });
});
