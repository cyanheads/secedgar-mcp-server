/**
 * @fileoverview The fund-ticker slice of `EdgarApiService`'s ticker index, driven
 * through the public resolvers with `globalThis.fetch` stubbed and the clock faked.
 * A failed load of `company_tickers_mf.json` is not cached with the equity index:
 * it gets its own short retry window — at least the cool-down after a 429 — and one
 * resolution after it refetches the slice for everyone, while the equity index keeps
 * its TTL (#119). On the mirror path a live fund entry supersedes the mirror's bare
 * fund row for the same symbol, and mirror fund rows never map a trust CIK back to
 * one fund's ticker (#135).
 * @module tests/services/edgar/edgar-api-service.fund-tickers
 */

import type { McpError } from '@cyanheads/mcp-ts-core/errors';
import { logger } from '@cyanheads/mcp-ts-core/utils';
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

import { CallScope } from '@/services/edgar/call-scope.js';
import { getEdgarApiService, initEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import type { CikMatch } from '@/services/edgar/types.js';

/** A fresh call scope that is never cancelled: one tool call's signal and failure budget (#179). */
const scope = () => new CallScope(new AbortController().signal);

/** The reason the MCP SDK aborts a cancelled request with: the `notifications/cancelled` reason string. */
const CANCELLED = 'client cancelled';

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const MF_URL = 'https://www.sec.gov/files/company_tickers_mf.json';

const OPERATING = { '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } };
const MF_FILE = {
  fields: ['cik', 'seriesId', 'classId', 'symbol'],
  data: [
    [36405, 'S000002839', 'C000092055', 'VOO'],
    [36405, 'S000002848', 'C000007773', 'VTI'],
  ],
};

const AAPL: CikMatch = { cik: '0000320193', ticker: 'AAPL', name: 'Apple Inc.' };
const VOO_LIVE: CikMatch = {
  cik: '0000036405',
  ticker: 'VOO',
  seriesId: 'S000002839',
  classId: 'C000092055',
};

/**
 * A status becomes an empty response with that status, an `Error` is thrown as the
 * runtime's rejection (no HTTP response, #173), `'silent'` never sends headers and
 * rejects with the request signal's reason once it aborts (#179); anything else is
 * a 200 JSON body.
 */
type Answer = number | Error | 'silent' | object;

const toResponse = (answer: Answer, signal?: AbortSignal | null): Response | Promise<Response> => {
  if (answer instanceof Error) throw answer;
  if (answer === 'silent') {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
  return typeof answer === 'number'
    ? new Response(`status ${answer}`, { status: answer })
    : new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } });
};

/** Node 26's (undici) own rejection for a reset connection: `fetch failed`, the code on `cause`. */
const NODE_RESET = new TypeError('fetch failed', {
  cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
});

/**
 * Serve the two ticker files from answer queues — the last answer repeats once a
 * queue runs dry — and count the requests each one draws. Any other URL rejects.
 */
function stubTickerFiles(answers: { tickers?: Answer[]; mf?: Answer[] }) {
  const queues = {
    tickers: [...(answers.tickers ?? [OPERATING])],
    mf: [...(answers.mf ?? [MF_FILE])],
  };
  const calls = { tickers: 0, mf: 0 };
  const next = (key: 'tickers' | 'mf'): Answer => {
    const queue = queues[key];
    return (queue.length > 1 ? queue.shift() : queue[0]) as Answer;
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === MF_URL) {
        calls.mf++;
        return toResponse(next('mf'), init?.signal);
      }
      if (url === TICKERS_URL) {
        calls.tickers++;
        return toResponse(next('tickers'), init?.signal);
      }
      throw new Error(`unmocked fetch: ${url}`);
    }),
  );
  return calls;
}

/** Run a service call to completion, letting the pacer and any 5xx backoff sleeps elapse. */
async function run<T>(call: Promise<T>, ms = 50): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return call;
}

const resolve = (query: string, ms?: number) =>
  run(getEdgarApiService().resolveCik(query, scope()), ms);

/** A mirror whose ticker layer holds these rows; fund symbols carry an empty name, as tickers-sync writes them. */
function useMirror(rows: Array<{ cik: string; name: string; ticker: string }>) {
  mirrorRef.current = {
    tickersReady: vi.fn(async () => true),
    getTickerRows: vi.fn(async () => rows),
  };
}

const MIRROR_ROWS = [
  { cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' },
  { cik: '0000036405', name: '', ticker: 'VOO' },
  { cik: '0000036405', name: '', ticker: 'VTI' },
];

const T0 = new Date('2026-01-05T15:00:00.000Z').getTime();

describe('EdgarApiService — fund-ticker slice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    config.mirrorFallbackLive = true;
    mirrorRef.current = undefined;
    initEdgarApiService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('logging a failed fund-ticker load (#43, #119)', () => {
    /** Spy on the framework's global logger, silencing its output. */
    function spyWarnings() {
      return vi.spyOn(logger, 'warning').mockImplementation(() => undefined);
    }

    it.each([
      ['a 404', [404], 50, { status: 404, retryInSeconds: 60 }],
      ['a 429', [429], 50, { status: 429, retryInSeconds: 600 }],
      ['a malformed body', [{ unexpected: true }], 50, { reason: 'malformed_body' }],
      [
        'no HTTP response on any attempt (#173)',
        [NODE_RESET],
        5_000,
        {
          reason: 'sec_unreachable',
          retryInSeconds: 60,
          error:
            'No HTTP response from SEC EDGAR (www.sec.gov) on the last of 3 attempts, which ended with ECONNRESET.',
        },
      ],
    ] as const)(
      'warns once with the endpoint and cause after %s',
      async (_label, mf, settle, fields) => {
        const warning = spyWarnings();
        stubTickerFiles({ mf: [...mf] });

        expect(await resolve('VOO', settle)).toEqual([]);
        // Resolutions inside the retry window send nothing and log nothing more.
        expect(await resolve('VTI')).toEqual([]);

        expect(warning).toHaveBeenCalledOnce();
        const [message, context] = warning.mock.calls[0] ?? [];
        expect(message).toContain('ETF and mutual-fund tickers');
        expect(context).toMatchObject({
          operation: 'loadMfTickers',
          extra: { endpoint: 'company_tickers_mf', ...fields },
        });
      },
    );

    it('warns again when the retry after the window fails too', async () => {
      const warning = spyWarnings();
      stubTickerFiles({ mf: [404] });

      await resolve('VOO');
      await vi.advanceTimersByTimeAsync(61_000);
      await resolve('VOO');

      expect(warning).toHaveBeenCalledTimes(2);
    });

    it('logs nothing when the fund file loads', async () => {
      const warning = spyWarnings();
      stubTickerFiles({});

      expect(await resolve('VOO')).toEqual(VOO_LIVE);
      expect(warning).not.toHaveBeenCalled();
    });
  });

  describe('a failed fund-ticker load (#119)', () => {
    it.each([
      ['a 404', [404, MF_FILE], 50],
      ['a malformed body', [{ unexpected: true }, MF_FILE], 50],
      ['a 503 that outlasts the retries', [503, 503, 503, MF_FILE], 5_000],
      [
        'no HTTP response on any of the three attempts (#173)',
        [NODE_RESET, NODE_RESET, NODE_RESET, MF_FILE],
        5_000,
      ],
    ] as const)(
      'after %s, retries once the window passes — equity index not refetched',
      async (_label, mf, settle) => {
        const calls = stubTickerFiles({ mf: [...mf] });

        expect(await resolve('VOO', settle)).toEqual([]);
        const mfAfterLoad = calls.mf;
        expect(await resolve('AAPL')).toEqual(AAPL);

        // Inside the window: no fund-file request, fund tickers still unresolved.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await resolve('VOO')).toEqual([]);
        expect(calls.mf).toBe(mfAfterLoad);

        // Past it: one refetch, and the fund ticker resolves with its series and class.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await resolve('VOO')).toEqual(VOO_LIVE);
        expect(calls.mf).toBe(mfAfterLoad + 1);
        expect(calls.tickers).toBe(1);
        expect(await getEdgarApiService().resolveFundSeries('S000002839', scope())).toEqual(
          VOO_LIVE,
        );
      },
    );

    it('refetches the fund slice once for every resolution waiting on it (single-flight)', async () => {
      const calls = stubTickerFiles({ mf: [404, MF_FILE] });
      await resolve('VOO');
      await vi.advanceTimersByTimeAsync(61_000);

      const api = getEdgarApiService();
      const results = await run(
        Promise.all([
          api.resolveCik('VOO', scope()),
          api.resolveCik('VTI', scope()),
          api.resolveCik('AAPL', scope()),
          api.listFundSeries('36405', scope()),
        ]),
      );

      expect(calls.mf).toBe(2);
      expect(results[0]).toEqual(VOO_LIVE);
      expect(results[1]).toMatchObject({ cik: '0000036405', seriesId: 'S000002848' });
      expect(results[2]).toEqual(AAPL);
      expect(results[3]).toEqual([
        { seriesId: 'S000002839', ticker: 'VOO' },
        { seriesId: 'S000002848', ticker: 'VTI' },
      ]);
    });

    it('retries a persistent failure once per window, not on every resolution', async () => {
      const calls = stubTickerFiles({ mf: [503] });
      await resolve('VOO', 5_000);
      // rawFetch's own three attempts, then nothing more for the window.
      expect(calls.mf).toBe(3);

      for (let i = 0; i < 5; i++) {
        expect(await resolve('AAPL')).toEqual(AAPL);
        expect(await resolve('VOO')).toEqual([]);
      }
      expect(calls.mf).toBe(3);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(await resolve('VOO', 5_000)).toEqual([]);
      expect(calls.mf).toBe(6);
      expect(await resolve('VOO')).toEqual([]);
      expect(calls.mf).toBe(6);
      expect(calls.tickers).toBe(1);
    });

    it('after a 429, sends nothing until the cool-down ends — equities still resolve — then loads the slice', async () => {
      const calls = stubTickerFiles({ mf: [429, MF_FILE] });
      expect(await resolve('VOO')).toEqual([]);
      expect(calls).toEqual({ tickers: 1, mf: 1 });

      // Past the ordinary retry window, still inside the block: the window is the cool-down.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(await resolve('VOO')).toEqual([]);
      expect(await resolve('AAPL')).toEqual(AAPL);
      expect(calls).toEqual({ tickers: 1, mf: 1 });

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(await resolve('VOO')).toEqual(VOO_LIVE);
      expect(calls).toEqual({ tickers: 1, mf: 2 });
    });

    it('keeps the equity index on its own TTL — a fund retry does not extend it', async () => {
      const calls = stubTickerFiles({ mf: [404, MF_FILE] });
      await resolve('AAPL');
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await resolve('VOO')).toEqual(VOO_LIVE);
      expect(calls).toEqual({ tickers: 1, mf: 2 });

      // Just short of the TTL counted from the first load: nothing refetched.
      await vi.advanceTimersByTimeAsync(3_600_000 - 61_000 - 1_000);
      expect(await resolve('VOO')).toEqual(VOO_LIVE);
      expect(calls).toEqual({ tickers: 1, mf: 2 });

      // At the TTL: the whole index reloads, both files.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await resolve('AAPL')).toEqual(AAPL);
      expect(calls).toEqual({ tickers: 2, mf: 3 });
    });
  });

  describe('a successful fund-ticker load', () => {
    it('stays cached for the full TTL', async () => {
      const calls = stubTickerFiles({});
      expect(await resolve('VOO')).toEqual(VOO_LIVE);

      for (const minutes of [1, 10, 30, 59]) {
        vi.setSystemTime(T0 + minutes * 60_000);
        expect(await resolve('VOO')).toEqual(VOO_LIVE);
      }
      expect(calls).toEqual({ tickers: 1, mf: 1 });

      vi.setSystemTime(T0 + 3_600_000 + 100);
      expect(await resolve('VOO')).toEqual(VOO_LIVE);
      expect(calls).toEqual({ tickers: 2, mf: 2 });
    });

    it('leaves equity resolution byte-identical — ticker, CIK, and name search', async () => {
      stubTickerFiles({});
      expect(await resolve('AAPL')).toEqual(AAPL);
      expect(await resolve('320193')).toEqual(AAPL);
      expect(await resolve('apple inc.')).toEqual(AAPL);
      expect(await getEdgarApiService().cikToTicker('320193', scope())).toBe('AAPL');
    });
  });

  describe('the shared ticker-index load under cancellation and the failure budget (#179)', () => {
    const BUDGET_STOP = "retries stopped at this call's 40 s budget for SEC failures";
    /** A call's rejection; a call that resolves fails the test. */
    const failure = (call: Promise<unknown>): Promise<McpError> =>
      call.then(
        () => {
          throw new Error('expected the call to reject');
        },
        (error: unknown) => error as McpError,
      );

    it('keeps loading for every other waiter when one cancels, and caches the index for later calls', async () => {
      const caller = new AbortController();
      const calls = stubTickerFiles({});
      const served = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: RequestInit) => {
          // The call that started the load is cancelled while the load is in flight.
          if (url === TICKERS_URL) caller.abort(CANCELLED);
          return served(url, init);
        }),
      );
      const api = getEdgarApiService();

      const cancelled = failure(api.resolveCik('AAPL', new CallScope(caller.signal)));
      const other = api.resolveCik('VOO', scope());
      await vi.advanceTimersByTimeAsync(50);

      expect((await cancelled) as unknown).toBe(CANCELLED);
      expect(await other).toEqual(VOO_LIVE);
      expect(calls).toEqual({ tickers: 1, mf: 1 });
      expect(await resolve('AAPL')).toEqual(AAPL);
      expect(calls).toEqual({ tickers: 1, mf: 1 });
    });

    it('starts no load for a call cancelled before it asks', async () => {
      const calls = stubTickerFiles({});
      const caller = new AbortController();
      caller.abort(CANCELLED);

      const error = await failure(
        getEdgarApiService().resolveCik('AAPL', new CallScope(caller.signal)),
      );
      await vi.advanceTimersByTimeAsync(1_000);

      expect(error as unknown).toBe(CANCELLED);
      expect(calls).toEqual({ tickers: 0, mf: 0 });
    });

    it('charges each waiting call the failure time the load spent while it waited, once however often it asks', async () => {
      stubTickerFiles({ tickers: ['silent', 'silent', OPERATING] });
      const api = getEdgarApiService();
      const starter = scope();
      const joiner = scope();

      // One call resolving several symbols at once, as fetch_frames does, waits once.
      const first = Promise.all([
        api.resolveCik('AAPL', starter),
        api.resolveCik('VOO', starter),
        api.cikToTicker('320193', starter),
      ]);
      // The load's first attempt has gone unanswered (15 s) and its 1 s backoff begun.
      await vi.advanceTimersByTimeAsync(20_000);
      const second = api.resolveCik('VOO', joiner);
      await vi.advanceTimersByTimeAsync(20_000);

      expect(await first).toEqual([AAPL, VOO_LIVE, 'AAPL']);
      expect(await second).toEqual(VOO_LIVE);
      // 15 + 1 + 15 + 2 s of failure in the load; the joiner waited through the last 17.
      expect(starter.spentMs).toBe(33_000);
      expect(joiner.spentMs).toBe(17_000);
    });

    it('settles a cold resolution whose every request goes unanswered twice inside 45 s, its next request refused as sec_unreachable naming the budget', async () => {
      const warning = vi.spyOn(logger, 'warning').mockImplementation(() => undefined);
      stubTickerFiles({ tickers: ['silent', 'silent', OPERATING], mf: ['silent'] });
      const api = getEdgarApiService();
      const callScope = scope();
      const t0 = Date.now();

      let resolvedAfterMs: number | undefined;
      const company = api.resolveCik('AAPL', callScope).then((match) => {
        resolvedAfterMs = Date.now() - t0;
        return match;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      // 33 s for company_tickers.json, then the fund file's first attempt — sent at the
      // next 1 ms pacing slot — gets the 7 s left and fails, so the fund slice degrades
      // as any failed fund load does.
      expect(await company).toEqual(AAPL);
      expect(resolvedAfterMs).toBe(40_001);
      expect(callScope.spentMs).toBe(40_000);
      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls[0]?.[1]).toMatchObject({
        extra: {
          endpoint: 'company_tickers_mf',
          reason: 'sec_unreachable',
          error: `No HTTP response from SEC EDGAR (www.sec.gov) on attempt 1 of 3, which got no response headers within 7 s; ${BUDGET_STOP}.`,
        },
      });

      // Refused before any request goes out: it settles without the clock moving.
      let refused: McpError | undefined;
      const submissions = failure(api.getSubmissions('320193', callScope)).then((error) => {
        refused = error;
        return error;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(refused).toBeDefined();
      const error = await submissions;
      expect(error.message).toBe(
        `No request sent to SEC EDGAR (data.sec.gov): ${BUDGET_STOP}, which its earlier requests spent.`,
      );
      expect(error.data).toMatchObject({ reason: 'sec_unreachable', retryable: true });
      expect(vi.mocked(globalThis.fetch).mock.calls.map(([url]) => url)).toEqual([
        TICKERS_URL,
        TICKERS_URL,
        TICKERS_URL,
        MF_URL,
      ]);
    });

    it('fails a load SEC never answers at the 40 s budget, as sec_unreachable naming it', async () => {
      stubTickerFiles({ tickers: ['silent'] });
      const api = getEdgarApiService();

      const error = failure(api.resolveCik('AAPL', scope()));
      await vi.advanceTimersByTimeAsync(40_000);

      expect((await error).message).toBe(
        `No HTTP response from SEC EDGAR (www.sec.gov) on attempt 3 of 3, which got no response headers within 7 s; ${BUDGET_STOP}.`,
      );
      expect((await error).data).toMatchObject({ reason: 'sec_unreachable', retryable: true });
    });
  });

  describe('the mirror path', () => {
    it('lets a live fund entry supersede the mirror fund row for the same symbol (#135)', async () => {
      useMirror(MIRROR_ROWS);
      const calls = stubTickerFiles({});

      expect(await resolve('VOO')).toEqual(VOO_LIVE);
      expect(await resolve('VTI')).toMatchObject({ seriesId: 'S000002848', classId: 'C000007773' });
      expect(await resolve('AAPL')).toEqual(AAPL);
      expect(calls).toEqual({ tickers: 0, mf: 1 });
    });

    it('never maps a trust CIK back to one fund ticker (#135)', async () => {
      useMirror(MIRROR_ROWS);
      stubTickerFiles({});
      const api = getEdgarApiService();

      expect(await resolve('36405')).toEqual({ cik: '0000036405' });
      expect(await run(api.cikToTicker('36405', scope()))).toBeUndefined();
      expect(await resolve('320193')).toEqual(AAPL);
    });

    it('retries a failed live fund merge the same way, restoring the series index (#119)', async () => {
      useMirror(MIRROR_ROWS);
      const calls = stubTickerFiles({ mf: [404, MF_FILE] });
      const api = getEdgarApiService();

      // The mirror row still resolves the symbol, but carries no series.
      expect(await resolve('VOO')).toEqual({ cik: '0000036405', ticker: 'VOO' });
      expect(await run(api.resolveFundSeries('S000002839', scope()))).toBeUndefined();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(await run(api.resolveFundSeries('S000002839', scope()))).toBeUndefined();
      expect(calls).toEqual({ tickers: 0, mf: 1 });

      await vi.advanceTimersByTimeAsync(31_000);
      expect(await run(api.resolveFundSeries('S000002839', scope()))).toEqual(VOO_LIVE);
      expect(await resolve('VOO')).toEqual(VOO_LIVE);
      expect(calls).toEqual({ tickers: 0, mf: 2 });
    });

    it('in strict mode resolves a fund ticker to its CIK from the mirror row, with no live request', async () => {
      config.mirrorFallbackLive = false;
      useMirror(MIRROR_ROWS);
      const fetchMock = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
      vi.stubGlobal('fetch', fetchMock);

      expect(await resolve('VOO')).toEqual({ cik: '0000036405', ticker: 'VOO' });
      expect(await resolve('AAPL')).toEqual(AAPL);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(await resolve('VTI')).toEqual({ cik: '0000036405', ticker: 'VTI' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('in strict mode keeps mirror fund rows out of the CIK index (#135)', async () => {
      config.mirrorFallbackLive = false;
      useMirror(MIRROR_ROWS);

      expect(await resolve('36405')).toEqual({ cik: '0000036405' });
    });
  });
});
