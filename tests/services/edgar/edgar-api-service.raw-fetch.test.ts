/**
 * @fileoverview `EdgarApiService`'s private `rawFetch` retry/error loop, exercised
 * through a public fetch method with `globalThis.fetch` stubbed. Pins which statuses
 * retry, how many attempts each makes, and what the thrown error carries — in
 * particular that a 429 fails fast with the ten-minute cool-down hint and without
 * SEC's HTML block page (#112), and that a request that gets no HTTP response at
 * all — a runtime `fetch` rejection, or no response headers within the per-attempt
 * cap — takes the same ladder as a 5xx and ends as `sec_unreachable` (#173), as
 * does a 2xx whose body fails to read after its headers, and a 200 body that is not
 * JSON fails the same way unretried (#181). Every wait on that ladder is bounded by
 * the call's 40 s failure budget and ends at once on the caller's cancel (#179). A
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

import { CallScope } from '@/services/edgar/call-scope.js';
import {
  disposeEdgarApiService,
  getEdgarApiService,
  initEdgarApiService,
} from '@/services/edgar/edgar-api-service.js';

const DOCUMENT_URL = 'https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/a.htm';

/** A fresh call scope that is never cancelled: one tool call's signal and failure budget (#179). */
const scope = () => new CallScope(new AbortController().signal);

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
 * a factory's `Response` is returned as-is, and its `Error` is thrown as the
 * runtime's rejection — and record the fake-clock time of every request start and
 * every rejection thrown. A call past the end of the list fails the test through
 * its call count.
 */
function stubSequence(...answers: Array<number | (() => Error | Response)>) {
  const queue = [...answers];
  const starts: number[] = [];
  const rejections: Error[] = [];
  const fetchMock = vi.fn(async () => {
    starts.push(Date.now());
    const next =
      queue.shift() ?? (() => new Error('fetch called more times than the test expects'));
    if (typeof next === 'number') return new Response(`status ${next}`, { status: next });
    const answer = next();
    if (answer instanceof Response) return answer;
    rejections.push(answer);
    throw answer;
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

// --- Response bodies that fail after their headers arrive (#181) ---

/**
 * Node 26's (undici) own body-read rejection: `TypeError('terminated')` with the
 * underlying failure on `cause`, which carries a code for some failures and none
 * for others.
 */
function nodeBodyRejection(name: string, message: string, code?: string) {
  const cause = Object.assign(new Error(message), code === undefined ? {} : { code });
  cause.name = name;
  return new TypeError('terminated', { cause });
}

/**
 * Each runtime's own rejection on reading a 200's body, captured from Bun 1.4.4 and
 * Node 26.12.1 against a loopback server that sent valid headers and then a
 * `Content-Length` longer than the bytes it sent (short), invalid chunk framing
 * (chunk), or `Content-Encoding: gzip` over a plain body (gzip). Bun carries the
 * transport code on the error itself, the request URL on `path`, and — for chunk
 * and gzip — the URL in its message too; Node's chunk-framing `HTTPParserError`
 * carries no code at all.
 */
const BODY_FAILURE_SHAPES: Array<{
  case: string;
  code: string | undefined;
  reject: () => Error;
  runtime: string;
}> = [
  { runtime: 'bun', case: 'short', code: 'ECONNRESET', reject: bunReset },
  {
    runtime: 'bun',
    case: 'chunk',
    code: 'InvalidHTTPResponse',
    reject: () =>
      bunRejection(
        'InvalidHTTPResponse',
        `InvalidHTTPResponse fetching "${DOCUMENT_URL}". For more information, pass \`verbose: true\` in the second argument to fetch()`,
      ),
  },
  {
    runtime: 'bun',
    case: 'gzip',
    code: 'ZlibError',
    reject: () =>
      bunRejection(
        'ZlibError',
        `ZlibError fetching "${DOCUMENT_URL}". For more information, pass \`verbose: true\` in the second argument to fetch()`,
      ),
  },
  {
    runtime: 'node',
    case: 'short',
    code: 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
    reject: () =>
      nodeBodyRejection(
        'ResponseContentLengthMismatchError',
        'Response body length does not match content-length header',
        'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
      ),
  },
  {
    runtime: 'node',
    case: 'chunk',
    code: undefined,
    reject: () =>
      nodeBodyRejection(
        'HTTPParserError',
        'Response does not match the HTTP/1.1 protocol (Invalid character in chunk size)',
      ),
  },
  {
    runtime: 'node',
    case: 'gzip',
    code: 'Z_DATA_ERROR',
    reject: () => nodeBodyRejection('Error', 'incorrect header check', 'Z_DATA_ERROR'),
  },
];

const nodeShortBody = () => BODY_FAILURE_SHAPES[3]?.reject() ?? new Error('missing shape');

const encoder = new TextEncoder();

/**
 * A 200 whose headers arrive and whose body then breaks: `head` is delivered, and
 * the next read rejects with `rejection`, as a runtime body stream does when the
 * connection fails after the headers.
 */
function brokenBody(rejection: Error, head = '{"partial":') {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(head));
      },
      pull(controller) {
        controller.error(rejection);
      },
    }),
    { status: 200 },
  );
}

/** A 200 that delivers `head` and then neither another byte nor its end; records its cancellation. */
function stalledBody(head = 'head ') {
  const state = { cancelled: false };
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(head));
      },
      cancel() {
        state.cancelled = true;
      },
    }),
    { status: 200 },
  );
  return { response, state };
}

/** A 200 whose body arrives as `chunks`, one every `gapMs` on the fake clock, then ends. */
function tricklingBody(chunks: string[], gapMs: number) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk, i) => {
          setTimeout(() => controller.enqueue(encoder.encode(chunk)), i * gapMs);
        });
        setTimeout(() => controller.close(), (chunks.length - 1) * gapMs);
      },
    }),
    { status: 200 },
  );
}

/**
 * A 200 whose body hands out `chunks` one per read, recording how many were pulled
 * and whether the rest was cancelled. `endless` keeps it open after the last chunk;
 * `cancelRejects` makes its cancel fail, as a cancel racing a body's end can.
 */
function chunkedBody(
  chunks: string[],
  options: { cancelRejects?: boolean; endless?: boolean } = {},
) {
  const state = { cancelled: false, pulled: 0 };
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[state.pulled];
          if (chunk === undefined) {
            if (!options.endless) controller.close();
            return;
          }
          state.pulled++;
          controller.enqueue(encoder.encode(chunk));
        },
        cancel() {
          state.cancelled = true;
          if (options.cancelRejects) throw new TypeError('cancel raced the end of the body');
        },
      },
      { highWaterMark: 0 },
    ),
    { status: 200 },
  );
  return { response, state };
}

const BODY_HINT =
  'SEC EDGAR (www.sec.gov) answered the last attempt, but its response body broke off or stalled before it finished — a network failure between this server and SEC, not a problem with the request. Retry the same call in a minute.';

const bodyFailedData = (url = DOCUMENT_URL) => ({
  reason: 'sec_unreachable',
  retryable: true,
  url,
  recovery: { hint: BODY_HINT },
});

const bodyFailedMessage = (ending: string) =>
  `The response body from SEC EDGAR (www.sec.gov) failed to read on the last of 3 attempts, which ${ending}.`;

const NOT_JSON_HINT =
  'SEC EDGAR (www.sec.gov) answered with something other than the JSON it serves for this request, such as a temporary error page — not a problem with the request. Retry the same call in a minute.';

// --- The caller's signal and the call's failure budget (#179) ---

/** How a failure the call's failure budget ended says so (#179). */
const BUDGET_STOP = "retries stopped at this call's 40 s budget for SEC failures";

/** The reason the MCP SDK aborts a cancelled request with: the `notifications/cancelled` reason string. */
const CANCELLED = 'client cancelled';

/**
 * Answer each call from `answers` in order: `'silent'` never sends headers, and
 * `[ms, response]` sends `response()` `ms` after dispatch on the fake clock. Either
 * rejects with the request signal's reason once it aborts, as both runtimes do. A
 * call past the end of the list rejects, failing the test through its call count.
 */
type TimedAnswer = 'silent' | readonly [number, () => Response];

function stubTimed(...answers: TimedAnswer[]) {
  const queue = [...answers];
  const starts: number[] = [];
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    starts.push(Date.now());
    const signal = init?.signal ?? undefined;
    const next = queue.shift();
    return new Promise<Response>((resolve, reject) => {
      if (next === undefined) {
        reject(new Error('fetch called more times than the test expects'));
        return;
      }
      const timer = next === 'silent' ? undefined : setTimeout(() => resolve(next[1]()), next[0]);
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
  return { fetchMock, starts };
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

    const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL, scope()));

    expect(error).toBeInstanceOf(McpError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('classifies a 429 as RateLimited with a ten-minute cool-down hint (#112)', async () => {
    stubStatus(429, SEC_BLOCK_PAGE);

    const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL, scope()));

    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    const hint = (error.data as { recovery?: { hint?: string } }).recovery?.hint;
    expect(hint).toContain('10 minutes');
    expect((error.data as { url?: string }).url).toBe(DOCUMENT_URL);
  });

  it('keeps SEC’s HTML block page out of the error payload (#112)', async () => {
    stubStatus(429, SEC_BLOCK_PAGE);

    const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL, scope()));

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

      const error = await rejectionWithTimers(
        getEdgarApiService().fetchText(DOCUMENT_URL, scope()),
      );

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(error).toBeInstanceOf(McpError);
    },
  );

  // --- 403: hint unchanged (#112 regression) ---

  it('keeps the 403 recovery hint byte-identical (#112)', async () => {
    stubStatus(403, 'forbidden');

    const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL, scope()));

    expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
    expect((error.data as { recovery?: { hint?: string } }).recovery?.hint).toBe(
      'www.sec.gov may be blocking requests. Check EDGAR_USER_AGENT format ("AppName contact@email.com") or retry later.',
    );
  });

  it('does not retry a 403', async () => {
    const fetchMock = stubStatus(403, 'forbidden');

    await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL, scope()));

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // --- Success and 404 paths stay unaffected ---

  it('returns the body on a 200 without retrying', async () => {
    const fetchMock = vi.fn(async () => new Response('filing text', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const text = getEdgarApiService().fetchText(DOCUMENT_URL, scope());
    await vi.advanceTimersByTimeAsync(1000);

    await expect(text).resolves.toBe('filing text');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws NotFound on a 404 without retrying', async () => {
    const fetchMock = stubStatus(404, 'not found');

    const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL, scope()));

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

        const error = await rejectionWithTimers(
          getEdgarApiService().fetchText(DOCUMENT_URL, scope()),
        );

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

        const error = await rejectionWithTimers(
          getEdgarApiService().fetchText(DOCUMENT_URL, scope()),
        );

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

      const error = await rejectionWithTimers(
        getEdgarApiService().fetchText(urlWithQuery, scope()),
      );

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

      const text = getEdgarApiService().fetchText(DOCUMENT_URL, scope());
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(text).resolves.toBe('status 200');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('reads a 404 after two network failures as null, and as NotFound where a 404 throws', async () => {
      const nullable = stubSequence(nodeNotFound, bunReset, 404);

      const missing = getEdgarApiService().tryFetchText(DOCUMENT_URL, scope());
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(missing).resolves.toBeNull();
      expect(nullable.fetchMock).toHaveBeenCalledTimes(3);

      const throwing = stubSequence(bunReset, nodeNotFound, 404);
      const error = await rejectionWithTimers(
        getEdgarApiService().fetchText(DOCUMENT_URL, scope()),
      );
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(throwing.fetchMock).toHaveBeenCalledTimes(3);
    });

    it('fails as the last attempt’s outcome when a ladder mixes no response and 5xx', async () => {
      const endsOn503 = stubSequence(bunReset, nodeReset, 503);
      const httpError = await rejectionWithTimers(
        getEdgarApiService().fetchText(DOCUMENT_URL, scope()),
      );
      expect(endsOn503.fetchMock).toHaveBeenCalledTimes(3);
      expect(httpError.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(httpError.data).toMatchObject({ status: 503, url: DOCUMENT_URL });
      expect((httpError.data as { reason?: unknown }).reason).toBeUndefined();

      // Two of the three attempts got an HTTP answer, so the message claims only the last.
      const endsUnanswered = stubSequence(503, 502, bunReset);
      const unreachable = await rejectionWithTimers(
        getEdgarApiService().fetchText(DOCUMENT_URL, scope()),
      );
      expect(endsUnanswered.fetchMock).toHaveBeenCalledTimes(3);
      expect(unreachable.data).toEqual(unreachableData());
      expect(unreachable.message).toBe(
        'No HTTP response from SEC EDGAR (www.sec.gov) on the last of 3 attempts, which ended with ECONNRESET.',
      );
    });

    it('lets the pacer’s RequestCancelled through unretried after disposal', async () => {
      const fetchMock = stubStatus(200);
      disposeEdgarApiService();

      const call = track(getEdgarApiService().fetchText(DOCUMENT_URL, scope()));
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
    it('aborts an attempt with no response headers 15 s after dispatch and retries it, three attempts in all, the last cut to the 40 s budget (#179)', async () => {
      const { fetchMock, signals, starts } = stubHeadersDelay(null);
      const t0 = Date.now();

      const call = track(getEdgarApiService().fetchText(DOCUMENT_URL, scope()));

      await vi.advanceTimersByTimeAsync(14_999);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0]?.aborted).toBe(true);

      // 15 s + 1 s backoff → second attempt; 15 s + 2 s backoff → third, which gets the
      // 7 s of the call's 40 s failure budget left rather than its own 15 s (#179).
      await vi.advanceTimersByTimeAsync(39_999 - 15_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(call.state.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await call.done;
      expect(starts.map((at) => at - t0)).toEqual([0, 16_000, 33_000]);
      expect(signals.map((signal) => signal.aborted)).toEqual([true, true, true]);
      expect(call.state.error).toBeInstanceOf(McpError);
      expect(call.state.error?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(call.state.error?.message).toBe(
        `No HTTP response from SEC EDGAR (www.sec.gov) on attempt 3 of 3, which got no response headers within 7 s; ${BUDGET_STOP}.`,
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

      const text = getEdgarApiService().fetchText(DOCUMENT_URL, scope());
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
        getEdgarApiService().fetchText(`${DOCUMENT_URL}?n=${i}`, scope()),
      );
      await vi.advanceTimersByTimeAsync(40_000);

      // One attempt each — none was aborted for the time it spent queued.
      expect(fetchMock).toHaveBeenCalledTimes(20);
      expect(signals.map((signal) => signal.aborted)).toEqual(Array(20).fill(false));
      expect((starts.at(-1) ?? 0) - (starts[0] ?? 0)).toBe(19_000);
      await expect(Promise.all(calls)).resolves.toEqual(Array(20).fill('filing text'));
    });

    it('does not bound the body: a body still streaming 15 s after its headers is read whole', async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const signal = init?.signal ?? undefined;
        const timers: Array<ReturnType<typeof setTimeout>> = [];
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('head '));
            // A byte every 10 s keeps the body inside its idle limit (#181).
            timers.push(setTimeout(() => controller.enqueue(encoder.encode('middle ')), 10_000));
            timers.push(
              setTimeout(() => {
                controller.enqueue(encoder.encode('tail'));
                controller.close();
              }, 20_000),
            );
            // Like a runtime body, the stream errors if the request's signal aborts.
            signal?.addEventListener(
              'abort',
              () => {
                for (const timer of timers) clearTimeout(timer);
                controller.error(signal.reason);
              },
              { once: true },
            );
          },
        });
        return new Response(body, { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);

      const text = getEdgarApiService().fetchText(DOCUMENT_URL, scope());
      await vi.advanceTimersByTimeAsync(21_000);

      await expect(text).resolves.toBe('head middle tail');
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  // --- A response body that fails to read (#181) ---

  describe('a response body that fails to read after its headers (#181)', () => {
    it.each(BODY_FAILURE_SHAPES)(
      'retries a $runtime $case body failure three times, 1 s then 2 s apart, then fails as sec_unreachable',
      async ({ code, reject }) => {
        const rejections = [reject(), reject(), reject()];
        const { fetchMock, starts } = stubSequence(...rejections.map((r) => () => brokenBody(r)));
        const t0 = Date.now();

        const error = await rejectionWithTimers(
          getEdgarApiService().fetchText(DOCUMENT_URL, scope()),
        );

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(starts.map((at) => at - t0)).toEqual([0, 1_000, 3_000]);
        expect(error).toBeInstanceOf(McpError);
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.message).toBe(
          bodyFailedMessage(
            code === undefined
              ? 'ended with a network error that carried no code'
              : `ended with ${code}`,
          ),
        );
        expect(error.data).toEqual(bodyFailedData());
        expect(error.cause).toBe(rejections[2]);
      },
    );

    it.each([
      ['fetchJson', (url: string) => getEdgarApiService().fetchJson(url, scope())],
      ['tryFetchJson', (url: string) => getEdgarApiService().tryFetchJson(url, scope())],
      ['fetchText', (url: string) => getEdgarApiService().fetchText(url, scope())],
      ['tryFetchText', (url: string) => getEdgarApiService().tryFetchText(url, scope())],
      [
        'tryGetFilingDocumentHead',
        () =>
          getEdgarApiService().tryGetFilingDocumentHead(
            '320193',
            '0000320193-23-000106',
            'a.htm',
            { maxBytes: 1_000_000, stopAt: '</never>' },
            scope(),
          ),
      ],
    ] as const)('reads the body inside the ladder in %s', async (_method, call) => {
      const { fetchMock } = stubSequence(
        () => brokenBody(nodeShortBody()),
        () => brokenBody(nodeShortBody()),
        () => brokenBody(nodeShortBody()),
      );

      const error = await rejectionWithTimers(call(DOCUMENT_URL));

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toBe(
        bodyFailedMessage('ended with UND_ERR_RES_CONTENT_LENGTH_MISMATCH'),
      );
      expect(error.data).toEqual(bodyFailedData());
    });

    it.each([
      ['fetchJson', () => getEdgarApiService().fetchJson(DOCUMENT_URL, scope()), { filings: 2 }],
      [
        'tryFetchJson',
        () => getEdgarApiService().tryFetchJson(DOCUMENT_URL, scope()),
        { filings: 2 },
      ],
      ['fetchText', () => getEdgarApiService().fetchText(DOCUMENT_URL, scope()), '{"filings":2}'],
      [
        'tryFetchText',
        () => getEdgarApiService().tryFetchText(DOCUMENT_URL, scope()),
        '{"filings":2}',
      ],
      [
        'tryGetFilingDocumentHead',
        () =>
          getEdgarApiService().tryGetFilingDocumentHead(
            '320193',
            '0000320193-23-000106',
            'a.htm',
            { maxBytes: 1_000_000, stopAt: '"filings"' },
            scope(),
          ),
        '{"filings":2}',
      ],
    ] as const)('returns the body a later attempt reads in %s', async (_method, call, expected) => {
      const { fetchMock } = stubSequence(
        () => brokenBody(bunReset()),
        () => new Response('{"filings":2}', { status: 200 }),
      );

      const result = call();
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(result).resolves.toEqual(expected);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('fails as the last attempt’s outcome when a ladder mixes body failures, no response, and 5xx', async () => {
      const endsOn503 = stubSequence(() => brokenBody(bunReset()), bunReset, 503);
      const httpError = await rejectionWithTimers(
        getEdgarApiService().fetchText(DOCUMENT_URL, scope()),
      );
      expect(endsOn503.fetchMock).toHaveBeenCalledTimes(3);
      expect(httpError.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(httpError.data).toMatchObject({ status: 503, url: DOCUMENT_URL });
      expect((httpError.data as { reason?: unknown }).reason).toBeUndefined();

      const endsOnBody = stubSequence(503, bunReset, () => brokenBody(nodeShortBody()));
      const bodyError = await rejectionWithTimers(
        getEdgarApiService().fetchText(DOCUMENT_URL, scope()),
      );
      expect(endsOnBody.fetchMock).toHaveBeenCalledTimes(3);
      expect(bodyError.data).toEqual(bodyFailedData());
      expect(bodyError.message).toBe(
        bodyFailedMessage('ended with UND_ERR_RES_CONTENT_LENGTH_MISMATCH'),
      );

      // A body that broke earlier does not color an unanswered last attempt.
      const endsUnanswered = stubSequence(
        () => brokenBody(bunReset()),
        () => brokenBody(bunReset()),
        nodeReset,
      );
      const unreachable = await rejectionWithTimers(
        getEdgarApiService().fetchText(DOCUMENT_URL, scope()),
      );
      expect(endsUnanswered.fetchMock).toHaveBeenCalledTimes(3);
      expect(unreachable.data).toEqual(unreachableData());
      expect(unreachable.message).toBe(
        'No HTTP response from SEC EDGAR (www.sec.gov) on the last of 3 attempts, which ended with ECONNRESET.',
      );
    });

    it('keeps the runtime’s text and the request URL out of the message', async () => {
      const urlWithQuery = 'https://efts.sec.gov/LATEST/search-index?q=%22acme%22&forms=10-K';
      const chunkFailure = () =>
        Object.assign(
          new TypeError(
            `InvalidHTTPResponse fetching "${urlWithQuery}". For more information, pass \`verbose: true\` in the second argument to fetch()`,
          ),
          { code: 'InvalidHTTPResponse', errno: 0, path: urlWithQuery },
        );
      stubSequence(
        () => brokenBody(nodeShortBody()),
        () => brokenBody(bunReset()),
        () => brokenBody(chunkFailure()),
      );

      const error = await rejectionWithTimers(
        getEdgarApiService().fetchText(urlWithQuery, scope()),
      );

      expect(error.message).not.toContain(urlWithQuery);
      expect(error.message).not.toContain('search-index');
      const wire = JSON.stringify({ message: error.message, data: error.data });
      expect(wire).not.toContain('verbose');
      expect(wire).not.toContain('terminated');
      expect(wire).not.toContain('fetching');
      expect(error.data).toEqual({
        ...bodyFailedData(urlWithQuery),
        recovery: { hint: BODY_HINT.replace('www.sec.gov', 'efts.sec.gov') },
      });
      expect(error.message).toBe(
        'The response body from SEC EDGAR (efts.sec.gov) failed to read on the last of 3 attempts, which ended with InvalidHTTPResponse.',
      );
    });

    it('leaves a 404’s body unread and its outcome unchanged', async () => {
      // `highWaterMark: 0` pulls only on a read, so `pulls` counts reads of the body.
      let pulls = 0;
      const notFoundBody = () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                pulls++;
                controller.error(bunReset());
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 404 },
        );
      const nullable = stubSequence(notFoundBody);
      const missing = getEdgarApiService().tryFetchText(DOCUMENT_URL, scope());
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(missing).resolves.toBeNull();
      expect(nullable.fetchMock).toHaveBeenCalledOnce();

      const throwing = stubSequence(notFoundBody);
      const error = await rejectionWithTimers(
        getEdgarApiService().fetchJson(DOCUMENT_URL, scope()),
      );
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(throwing.fetchMock).toHaveBeenCalledOnce();
      expect(pulls).toBe(0);
    });

    it('keeps the error-path body read best-effort: a 503 or 403 whose body breaks keeps its status mapping', async () => {
      const breakingStatus = (status: number) => () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(nodeShortBody());
            },
          }),
          { status },
        );

      const fiveHundreds = stubSequence(
        breakingStatus(503),
        breakingStatus(503),
        breakingStatus(503),
      );
      const httpError = await rejectionWithTimers(
        getEdgarApiService().fetchText(DOCUMENT_URL, scope()),
      );
      expect(fiveHundreds.fetchMock).toHaveBeenCalledTimes(3);
      expect(httpError.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(httpError.data).toMatchObject({ status: 503, url: DOCUMENT_URL });
      expect((httpError.data as { reason?: unknown }).reason).toBeUndefined();

      const forbidden = stubSequence(breakingStatus(403));
      const forbiddenError = await rejectionWithTimers(
        getEdgarApiService().fetchText(DOCUMENT_URL, scope()),
      );
      expect(forbidden.fetchMock).toHaveBeenCalledOnce();
      expect(forbiddenError.code).toBe(JsonRpcErrorCode.Forbidden);
      expect((forbiddenError.data as { recovery?: { hint?: string } }).recovery?.hint).toBe(
        'www.sec.gov may be blocking requests. Check EDGAR_USER_AGENT format ("AppName contact@email.com") or retry later.',
      );
    });
  });

  // --- A body that stops arriving (#181) ---

  describe('the body idle limit (#181)', () => {
    it('fails an attempt whose body sends no bytes for 15 s, retries it, and cancels each stalled body, the last idle wait cut to the 40 s budget (#179)', async () => {
      const bodies = [stalledBody(), stalledBody(), stalledBody()];
      const { fetchMock, starts } = stubSequence(...bodies.map((b) => () => b.response));
      const t0 = Date.now();

      const call = track(getEdgarApiService().fetchText(DOCUMENT_URL, scope()));

      await vi.advanceTimersByTimeAsync(14_999);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(bodies[0]?.state.cancelled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(bodies[0]?.state.cancelled).toBe(true);

      // 15 s idle + 1 s backoff → second attempt; 15 s + 2 s → third, whose idle wait
      // gets the 7 s of the call's failure budget left (#179).
      await vi.advanceTimersByTimeAsync(39_999 - 15_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(call.state.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await call.done;
      expect(starts.map((at) => at - t0)).toEqual([0, 16_000, 33_000]);
      expect(bodies.map((b) => b.state.cancelled)).toEqual([true, true, true]);
      expect(call.state.error).toBeInstanceOf(McpError);
      expect(call.state.error?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(call.state.error?.message).toBe(
        `The response body from SEC EDGAR (www.sec.gov) failed to read on attempt 3 of 3, which got no body bytes for 7 s; ${BUDGET_STOP}.`,
      );
      expect(call.state.error?.data).toEqual(bodyFailedData());
    });

    it('never cuts a body that is still arriving, however slowly: a byte every 10 s for a minute', async () => {
      const chunks = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      const { fetchMock } = stubSequence(() => tricklingBody(chunks, 10_000));

      const call = track(getEdgarApiService().fetchText(DOCUMENT_URL, scope()));
      await vi.advanceTimersByTimeAsync(59_999);
      expect(call.state.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await call.done;
      expect(call.state.value).toBe('abcdefg');
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('returns the body a retry reads after a stalled attempt', async () => {
      const { fetchMock } = stubSequence(
        () => stalledBody().response,
        () => new Response('second try', { status: 200 }),
      );

      const text = getEdgarApiService().fetchText(DOCUMENT_URL, scope());
      await vi.advanceTimersByTimeAsync(17_000);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      await expect(text).resolves.toBe('second try');
    });
  });

  // --- A 200 whose body is not JSON (#181) ---

  describe('a 200 whose body is not JSON (#181)', () => {
    it.each([
      ['fetchJson', () => getEdgarApiService().fetchJson(DOCUMENT_URL, scope())],
      ['tryFetchJson', () => getEdgarApiService().tryFetchJson(DOCUMENT_URL, scope())],
    ] as const)(
      'sends one request in %s and fails as sec_unreachable without the parser’s text',
      async (_method, call) => {
        const { fetchMock } = stubSequence(
          () =>
            new Response('<html><body>Service temporarily unavailable</body></html>', {
              status: 200,
            }),
        );

        const error = await rejectionWithTimers(call());

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(error).toBeInstanceOf(McpError);
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.message).toBe(
          'SEC EDGAR (www.sec.gov) answered, but its response body is not the JSON this request expects.',
        );
        expect(error.data).toEqual({
          reason: 'sec_unreachable',
          retryable: true,
          url: DOCUMENT_URL,
          recovery: { hint: NOT_JSON_HINT },
        });
        expect(error.cause).toBeInstanceOf(SyntaxError);
        const wire = JSON.stringify({ message: error.message, data: error.data });
        expect(wire).not.toContain('<html');
        expect(wire).not.toContain('Unexpected token');
        expect(wire).not.toContain('JSON Parse error');
      },
    );

    it('still returns the same body as text where text is asked for', async () => {
      const { fetchMock } = stubSequence(() => new Response('<html>page</html>', { status: 200 }));

      const text = getEdgarApiService().fetchText(DOCUMENT_URL, scope());
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(text).resolves.toBe('<html>page</html>');
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  // --- The filing-head read ---

  describe('tryGetFilingDocumentHead', () => {
    const head = (options: { maxBytes: number; stopAt: string }) =>
      getEdgarApiService().tryGetFilingDocumentHead(
        '320193',
        '0000320193-23-000106',
        'primary_doc.xml',
        options,
        scope(),
      );

    it('stops at the read holding stopAt and cancels the rest of the body', async () => {
      const body = chunkedBody(['<a>', '<b>', '<c></header>', '<d>', '<e>']);
      stubSequence(() => body.response);

      const result = head({ maxBytes: 1_000_000, stopAt: '</header>' });
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe('<a><b><c></header>');
      expect(body.state.pulled).toBe(3);
      expect(body.state.cancelled).toBe(true);
    });

    it('stops once maxBytes have arrived, at a read boundary', async () => {
      const body = chunkedBody(['0123456789', 'abcdefghij', 'ABCDEFGHIJ', 'klmnopqrst']);
      stubSequence(() => body.response);

      const result = head({ maxBytes: 25, stopAt: '</never>' });
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe('0123456789abcdefghijABCDEFGHIJ');
      expect(body.state.pulled).toBe(3);
      expect(body.state.cancelled).toBe(true);
    });

    it('returns the whole document when it ends before either cutoff', async () => {
      stubSequence(() => chunkedBody(['<doc>', '</doc>']).response);

      const result = head({ maxBytes: 1_000_000, stopAt: '</never>' });
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe('<doc></doc>');
    });

    it('returns null on a 404 in one request', async () => {
      const { fetchMock } = stubSequence(404);

      const result = head({ maxBytes: 1_000_000, stopAt: '</header>' });
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(result).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('does not read its own early stop as a body failure, even when the cancel itself fails', async () => {
      const body = chunkedBody(['<a></header>', '<b>'], { cancelRejects: true, endless: true });
      const { fetchMock } = stubSequence(() => body.response);

      const result = track(head({ maxBytes: 1_000_000, stopAt: '</header>' }));
      await vi.advanceTimersByTimeAsync(0);
      await result.done;

      expect(result.state.value).toBe('<a></header>');
      expect(body.state.cancelled).toBe(true);
      // Nothing left to fire: no idle timer outlives the read, and no retry follows.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('retries a head read whose body breaks before stopAt, and returns the head a later attempt reads', async () => {
      const { fetchMock } = stubSequence(
        () => brokenBody(nodeShortBody(), '<a>'),
        () => chunkedBody(['<a>', '</header>', '<b>']).response,
      );

      const result = head({ maxBytes: 1_000_000, stopAt: '</header>' });
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(result).resolves.toBe('<a></header>');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // --- The caller's signal (#179) ---

  describe('the caller’s signal (#179)', () => {
    /**
     * A 200 that delivers `head`, cancels the caller from inside its next pull — the
     * read under test is in flight — and then delivers `tail` and ends, so a read
     * that ignored the cancel would finish and return the whole body.
     */
    function cancellingBody(caller: AbortController, head: string, tail: string) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(head));
          },
          pull(controller) {
            caller.abort(CANCELLED);
            controller.enqueue(encoder.encode(tail));
            controller.close();
          },
        }),
        { status: 200 },
      );
    }

    it('aborts the attempt in flight and sends nothing more, rethrowing the caller’s reason untouched', async () => {
      const caller = new AbortController();
      const signals: AbortSignal[] = [];
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        signals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          caller.abort(CANCELLED);
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const call = track(
        getEdgarApiService().fetchText(DOCUMENT_URL, new CallScope(caller.signal)),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(call.state.settled).toBe(true);
      expect(call.state.error as unknown).toBe(CANCELLED);
      expect(signals[0]?.aborted).toBe(true);
      // No retry: the cancel is not a no-response attempt.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('ends a body read mid-stream: no retry, never a body-read failure, and the rest of the body is cancelled', async () => {
      const caller = new AbortController();
      const body = { cancelled: false };
      const fetchMock = vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode('head '));
              },
              pull() {
                caller.abort(CANCELLED);
              },
              cancel() {
                body.cancelled = true;
              },
            }),
            { status: 200 },
          ),
      );
      vi.stubGlobal('fetch', fetchMock);

      const call = track(
        getEdgarApiService().fetchText(DOCUMENT_URL, new CallScope(caller.signal)),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(call.state.settled).toBe(true);
      expect(call.state.error as unknown).toBe(CANCELLED);
      expect(body.cancelled).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('ends a backoff sleep at once and sends no further attempt', async () => {
      const caller = new AbortController();
      const fetchMock = stubStatus(503);

      const call = track(
        getEdgarApiService().fetchText(DOCUMENT_URL, new CallScope(caller.signal)),
      );
      await vi.advanceTimersByTimeAsync(500);
      // The 503 is in, and the call is sleeping its 1 s backoff.
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(call.state.settled).toBe(false);

      caller.abort(CANCELLED);
      await vi.advanceTimersByTimeAsync(0);
      expect(call.state.error as unknown).toBe(CANCELLED);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it.each([
      [
        'getSubmissions',
        (callScope: CallScope) => getEdgarApiService().getSubmissions('320193', callScope),
        { cik: '320193' },
      ],
      [
        'fetchArchivePage',
        (callScope: CallScope) =>
          getEdgarApiService().fetchArchivePage('CIK0000320193-submissions-001.json', callScope),
        { cik: '320193' },
      ],
      [
        'fetchFullIndexQuarter',
        (callScope: CallScope) => getEdgarApiService().fetchFullIndexQuarter(1998, 1, callScope),
        // The whole body arrives, but it is not a master.idx: no entries parse from it.
        [],
      ],
    ] as const)(
      'caches nothing from a %s read cancelled mid-body',
      async (_method, read, whole) => {
        const caller = new AbortController();
        const fetchMock = vi
          .fn()
          .mockImplementationOnce(async () => cancellingBody(caller, '{"cik":', '"320193"}'))
          .mockImplementation(async () => new Response('{"cik":"320193"}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const cancelled = track(read(new CallScope(caller.signal)));
        await vi.advanceTimersByTimeAsync(0);
        expect(cancelled.state.error as unknown).toBe(CANCELLED);

        // The next call reads the same URL afresh: the cancelled read left no cache entry behind.
        const again = read(scope());
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(again).resolves.toEqual(whole);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [first, second] = fetchMock.mock.calls.map(([url]) => url);
        expect(second).toBe(first);
      },
    );
  });

  // --- The call's failure budget (#179) ---

  describe('the call’s failure budget (#179)', () => {
    it('counts headers that arrive just inside 15 s when the body then stalls, ending the call at 40 s, not three ~30 s attempts', async () => {
      const { fetchMock, starts } = stubTimed(
        [14_900, () => stalledBody().response],
        [14_900, () => stalledBody().response],
      );
      const t0 = Date.now();

      const call = track(getEdgarApiService().fetchText(DOCUMENT_URL, scope()));
      // 14.9 s of headers + 15 s idle = 29.9 s, then 1 s of backoff: the second attempt
      // gets the 9.1 s left, and its headers are not in by then.
      await vi.advanceTimersByTimeAsync(39_999);
      expect(call.state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await call.done;

      expect(starts.map((at) => at - t0)).toEqual([0, 30_900]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(call.state.error?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(call.state.error?.message).toBe(
        `No HTTP response from SEC EDGAR (www.sec.gov) on attempt 2 of 3, which got no response headers within 9.1 s; ${BUDGET_STOP}.`,
      );
      expect(call.state.error?.data).toEqual(unreachableData());
    });

    it('charges every failing attempt of the call, concurrent ones included: three silent requests spend it in one round', async () => {
      const { fetchMock } = stubTimed('silent', 'silent', 'silent');
      const callScope = scope();
      const api = getEdgarApiService();

      const calls = [1, 2, 3].map((n) => track(api.fetchText(`${DOCUMENT_URL}?n=${n}`, callScope)));
      await vi.advanceTimersByTimeAsync(60_000);

      // 15 s each: the third to time out finds the budget spent, and the two sleeping
      // their backoff find it spent when they wake, so no second attempt goes out.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      for (const call of calls) {
        expect(call.state.error?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(call.state.error?.message).toBe(
          `No HTTP response from SEC EDGAR (www.sec.gov) on attempt 1 of 3, which got no response headers within 15 s; ${BUDGET_STOP}.`,
        );
      }
    });

    it('ends a 5xx ladder at the budget with the status mapping and a message naming the budget', async () => {
      const busy = () => new Response('busy', { status: 503 });
      const { fetchMock } = stubTimed(
        'silent',
        'silent',
        [0, () => new Response('first', { status: 200 })],
        [2_000, busy],
        [2_000, busy],
      );
      const callScope = scope();
      const api = getEdgarApiService();

      // 15 + 1 + 15 + 2 = 33 s of the budget spent, then answered.
      const first = api.fetchText(DOCUMENT_URL, callScope);
      await vi.advanceTimersByTimeAsync(34_000);
      await expect(first).resolves.toBe('first');

      // 2 s to a 503 and 1 s of backoff leave 4 s; the second 503 takes 2 s more, and
      // the 2 s backoff no longer fits.
      const second = track(api.fetchText(`${DOCUMENT_URL}?n=2`, callScope));
      await vi.advanceTimersByTimeAsync(10_000);
      await second.done;

      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(second.state.error?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(second.state.error?.message).toBe(
        `SEC EDGAR returned HTTP 503 on attempt 2 of 3; ${BUDGET_STOP}.`,
      );
      expect(second.state.error?.data).toMatchObject({ status: 503, url: `${DOCUMENT_URL}?n=2` });
    });

    it('stops further requests in the call that spent it, and in no other call', async () => {
      const { fetchMock } = stubTimed('silent', 'silent', 'silent', [
        0,
        () => new Response('other call', { status: 200 }),
      ]);
      const spent = scope();
      const api = getEdgarApiService();

      const first = track(api.fetchText(DOCUMENT_URL, spent));
      await vi.advanceTimersByTimeAsync(40_000);
      await first.done;
      expect(first.state.error?.data).toEqual(unreachableData());

      const next = track(api.fetchText(`${DOCUMENT_URL}?n=2`, spent));
      await vi.advanceTimersByTimeAsync(0);
      expect(next.state.error?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(next.state.error?.message).toBe(
        `No request sent to SEC EDGAR (www.sec.gov): ${BUDGET_STOP}, which its earlier requests spent.`,
      );
      expect(next.state.error?.data).toEqual({
        reason: 'sec_unreachable',
        retryable: true,
        url: `${DOCUMENT_URL}?n=2`,
        recovery: {
          hint: "SEC EDGAR (www.sec.gov) failed this call's earlier requests until its budget for SEC failures ran out — a network failure between this server and SEC, not a problem with the request. Retry the same call in a minute.",
        },
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);

      const other = api.fetchText(`${DOCUMENT_URL}?n=3`, scope());
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(other).resolves.toBe('other call');
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('never cuts a healthy call, however long its requests take: slow headers and slow bodies charge nothing', async () => {
      const slow = () => tricklingBody(['a', 'b', 'c'], 10_000);
      const { fetchMock } = stubTimed(
        'silent',
        [0, () => new Response('recovered', { status: 200 })],
        [14_000, slow],
        [14_000, slow],
        [14_000, slow],
        [14_000, slow],
      );
      const callScope = scope();
      const api = getEdgarApiService();

      // One silent attempt and its backoff spend 16 s; nothing after it is charged.
      const texts: string[] = [];
      for (let n = 0; n < 5; n++) {
        const text = api.fetchText(`${DOCUMENT_URL}?n=${n}`, callScope);
        await vi.advanceTimersByTimeAsync(40_000);
        texts.push(await text);
      }

      expect(texts).toEqual(['recovered', 'abc', 'abc', 'abc', 'abc']);
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(callScope.spentMs).toBe(16_000);
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
