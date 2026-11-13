/**
 * @fileoverview EFTS response shape-guard tests for `EdgarApiService.searchFilings`
 * (#61). EFTS can return a 2xx whose body omits `hits.total` — a degraded payload,
 * or a rejected request echoed as `{ error: ... }` with 200. The service must throw
 * a structured retryable ServiceUnavailable instead of letting a raw property-access
 * TypeError leak, while a genuine zero-hit response (hits.total.value: 0, empty
 * hits.hits) passes through as valid. `findFilingCiks` routes through the same
 * guard, so both call sites are covered. A 200 relaying a failure of the search
 * backend (`errorType`) is a failed attempt on the retry ladder when the failure is
 * a transport one, and fails on its one request otherwise, with the backend's error
 * in typed fields (#206). Caller text is escaped before it reaches full-text search,
 * in `q` and `keysTyped` alike (#205). An entity lookup returns SEC's `hits.total` beside
 * its hits (#230), each listed entity's name without SEC's ticker list and with its first
 * ticker (#236). A subsidiary search names the filers of the 10-K subsidiaries exhibits
 * (EX-21) holding a quoted name, and no other filer (#236).
 * @module tests/services/edgar/edgar-api-service.efts
 */

import { readFileSync } from 'node:fs';
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
import { getEdgarApiService, initEdgarApiService } from '@/services/edgar/edgar-api-service.js';

const scope = () => new CallScope(new AbortController().signal);

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('EdgarApiService.searchFilings — EFTS shape guard (#61)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    initEdgarApiService();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('throws structured ServiceUnavailable on a 2xx body with an error echo and no hits.total', async () => {
    // Live-verified degraded shape: EFTS answers a rejected request with 200 and
    // { error: "...", hits: { hits: [] } } — no hits.total.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          error:
            'Blank search not valid.  Either entity, keywords, location, or filing types must be submitted.',
          hits: { hits: [] },
        }),
      ),
    );

    const err = await getEdgarApiService()
      .searchFilings({ query: 'revenue' }, scope())
      .catch((e) => e);

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data.reason).toBe('efts_degraded_response');
    expect(err.data.recovery.hint).toMatch(/retry/i);
    expect(err.data.upstreamError).toContain('Blank search not valid');
  });

  it('throws structured ServiceUnavailable on an entirely empty 2xx body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({})),
    );

    const err = await getEdgarApiService()
      .searchFilings({ query: 'revenue' }, scope())
      .catch((e) => e);

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data.reason).toBe('efts_degraded_response');
    expect(err.message).not.toMatch(/undefined is not an object/);
  });

  it('accepts a genuine zero-hit response as valid (live-verified shape)', async () => {
    // A zero-hit 2xx still carries hits.total = { value: 0, relation: 'eq' } and an
    // empty hits.hits — valid, not degraded.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          hits: { total: { value: 0, relation: 'eq' }, hits: [] },
          query: { from: 0, size: 20, query: 'zzqqxyzzy' },
        }),
      ),
    );

    const response = await getEdgarApiService().searchFilings({ query: 'zzqqxyzzy' }, scope());

    expect(response.hits.total.value).toBe(0);
    expect(response.hits.hits).toEqual([]);
  });

  it('guards the findFilingCiks call site too — structured error, not a TypeError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({})),
    );

    const err = await getEdgarApiService()
      .findFilingCiks('0000320193-23-000106', scope())
      .catch((e) => e);

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data.reason).toBe('efts_degraded_response');
  });
});

describe('EdgarApiService.resolveEntityByName — EFTS entity-autocomplete (#73)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    initEdgarApiService();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('resolves a name to a single zero-padded CIK candidate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          hits: {
            hits: [{ _id: '1067983', _source: { entity: 'BERKSHIRE HATHAWAY INC', rank: 999 } }],
          },
        }),
      ),
    );

    const resolution = await getEdgarApiService().resolveEntityByName(
      'berkshire hathaway',
      scope(),
    );

    // Bare _id is zero-padded to the 10-digit CIK the submissions API expects. A response
    // carrying no hits.total reports none.
    expect(resolution).toEqual({
      matches: [{ cik: '0001067983', name: 'BERKSHIRE HATHAWAY INC' }],
      total: undefined,
    });
  });

  it('returns every distinct CIK for a name shared by multiple entities (Vanguard)', async () => {
    // Live-verified shape: "vanguard group" returns a transfer-agent CIK (735286) ranked
    // above the 13F filer (102909) under the same legal name — both must surface so the
    // caller disambiguates by CIK; the tool must never auto-pick the top hit (#73).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          hits: {
            hits: [
              { _id: '735286', _source: { entity: 'VANGUARD GROUP INC', rank: 784474 } },
              { _id: '102909', _source: { entity: 'VANGUARD GROUP INC', rank: 178869656 } },
            ],
          },
        }),
      ),
    );

    const { matches } = await getEdgarApiService().resolveEntityByName('vanguard group', scope());

    expect(matches).toEqual([
      { cik: '0000735286', name: 'VANGUARD GROUP INC' },
      { cik: '0000102909', name: 'VANGUARD GROUP INC' },
    ]);
  });

  /** Ten distinct entity hits, as EFTS returns its first page for a common name. */
  const tenHits = Array.from({ length: 10 }, (_, i) => ({
    _id: String(2026150 + i),
    _source: { entity: `Wealth Management ${i} LLC`, rank: 1 },
  }));

  it.each([
    ['an exact count', { value: 598, relation: 'eq' }],
    ['a floor', { value: 10000, relation: 'gte' }],
  ])('returns SEC hits.total beside its first page of hits, %s (#230)', async (_case, total) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ hits: { total, hits: tenHits } })),
    );

    const resolution = await getEdgarApiService().resolveEntityByName(
      'Wealth Management LLC',
      scope(),
    );

    expect(resolution.matches).toHaveLength(10);
    expect(resolution.matches[0]).toEqual({ cik: '0002026150', name: 'Wealth Management 0 LLC' });
    expect(resolution.total).toEqual(total);
  });

  it('reads a hits.total with no numeric value as no total (#230)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ hits: { total: {}, hits: tenHits } })),
    );

    const resolution = await getEdgarApiService().resolveEntityByName(
      'Wealth Management LLC',
      scope(),
    );

    expect(resolution.matches).toHaveLength(10);
    expect(resolution.total).toBeUndefined();
  });

  it('sends the typed name via the keysTyped query param', async () => {
    const fetchMock = vi.fn(async (_input: unknown) => jsonResponse({ hits: { hits: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    await getEdgarApiService().resolveEntityByName('vanguard group', scope());

    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('efts.sec.gov/LATEST/search-index');
    expect(calledUrl).toContain('keysTyped=vanguard+group');
  });

  it('returns an empty array when EFTS reports no hits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ hits: { total: { value: 0, relation: 'eq' }, hits: [] } })),
    );

    const resolution = await getEdgarApiService().resolveEntityByName(
      'zzqqxyzzy nonexistent',
      scope(),
    );

    expect(resolution).toEqual({ matches: [], total: { value: 0, relation: 'eq' } });
  });

  it('dedups repeated CIKs, keeping first-seen order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          hits: {
            hits: [
              { _id: '102909', _source: { entity: 'VANGUARD GROUP INC', rank: 1 } },
              { _id: '102909', _source: { entity: 'VANGUARD GROUP INC', rank: 1 } },
            ],
          },
        }),
      ),
    );

    const { matches } = await getEdgarApiService().resolveEntityByName('vanguard', scope());

    expect(matches).toEqual([{ cik: '0000102909', name: 'VANGUARD GROUP INC' }]);
  });
});

// --- A 200 relaying a failure of the search backend (#206) ---

/**
 * What EDGAR full-text search answers, with HTTP 200, when its OpenSearch client throws:
 * the error's class, its message, the Lambda's stack frames, and the Lambda's request id.
 */
const backendErrorBody = (errorType: string, errorMessage: string) => ({
  errorType,
  errorMessage,
  trace: [
    `${errorType}: ${errorMessage}`,
    '    at ClientRequest.onError (/opt/nodejs/node_modules/@opensearch-project/opensearch/lib/Connection.js:129:16)',
  ],
  requestId: '3f0c9d52-7d1e-4b0e-9a3c-2b5f8e4a1c77',
});

const CONNECTION_MESSAGE =
  'getaddrinfo EBUSY vpc-efts-prod-opensearchservice.us-east-1.es.amazonaws.com';

/** EFTS's answer to `q=revenue&from=9901`, captured live 2026-11-02. */
const RESULT_WINDOW_MESSAGE =
  'search_phase_execution_exception: [illegal_argument_exception] Reason: Result window is too large, from + size must be less than or equal to: [10000] but was [10001]. See the scroll api for a more efficient way to request large data sets. This limit can be set by changing the [index.max_result_window] index level setting.';

const HITS_PAGE = {
  hits: {
    total: { value: 1, relation: 'eq' },
    hits: [
      {
        _id: '0000320193-23-000106:aapl-20230930.htm',
        _source: {
          adsh: '0000320193-23-000106',
          ciks: ['0000320193'],
          display_names: ['Apple Inc.  (AAPL)  (CIK 0000320193)'],
          file_date: '2023-11-03',
          form: '10-K',
        },
      },
    ],
  },
};

const TRANSIENT_HINT =
  "EDGAR full-text search (efts.sec.gov) answered, but its search backend could not run the search — a temporary failure on SEC's side, not a problem with the request. Retry the same call in a minute.";

const REFUSED_HINT =
  'EDGAR full-text search (efts.sec.gov) refused to run this search, and resending it unchanged fails the same way — upstreamErrorMessage gives the reason to change.';

/** The reason the MCP SDK aborts a cancelled request with. */
const CANCELLED = 'client cancelled';

/**
 * Answer each EDGAR full-text search request from `answers` in order — `[ms, body]`
 * sends `body` as a JSON 200 `ms` after dispatch on the fake clock, or rejects with the
 * request signal's reason once it aborts — recording each request's start. A request to
 * another host, or past the end of the list, rejects; the test fails through its count.
 */
function stubEfts(...answers: Array<readonly [number, unknown]>) {
  const queue = [...answers];
  const starts: number[] = [];
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const next = new URL(input).hostname === 'efts.sec.gov' ? queue.shift() : undefined;
    if (next === undefined) return Promise.reject(new Error(`unexpected fetch: ${input}`));
    starts.push(Date.now());
    if (next[0] === 0) return Promise.resolve(jsonResponse(next[1]));
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(jsonResponse(next[1])), next[0]);
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

/**
 * Settle assertions made on a pending call — each one `expect(call).rejects…`, made
 * before the fake clock runs so none awaits a clock that never moves — and fail with
 * the first that failed. Settling them all leaves no failed assertion unhandled.
 */
async function settleAll(assertions: Array<Promise<unknown>>) {
  for (const outcome of await Promise.allSettled(assertions)) {
    if (outcome.status === 'rejected') throw outcome.reason;
  }
}

/** Assert `call` rejects with exactly this code, message, and data once the fake clock has run `ms`. */
async function expectFailure(
  call: Promise<unknown>,
  ms: number,
  error: { code: number; data: Record<string, unknown>; message: string },
) {
  const assertions = [
    expect(call).rejects.toBeInstanceOf(McpError),
    expect(call).rejects.toHaveProperty('code', error.code),
    expect(call).rejects.toHaveProperty('message', error.message),
    expect(call).rejects.toHaveProperty('data', error.data),
  ];
  await vi.advanceTimersByTimeAsync(ms);
  await settleAll(assertions);
}

describe('EdgarApiService — a 200 relaying a failure of the search backend (#206)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    initEdgarApiService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('a transport failure (ConnectionError, TimeoutError, NoLivingConnectionsError)', () => {
    it.each(['ConnectionError', 'TimeoutError', 'NoLivingConnectionsError'])(
      'retries a %s three times, 1 s then 2 s apart, then fails as a retryable efts_degraded_response',
      async (errorType) => {
        const body = backendErrorBody(errorType, CONNECTION_MESSAGE);
        const { fetchMock, starts } = stubEfts([0, body], [0, body], [0, body]);
        const t0 = Date.now();

        await expectFailure(
          getEdgarApiService().searchFilings({ query: 'revenue' }, scope()),
          10_000,
          {
            code: JsonRpcErrorCode.ServiceUnavailable,
            message:
              'EDGAR full-text search (efts.sec.gov) answered the last of 3 attempts with a failure of its search backend instead of results.',
            // Exactly these fields: never the backend's stack frames or its request id.
            data: {
              reason: 'efts_degraded_response',
              retryable: true,
              upstreamErrorType: errorType,
              upstreamErrorMessage: CONNECTION_MESSAGE,
              recovery: { hint: TRANSIENT_HINT },
            },
          },
        );
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(starts.map((at) => at - t0)).toEqual([0, 1_000, 3_000]);
      },
    );

    it('returns the hits a retry gets, charging the failed attempt’s wait and its backoff to the call', async () => {
      const { fetchMock, starts } = stubEfts(
        [300, backendErrorBody('ConnectionError', CONNECTION_MESSAGE)],
        [0, HITS_PAGE],
      );
      const callScope = scope();
      const t0 = Date.now();

      const response = getEdgarApiService().searchFilings({ query: 'revenue' }, callScope);
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(response).resolves.toEqual(HITS_PAGE);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(starts.map((at) => at - t0)).toEqual([0, 1_300]);
      // 300 ms to the failed attempt's answer, then its 1 s backoff.
      expect(callScope.spentMs).toBe(1_300);
    });

    it('charges the time a failed attempt’s body took to read, as well as its headers', async () => {
      const failure = new TextEncoder().encode(
        JSON.stringify(backendErrorBody('ConnectionError', CONNECTION_MESSAGE)),
      );
      // Headers at once; the body's second half 400 ms later on the fake clock.
      const slowBody = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(failure.slice(0, 10));
              setTimeout(() => {
                controller.enqueue(failure.slice(10));
                controller.close();
              }, 400);
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(async () => slowBody())
        .mockImplementationOnce(async () => jsonResponse(HITS_PAGE));
      vi.stubGlobal('fetch', fetchMock);
      const callScope = scope();

      const response = getEdgarApiService().searchFilings({ query: 'revenue' }, callScope);
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(response).resolves.toEqual(HITS_PAGE);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // 400 ms reading the failed attempt's body, then its 1 s backoff.
      expect(callScope.spentMs).toBe(1_400);
    });

    it('ends a backoff at once on the caller’s cancel, rethrowing its reason and sending nothing more', async () => {
      const { fetchMock } = stubEfts(
        [0, backendErrorBody('ConnectionError', CONNECTION_MESSAGE)],
        [0, HITS_PAGE],
      );
      const caller = new AbortController();

      const call = getEdgarApiService().searchFilings(
        { query: 'revenue' },
        new CallScope(caller.signal),
      );
      const cancelled = expect(call).rejects.toBe(CANCELLED);
      await vi.advanceTimersByTimeAsync(500);
      // The failed attempt is in, and the call is sleeping its 1 s backoff.
      expect(fetchMock).toHaveBeenCalledOnce();

      caller.abort(CANCELLED);
      await vi.advanceTimersByTimeAsync(0);
      await cancelled;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('sends no further attempt once the call’s failure budget cannot cover the backoff', async () => {
      const { fetchMock } = stubEfts(
        [0, backendErrorBody('ConnectionError', CONNECTION_MESSAGE)],
        [0, HITS_PAGE],
      );
      const callScope = scope();
      callScope.charge(39_500);

      await expectFailure(
        getEdgarApiService().searchFilings({ query: 'revenue' }, callScope),
        60_000,
        {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message:
            "EDGAR full-text search (efts.sec.gov) answered attempt 1 of 3 with a failure of its search backend instead of results; retries stopped at this call's 40 s budget for SEC failures.",
          data: {
            reason: 'efts_degraded_response',
            retryable: true,
            upstreamErrorType: 'ConnectionError',
            upstreamErrorMessage: CONNECTION_MESSAGE,
            recovery: { hint: TRANSIENT_HINT },
          },
        },
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('re-admits each retry through the block gate: a 429 landing during the backoff refuses the retry unsent', async () => {
      const requests: string[] = [];
      const fetchMock = vi.fn(async (input: string) => {
        requests.push(new URL(input).hostname);
        if (new URL(input).hostname === 'www.sec.gov')
          return new Response('blocked', { status: 429 });
        return jsonResponse(backendErrorBody('ConnectionError', CONNECTION_MESSAGE));
      });
      vi.stubGlobal('fetch', fetchMock);
      const api = getEdgarApiService();

      const search = api.searchFilings({ query: 'revenue' }, scope());
      const assertions = [
        expect(search).rejects.toHaveProperty('code', JsonRpcErrorCode.RateLimited),
        expect(search).rejects.toHaveProperty(
          'message',
          expect.stringContaining('request not sent'),
        ),
        expect(search).rejects.toHaveProperty('data.reason', 'rate_limited'),
      ];
      await vi.advanceTimersByTimeAsync(500);
      // Another call draws a 429 while the search sleeps its backoff, closing the gate.
      const blocked = api.fetchText(
        'https://www.sec.gov/Archives/edgar/data/320193/a.htm',
        scope(),
      );
      assertions.push(expect(blocked).rejects.toHaveProperty('code', JsonRpcErrorCode.RateLimited));
      await vi.advanceTimersByTimeAsync(5_000);

      await settleAll(assertions);
      expect(requests).toEqual(['efts.sec.gov', 'www.sec.gov']);
    });
  });

  describe('any other backend error', () => {
    it('fails a ResponseError on its one request, carrying the error in typed fields and claiming no retry', async () => {
      const { fetchMock } = stubEfts([0, backendErrorBody('ResponseError', RESULT_WINDOW_MESSAGE)]);

      await expectFailure(
        getEdgarApiService().searchFilings({ query: 'revenue', from: 9901 }, scope()),
        60_000,
        {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message:
            'EDGAR full-text search (efts.sec.gov) answered with an error from its search backend instead of results.',
          data: {
            reason: 'efts_degraded_response',
            retryable: false,
            upstreamErrorType: 'ResponseError',
            upstreamErrorMessage: RESULT_WINDOW_MESSAGE,
            recovery: { hint: REFUSED_HINT },
          },
        },
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('bounds the backend’s error type and message to 500 bytes, never splitting a character', async () => {
      // 'é' is two bytes, straddling the 500-byte cut.
      const longMessage = `${'x'.repeat(499)}é and the rest of a long message`;
      stubEfts([0, backendErrorBody('A'.repeat(600), longMessage)]);

      await expectFailure(
        getEdgarApiService().searchFilings({ query: 'revenue' }, scope()),
        1_000,
        {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message:
            'EDGAR full-text search (efts.sec.gov) answered with an error from its search backend instead of results.',
          data: {
            reason: 'efts_degraded_response',
            retryable: false,
            upstreamErrorType: `${'A'.repeat(500)}…`,
            upstreamErrorMessage: `${'x'.repeat(499)}…`,
            recovery: { hint: REFUSED_HINT },
          },
        },
      );
    });
  });

  describe('a 200 with no hits and no backend error (unchanged)', () => {
    const DEGRADED_MESSAGE =
      'SEC EDGAR full-text search returned an unexpected response without hits — the service may be degraded.';
    const DEGRADED_RECOVERY = {
      hint: 'Retry the search in a few minutes — EDGAR full-text search returned an incomplete response.',
    };

    it.each<[string, unknown, Record<string, unknown>]>([
      [
        'an error echo',
        {
          error:
            'Blank search not valid.  Either entity, keywords, location, or filing types must be submitted.',
          hits: { hits: [] },
        },
        {
          upstreamError:
            'Blank search not valid.  Either entity, keywords, location, or filing types must be submitted.',
        },
      ],
      ['an empty object', {}, {}],
      ['hits without a total', { hits: { hits: [] } }, {}],
      ['an errorType that is not a string', { errorType: 7, errorMessage: 'x' }, {}],
    ])('fails %s on its one request as before', async (_case, body, extra) => {
      const { fetchMock } = stubEfts([0, body], [0, HITS_PAGE]);

      await expectFailure(
        getEdgarApiService().searchFilings({ query: 'revenue' }, scope()),
        10_000,
        {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: DEGRADED_MESSAGE,
          data: { reason: 'efts_degraded_response', ...extra, recovery: DEGRADED_RECOVERY },
        },
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  describe('resolveEntityByName', () => {
    it('throws the exhausted transport failure instead of reporting no match', async () => {
      const body = backendErrorBody('ConnectionError', CONNECTION_MESSAGE);
      const { fetchMock } = stubEfts([0, body], [0, body], [0, body]);

      await expectFailure(
        getEdgarApiService().resolveEntityByName('obscure capital', scope()),
        10_000,
        {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message:
            'EDGAR full-text search (efts.sec.gov) answered the last of 3 attempts with a failure of its search backend instead of results.',
          data: {
            reason: 'efts_degraded_response',
            retryable: true,
            upstreamErrorType: 'ConnectionError',
            upstreamErrorMessage: CONNECTION_MESSAGE,
            recovery: { hint: TRANSIENT_HINT },
          },
        },
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('throws any other backend error on its one request', async () => {
      const { fetchMock } = stubEfts([0, backendErrorBody('ResponseError', RESULT_WINDOW_MESSAGE)]);

      await expectFailure(
        getEdgarApiService().resolveEntityByName('obscure capital', scope()),
        1_000,
        {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message:
            'EDGAR full-text search (efts.sec.gov) answered with an error from its search backend instead of results.',
          data: {
            reason: 'efts_degraded_response',
            retryable: false,
            upstreamErrorType: 'ResponseError',
            upstreamErrorMessage: RESULT_WINDOW_MESSAGE,
            recovery: { hint: REFUSED_HINT },
          },
        },
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('still reads a body with no hit list and no backend error as no match', async () => {
      const { fetchMock } = stubEfts([0, {}]);

      const resolution = getEdgarApiService().resolveEntityByName('obscure capital', scope());
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(resolution).resolves.toEqual({ matches: [], total: undefined });
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });
});

// --- Caller text is escaped before it reaches full-text search (#205) ---

const ENTITY_HITS = {
  hits: { hits: [{ _id: '36104', _source: { entity: 'US BANCORP \\DE\\' } }] },
};

/**
 * Stand in for EDGAR full-text search that answers `HITS_PAGE` (a search) or `ENTITY_HITS`
 * (an entity lookup) only when every backslash and control character in `q` and
 * `keysTyped` arrives escaped (`\\`, `\uXXXX`), and fails the request otherwise, so a case
 * passes only when the service escaped the term. Each request URL is recorded.
 */
function stubEftsTerms() {
  const urls: URL[] = [];
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.hostname !== 'efts.sec.gov') throw new Error(`unexpected fetch: ${input}`);
    urls.push(url);
    const terms = ['q', 'keysTyped'].flatMap((key) => url.searchParams.get(key) ?? []);
    const unescaped = terms.some((term) =>
      /[\\\p{Cc}]/u.test(term.replace(/\\(?:\\|u[0-9a-f]{4})/g, '')),
    );
    if (unescaped) return new Response('Bad Request', { status: 400 });
    return jsonResponse(url.searchParams.has('keysTyped') ? ENTITY_HITS : HITS_PAGE);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, urls };
}

describe('EdgarApiService — caller text is escaped before it reaches full-text search (#205)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    initEdgarApiService();
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['a phrase with backslash-wrapped letters', '"US BANCORP \\DE\\"', '"US BANCORP \\\\DE\\\\"'],
    ['a trailing backslash', 'US BANCORP \\', 'US BANCORP \\\\'],
    ['an inner tab', 'US BANCORP\tDE', 'US BANCORP\\u0009DE'],
    ['an inner newline', 'US BANCORP\nDE', 'US BANCORP\\u000aDE'],
    ['a NUL and a DEL', 'a\u0000b\u007fc', 'a\\u0000b\\u007fc'],
    ['C1 control characters', 'a\u0085b\u009fc', 'a\\u0085b\\u009fc'],
    ['typed escape text', 'a\\u0009b', 'a\\\\u0009b'],
  ])(
    'sends %s in q with each backslash doubled and each control character as \\uXXXX',
    async (_case, query, sent) => {
      const { fetchMock, urls } = stubEftsTerms();

      const response = await getEdgarApiService().searchFilings(
        { query, forms: ['13F-HR'] },
        scope(),
      );

      expect(urls[0]?.searchParams.get('q')).toBe(sent);
      expect(response.hits.total.value).toBe(1);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('leaves text with no backslash or control character unchanged, quotes included', async () => {
    const { urls } = stubEftsTerms();

    await getEdgarApiService().searchFilings(
      {
        query: '"material weakness" -preliminary (revenue OR income) account* /ADR',
        forms: ['10-K'],
      },
      scope(),
    );

    expect(urls[0]?.searchParams.get('q')).toBe(
      '"material weakness" -preliminary (revenue OR income) account* /ADR',
    );
  });

  it('escapes keysTyped the same way', async () => {
    const { fetchMock, urls } = stubEftsTerms();

    const { matches } = await getEdgarApiService().resolveEntityByName(
      'US BANCORP \\DE\\\t',
      scope(),
    );

    expect(urls[0]?.searchParams.get('keysTyped')).toBe('US BANCORP \\\\DE\\\\\\u0009');
    expect(matches).toEqual([{ cik: '0000036104', name: 'US BANCORP \\DE\\' }]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// --- The entity index's ticker list, and 10-K subsidiaries exhibits (#236) ---

/**
 * SEC's entity-index answer for `Charles Schwab`, captured live 2026-11-13 (first three
 * hits): a listed entity carries its tickers after its name and again in `tickers`.
 */
const SCHWAB_ENTITY_HITS = {
  hits: {
    total: { value: 16, relation: 'eq' },
    hits: [
      { _id: '923738', _source: { entity: 'Schwab Charles R.', rank: 1817323 } },
      {
        _id: '316709',
        _source: {
          entity: 'SCHWAB CHARLES CORP (SCHW, SCHW-PJ, SCHW-PD)',
          tickers: 'SCHW, SCHW-PJ, SCHW-PD',
          rank: 82073066,
        },
      },
      { _id: '1549728', _source: { entity: 'Schwabe Charles E.', rank: 10330 } },
    ],
  },
};

describe('EdgarApiService.resolveEntityByName — SEC’s ticker list split from the name (#236)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initEdgarApiService();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('names a listed entity without its ticker list and carries the first ticker', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(SCHWAB_ENTITY_HITS)),
    );

    const { matches } = await getEdgarApiService().resolveEntityByName('Charles Schwab', scope());

    expect(matches).toEqual([
      { cik: '0000923738', name: 'Schwab Charles R.' },
      { cik: '0000316709', name: 'SCHWAB CHARLES CORP', ticker: 'SCHW' },
      { cik: '0001549728', name: 'Schwabe Charles E.' },
    ]);
    expect(matches[0]).not.toHaveProperty('ticker');
  });

  it('leaves a parenthetical SEC lists no tickers for in the name, as no ticker', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          hits: { hits: [{ _id: '1234567', _source: { entity: 'DEERFIELD HOLDINGS INC (DE)' } }] },
        }),
      ),
    );

    const { matches } = await getEdgarApiService().resolveEntityByName('Deerfield', scope());

    expect(matches).toEqual([{ cik: '0001234567', name: 'DEERFIELD HOLDINGS INC (DE)' }]);
    expect(matches[0]).not.toHaveProperty('ticker');
  });
});

/** The full-text page for a quoted name over 10-Ks, trimmed from a live capture (2026-11-13). */
const fullTextFixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../fixtures/company-search/fts10k-${name}.json`, import.meta.url),
      'utf8',
    ),
  );

/** SEC's ticker file as the subsidiary-exhibit cases need it: Roper, Duke, and Apollo listed. */
const PARENT_TICKER_FILE = {
  0: { cik_str: 882835, ticker: 'ROP', title: 'ROPER TECHNOLOGIES INC' },
  1: { cik_str: 1326160, ticker: 'DUK', title: 'Duke Energy CORP' },
  2: { cik_str: 1278752, ticker: 'MFIC', title: 'MidCap Financial Investment Corp' },
};

/**
 * Stand in for SEC: the two ticker files, and every full-text search answered with `page`.
 * Records each full-text request URL; any other request rejects and is recorded.
 */
function stubParentSearch(page: unknown) {
  const searches: URL[] = [];
  const unrouted: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/files/company_tickers.json') return jsonResponse(PARENT_TICKER_FILE);
      if (url.pathname === '/files/company_tickers_mf.json') {
        return jsonResponse({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [] });
      }
      if (url.hostname === 'efts.sec.gov' && url.searchParams.has('q')) {
        searches.push(url);
        return jsonResponse(page);
      }
      unrouted.push(input);
      throw new Error(`unrouted fetch: ${input}`);
    }),
  );
  return { searches, unrouted };
}

/** One full-text hit: a document of a 10-K filed by `filers` (`[cik, display name]`). */
const tenKHit = (
  adsh: string,
  fileType: string,
  fileDate: string,
  filers: Array<readonly [string, string | undefined]>,
) => ({
  _id: `${adsh}:doc.htm`,
  _source: {
    adsh,
    ciks: filers.map(([cik]) => cik),
    display_names: filers.flatMap(([cik, name]) => (name ? [`${name}  (CIK ${cik})`] : [])),
    file_date: fileDate,
    file_type: fileType,
    form: '10-K',
    root_forms: ['10-K'],
  },
});

describe('EdgarApiService.findSubsidiaryParents — 10-K subsidiaries exhibits naming a company (#236)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    initEdgarApiService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Run `call` with the pacer's spacing elapsed. */
  async function settled<T>(call: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(1_000);
    return call;
  }

  it('sends one quoted-phrase search over 10-Ks, its first 100 documents', async () => {
    const sec = stubParentSearch(fullTextFixture('vertafore'));

    await settled(getEdgarApiService().findSubsidiaryParents('Vertafore', scope()));

    expect(sec.searches).toHaveLength(1);
    const params = sec.searches[0]?.searchParams;
    expect(params?.get('q')).toBe('"Vertafore"');
    expect(params?.get('forms')).toBe('10-K');
    expect(params?.get('size')).toBe('100');
    expect(params?.get('from')).toBe('0');
    expect(sec.unrouted).toEqual([]);
  });

  it.each([
    ['Vertafore', 'vertafore'],
    ['Clinisys', 'clinisys'],
    ['Strata Decision Technology', 'strata-decision-technology'],
  ])(
    'names only the filer of the EX-21 hits for %s, at its newest exhibit, never a filer of other documents',
    async (name, fixture) => {
      const sec = stubParentSearch(fullTextFixture(fixture));

      const parents = await settled(getEdgarApiService().findSubsidiaryParents(name, scope()));

      // The pages also hold Apollo Investment's, Health Catalyst's, Allscripts', and others'
      // 10-K documents mentioning the name; only Roper's subsidiaries exhibits count.
      expect(parents).toEqual([
        {
          cik: '0000882835',
          name: 'ROPER TECHNOLOGIES INC',
          ticker: 'ROP',
          filingDate: '2026-02-24',
          accessionNumber: '0000882835-26-000009',
        },
      ]);
      expect(sec.unrouted).toEqual([]);
    },
  );

  it('lists co-registrants the ticker file lists first, then by newest exhibit, then in search order', async () => {
    stubParentSearch({
      hits: {
        total: { value: 4, relation: 'eq' },
        hits: [
          tenKHit('0001326160-16-000221', 'EX-21', '2016-02-25', [
            ['0000017797', 'DUKE ENERGY PROGRESS, LLC.'],
            ['0001094093', 'PROGRESS ENERGY INC'],
            ['0001326160', 'Duke Energy CORP  (DUK, DUKB, DUKH, DUK-PA)'],
          ]),
          tenKHit('0001326160-23-000073', 'EX-21.1', '2023-02-27', [
            ['0001326160', 'Duke Energy CORP  (DUK, DUKB, DUKH, DUK-PA)'],
            ['0000030371', 'Duke Energy Carolinas, LLC'],
            ['0000017797', 'DUKE ENERGY PROGRESS, LLC.'],
            ['0000081020', undefined],
          ]),
          // Newer, but not a subsidiaries exhibit: it moves no filer's exhibit date.
          tenKHit('0001326160-24-000011', 'EX-10.61', '2024-02-27', [
            ['0001094093', 'PROGRESS ENERGY INC'],
          ]),
          // An exhibit number that merely starts with 21 is not exhibit 21.
          tenKHit('0009999999-24-000001', 'EX-210', '2024-03-01', [
            ['0009999999', 'NOT A PARENT INC'],
          ]),
        ],
      },
    });

    const parents = await settled(
      getEdgarApiService().findSubsidiaryParents('Duke Energy Renewables', scope()),
    );

    expect(parents).toEqual([
      {
        cik: '0001326160',
        name: 'Duke Energy CORP',
        ticker: 'DUK',
        filingDate: '2023-02-27',
        accessionNumber: '0001326160-23-000073',
      },
      {
        cik: '0000017797',
        name: 'DUKE ENERGY PROGRESS, LLC.',
        filingDate: '2023-02-27',
        accessionNumber: '0001326160-23-000073',
      },
      {
        cik: '0000030371',
        name: 'Duke Energy Carolinas, LLC',
        filingDate: '2023-02-27',
        accessionNumber: '0001326160-23-000073',
      },
      { cik: '0000081020', filingDate: '2023-02-27', accessionNumber: '0001326160-23-000073' },
      {
        cik: '0001094093',
        name: 'PROGRESS ENERGY INC',
        filingDate: '2016-02-25',
        accessionNumber: '0001326160-16-000221',
      },
    ]);
    // Absent fields are left out, never set to undefined.
    expect(parents[1]).not.toHaveProperty('ticker');
    expect(parents[3]).not.toHaveProperty('name');
  });

  it('drops a double quote from the name, which would end the phrase early', async () => {
    const sec = stubParentSearch({ hits: { total: { value: 0, relation: 'eq' }, hits: [] } });

    const parents = await settled(
      getEdgarApiService().findSubsidiaryParents('"Acme "Widget" Works"', scope()),
    );

    expect(parents).toEqual([]);
    expect(sec.searches[0]?.searchParams.get('q')).toBe('"Acme Widget Works"');
  });
});
