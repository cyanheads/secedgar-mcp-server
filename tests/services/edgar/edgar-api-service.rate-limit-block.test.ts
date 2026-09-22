/**
 * @fileoverview `EdgarApiService`'s outbound pacing and its response to SEC's
 * rate-limit block, driven through the public fetch methods with
 * `globalThis.fetch` stubbed and the clock faked — nothing reaches sec.gov, and
 * a real 429 would block this IP for ten minutes. Pins the start spacing the
 * configured request rate implies, then the block cycle: a 429 closes a gate
 * that refuses calls locally with a counting-down `retryAfter`, the first call
 * after it reopens is a single probe, a probe 429 closes it again, and a probe
 * answer resumes ordinary pacing (#116).
 * @module tests/services/edgar/edgar-api-service.rate-limit-block
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { config } = vi.hoisted(() => ({
  config: {
    userAgent: 'test test@example.com',
    rateLimitRps: 10,
    rateLimitCooldownSeconds: 600,
    tickerCacheTtl: 3600,
    mirrorFallbackLive: true,
  },
}));

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));
vi.mock('@/services/edgar/mirror/index.js', () => ({ getEdgarMirror: () => undefined }));

import {
  disposeEdgarApiService,
  getEdgarApiService,
  initEdgarApiService,
} from '@/services/edgar/edgar-api-service.js';

const DOC = (n: number) =>
  `https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/doc-${n}.htm`;

const COOLDOWN_MS = 600_000;

/** A response whose resolution the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

type Answer = number | Promise<Response>;

/**
 * Stub `fetch` with a queue of answers — a status becomes a fresh `Response`, a
 * promise is returned as-is — falling back to 200 once the queue is empty.
 * Records the fake-clock time of every request start.
 */
function stubFetch(...answers: Answer[]) {
  const queue = [...answers];
  const starts: number[] = [];
  const fetchMock = vi.fn(async (_url: string) => {
    starts.push(Date.now());
    const next = queue.shift() ?? 200;
    return typeof next === 'number' ? new Response(`status ${next}`, { status: next }) : next;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, starts };
}

/** Settle a call to its rejection (or `undefined` on success) without throwing. */
function settle(promise: Promise<unknown>): Promise<McpError | undefined> {
  return promise.then(
    () => undefined,
    (error: unknown) => error as McpError,
  );
}

function data(error: McpError | undefined): Record<string, unknown> {
  return (error?.data ?? {}) as Record<string, unknown>;
}

function hint(error: McpError | undefined): string | undefined {
  return (data(error).recovery as { hint?: string } | undefined)?.hint;
}

/** Close the gate: one call answered 429 at the current fake time. */
async function closeGateWith429(): Promise<McpError | undefined> {
  return settle(getEdgarApiService().fetchText(DOC(0)));
}

const T0 = new Date('2026-01-05T15:00:00.000Z').getTime();

describe('EdgarApiService — outbound pacing and the rate-limit block (#116)', () => {
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

  // --- Pacing (unchanged by #116) ---

  describe('pacing', () => {
    it('spaces request starts 1000 / EDGAR_RATE_LIMIT_RPS ms apart', async () => {
      const { starts } = stubFetch();
      const api = getEdgarApiService();

      const calls = [api.fetchText(DOC(1)), api.fetchText(DOC(2)), api.fetchText(DOC(3))];
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all(calls);

      expect(starts.map((at) => at - T0)).toEqual([0, 100, 200]);
    });

    it('lets a request start while an earlier one is still in flight', async () => {
      const slow = deferred<Response>();
      const { starts } = stubFetch(slow.promise);
      const api = getEdgarApiService();

      const first = api.fetchText(DOC(1));
      const second = api.fetchText(DOC(2));
      await vi.advanceTimersByTimeAsync(150);

      // The second request went out at +100ms, before the first response arrived.
      expect(starts.map((at) => at - T0)).toEqual([0, 100]);
      await expect(second).resolves.toBe('status 200');

      slow.resolve(new Response('slow', { status: 200 }));
      await expect(first).resolves.toBe('slow');
    });

    it('queues an ordinary burst to completion rather than shedding any of it', async () => {
      const { fetchMock, starts } = stubFetch();
      const api = getEdgarApiService();

      const burst = Array.from({ length: 30 }, (_, i) => settle(api.fetchText(DOC(i))));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await Promise.all(burst)).toEqual(Array(30).fill(undefined));
      expect(fetchMock).toHaveBeenCalledTimes(30);
      expect((starts.at(-1) ?? 0) - T0).toBe(2_900);
    });
  });

  // --- The block gate ---

  describe('while the block is active', () => {
    it('tags the upstream 429 with the rate_limited reason and the full cool-down', async () => {
      stubFetch(429);

      const error = await closeGateWith429();

      expect(error?.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(data(error)).toMatchObject({ reason: 'rate_limited', retryAfter: 600 });
      expect(hint(error)).toContain('10 minutes');
      expect(hint(error)).toContain('600 seconds');
    });

    it('refuses the next call locally — no request sent — with the same reason', async () => {
      const { fetchMock } = stubFetch(429);
      await closeGateWith429();

      const refused = await settle(getEdgarApiService().fetchText(DOC(1)));

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(refused).toBeInstanceOf(McpError);
      expect(refused?.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(refused?.message).toContain('not sent');
      expect(data(refused)).toMatchObject({ reason: 'rate_limited', retryAfter: 600 });
      expect(hint(refused)).toContain('10 minutes');
    });

    it('counts retryAfter down to the seconds remaining in the cool-down', async () => {
      const { fetchMock } = stubFetch(429);
      await closeGateWith429();
      const api = getEdgarApiService();

      await vi.advanceTimersByTimeAsync(4 * 60_000);
      const atFourMinutes = await settle(api.fetchText(DOC(1)));
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 59_500);
      const halfSecondLeft = await settle(api.fetchText(DOC(2)));

      expect(data(atFourMinutes).retryAfter).toBe(360);
      expect(hint(atFourMinutes)).toContain('360 seconds');
      // Never 0: a caller told to wait 0 seconds would be refused again.
      expect(data(halfSecondLeft).retryAfter).toBe(1);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('never sends a request that was already queued when the 429 landed', async () => {
      const { fetchMock } = stubFetch(429);
      const api = getEdgarApiService();

      const calls = [DOC(0), DOC(1), DOC(2)].map((url) => settle(api.fetchText(url)));
      await vi.advanceTimersByTimeAsync(1_000);
      const [upstream, queued1, queued2] = await Promise.all(calls);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(data(upstream)).toMatchObject({ reason: 'rate_limited', status: 429 });
      for (const refused of [queued1, queued2]) {
        expect(refused?.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(data(refused)).toMatchObject({ reason: 'rate_limited' });
        expect(data(refused).status).toBeUndefined();
      }
    });

    it('does not send a 5xx retry once another call has closed the gate', async () => {
      // Call A draws a 503 and sleeps its 1s backoff; call B draws the 429 meanwhile.
      const { fetchMock } = stubFetch(503, 429);
      const api = getEdgarApiService();

      const a = settle(api.fetchText(DOC(1)));
      const b = settle(api.fetchText(DOC(2)));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(data(await b)).toMatchObject({ reason: 'rate_limited', status: 429 });
      const retryRefused = await a;
      expect(retryRefused?.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(data(retryRefused).status).toBeUndefined();
    });
  });

  describe('after the cool-down', () => {
    it('sends one probe and holds every other call until it resolves', async () => {
      const probe = deferred<Response>();
      const { fetchMock, starts } = stubFetch(429, probe.promise);
      await closeGateWith429();
      await vi.advanceTimersByTimeAsync(COOLDOWN_MS);
      const api = getEdgarApiService();

      const calls = [api.fetchText(DOC(1)), api.fetchText(DOC(2)), api.fetchText(DOC(3))];
      await vi.advanceTimersByTimeAsync(10_000);

      // Only the probe went out; the other two are waiting on it, not refused.
      expect(fetchMock).toHaveBeenCalledTimes(2);

      probe.resolve(new Response('probe ok', { status: 200 }));
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(Promise.all(calls)).resolves.toEqual(['probe ok', 'status 200', 'status 200']);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      const [, probeStart, secondStart, thirdStart] = starts;
      expect((secondStart ?? 0) - (probeStart ?? 0)).toBeGreaterThanOrEqual(10_000);
      expect((thirdStart ?? 0) - (secondStart ?? 0)).toBe(100);
    });

    it('closes again for the full cool-down when the probe draws a 429, refusing the waiters', async () => {
      const probe = deferred<Response>();
      const { fetchMock } = stubFetch(429, probe.promise);
      await closeGateWith429();
      await vi.advanceTimersByTimeAsync(COOLDOWN_MS);
      const api = getEdgarApiService();

      const probing = settle(api.fetchText(DOC(1)));
      const waiting = settle(api.fetchText(DOC(2)));
      await vi.advanceTimersByTimeAsync(2_000);
      probe.resolve(new Response('blocked', { status: 429 }));

      const [probeError, waiterError] = await Promise.all([probing, waiting]);
      expect(data(probeError)).toMatchObject({ reason: 'rate_limited', status: 429 });
      expect(data(probeError).retryAfter).toBe(600);
      expect(data(waiterError)).toMatchObject({ reason: 'rate_limited', retryAfter: 600 });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(COOLDOWN_MS - 1_000);
      expect(data(await settle(api.fetchText(DOC(3)))).retryAfter).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('lets the next call probe again when the probe got no HTTP answer', async () => {
      const probe = deferred<Response>();
      const nextProbe = deferred<Response>();
      const { fetchMock } = stubFetch(429, probe.promise, nextProbe.promise);
      await closeGateWith429();
      await vi.advanceTimersByTimeAsync(COOLDOWN_MS);
      const api = getEdgarApiService();

      const probing = settle(api.fetchText(DOC(1)));
      const waiting = api.fetchText(DOC(2));
      const alsoWaiting = api.fetchText(DOC(3));
      probe.reject(new TypeError('fetch failed'));
      await vi.advanceTimersByTimeAsync(2_000);

      // The network error proves nothing about the block: one waiter probes again, alone.
      expect(await probing).toBeInstanceOf(TypeError);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      nextProbe.resolve(new Response('answered', { status: 200 }));
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(Promise.all([waiting, alsoWaiting])).resolves.toEqual([
        'answered',
        'status 200',
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('runs the whole cycle twice and ends on ordinary pacing', async () => {
      const firstProbe = deferred<Response>();
      const secondProbe = deferred<Response>();
      const inFlight = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
      const { fetchMock, starts } = stubFetch(
        429,
        firstProbe.promise,
        secondProbe.promise,
        200,
        ...inFlight.map((d) => d.promise),
      );
      const api = getEdgarApiService();

      // 429 → the gate closes and refuses locally, retryAfter counting down.
      await closeGateWith429();
      await vi.advanceTimersByTimeAsync(COOLDOWN_MS / 2);
      expect(data(await settle(api.fetchText(DOC(1)))).retryAfter).toBe(300);

      // Reopens → a single probe → it draws a 429 → closed for the full cool-down again.
      await vi.advanceTimersByTimeAsync(COOLDOWN_MS / 2);
      const probe1 = settle(api.fetchText(DOC(2)));
      const waiter1 = settle(api.fetchText(DOC(3)));
      await vi.advanceTimersByTimeAsync(500);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      firstProbe.resolve(new Response('blocked', { status: 429 }));
      expect(data(await probe1)).toMatchObject({ status: 429, retryAfter: 600 });
      expect(data(await waiter1).retryAfter).toBe(600);
      await vi.advanceTimersByTimeAsync(COOLDOWN_MS / 3);
      expect(data(await settle(api.fetchText(DOC(4)))).retryAfter).toBe(400);

      // Reopens → a single probe → it succeeds.
      await vi.advanceTimersByTimeAsync((2 * COOLDOWN_MS) / 3);
      const probe2 = api.fetchText(DOC(5));
      const waiter2 = api.fetchText(DOC(6));
      await vi.advanceTimersByTimeAsync(500);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      secondProbe.resolve(new Response('open', { status: 200 }));
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(Promise.all([probe2, waiter2])).resolves.toEqual(['open', 'status 200']);

      // Ordinary pacing: three slow requests start 100ms apart without waiting on each other.
      const before = starts.length;
      const paced = [7, 8, 9].map((n) => api.fetchText(DOC(n)));
      await vi.advanceTimersByTimeAsync(250);
      const pacedStarts = starts.slice(before);
      expect(pacedStarts).toHaveLength(3);
      expect(pacedStarts.map((at) => at - (pacedStarts[0] ?? 0))).toEqual([0, 100, 200]);
      for (const d of inFlight) d.resolve(new Response('late', { status: 200 }));
      await expect(Promise.all(paced)).resolves.toEqual(['late', 'late', 'late']);
    });
  });

  describe('disposal', () => {
    it('rejects queued requests without sending them and refuses new ones', async () => {
      const slow = deferred<Response>();
      const { fetchMock } = stubFetch(slow.promise);
      const api = getEdgarApiService();

      const inFlight = api.fetchText(DOC(1));
      const queued = [settle(api.fetchText(DOC(2))), settle(api.fetchText(DOC(3)))];
      // The first request goes out at once; the other two wait for their slots.
      await vi.advanceTimersByTimeAsync(50);
      disposeEdgarApiService();

      for (const error of await Promise.all(queued)) {
        expect(error?.code).toBe(JsonRpcErrorCode.RequestCancelled);
      }
      expect((await settle(api.fetchText(DOC(4))))?.code).toBe(JsonRpcErrorCode.RequestCancelled);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchMock).toHaveBeenCalledOnce();

      // The request already in flight is left to finish.
      slow.resolve(new Response('finished', { status: 200 }));
      await expect(inFlight).resolves.toBe('finished');
    });
  });
});
