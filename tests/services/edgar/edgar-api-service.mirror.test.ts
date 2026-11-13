/**
 * @fileoverview Routing tests for EdgarApiService ↔ the local mirror, with the config
 * and mirror modules mocked and `globalThis.fetch` stubbed. A point read
 * (`tryGetCompanyConcept`, `tryGetCompanyFacts`) for a filer the store holds goes live
 * only when the filer's newest XBRL filing, per its submissions document (read once
 * per CIK per ticker-cache TTL), was accepted on or after the day before the
 * companyfacts checkpoint; otherwise the mirror answers, an unreported tag included
 * (#234). A frame goes live while its period's filing window was still open at the
 * checkpoint. Any live failure but the caller's cancel answers from the mirror where
 * it holds the answer; strict mirror-only mode sends nothing; the no-mirror path
 * reads live.
 * @module tests/services/edgar/edgar-api-service.mirror
 */

import type { McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { config, mirrorRef } = vi.hoisted(() => ({
  config: {
    userAgent: 'test test@example.com',
    rateLimitRps: 1000,
    rateLimitCooldownSeconds: 600,
    tickerCacheTtl: 3600,
    mirrorFallbackLive: true,
  },
  mirrorRef: { current: undefined as Record<string, ReturnType<typeof vi.fn>> | undefined },
}));

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));
vi.mock('@/services/edgar/mirror/index.js', () => ({ getEdgarMirror: () => mirrorRef.current }));
// A row copied from the committed former-ticker asset (#237).
vi.mock('@/services/edgar/data/former-tickers.json', () => ({
  default: [['AMRK', '0001591588', '2025-12', 'A-Mark Precious Metals, Inc.']],
}));

import { CallScope } from '@/services/edgar/call-scope.js';
import { getEdgarApiService, initEdgarApiService } from '@/services/edgar/edgar-api-service.js';

const scope = () => new CallScope(new AbortController().signal);

/** The reason the MCP SDK aborts a cancelled request with: the `notifications/cancelled` reason string. */
const CANCELLED = 'client cancelled';

function makeMirrorStub() {
  return {
    companyFactsReady: vi.fn(),
    companyFactsComplete: vi.fn(),
    companyFactsCheckpoint: vi.fn(),
    holdsFiler: vi.fn(),
    tickersReady: vi.fn(),
    getCompanyConcept: vi.fn(),
    getCompanyFacts: vi.fn(),
    getFrames: vi.fn(),
    getTickerRows: vi.fn(),
  };
}

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

// --- SEC stub: answers per URL, counted ---

/**
 * A status becomes an empty response with that status, an `Error` is thrown as the
 * runtime's rejection (no HTTP response), `'silent'` never sends headers and rejects
 * with the request signal's reason once it aborts, a string is a 200 text body, and
 * anything else is a 200 JSON body.
 */
type Answer = number | Error | 'silent' | string | object;

function toResponse(answer: Answer, signal?: AbortSignal | null): Response | Promise<Response> {
  if (answer instanceof Error) throw answer;
  if (answer === 'silent') {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
  if (typeof answer === 'number') return new Response(`status ${answer}`, { status: answer });
  if (typeof answer === 'string') return new Response(answer, { status: 200 });
  return jsonResponse(answer);
}

/**
 * Serve each routed URL from its answer queue — the last answer repeats once a queue
 * runs dry — and `fallback` for any other URL it answers; anything else rejects,
 * failing the test. Returns every URL requested, in order.
 */
function stubSec(routes: Record<string, Answer[]>, fallback?: (url: string) => Answer | undefined) {
  const queues = new Map(Object.entries(routes).map(([url, answers]) => [url, [...answers]]));
  const requested: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requested.push(url);
      const queue = queues.get(url);
      const answer = queue ? (queue.length > 1 ? queue.shift() : queue[0]) : fallback?.(url);
      if (answer === undefined) throw new Error(`unrouted fetch: ${url}`);
      return toResponse(answer, init?.signal);
    }),
  );
  return {
    requested,
    count: (url: string) => requested.filter((r) => r === url).length,
  };
}

/** Run a service call to completion, letting the pacer and any 5xx backoff sleeps elapse. */
async function run<T>(call: Promise<T>, ms = 50): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return call;
}

/** A call's rejection; a call that resolves fails the test. */
const failure = (call: Promise<unknown>): Promise<McpError> =>
  call.then(
    () => {
      throw new Error('expected the call to reject');
    },
    (error: unknown) => error as McpError,
  );

/** Node 26's (undici) own rejection for a reset connection: `fetch failed`, the code on `cause`. */
const NODE_RESET = () =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });

// --- Fixtures ---

const APPLE = '0000320193';
const MICROSOFT = '0000789019';
const submissionsUrl = (cik: string) => `https://data.sec.gov/submissions/CIK${cik}.json`;
const conceptUrl = (cik: string, tag = 'Revenues') =>
  `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`;
const factsUrl = (cik: string) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
const framesUrl = (period: string) =>
  `https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/${period}.json`;

/** The store's companyfacts checkpoint: the bulk archive's `Last-Modified` at its last sync. */
const CHECKPOINT = '2026-11-01T04:30:48.000Z';
/** A day before the checkpoint: an XBRL filing accepted at or after it sends point reads live. */
const CUTOFF = '2026-10-31T04:30:48.000Z';
const JUST_BEFORE_CUTOFF = '2026-10-31T04:30:47.999Z';

/**
 * A submissions document whose `recent` window holds `rows` — each an acceptance time
 * and its `isXBRL` flag — and whose archive manifest is `files`.
 */
function submissionsDoc(
  rows: Array<readonly [acceptance: string, isXBRL: 0 | 1]>,
  files: Array<{ filingTo: string }> = [],
) {
  const column = <T>(value: T) => rows.map(() => value);
  return {
    cik: APPLE,
    name: 'Apple Inc.',
    tickers: ['AAPL'],
    exchanges: ['Nasdaq'],
    filings: {
      recent: {
        accessionNumber: column('0000320193-26-000026'),
        filingDate: rows.map(([at]) => at.slice(0, 10)),
        form: column('10-K'),
        primaryDocument: column('aapl-20260926.htm'),
        primaryDocDescription: column('10-K'),
        reportDate: column('2026-09-26'),
        acceptanceDateTime: rows.map(([at]) => at),
        isXBRL: rows.map(([, flag]) => flag),
      },
      files: files.map(({ filingTo }, i) => ({
        name: `CIK0000320193-submissions-00${i + 1}.json`,
        filingCount: 1000,
        filingFrom: '1994-01-26',
        filingTo,
      })),
    },
  };
}

/** No XBRL filing since well before the cutoff; a newer filing without XBRL beside it. */
const UNCHANGED = submissionsDoc([
  ['2026-11-05T21:30:47.000Z', 0],
  ['2026-08-01T20:06:00.000Z', 1],
]);
/** A 10-K accepted on the day before the checkpoint. */
const FILED_SINCE = submissionsDoc([
  ['2026-11-05T21:30:47.000Z', 0],
  [CUTOFF, 1],
]);

const MIRROR_CONCEPT = {
  cik: 320193,
  entityName: 'Apple Inc. (mirror)',
  taxonomy: 'us-gaap',
  tag: 'Revenues',
  label: 'Revenues',
  units: {},
};
const MIRROR_FACTS = { cik: 320193, entityName: 'Apple Inc. (mirror)', facts: {} };
const LIVE_CONCEPT = { ...MIRROR_CONCEPT, entityName: 'Apple Inc. (live)' };
const LIVE_FACTS = { ...MIRROR_FACTS, entityName: 'Apple Inc. (live)' };

/**
 * A ready, complete store checkpointed at `checkpoint`. A filer it holds reports
 * Revenues and nothing else; one it does not hold has no rows at all.
 */
function useStore(options: { holds?: boolean; checkpoint?: string | undefined } = {}) {
  const holds = options.holds ?? true;
  const mirror = makeMirrorStub();
  mirror.companyFactsReady.mockResolvedValue(true);
  mirror.companyFactsComplete.mockResolvedValue(true);
  mirror.companyFactsCheckpoint.mockResolvedValue(
    'checkpoint' in options ? options.checkpoint : CHECKPOINT,
  );
  mirror.holdsFiler.mockResolvedValue(holds);
  mirror.getCompanyConcept.mockImplementation(
    async (_cik: string, _taxonomy: string, tag: string) =>
      holds && tag === 'Revenues' ? MIRROR_CONCEPT : null,
  );
  mirror.getCompanyFacts.mockResolvedValue(holds ? MIRROR_FACTS : null);
  mirrorRef.current = mirror;
  return mirror;
}

const concept = (cik = APPLE, tag = 'Revenues', callScope = scope()) =>
  getEdgarApiService().tryGetCompanyConcept(cik, 'us-gaap', tag, callScope);
const entityOf = (result: { entityName?: string } | null) => result?.entityName ?? null;

const T0 = new Date('2026-11-08T15:00:00.000Z').getTime();

describe('EdgarApiService — mirror routing', () => {
  beforeEach(() => {
    config.mirrorFallbackLive = true;
    mirrorRef.current = undefined;
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    initEdgarApiService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('point reads for a filer the store holds (#234)', () => {
    it('answers from the mirror while the filer has filed no XBRL since a day before the checkpoint — an unreported tag as null — on one submissions read per TTL', async () => {
      useStore();
      const sec = stubSec({ [submissionsUrl(APPLE)]: [UNCHANGED] });
      const api = getEdgarApiService();

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (mirror)');
      expect(await run(concept(APPLE, 'NotReported'))).toBeNull();
      expect(entityOf(await run(api.tryGetCompanyFacts('320193', scope())))).toBe(
        'Apple Inc. (mirror)',
      );
      expect(mirrorRef.current?.getCompanyFacts).toHaveBeenCalledWith('320193');
      expect(sec.requested).toEqual([submissionsUrl(APPLE)]);
    });

    it('answers from the mirror when the newest XBRL acceptance falls 1 ms before the cutoff', async () => {
      useStore();
      const sec = stubSec({
        [submissionsUrl(APPLE)]: [submissionsDoc([[JUST_BEFORE_CUTOFF, 1]])],
      });

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (mirror)');
      expect(sec.requested).toEqual([submissionsUrl(APPLE)]);
    });

    it('reads live once the newest XBRL filing was accepted at the cutoff, a day before the checkpoint', async () => {
      useStore();
      const sec = stubSec({
        [submissionsUrl(APPLE)]: [FILED_SINCE],
        [conceptUrl(APPLE)]: [LIVE_CONCEPT],
        [conceptUrl(APPLE, 'NotReported')]: [404],
        [factsUrl(APPLE)]: [LIVE_FACTS],
      });

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (live)');
      // SEC's own 404 answers an unreported tag.
      expect(await run(concept(APPLE, 'NotReported'))).toBeNull();
      expect(entityOf(await run(getEdgarApiService().tryGetCompanyFacts(APPLE, scope())))).toBe(
        'Apple Inc. (live)',
      );
      expect(sec.count(submissionsUrl(APPLE))).toBe(1);
      expect(sec.requested).toHaveLength(4);
    });

    it('answers the stored row when a live read answers 404 — SEC never drops a fact it has reported — and null for a tag the store lacks, marking nothing', async () => {
      useStore();
      const sec = stubSec({
        [submissionsUrl(APPLE)]: [FILED_SINCE],
        [conceptUrl(APPLE)]: [404],
        [conceptUrl(APPLE, 'NotReported')]: [404],
        [factsUrl(APPLE)]: [404],
      });

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (mirror)');
      expect(entityOf(await run(getEdgarApiService().tryGetCompanyFacts(APPLE, scope())))).toBe(
        'Apple Inc. (mirror)',
      );
      expect(await run(concept(APPLE, 'NotReported'))).toBeNull();
      // A 404 is SEC answering, not failing: the filer's next read still goes live.
      expect(entityOf(await run(concept()))).toBe('Apple Inc. (mirror)');
      expect(sec.requested).toEqual([
        submissionsUrl(APPLE),
        conceptUrl(APPLE),
        factsUrl(APPLE),
        conceptUrl(APPLE, 'NotReported'),
        conceptUrl(APPLE),
      ]);
    });

    it('reads live for a filer the store does not hold, with no submissions read', async () => {
      useStore({ holds: false });
      const sec = stubSec({ [conceptUrl(APPLE)]: [LIVE_CONCEPT], [factsUrl(APPLE)]: [LIVE_FACTS] });

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (live)');
      expect(entityOf(await run(getEdgarApiService().tryGetCompanyFacts(APPLE, scope())))).toBe(
        'Apple Inc. (live)',
      );
      expect(sec.requested).toEqual([conceptUrl(APPLE), factsUrl(APPLE)]);
    });

    it('fails a live read for a filer the store does not hold as the live read does — the mirror has nothing to answer with', async () => {
      useStore({ holds: false });
      stubSec({ [conceptUrl(APPLE)]: [503] });

      const error = await run(failure(concept()), 5_000);

      expect(error.data).toMatchObject({ reason: 'sec_unavailable', status: 503 });
    });

    it.each([
      ['archive pages reaching a day the cutoff falls in', '2026-10-31', 'live'],
      ['archive pages ending two days before it', '2026-10-29', 'mirror'],
    ] as const)(
      'with no XBRL filing in recent, counts what %s may hold: %s',
      async (_label, filingTo, source) => {
        useStore();
        stubSec({
          [submissionsUrl(APPLE)]: [
            submissionsDoc([['2026-11-05T21:30:47.000Z', 0]], [{ filingTo }]),
          ],
          [conceptUrl(APPLE)]: [LIVE_CONCEPT],
        });

        expect(entityOf(await run(concept()))).toBe(`Apple Inc. (${source})`);
      },
    );

    it('answers from the mirror for a filer that has never filed XBRL', async () => {
      useStore();
      stubSec({ [submissionsUrl(APPLE)]: [submissionsDoc([['2026-11-05T21:30:47.000Z', 0]])] });

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (mirror)');
    });

    it.each([
      ['isXBRL', 'isXBRL'],
      ['acceptanceDateTime', 'acceptanceDateTime'],
    ] as const)('reads live when recent lacks the %s column', async (_label, column) => {
      useStore();
      const doc = submissionsDoc([['2026-08-01T20:06:00.000Z', 1]]);
      delete (doc.filings.recent as Partial<typeof doc.filings.recent>)[column];
      stubSec({ [submissionsUrl(APPLE)]: [doc], [conceptUrl(APPLE)]: [LIVE_CONCEPT] });

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (live)');
    });

    it('reads live when an XBRL row carries an acceptance time that does not parse', async () => {
      useStore();
      stubSec({
        [submissionsUrl(APPLE)]: [submissionsDoc([['not a date', 1]])],
        [conceptUrl(APPLE)]: [LIVE_CONCEPT],
      });

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (live)');
    });

    it('reads live when the store carries no checkpoint to compare against, with no submissions read', async () => {
      useStore({ checkpoint: undefined });
      const sec = stubSec({ [conceptUrl(APPLE)]: [LIVE_CONCEPT] });

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (live)');
      expect(sec.requested).toEqual([conceptUrl(APPLE)]);
    });

    it('never answers one filer from another’s entry', async () => {
      useStore();
      const sec = stubSec({
        [submissionsUrl(APPLE)]: [UNCHANGED],
        [submissionsUrl(MICROSOFT)]: [FILED_SINCE],
        [conceptUrl(MICROSOFT)]: [{ ...LIVE_CONCEPT, entityName: 'Microsoft (live)' }],
      });

      expect(entityOf(await run(concept(APPLE)))).toBe('Apple Inc. (mirror)');
      expect(entityOf(await run(concept(MICROSOFT)))).toBe('Microsoft (live)');
      expect(entityOf(await run(concept('320193')))).toBe('Apple Inc. (mirror)');
      expect(sec.requested).toEqual([
        submissionsUrl(APPLE),
        submissionsUrl(MICROSOFT),
        conceptUrl(MICROSOFT),
      ]);
    });

    it('rereads the submissions document once the ticker-cache TTL has passed', async () => {
      useStore();
      const sec = stubSec({
        [submissionsUrl(APPLE)]: [UNCHANGED, FILED_SINCE],
        [conceptUrl(APPLE)]: [LIVE_CONCEPT],
      });

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (mirror)');
      vi.setSystemTime(T0 + 3_600_000 - 1_000);
      expect(entityOf(await run(concept()))).toBe('Apple Inc. (mirror)');
      expect(sec.count(submissionsUrl(APPLE))).toBe(1);

      vi.setSystemTime(T0 + 3_600_000 + 1_000);
      expect(entityOf(await run(concept()))).toBe('Apple Inc. (live)');
      expect(sec.count(submissionsUrl(APPLE))).toBe(2);
    });

    // The submissions cache's own bound is in bytes: edgar-api-service.caches.test.ts.
    it('marks at most 4,096 failed filers, dropping the mark used longest ago', async () => {
      useStore();
      const sec = stubSec({}, (url) => (url.includes('/submissions/') ? 404 : undefined));
      const cik = (n: number) => String(n).padStart(10, '0');
      const api = getEdgarApiService();
      const readAll = (ciks: string[]) =>
        run(
          Promise.all(ciks.map((c) => api.tryGetCompanyConcept(c, 'us-gaap', 'Revenues', scope()))),
          10_000,
        );

      await readAll(Array.from({ length: 4_097 }, (_, i) => cik(i + 1)));
      expect(sec.requested).toHaveLength(4_097);

      // The first filer's mark was dropped; the newest still has the store answer unasked.
      await readAll([cik(4_097), cik(2)]);
      expect(sec.requested).toHaveLength(4_097);
      await readAll([cik(1)]);
      expect(sec.requested).toHaveLength(4_098);
      expect(sec.requested.at(-1)).toBe(submissionsUrl(cik(1)));
    });

    it('rethrows the caller’s cancel during the submissions read, caching nothing', async () => {
      useStore();
      const sec = stubSec({ [submissionsUrl(APPLE)]: ['silent', UNCHANGED] });
      const caller = new AbortController();

      const cancelled = failure(concept(APPLE, 'Revenues', new CallScope(caller.signal)));
      await vi.advanceTimersByTimeAsync(2_000);
      caller.abort(CANCELLED);
      expect((await cancelled) as unknown).toBe(CANCELLED);
      expect(mirrorRef.current?.getCompanyConcept).not.toHaveBeenCalled();

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (mirror)');
      expect(sec.count(submissionsUrl(APPLE))).toBe(2);
    });

    it('lets a concurrent read of the same filer finish when another caller cancels', async () => {
      useStore();
      const sec = stubSec({ [submissionsUrl(APPLE)]: ['silent', UNCHANGED] });
      const caller = new AbortController();

      const cancelled = failure(concept(APPLE, 'Revenues', new CallScope(caller.signal)));
      const other = concept();
      await vi.advanceTimersByTimeAsync(50);
      // The second call waits on the first one's read rather than sending its own.
      expect(sec.count(submissionsUrl(APPLE))).toBe(1);
      caller.abort(CANCELLED);

      expect((await cancelled) as unknown).toBe(CANCELLED);
      expect(entityOf(await other)).toBe('Apple Inc. (mirror)');
      expect(sec.count(submissionsUrl(APPLE))).toBe(2);
    });

    it('shares one submissions read among concurrent point reads of a filer, within a call and across calls', async () => {
      useStore();
      const sec = stubSec({ [submissionsUrl(APPLE)]: [UNCHANGED] });
      const api = getEdgarApiService();
      const call = scope();

      const results = await run(
        Promise.all([
          concept(APPLE, 'Revenues', call),
          api.tryGetCompanyFacts(APPLE, call),
          concept(APPLE, 'NotReported', scope()),
        ]),
      );

      expect(results.map(entityOf)).toEqual(['Apple Inc. (mirror)', 'Apple Inc. (mirror)', null]);
      expect(sec.requested).toEqual([submissionsUrl(APPLE)]);
    });

    it('sends no second submissions read for a filer whose document a tool already read', async () => {
      useStore();
      const sec = stubSec({
        [submissionsUrl(APPLE)]: [UNCHANGED],
        [submissionsUrl(MICROSOFT)]: [UNCHANGED],
      });
      const api = getEdgarApiService();

      await run(api.getSubmissions('320193', scope()));
      expect(entityOf(await run(concept()))).toBe('Apple Inc. (mirror)');
      // And the other way round: the point read's document serves the tool's later read.
      expect(entityOf(await run(concept(MICROSOFT)))).toBe('Apple Inc. (mirror)');
      await run(api.getSubmissions(MICROSOFT, scope()));

      expect(sec.requested).toEqual([submissionsUrl(APPLE), submissionsUrl(MICROSOFT)]);
    });

    it('never waits on another call’s read past its own failure budget: it reads for itself and settles from the mirror', async () => {
      useStore();
      const sec = stubSec({ [submissionsUrl(APPLE)]: ['silent'] });
      const owner = concept();
      const lowBudget = scope();
      lowBudget.charge(35_000);
      const t0 = Date.now();

      let answeredAfterMs: number | undefined;
      const read = concept(APPLE, 'Revenues', lowBudget).then((result) => {
        answeredAfterMs = Date.now() - t0;
        return result;
      });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(entityOf(await read)).toBe('Apple Inc. (mirror)');
      // Its own read, sent at the next 1 ms pacing slot, gets the 5 s it has left.
      expect(answeredAfterMs).toBe(5_001);
      expect(lowBudget.spentMs).toBe(40_000);
      expect(sec.count(submissionsUrl(APPLE))).toBe(2);

      await vi.advanceTimersByTimeAsync(40_000);
      expect(entityOf(await owner)).toBe('Apple Inc. (mirror)');
    });
  });

  describe('a failed submissions read (#234)', () => {
    it.each([
      ['a 404', [404], 50, 1],
      ['a 403', [403], 50, 1],
      ['a 503 on every attempt', [503], 5_000, 3],
      ['no HTTP response on any attempt', [NODE_RESET()], 5_000, 3],
      ['a 200 that is not JSON', ['<html>Temporarily unavailable</html>'], 50, 1],
      ['a 200 that is not a submissions document', [{ unexpected: true }], 50, 1],
    ] as const)(
      'answers from the mirror after %s, and sends nothing more for that filer for 60 s',
      async (_label, answers, settle, attempts) => {
        useStore();
        const sec = stubSec({ [submissionsUrl(APPLE)]: [...answers] });

        expect(entityOf(await run(concept(), settle))).toBe('Apple Inc. (mirror)');
        expect(await run(concept(APPLE, 'NotReported'))).toBeNull();
        expect(sec.requested).toHaveLength(attempts);

        await vi.advanceTimersByTimeAsync(50_000);
        expect(entityOf(await run(concept()))).toBe('Apple Inc. (mirror)');
        expect(sec.requested).toHaveLength(attempts);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(entityOf(await run(concept(), settle))).toBe('Apple Inc. (mirror)');
        expect(sec.requested).toHaveLength(attempts * 2);
      },
    );

    it('answers from the mirror after a 429, and sends nothing at all while the block’s cool-down runs', async () => {
      useStore();
      const sec = stubSec({
        [submissionsUrl(APPLE)]: [429],
        [submissionsUrl(MICROSOFT)]: [UNCHANGED],
      });

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (mirror)');
      // Another filer's read is refused locally: still the mirror's answer, nothing sent.
      expect(entityOf(await run(concept(MICROSOFT)))).toBe('Apple Inc. (mirror)');
      expect(sec.requested).toEqual([submissionsUrl(APPLE)]);
    });

    it('holds off a filer for the Retry-After a 5xx carries when it is longer than 60 s', async () => {
      useStore();
      const fetchMock = vi.fn(
        async () => new Response('busy', { status: 503, headers: { 'retry-after': '120' } }),
      );
      vi.stubGlobal('fetch', fetchMock);

      expect(entityOf(await run(concept(), 5_000))).toBe('Apple Inc. (mirror)');
      expect(fetchMock).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(70_000);
      expect(entityOf(await run(concept(), 5_000))).toBe('Apple Inc. (mirror)');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('settles from the mirror inside the call’s 40 s budget when SEC never answers', async () => {
      useStore();
      const sec = stubSec({ [submissionsUrl(APPLE)]: ['silent'] });
      const callScope = scope();
      const t0 = Date.now();

      let answeredAfterMs: number | undefined;
      const read = concept(APPLE, 'Revenues', callScope).then((result) => {
        answeredAfterMs = Date.now() - t0;
        return result;
      });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(entityOf(await read)).toBe('Apple Inc. (mirror)');
      // 15 + 1 + 15 + 2 s, then the third attempt gets the 7 s left.
      expect(answeredAfterMs).toBe(40_000);
      expect(callScope.spentMs).toBe(40_000);
      expect(sec.requested).toHaveLength(3);
    });

    it('sends nothing once the call’s budget is spent, and leaves the next call to read', async () => {
      useStore();
      const sec = stubSec({ [submissionsUrl(APPLE)]: [UNCHANGED] });
      const spent = scope();
      spent.charge(40_000);

      expect(entityOf(await run(concept(APPLE, 'Revenues', spent)))).toBe('Apple Inc. (mirror)');
      expect(sec.requested).toEqual([]);

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (mirror)');
      expect(sec.requested).toEqual([submissionsUrl(APPLE)]);
    });
  });

  describe('a failed live read for a filer the store holds (#234)', () => {
    it.each([
      ['a 403', [403], 50, 1],
      ['a 429', [429], 50, 1],
      ['a 503 on every attempt', [503], 5_000, 3],
      ['no HTTP response on any attempt', [NODE_RESET()], 5_000, 3],
      ['a 200 that is not JSON', ['<html>Temporarily unavailable</html>'], 50, 1],
    ] as const)(
      'answers from the mirror after %s, and reads no more of that filer live for 60 s',
      async (_label, answers, settle, attempts) => {
        useStore();
        const sec = stubSec({
          [submissionsUrl(APPLE)]: [FILED_SINCE],
          [conceptUrl(APPLE)]: [...answers],
        });

        expect(entityOf(await run(concept(), settle))).toBe('Apple Inc. (mirror)');
        expect(entityOf(await run(getEdgarApiService().tryGetCompanyFacts(APPLE, scope())))).toBe(
          'Apple Inc. (mirror)',
        );
        expect(await run(concept(APPLE, 'NotReported'))).toBeNull();
        expect(sec.count(conceptUrl(APPLE))).toBe(attempts);
        expect(sec.requested).toHaveLength(1 + attempts);
      },
    );

    it('rethrows the caller’s cancel during the live read, and reads live again on the next call', async () => {
      useStore();
      const sec = stubSec({
        [submissionsUrl(APPLE)]: [FILED_SINCE],
        [conceptUrl(APPLE)]: ['silent', LIVE_CONCEPT],
      });
      const caller = new AbortController();

      const cancelled = failure(concept(APPLE, 'Revenues', new CallScope(caller.signal)));
      await vi.advanceTimersByTimeAsync(2_000);
      caller.abort(CANCELLED);
      expect((await cancelled) as unknown).toBe(CANCELLED);
      expect(mirrorRef.current?.getCompanyConcept).not.toHaveBeenCalled();

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (live)');
      expect(sec.count(conceptUrl(APPLE))).toBe(2);
    });

    it('settles from the mirror inside the call’s 40 s budget when the live read never answers', async () => {
      useStore();
      const sec = stubSec({
        [submissionsUrl(APPLE)]: [FILED_SINCE],
        [conceptUrl(APPLE)]: ['silent'],
      });
      const callScope = scope();

      const read = concept(APPLE, 'Revenues', callScope);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(entityOf(await read)).toBe('Apple Inc. (mirror)');
      expect(callScope.spentMs).toBe(40_000);
      expect(sec.count(conceptUrl(APPLE))).toBe(3);
    });
  });

  /**
   * A read the call's own failure budget ended says nothing about SEC or the filer: the store
   * answers that call, and the next call still asks SEC (#179, #234). A read SEC failed marks
   * the filer whatever budget the call had left.
   */
  describe('a read this call’s own failure budget ended', () => {
    /** A call with `leftMs` of its 40 s failure budget left. */
    const withBudgetLeft = (leftMs: number) => {
      const callScope = scope();
      callScope.charge(40_000 - leftMs);
      return callScope;
    };

    it('marks nothing when the budget left cuts the recency read short: the next call reads SEC', async () => {
      useStore();
      const sec = stubSec({
        [submissionsUrl(APPLE)]: ['silent', FILED_SINCE],
        [conceptUrl(APPLE)]: [LIVE_CONCEPT],
      });
      const low = withBudgetLeft(5_000);

      expect(entityOf(await run(concept(APPLE, 'Revenues', low), 10_000))).toBe(
        'Apple Inc. (mirror)',
      );
      // One attempt, cut to the 5 s left rather than its own 15 s.
      expect(low.spentMs).toBe(40_000);
      expect(sec.requested).toEqual([submissionsUrl(APPLE)]);

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (live)');
      expect(sec.requested).toEqual([
        submissionsUrl(APPLE),
        submissionsUrl(APPLE),
        conceptUrl(APPLE),
      ]);
    });

    it('marks nothing when the budget is spent while the recency read waits for its pacing slot, so it is never sent: the next call reads SEC', async () => {
      useStore();
      const sec = stubSec({
        [submissionsUrl(MICROSOFT)]: [UNCHANGED],
        [submissionsUrl(APPLE)]: [FILED_SINCE],
        [conceptUrl(APPLE)]: [LIVE_CONCEPT],
      });
      const low = withBudgetLeft(10_000);

      // Microsoft's read takes the pacer's first slot; Apple's waits 1 ms for the next.
      const other = concept(MICROSOFT);
      const refused = concept(APPLE, 'Revenues', low);
      await vi.advanceTimersByTimeAsync(0);
      expect(sec.requested).toEqual([submissionsUrl(MICROSOFT)]);
      low.charge(10_000);

      expect(entityOf(await run(refused))).toBe('Apple Inc. (mirror)');
      expect(entityOf(await other)).toBe('Apple Inc. (mirror)');
      expect(sec.count(submissionsUrl(APPLE))).toBe(0);

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (live)');
      expect(sec.count(submissionsUrl(APPLE))).toBe(1);
      expect(sec.count(conceptUrl(APPLE))).toBe(1);
    });

    it('marks nothing when the budget left cuts the live read short: the next call reads live', async () => {
      useStore();
      const sec = stubSec({
        [submissionsUrl(APPLE)]: [FILED_SINCE],
        [conceptUrl(APPLE)]: ['silent', LIVE_CONCEPT],
      });
      const low = withBudgetLeft(5_000);

      expect(entityOf(await run(concept(APPLE, 'Revenues', low), 10_000))).toBe(
        'Apple Inc. (mirror)',
      );
      expect(low.spentMs).toBe(40_000);

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (live)');
      // The submissions document is cached; the live read is asked again.
      expect(sec.requested).toEqual([submissionsUrl(APPLE), conceptUrl(APPLE), conceptUrl(APPLE)]);
    });

    it('still marks the filer when SEC answers 503 on every attempt of a low-budget call', async () => {
      useStore();
      const sec = stubSec({ [submissionsUrl(APPLE)]: [503] });
      const low = withBudgetLeft(5_000);

      expect(entityOf(await run(concept(APPLE, 'Revenues', low), 5_000))).toBe(
        'Apple Inc. (mirror)',
      );
      expect(sec.requested).toHaveLength(3);

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (mirror)');
      expect(sec.requested).toHaveLength(3);
    });

    it('still marks the filer when SEC answered an earlier attempt with a 503 before the budget cut the last one', async () => {
      useStore();
      const sec = stubSec({ [submissionsUrl(APPLE)]: [503, 'silent'] });
      const low = withBudgetLeft(4_000);

      // The 503, a 1 s backoff, then the second attempt cut to the 3 s left.
      expect(entityOf(await run(concept(APPLE, 'Revenues', low), 5_000))).toBe(
        'Apple Inc. (mirror)',
      );
      expect(low.spentMs).toBe(40_000);
      expect(sec.requested).toHaveLength(2);

      expect(entityOf(await run(concept()))).toBe('Apple Inc. (mirror)');
      expect(sec.requested).toHaveLength(2);
    });
  });

  describe('frames (#234)', () => {
    const MIRROR_FRAME = { ccp: 'mirror', data: [], pts: 0, tag: 'Revenues', taxonomy: 'us-gaap' };
    const LIVE_FRAME = { ...MIRROR_FRAME, ccp: 'live' };
    const frames = (period: string, callScope = scope()) =>
      getEdgarApiService().tryGetFrames('us-gaap', 'Revenues', 'USD', period, callScope);
    const sourceOf = (frame: { ccp?: string } | null) => frame?.ccp ?? null;

    /** A ready, complete store holding a frame for every period; checkpointed at {@link CHECKPOINT} unless `options` says otherwise. */
    function useFrameStore(options: { checkpoint?: string | undefined } = {}) {
      const mirror = useStore(options);
      mirror.getFrames.mockResolvedValue(MIRROR_FRAME);
      return mirror;
    }

    it.each([
      ['CY2025', 'mirror', 'its window closed at the end of 2026-10-31'],
      ['CY2026', 'live', 'its window runs to 2027-10-31'],
      ['CY2026Q1', 'mirror', 'its window closed at the end of 2026-09-30'],
      ['CY2026Q2', 'live', 'its window runs to 2026-12-31'],
      ['CY2026Q3', 'live', 'its window runs to 2027-03-31'],
      ['CY2026Q3I', 'live', 'its window runs to 2027-03-31'],
      ['CY2025Q4I', 'mirror', 'its window closed at the end of 2026-06-30'],
    ] as const)(
      'on a store checkpointed 2026-11-01, answers %s from the %s: %s',
      async (period, source, _window) => {
        useFrameStore();
        const sec = stubSec({ [framesUrl(period)]: [LIVE_FRAME] });

        expect(sourceOf(await run(frames(period)))).toBe(source);
        expect(sec.requested).toHaveLength(source === 'live' ? 1 : 0);
      },
    );

    it.each([
      ['CY2025Q4', '2026-06-30T23:59:59.999Z', 'live'],
      ['CY2025Q4', '2026-07-01T00:00:00.000Z', 'mirror'],
      ['CY2025', '2026-10-31T23:59:59.999Z', 'live'],
      ['CY2025', '2026-11-01T00:00:00.000Z', 'mirror'],
    ] as const)(
      'answers %s on a store checkpointed %s from the %s',
      async (period, checkpoint, source) => {
        useFrameStore({ checkpoint });
        stubSec({ [framesUrl(period)]: [LIVE_FRAME] });

        expect(sourceOf(await run(frames(period)))).toBe(source);
      },
    );

    it('reads live when the store carries no checkpoint', async () => {
      useFrameStore({ checkpoint: undefined });
      stubSec({ [framesUrl('CY2020')]: [LIVE_FRAME] });

      expect(sourceOf(await run(frames('CY2020')))).toBe('live');
    });

    it('reads live when a closed period’s frame is missing from the store', async () => {
      useFrameStore().getFrames.mockResolvedValue(null);
      const sec = stubSec({ [framesUrl('CY2023')]: [404] });

      expect(await run(frames('CY2023'))).toBeNull();
      expect(sec.requested).toEqual([framesUrl('CY2023')]);
    });

    it('answers an open period as SEC does when the live read finds no frame, whatever the store holds', async () => {
      useFrameStore();
      const sec = stubSec({ [framesUrl('CY2026Q3')]: [404] });

      expect(await run(frames('CY2026Q3'))).toBeNull();
      expect(sec.requested).toEqual([framesUrl('CY2026Q3')]);
    });

    it.each([
      ['a 403', [403], 50, 1],
      ['a 429', [429], 50, 1],
      ['a 503 on every attempt', [503], 5_000, 3],
      ['no HTTP response on any attempt', [NODE_RESET()], 5_000, 3],
      ['a 200 that is not JSON', ['<html>Temporarily unavailable</html>'], 50, 1],
    ] as const)(
      'answers an open period from the store’s frame after %s',
      async (_label, answers, settle, attempts) => {
        useFrameStore();
        const sec = stubSec({ [framesUrl('CY2026Q3')]: [...answers] });

        expect(sourceOf(await run(frames('CY2026Q3'), settle))).toBe('mirror');
        expect(sec.requested).toHaveLength(attempts);
      },
    );

    it('fails an open period as the live read did when the store holds no frame for it', async () => {
      useFrameStore().getFrames.mockResolvedValue(null);
      stubSec({ [framesUrl('CY2026Q3')]: [503] });

      const error = await run(failure(frames('CY2026Q3')), 5_000);

      expect(error.data).toMatchObject({ reason: 'sec_unavailable', status: 503 });
    });

    it('rethrows the caller’s cancel during an open period’s live read, without reading the store', async () => {
      const mirror = useFrameStore();
      stubSec({ [framesUrl('CY2026Q3')]: ['silent'] });
      const caller = new AbortController();

      const cancelled = failure(frames('CY2026Q3', new CallScope(caller.signal)));
      await vi.advanceTimersByTimeAsync(2_000);
      caller.abort(CANCELLED);

      expect((await cancelled) as unknown).toBe(CANCELLED);
      expect(mirror.getFrames).not.toHaveBeenCalled();
    });

    it('reads live when the company-facts layer is not fully synced (#29)', async () => {
      // A partial or mid-(re)sync store: point-lookup readiness can be true, but the
      // frames aggregation gates on the stricter completeness marker. Frames go live
      // rather than serve a silently-incomplete frame from a partial store.
      const mirror = useFrameStore();
      mirror.companyFactsComplete.mockResolvedValue(false);
      const sec = stubSec({ [framesUrl('CY2023')]: [LIVE_FRAME] });

      expect(sourceOf(await run(frames('CY2023')))).toBe('live');
      expect(mirror.getFrames).not.toHaveBeenCalled();
      expect(sec.requested).toHaveLength(1);
    });
  });

  describe('strict mirror-only mode', () => {
    beforeEach(() => {
      config.mirrorFallbackLive = false;
    });

    it('sends no request of any kind: ticker file, fund file, submissions, concept, facts, or frames', async () => {
      const mirror = useStore();
      mirror.tickersReady.mockResolvedValue(true);
      mirror.getTickerRows.mockResolvedValue([
        { cik: APPLE, name: 'Apple Inc.', ticker: 'AAPL' },
        { cik: '0000036405', name: '', ticker: 'VOO' },
      ]);
      mirror.getFrames.mockResolvedValue(null);
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const api = getEdgarApiService();

      expect(await run(api.resolveCik('AAPL', scope()))).toMatchObject({ cik: APPLE });
      expect(await run(api.resolveCik('VOO', scope()))).toEqual({
        cik: '0000036405',
        ticker: 'VOO',
      });
      expect(entityOf(await run(concept()))).toBe('Apple Inc. (mirror)');
      expect(await run(concept(APPLE, 'NotReported'))).toBeNull();
      expect(entityOf(await run(api.tryGetCompanyFacts(APPLE, scope())))).toBe(
        'Apple Inc. (mirror)',
      );
      expect(
        await run(api.tryGetFrames('us-gaap', 'Revenues', 'USD', 'CY2026Q3', scope())),
      ).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws when the company-facts layer is not yet synced', async () => {
      const mirror = useStore();
      mirror.companyFactsReady.mockResolvedValue(false);
      mirror.companyFactsComplete.mockResolvedValue(false);

      expect((await run(failure(concept()))).message).toMatch(/not synced/);
      const framesFailure = await run(
        failure(getEdgarApiService().tryGetFrames('us-gaap', 'Revenues', 'USD', 'CY2023', scope())),
      );
      expect(framesFailure.message).toMatch(/not synced/);
    });

    it('fails an empty ticker layer as not synced, sending nothing', async () => {
      const mirror = useStore();
      mirror.tickersReady.mockResolvedValue(true);
      mirror.getTickerRows.mockResolvedValue([]);
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const error = await run(failure(getEdgarApiService().resolveCik('AAPL', scope())));

      expect(error.message).toMatch(/ticker layer is not synced/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('resolves a former ticker from the committed asset, sending nothing (#237)', async () => {
      const mirror = useStore();
      mirror.tickersReady.mockResolvedValue(true);
      mirror.getTickerRows.mockResolvedValue([
        { cik: '0001591588', name: 'Gold.com, Inc.', ticker: 'GOLD' },
      ]);
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      expect(await run(getEdgarApiService().resolveCik('AMRK', scope()))).toEqual({
        cik: '0001591588',
        name: 'Gold.com, Inc.',
        ticker: 'GOLD',
        reading:
          "AMRK read as a former ticker of Gold.com, Inc. (GOLD, CIK 0001591588) as late as 2025-12 in SEC's ticker file",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('keeps answering from the mirror while SEC’s rate-limit block is active, sending nothing (#116)', async () => {
    // A live read draws the 429 and closes the gate.
    const fetchMock = vi.fn(async () => new Response('blocked', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = getEdgarApiService();
    expect(
      await run(failure(api.tryGetFrames('us-gaap', 'Revenues', 'USD', 'CY2023', scope()))),
    ).toMatchObject({ data: { reason: 'rate_limited' } });

    const mirror = useStore();
    mirror.tickersReady.mockResolvedValue(true);
    mirror.getTickerRows.mockResolvedValue([{ cik: APPLE, name: 'Apple Inc.', ticker: 'AAPL' }]);
    mirror.getFrames.mockResolvedValue({ ccp: 'CY2023', data: [], pts: 0, tag: 'Revenues' });

    // The ticker index (both live ticker files are refused locally), company facts and
    // the concept (their submissions read is refused), and frames — a closed period, and
    // an open one whose live read is refused — all answer from the mirror.
    expect(await run(api.resolveCik('AAPL', scope()))).toMatchObject({ cik: APPLE });
    expect(entityOf(await run(api.tryGetCompanyFacts('320193', scope())))).toBe(
      'Apple Inc. (mirror)',
    );
    expect(entityOf(await run(concept('320193')))).toBe('Apple Inc. (mirror)');
    expect(
      await run(api.tryGetFrames('us-gaap', 'Revenues', 'USD', 'CY2023', scope())),
    ).toMatchObject({ tag: 'Revenues' });
    expect(
      await run(api.tryGetFrames('us-gaap', 'Revenues', 'USD', 'CY2026Q3', scope())),
    ).toMatchObject({ tag: 'Revenues' });

    // A live-only read in the same window is refused without a request.
    expect(await run(failure(api.getSubmissions('320193', scope())))).toMatchObject({
      data: { reason: 'rate_limited' },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reads live when no mirror is registered', async () => {
    mirrorRef.current = undefined;
    const sec = stubSec({
      [framesUrl('CY2023')]: [{ ccp: 'live' }],
      [conceptUrl(APPLE)]: [LIVE_CONCEPT],
    });

    await run(getEdgarApiService().tryGetFrames('us-gaap', 'Revenues', 'USD', 'CY2023', scope()));
    expect(entityOf(await run(concept()))).toBe('Apple Inc. (live)');

    expect(sec.requested).toEqual([framesUrl('CY2023'), conceptUrl(APPLE)]);
  });

  // --- Live-path ticker cache: MF ticker merge (issue #40) ---

  it('merges MF tickers into byTicker so fund symbols resolve by ticker', async () => {
    // No mirror — exercise the live-path loadTickerCache.
    mirrorRef.current = undefined;

    const operatingTickers = {
      '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
    };
    const mfTickers = {
      fields: ['cik', 'seriesId', 'classId', 'symbol'],
      data: [[36405, 'S000002839', 'C000092055', 'VOO']],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('company_tickers_mf.json')) return jsonResponse(mfTickers);
        if (url.includes('company_tickers.json')) return jsonResponse(operatingTickers);
        return jsonResponse(null);
      }),
    );

    const vooMatch = await run(getEdgarApiService().resolveCik('VOO', scope()));
    expect(Array.isArray(vooMatch)).toBe(false);
    expect((vooMatch as { cik: string }).cik).toBe('0000036405');
  });

  it('carries seriesId and classId on MF resolved match', async () => {
    mirrorRef.current = undefined;

    const operatingTickers = {
      '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
    };
    const mfTickers = {
      fields: ['cik', 'seriesId', 'classId', 'symbol'],
      data: [[36405, 'S000002839', 'C000092055', 'VOO']],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('company_tickers_mf.json')) return jsonResponse(mfTickers);
        if (url.includes('company_tickers.json')) return jsonResponse(operatingTickers);
        return jsonResponse(null);
      }),
    );

    const vooMatch = await run(getEdgarApiService().resolveCik('VOO', scope()));
    const match = vooMatch as { cik: string; seriesId?: string; classId?: string };
    expect(match.seriesId).toBe('S000002839');
    expect(match.classId).toBe('C000092055');
  });

  it('does not add MF CIKs to byCik — equity AAPL resolve is unaffected', async () => {
    mirrorRef.current = undefined;

    const operatingTickers = {
      '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
    };
    const mfTickers = {
      // Same CIK 36405 as VOO — must not pollute byCik
      fields: ['cik', 'seriesId', 'classId', 'symbol'],
      data: [[36405, 'S000002839', 'C000092055', 'VOO']],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('company_tickers_mf.json')) return jsonResponse(mfTickers);
        if (url.includes('company_tickers.json')) return jsonResponse(operatingTickers);
        return jsonResponse(null);
      }),
    );

    const aaplMatch = await run(getEdgarApiService().resolveCik('AAPL', scope()));
    expect(Array.isArray(aaplMatch)).toBe(false);
    const m = aaplMatch as { cik: string; name?: string };
    expect(m.cik).toBe('0000320193');
    expect(m.name).toBe('Apple Inc.');
  });

  it('gracefully degrades when company_tickers_mf.json is unavailable', async () => {
    mirrorRef.current = undefined;

    const operatingTickers = {
      '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('company_tickers_mf.json')) return new Response(null, { status: 404 });
        if (url.includes('company_tickers.json')) return jsonResponse(operatingTickers);
        return jsonResponse(null);
      }),
    );

    // Equity ticker still resolves
    const aaplMatch = await run(getEdgarApiService().resolveCik('AAPL', scope()));
    expect(Array.isArray(aaplMatch)).toBe(false);
    expect((aaplMatch as { cik: string }).cik).toBe('0000320193');
  });

  it('operating-company ticker wins over a fund symbol on a cross-file collision (SPCX)', async () => {
    mirrorRef.current = undefined;

    const operatingTickers = {
      '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
      '1': { cik_str: 1181412, ticker: 'SPCX', title: 'Operating Co' },
    };
    const mfTickers = {
      fields: ['cik', 'seriesId', 'classId', 'symbol'],
      data: [
        [1719812, 'S000000001', 'C000000001', 'SPCX'], // collides with the equity SPCX above
        [36405, 'S000002839', 'C000092055', 'VOO'], // unique fund symbol — still resolves
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('company_tickers_mf.json')) return jsonResponse(mfTickers);
        if (url.includes('company_tickers.json')) return jsonResponse(operatingTickers);
        return jsonResponse(null);
      }),
    );

    const spcx = (await run(getEdgarApiService().resolveCik('SPCX', scope()))) as {
      cik: string;
      seriesId?: string;
    };
    expect(spcx.cik).toBe('0001181412'); // the equity CIK, not the fund 0001719812
    expect(spcx.seriesId).toBeUndefined();

    const voo = (await run(getEdgarApiService().resolveCik('VOO', scope()))) as { cik: string };
    expect(voo.cik).toBe('0000036405');
  });

  // --- Mirror-path MF merge (#43) ---

  it('fund ticker resolves via live MF merge when mirrorFallbackLive=true (#43)', async () => {
    // Mirror serves equity-only rows (no fund tickers) + mirrorFallbackLive=true →
    // the live ticker files are read (#234) and the MF file is merged in, so VOO resolves.
    config.mirrorFallbackLive = true;
    const mirror = makeMirrorStub();
    mirror.tickersReady.mockResolvedValue(true);
    mirror.getTickerRows.mockResolvedValue([
      { cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' },
    ]); // equity-only, no VOO

    mirrorRef.current = mirror;

    const mfTickers = {
      fields: ['cik', 'seriesId', 'classId', 'symbol'],
      data: [[36405, 'S000002839', 'C000092055', 'VOO']],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('company_tickers_mf.json')) return jsonResponse(mfTickers);
        if (url.includes('company_tickers.json')) {
          return jsonResponse({ '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } });
        }
        throw new Error(`unexpected live fetch: ${url}`);
      }),
    );

    const vooMatch = await run(getEdgarApiService().resolveCik('VOO', scope()));
    expect(Array.isArray(vooMatch)).toBe(false);
    expect((vooMatch as { cik: string }).cik).toBe('0000036405');
  });

  it('no live MF fetch when mirrorFallbackLive=false (#43)', async () => {
    config.mirrorFallbackLive = false;
    const mirror = makeMirrorStub();
    mirror.tickersReady.mockResolvedValue(true);
    mirror.getTickerRows.mockResolvedValue([
      { cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' },
    ]);
    mirrorRef.current = mirror;

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // VOO is not in the mirror and no live fetch is allowed
    await run(getEdgarApiService().resolveCik('VOO', scope()));
    // No fetch should occur — fund ticker stays unresolved but no live call
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves a former name on the mirror path via the committed asset', async () => {
    const mirror = makeMirrorStub();
    mirror.tickersReady.mockResolvedValue(true);
    mirror.getTickerRows.mockResolvedValue([
      { cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' },
    ]);
    mirrorRef.current = mirror;
    // Strict mirror (no live fallback) isolates former-name resolution from the
    // live ticker files (#43, #234) — the committed asset is the only source here.
    config.mirrorFallbackLive = false;
    // The former-name asset is committed, not fetched — no live call should fire.
    const fetchMock = vi.fn(() => {
      throw new Error('unexpected live fetch on the mirror path');
    });
    vi.stubGlobal('fetch', fetchMock);

    // "Facebook" matches a former-name tuple in the committed former-names.json asset.
    const match = (await run(getEdgarApiService().resolveCik('Facebook', scope()))) as {
      cik: string;
    };
    expect(match.cik).toBe('0001326801');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
