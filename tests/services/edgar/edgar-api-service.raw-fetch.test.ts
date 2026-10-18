/**
 * @fileoverview `EdgarApiService`'s private `rawFetch` retry/error loop, exercised
 * through a public fetch method with `globalThis.fetch` stubbed. Pins which statuses
 * retry, how many attempts each makes, and what the thrown error carries — in
 * particular that a 429 fails fast with the ten-minute cool-down hint and without
 * SEC's HTML block page (#112), and that a request that gets no HTTP response at
 * all — a runtime `fetch` rejection, or no response headers within the per-attempt
 * cap — takes the same ladder as a 5xx and ends as `sec_unreachable` (#173). A
 * User-Agent that `fetch` refuses before sending is a configuration error at
 * startup instead, never a no-response attempt. No request ever reaches sec.gov:
 * a real 429 would block this IP for ten minutes.
 * @module tests/services/edgar/edgar-api-service.raw-fetch
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

const DOCUMENT_URL = 'https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/a.htm';

/** The shape SEC serves on a rate-limit block: a full HTML page, not a JSON body. */
const SEC_BLOCK_PAGE = `<!DOCTYPE html><html><head><title>SEC.gov | Request Rate Threshold Exceeded</title></head><body><h1>Your Request Originates from an Undeclared Automated Tool</h1><p>To allow for equitable access to all users, SEC reserves the right to limit requests originating from undeclared automated tools.</p></body></html>`;

/** Serve `status` on every call, with a fresh body each time. */
function stubStatus(status: number, body = 'upstream error') {
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * Drive a call that is expected to reject while advancing the fake clock past the
 * throttle delay and every retry backoff, and return the rejection.
 */
async function rejectionWithTimers(promise: Promise<unknown>): Promise<McpError> {
  const settled = promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(30_000);
  return (await settled) as McpError;
}

// --- Runtime rejections with no HTTP response (#173) ---

/** Bun's connect-failure wording, captured from Bun 1.4.3 against a closed loopback port. */
const BUN_CONNECT_TEXT = 'Unable to connect. Is the computer able to access the url?';

/**
 * Bun 1.4.3's own `fetch` rejection, as captured against loopback servers and a
 * `.invalid` name: a `TypeError` carrying the transport code itself, a message led
 * by that code, no `cause`, and the full request URL on `path`.
 */
function bunRejection(code: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new TypeError(message), { code, path: DOCUMENT_URL, errno: 0, ...extra });
}

/**
 * Node 26's (undici 8.10) own `fetch` rejection: `TypeError('fetch failed')` with the
 * transport code on its `cause`.
 */
function nodeRejection(code: string, message: string, name = 'Error') {
  const cause = Object.assign(new Error(message), { code });
  cause.name = name;
  return new TypeError('fetch failed', { cause });
}

const bunReset = () =>
  bunRejection(
    'ECONNRESET',
    'ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
  );
const nodeReset = () => nodeRejection('ECONNRESET', 'read ECONNRESET');
const nodeNotFound = () => nodeRejection('ENOTFOUND', 'getaddrinfo ENOTFOUND www.sec.gov');

const NO_RESPONSE_SHAPES: Array<{ code: string; reject: () => Error; runtime: string }> = [
  {
    runtime: 'bun',
    code: 'ECONNREFUSED',
    reject: () => bunRejection('ECONNREFUSED', `ECONNREFUSED: ${BUN_CONNECT_TEXT}`),
  },
  { runtime: 'bun', code: 'ECONNRESET', reject: bunReset },
  {
    runtime: 'bun',
    code: 'ENOTFOUND',
    reject: () =>
      bunRejection('ENOTFOUND', 'getaddrinfo ENOTFOUND www.sec.gov', {
        errno: 4,
        hostname: 'www.sec.gov',
        syscall: 'getaddrinfo',
      }),
  },
  {
    runtime: 'bun',
    code: 'EHOSTUNREACH',
    reject: () => bunRejection('EHOSTUNREACH', `EHOSTUNREACH: ${BUN_CONNECT_TEXT}`),
  },
  {
    runtime: 'bun',
    code: 'ETIMEDOUT',
    reject: () => bunRejection('ETIMEDOUT', `ETIMEDOUT: ${BUN_CONNECT_TEXT}`),
  },
  {
    runtime: 'node',
    code: 'UND_ERR_CONNECT_TIMEOUT',
    reject: () =>
      nodeRejection(
        'UND_ERR_CONNECT_TIMEOUT',
        'Connect Timeout Error (attempted address: www.sec.gov:443, timeout: 10000ms)',
        'ConnectTimeoutError',
      ),
  },
  {
    runtime: 'node',
    code: 'ECONNREFUSED',
    reject: () => nodeRejection('ECONNREFUSED', 'connect ECONNREFUSED 23.33.62.137:443'),
  },
  { runtime: 'node', code: 'ECONNRESET', reject: nodeReset },
  { runtime: 'node', code: 'ENOTFOUND', reject: nodeNotFound },
  {
    runtime: 'node',
    code: 'EAI_AGAIN',
    reject: () => nodeRejection('EAI_AGAIN', 'getaddrinfo EAI_AGAIN www.sec.gov'),
  },
  {
    runtime: 'node',
    code: 'EHOSTUNREACH',
    reject: () => nodeRejection('EHOSTUNREACH', 'connect EHOSTUNREACH 23.33.62.137:443'),
  },
  {
    runtime: 'node (a plain-object cause)',
    code: 'UND_ERR_CONNECT_TIMEOUT',
    reject: () => new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }),
  },
];

const UNREACHABLE_HINT =
  'SEC EDGAR (www.sec.gov) sent no HTTP response to the last attempt — a network failure between this server and SEC, not a problem with the request. Retry the same call in a minute.';

const unreachableData = (url = DOCUMENT_URL) => ({
  reason: 'sec_unreachable',
  retryable: true,
  url,
  recovery: { hint: UNREACHABLE_HINT },
});

/**
 * Answer each call from `answers` in order — a status becomes a fresh `Response`,
 * an `Error` is thrown as the runtime's rejection — and record the fake-clock time
 * of every request start and every rejection thrown. A call past the end of the
 * list fails the test through its call count.
 */
function stubSequence(...answers: Array<number | (() => Error)>) {
  const queue = [...answers];
  const starts: number[] = [];
  const rejections: Error[] = [];
  const fetchMock = vi.fn(async () => {
    starts.push(Date.now());
    const next =
      queue.shift() ?? (() => new Error('fetch called more times than the test expects'));
    if (typeof next === 'number') return new Response(`status ${next}`, { status: next });
    const rejection = next();
    rejections.push(rejection);
    throw rejection;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, rejections, starts };
}

/**
 * A `fetch` whose response headers arrive `headersAfterMs` after dispatch, or
 * never when `null`. It honors the request's signal the way both runtimes do:
 * once aborted, it rejects with the signal's reason.
 */
function stubHeadersDelay(headersAfterMs: number | null, body = 'filing text') {
  const starts: number[] = [];
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    starts.push(Date.now());
    const signal = init?.signal ?? undefined;
    if (signal) signals.push(signal);
    return new Promise<Response>((resolve, reject) => {
      const timer =
        headersAfterMs === null
          ? undefined
          : setTimeout(() => resolve(new Response(body, { status: 200 })), headersAfterMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, signals, starts };
}

/** Track a call's settlement without awaiting it, so a test can assert it is still pending. */
function track(promise: Promise<unknown>) {
  const state: { error?: McpError; settled: boolean; value?: unknown } = { settled: false };
  const done = promise.then(
    (value) => {
      Object.assign(state, { settled: true, value });
    },
    (error: unknown) => {
      Object.assign(state, { settled: true, error: error as McpError });
    },
  );
  return { done, state };
}

describe('EdgarApiService.rawFetch — retry and error classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    initEdgarApiService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    config.rateLimitRps = 10;
  });

  // --- 429: fail fast, hint, no block page (#112) ---

  it('makes exactly one request on a 429 instead of retrying into the block (#112)', async () => {
    const fetchMock = stubStatus(429, SEC_BLOCK_PAGE);

    const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));

    expect(error).toBeInstanceOf(McpError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('classifies a 429 as RateLimited with a ten-minute cool-down hint (#112)', async () => {
    stubStatus(429, SEC_BLOCK_PAGE);

    const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));

    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    const hint = (error.data as { recovery?: { hint?: string } }).recovery?.hint;
    expect(hint).toContain('10 minutes');
    expect((error.data as { url?: string }).url).toBe(DOCUMENT_URL);
  });

  it('keeps SEC’s HTML block page out of the error payload (#112)', async () => {
    stubStatus(429, SEC_BLOCK_PAGE);

    const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));

    const wire = JSON.stringify({ message: error.message, data: error.data });
    expect(wire).not.toContain('<!DOCTYPE');
    expect(wire).not.toContain('<html');
    expect(wire).not.toContain('<title>');
    expect((error.data as { body?: unknown }).body).toBeUndefined();
    expect((error.data as { responseBody?: unknown }).responseBody).toBeUndefined();
  });

  // --- 5xx: still retried (#112 regression) ---

  it.each([500, 502, 503, 504])(
    'still retries a %i up to MAX_RETRIES before failing (#112)',
    async (status) => {
      const fetchMock = stubStatus(status);

      const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(error).toBeInstanceOf(McpError);
    },
  );

  // --- 403: hint unchanged (#112 regression) ---

  it('keeps the 403 recovery hint byte-identical (#112)', async () => {
    stubStatus(403, 'forbidden');

    const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));

    expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
    expect((error.data as { recovery?: { hint?: string } }).recovery?.hint).toBe(
      'www.sec.gov may be blocking requests. Check EDGAR_USER_AGENT format ("AppName contact@email.com") or retry later.',
    );
  });

  it('does not retry a 403', async () => {
    const fetchMock = stubStatus(403, 'forbidden');

    await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // --- Success and 404 paths stay unaffected ---

  it('returns the body on a 200 without retrying', async () => {
    const fetchMock = vi.fn(async () => new Response('filing text', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const text = getEdgarApiService().fetchText(DOCUMENT_URL);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(text).resolves.toBe('filing text');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws NotFound on a 404 without retrying', async () => {
    const fetchMock = stubStatus(404, 'not found');

    const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));

    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // --- No HTTP response: retried, then sec_unreachable (#173) ---

  describe('a request that gets no HTTP response (#173)', () => {
    it.each(NO_RESPONSE_SHAPES)(
      'retries a $runtime $code rejection three times, 1 s then 2 s apart, then fails as sec_unreachable',
      async ({ code, reject }) => {
        const { fetchMock, rejections, starts } = stubSequence(reject, reject, reject);
        const t0 = Date.now();

        const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(starts.map((at) => at - t0)).toEqual([0, 1_000, 3_000]);
        expect(error).toBeInstanceOf(McpError);
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.message).toBe(
          `No HTTP response from SEC EDGAR (www.sec.gov) on the last of 3 attempts, which ended with ${code}.`,
        );
        // Exactly the declared fields: nothing copied off the runtime's rejection.
        expect(error.data).toEqual(unreachableData());
        // The runtime's own rejection rides `cause`, for the log only.
        expect(rejections).toHaveLength(3);
        expect(error.cause).toBe(rejections[2]);
      },
    );

    it.each([
      ['no code field at all', () => new TypeError('fetch failed')],
      // Only an identifier-shaped code is named: free text in `code` stays out of the message.
      [
        'a code field holding text rather than an identifier',
        () =>
          nodeRejection('getaddrinfo ENOTFOUND www.sec.gov', 'getaddrinfo ENOTFOUND www.sec.gov'),
      ],
    ])(
      'retries a rejection that carries %s, and names no transport code',
      async (_label, reject) => {
        const { fetchMock } = stubSequence(reject, reject, reject);

        const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(error.message).toBe(
          'No HTTP response from SEC EDGAR (www.sec.gov) on the last of 3 attempts, which ended with a network error that carried no code.',
        );
        expect(error.data).toEqual(unreachableData());
      },
    );

    it('keeps the runtime’s own text and the URL it carries on `path` out of the message and data', async () => {
      const urlWithQuery = 'https://efts.sec.gov/LATEST/search-index?q=%22acme%22&forms=10-K';
      const reset = () =>
        Object.assign(
          new TypeError(
            'ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
          ),
          { code: 'ECONNRESET', errno: 0, path: urlWithQuery },
        );
      const refused = () =>
        Object.assign(new TypeError(`ECONNREFUSED: ${BUN_CONNECT_TEXT}`), {
          code: 'ECONNREFUSED',
          errno: 0,
          path: urlWithQuery,
        });
      stubSequence(reset, refused, reset);

      const error = await rejectionWithTimers(getEdgarApiService().fetchText(urlWithQuery));

      const wire = JSON.stringify({ message: error.message, data: error.data });
      expect(wire).not.toContain('verbose');
      expect(wire).not.toContain('Is the computer able to access the url?');
      expect(wire).not.toContain('socket connection');
      expect(error.data).toEqual({
        ...unreachableData(urlWithQuery),
        recovery: { hint: UNREACHABLE_HINT.replace('www.sec.gov', 'efts.sec.gov') },
      });
      expect(error.message).toBe(
        'No HTTP response from SEC EDGAR (efts.sec.gov) on the last of 3 attempts, which ended with ECONNRESET.',
      );
    });

    it('returns the HTTP answer that follows a network failure', async () => {
      const { fetchMock } = stubSequence(bunReset, 200);

      const text = getEdgarApiService().fetchText(DOCUMENT_URL);
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(text).resolves.toBe('status 200');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('reads a 404 after two network failures as null, and as NotFound where a 404 throws', async () => {
      const nullable = stubSequence(nodeNotFound, bunReset, 404);

      const missing = getEdgarApiService().tryFetchText(DOCUMENT_URL);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(missing).resolves.toBeNull();
      expect(nullable.fetchMock).toHaveBeenCalledTimes(3);

      const throwing = stubSequence(bunReset, nodeNotFound, 404);
      const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(throwing.fetchMock).toHaveBeenCalledTimes(3);
    });

    it('fails as the last attempt’s outcome when a ladder mixes no response and 5xx', async () => {
      const endsOn503 = stubSequence(bunReset, nodeReset, 503);
      const httpError = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));
      expect(endsOn503.fetchMock).toHaveBeenCalledTimes(3);
      expect(httpError.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(httpError.data).toMatchObject({ status: 503, url: DOCUMENT_URL });
      expect((httpError.data as { reason?: unknown }).reason).toBeUndefined();

      // Two of the three attempts got an HTTP answer, so the message claims only the last.
      const endsUnanswered = stubSequence(503, 502, bunReset);
      const unreachable = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));
      expect(endsUnanswered.fetchMock).toHaveBeenCalledTimes(3);
      expect(unreachable.data).toEqual(unreachableData());
      expect(unreachable.message).toBe(
        'No HTTP response from SEC EDGAR (www.sec.gov) on the last of 3 attempts, which ended with ECONNRESET.',
      );
    });

    it('lets the pacer’s RequestCancelled through unretried after disposal', async () => {
      const fetchMock = stubStatus(200);
      disposeEdgarApiService();

      const call = track(getEdgarApiService().fetchText(DOCUMENT_URL));
      // No clock advance: a retry would be sleeping its 1 s backoff here.
      await vi.advanceTimersByTimeAsync(0);

      expect(call.state.settled).toBe(true);
      expect(call.state.error).toBeInstanceOf(McpError);
      expect(call.state.error?.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // --- The per-attempt header timeout (#173) ---

  describe('the per-attempt header timeout (#173)', () => {
    it('aborts an attempt with no response headers 15 s after dispatch and retries it, three attempts in all', async () => {
      const { fetchMock, signals, starts } = stubHeadersDelay(null);
      const t0 = Date.now();

      const call = track(getEdgarApiService().fetchText(DOCUMENT_URL));

      await vi.advanceTimersByTimeAsync(14_999);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0]?.aborted).toBe(true);

      // 15 s + 1 s backoff → second attempt; 15 s + 2 s backoff → third; 15 s → done.
      await vi.advanceTimersByTimeAsync(47_999 - 15_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(call.state.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await call.done;
      expect(starts.map((at) => at - t0)).toEqual([0, 16_000, 33_000]);
      expect(signals.map((signal) => signal.aborted)).toEqual([true, true, true]);
      expect(call.state.error).toBeInstanceOf(McpError);
      expect(call.state.error?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(call.state.error?.message).toBe(
        'No HTTP response from SEC EDGAR (www.sec.gov) on the last of 3 attempts, which got no response headers within 15 s.',
      );
      expect(call.state.error?.data).toEqual(unreachableData());
    });

    it('returns the answer when a retry after a timed-out attempt gets headers in time', async () => {
      const starts: number[] = [];
      let calls = 0;
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        starts.push(Date.now());
        calls++;
        if (calls > 1) return Promise.resolve(new Response('second try', { status: 200 }));
        const signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });
      vi.stubGlobal('fetch', fetchMock);
      const t0 = Date.now();

      const text = getEdgarApiService().fetchText(DOCUMENT_URL);
      await vi.advanceTimersByTimeAsync(17_000);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(starts.map((at) => at - t0)).toEqual([0, 16_000]);
      await expect(text).resolves.toBe('second try');
    });

    it('starts the clock at dispatch, so time queued in the pacer does not count', async () => {
      // One start a second: the twentieth call waits 19 s for its slot.
      config.rateLimitRps = 1;
      initEdgarApiService();
      const { fetchMock, signals, starts } = stubHeadersDelay(14_000);

      const calls = Array.from({ length: 20 }, (_, i) =>
        getEdgarApiService().fetchText(`${DOCUMENT_URL}?n=${i}`),
      );
      await vi.advanceTimersByTimeAsync(40_000);

      // One attempt each — none was aborted for the time it spent queued.
      expect(fetchMock).toHaveBeenCalledTimes(20);
      expect(signals.map((signal) => signal.aborted)).toEqual(Array(20).fill(false));
      expect((starts.at(-1) ?? 0) - (starts[0] ?? 0)).toBe(19_000);
      await expect(Promise.all(calls)).resolves.toEqual(Array(20).fill('filing text'));
    });

    it('does not bound the body: a body still streaming 15 s after its headers is read whole', async () => {
      const encoder = new TextEncoder();
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const signal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('head '));
            const timer = setTimeout(() => {
              controller.enqueue(encoder.encode('tail'));
              controller.close();
            }, 20_000);
            // Like a runtime body, the stream errors if the request's signal aborts.
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                controller.error(signal.reason);
              },
              { once: true },
            );
          },
        });
        return new Response(body, { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);

      const text = getEdgarApiService().fetchText(DOCUMENT_URL);
      await vi.advanceTimersByTimeAsync(21_000);

      await expect(text).resolves.toBe('head tail');
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });
});

// --- A User-Agent fetch cannot send is a configuration error (#173) ---

describe('EDGAR_USER_AGENT values fetch cannot send (#173)', () => {
  /**
   * The User-Agent the real config module holds — evaluated afresh so its cache is
   * empty, with EDGAR_USER_AGENT set to `userAgent` and `runtimeCaps.isBun` to
   * `isBun`, so both runtimes' branches run whichever runtime runs the suite — or
   * the code and message of the `McpError` it fails with. The suite above runs on a
   * mocked config.
   */
  async function readUserAgent(userAgent: string, isBun: boolean) {
    vi.stubEnv('EDGAR_USER_AGENT', userAgent);
    vi.resetModules();
    vi.doMock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
      const utils = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
      return { ...utils, runtimeCaps: { ...utils.runtimeCaps, isBun } };
    });
    const { getServerConfig } = await vi.importActual<typeof import('@/config/server-config.js')>(
      '@/config/server-config.js',
    );
    try {
      return { userAgent: getServerConfig().userAgent };
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
      return { code: error.code, message: error.message };
    }
  }

  /** The message `parseEnvConfig` builds around one EDGAR_USER_AGENT issue. */
  const configFailure = (issue: string) =>
    `Server config validation failed:\n  - EDGAR_USER_AGENT (userAgent): ${issue}`;

  const refusal = (issue: string) => ({
    code: JsonRpcErrorCode.ConfigurationError,
    message: configFailure(issue),
  });

  const OUTSIDE_LATIN1 = (position: number, codePoint: string) =>
    `Cannot be sent as an HTTP header: character ${position} is ${codePoint}, outside the Latin-1 range a header can carry. Replace it with an ASCII equivalent (a hyphen for a dash, a straight quote for a curly one) and keep the "AppName contact@email.com" format.`;
  const CONTROL_CHARACTER =
    'Cannot be sent as an HTTP header: it holds a line break or another control character. Remove it and keep the "AppName contact@email.com" format.';

  afterEach(() => {
    vi.doUnmock('@cyanheads/mcp-ts-core/utils');
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // What Bun 1.4.3 and Node 26 both send, probed against a loopback server.
  it.each([
    ['plain ASCII', 'secedgar-mcp-server ops@example.com'],
    ['a Latin-1 accent', 'Société Recherche ops@example.com'],
    ['a no-break space (U+00A0, Latin-1)', 'Acme Research ops@example.com'],
    ['an inner tab', 'Acme\tResearch ops@example.com'],
    [
      'surrounding whitespace and a trailing line break, which fetch strips',
      ' Acme ops@example.com\r\n',
    ],
  ])('accepts %s, as fetch does on both runtimes', async (_label, userAgent) => {
    expect(await readUserAgent(userAgent, false), 'Node').toEqual({ userAgent });
    expect(await readUserAgent(userAgent, true), 'Bun').toEqual({ userAgent });
  });

  // What both runtimes refuse before any request goes out.
  it.each([
    ['an em dash', 'Acme — Research ops@example.com', OUTSIDE_LATIN1(6, 'U+2014')],
    ['a curly apostrophe', 'Acme’s Research ops@example.com', OUTSIDE_LATIN1(5, 'U+2019')],
    ['an emoji', 'Acme 📈 ops@example.com', OUTSIDE_LATIN1(6, 'U+1F4C8')],
    ['an inner line break', 'Acme\r\nX-Injected: 1', CONTROL_CHARACTER],
  ])(
    'rejects %s as a ConfigurationError naming EDGAR_USER_AGENT',
    async (_label, userAgent, issue) => {
      expect(await readUserAgent(userAgent, false), 'Node').toEqual(refusal(issue));
      expect(await readUserAgent(userAgent, true), 'Bun').toEqual(refusal(issue));
    },
  );

  // Node's undici refuses DEL and the C0 controls other than tab at dispatch; Bun 1.4 sends them.
  it.each([
    ['DEL', 'Acme\u007fResearch ops@example.com'],
    ['U+0001', 'Acme\u0001Research ops@example.com'],
  ])(
    'rejects %s on Node, whose fetch refuses it, and accepts it on Bun, which sends it',
    async (_label, userAgent) => {
      expect(await readUserAgent(userAgent, false), 'Node').toEqual(refusal(CONTROL_CHARACTER));
      expect(await readUserAgent(userAgent, true), 'Bun').toEqual({ userAgent });
    },
  );

  it('stops the service at initialization, before any request, instead of retrying into sec_unreachable', async () => {
    vi.stubEnv('EDGAR_USER_AGENT', 'Acme — Research ops@example.com');
    vi.resetModules();
    vi.doUnmock('@/config/server-config.js');
    const fetchMock = vi.fn(async () => new Response('unreachable', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const service = await import('@/services/edgar/edgar-api-service.js');

    expect(() => service.initEdgarApiService()).toThrow(configFailure(OUTSIDE_LATIN1(6, 'U+2014')));
    expect(fetchMock).not.toHaveBeenCalled();
    vi.doMock('@/config/server-config.js', () => ({ getServerConfig: () => config }));
  });
});
