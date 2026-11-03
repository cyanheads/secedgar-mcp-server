/**
 * @fileoverview The `rate_limited` failure as a caller sees it (#116). Every tool
 * that reaches SEC declares the reason on its contract, and a call made during
 * SEC's rate-limit block arrives on both client surfaces — `structuredContent`
 * and `content[]` — with the same reason whether SEC answered the 429 or the
 * server refused the call without sending it. The same tools declare
 * `sec_unreachable`, the failure once the last attempt gets no complete, readable
 * response (#173, #181), or a submissions body lacks its shape (#186). Every tool that
 * fails on EDGAR full-text search declares `efts_degraded_response`, the failure once its
 * search backend fails every attempt or refuses the request (#206). Driven through
 * `runToolContract` over the real `EdgarApiService` with `globalThis.fetch` stubbed.
 * @module tests/mcp-server/tools/rate-limit-contract
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

import { companySearchTool } from '@/mcp-server/tools/definitions/company-search.tool.js';
import { getFinancialsTool } from '@/mcp-server/tools/definitions/get-financials.tool.js';
import { getInstitutionalHoldingsTool } from '@/mcp-server/tools/definitions/get-institutional-holdings.tool.js';
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { searchFilingsTool } from '@/mcp-server/tools/definitions/search-filings.tool.js';
import { initEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { blockText } from '../../support/assertions.js';
import { readCommonMark } from '../../support/commonmark.js';

/** Tools that never reach SEC: the static concept catalog and the canvas tools. */
const OFFLINE_TOOLS = new Set([
  'secedgar_search_concepts',
  'secedgar_dataframe_describe',
  'secedgar_dataframe_query',
  'secedgar_dataframe_drop',
]);

type ErrorEnvelope = { code: number; data?: Record<string, unknown> };

function envelope(result: { structuredContent?: unknown }): ErrorEnvelope {
  return (result.structuredContent as { error: ErrorEnvelope }).error;
}

describe('rate_limited on the tool contracts (#116)', () => {
  it('is declared by every tool that reaches SEC, and by no other', () => {
    for (const def of buildToolDefinitions({ dropEnabled: true, clampOversizedLimits: true })) {
      const entry = def.errors?.find((e) => e.reason === 'rate_limited');
      if (OFFLINE_TOOLS.has(def.name)) {
        expect(entry, def.name).toBeUndefined();
        continue;
      }
      expect(entry, def.name).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        retryable: true,
        thrownBy: 'service',
      });
    }
  });
});

describe('sec_unreachable on the tool contracts (#173)', () => {
  it('is declared by exactly the tools that declare rate_limited', () => {
    const defs = buildToolDefinitions({ dropEnabled: true, clampOversizedLimits: true });
    const declaring = (reason: string) =>
      defs.filter((def) => def.errors?.some((e) => e.reason === reason)).map((def) => def.name);

    expect(declaring('rate_limited').length).toBeGreaterThan(0);
    expect(declaring('sec_unreachable')).toEqual(declaring('rate_limited'));
    for (const def of defs) {
      const entry = def.errors?.find((e) => e.reason === 'sec_unreachable');
      if (!entry) continue;
      expect(entry, def.name).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        retryable: true,
        thrownBy: 'service',
      });
    }
  });

  /**
   * A 503, a 502, then a reset ends here too, so the text claims only the last attempt;
   * the call's failure budget can end the ladder before the third, or keep a request
   * from being sent at all (#179).
   */
  it('says the same of every ladder that ends this way, in one string on every tool', () => {
    const whens = buildToolDefinitions({ dropEnabled: true, clampOversizedLimits: true }).flatMap(
      (def) => def.errors?.filter((e) => e.reason === 'sec_unreachable').map((e) => e.when) ?? [],
    );
    expect(whens).toHaveLength(13);
    expect(new Set(whens)).toEqual(
      new Set([
        "SEC EDGAR gave no complete, readable response — on the last attempt made (the third, or an earlier one once this call's 40-second budget for SEC failures ran out) the connection failed, no response headers arrived within 15 seconds, or the body broke off or stalled for 15 seconds, each wait capped at what was left of that budget; a 200 body was not the JSON SEC serves; or earlier SEC failures had spent that budget, so the request was never sent",
      ]),
    );
  });
});

describe('efts_degraded_response on the tool contracts (#206)', () => {
  it('is declared by exactly the tools that surface an EDGAR full-text search failure, in one string on every tool', () => {
    const entries = buildToolDefinitions({ dropEnabled: true, clampOversizedLimits: true }).flatMap(
      (def) =>
        def.errors
          ?.filter((e) => e.reason === 'efts_degraded_response')
          .map((e) => ({ ...e, tool: def.name })) ?? [],
    );

    // search_filings and find_holders search; get_institutional_holdings resolves a name
    // outside the ticker file through EDGAR's entity search on the same endpoint.
    // get_filing's filer lookup searches too, but a failed lookup falls back to the
    // accession-prefix CIK rather than failing the call (#215).
    expect(entries.map((e) => e.tool).sort()).toEqual([
      'secedgar_find_holders',
      'secedgar_get_institutional_holdings',
      'secedgar_search_filings',
    ]);
    for (const entry of entries) {
      expect(entry, entry.tool).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        retryable: true,
        thrownBy: 'service',
      });
    }
    expect(new Set(entries.map((e) => e.when)).size).toBe(1);
    expect(new Set(entries.map((e) => e.recovery)).size).toBe(1);
  });
});

describe('a call whose full-text search backend fails (#206)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    initEdgarApiService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const LAMBDA_REQUEST_ID = '3f0c9d52-7d1e-4b0e-9a3c-2b5f8e4a1c77';
  const backendErrorBody = (errorType: string, errorMessage: string) => ({
    errorType,
    errorMessage,
    trace: [
      `${errorType}: ${errorMessage}`,
      '    at onBody (/opt/nodejs/node_modules/@opensearch-project/opensearch/lib/Transport.js:425:23)',
    ],
    requestId: LAMBDA_REQUEST_ID,
  });
  const CONNECTION_MESSAGE =
    'getaddrinfo EBUSY vpc-efts-prod-opensearchservice.us-east-1.es.amazonaws.com';
  const TRANSIENT_MESSAGE =
    'EDGAR full-text search (efts.sec.gov) answered the last of 3 attempts with a failure of its search backend instead of results.';
  const TRANSIENT_HINT =
    "EDGAR full-text search (efts.sec.gov) answered, but its search backend could not run the search — a temporary failure on SEC's side, not a problem with the request. Retry the same call in a minute.";

  /** Serve the empty-enough ticker files a cold name lookup reads, and `efts` for every full-text search request. */
  function stubSec(efts: () => Response) {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string) => {
      requests.push(input);
      const url = new URL(input);
      if (url.hostname === 'efts.sec.gov') return efts();
      if (url.hostname === 'www.sec.gov' && url.pathname === '/files/company_tickers.json') {
        return Response.json({ 0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } });
      }
      if (url.hostname === 'www.sec.gov' && url.pathname === '/files/company_tickers_mf.json') {
        return Response.json({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [] });
      }
      throw new Error(`unrouted fetch: ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return { requests };
  }

  const eftsRequests = (requests: string[]) =>
    requests.filter((input) => new URL(input).hostname === 'efts.sec.gov');

  it('fails search_filings on both surfaces after three attempts, retryable, with the backend error typed and its trace and request id left out', async () => {
    const { requests } = stubSec(() =>
      Response.json(backendErrorBody('ConnectionError', CONNECTION_MESSAGE)),
    );

    const pending = runToolContract(searchFilingsTool, { query: 'revenue' });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(eftsRequests(requests)).toHaveLength(3);
    expect(result.isError).toBe(true);
    expect(envelope(result)).toEqual({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: TRANSIENT_MESSAGE,
      data: {
        reason: 'efts_degraded_response',
        retryable: true,
        upstreamErrorType: 'ConnectionError',
        upstreamErrorMessage: CONNECTION_MESSAGE,
        recovery: { hint: TRANSIENT_HINT },
      },
    });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: `Error: ${TRANSIENT_MESSAGE}\n\nRecovery: ${TRANSIENT_HINT}\n\n(reason efts_degraded_response · retryable)`,
      },
    ]);
    const wire = JSON.stringify(result);
    expect(wire).not.toContain('/opt/nodejs');
    expect(wire).not.toContain(LAMBDA_REQUEST_ID);
  });

  it('fails search_filings on a refused search in one request, not retryable and never called an outage', async () => {
    const refusal =
      'search_phase_execution_exception: [illegal_argument_exception] Reason: Result window is too large, from + size must be less than or equal to: [10000] but was [10001]. See the scroll api for a more efficient way to request large data sets. This limit can be set by changing the [index.max_result_window] index level setting.';
    const { requests } = stubSec(() => Response.json(backendErrorBody('ResponseError', refusal)));

    const pending = runToolContract(searchFilingsTool, { query: 'revenue' });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(eftsRequests(requests)).toHaveLength(1);
    const message =
      'EDGAR full-text search (efts.sec.gov) answered with an error from its search backend instead of results.';
    const hint =
      'EDGAR full-text search (efts.sec.gov) refused to run this search, and resending it unchanged fails the same way — upstreamErrorMessage gives the reason to change.';
    expect(envelope(result)).toEqual({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message,
      data: {
        reason: 'efts_degraded_response',
        retryable: false,
        upstreamErrorType: 'ResponseError',
        upstreamErrorMessage: refusal,
        recovery: { hint },
      },
    });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: `Error: ${message}\n\nRecovery: ${hint}\n\n(reason efts_degraded_response · not retryable)`,
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/in a few minutes|temporary|degraded\./);
  });

  it('fails get_institutional_holdings’ entity-search fallback as efts_degraded_response, not company_not_found', async () => {
    const { requests } = stubSec(() =>
      Response.json(backendErrorBody('ConnectionError', CONNECTION_MESSAGE)),
    );

    const pending = runToolContract(getInstitutionalHoldingsTool, {
      company: 'Qzxv Capital Advisors',
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(eftsRequests(requests)).toHaveLength(3);
    expect(envelope(result)).toEqual({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: TRANSIENT_MESSAGE,
      data: {
        reason: 'efts_degraded_response',
        retryable: true,
        upstreamErrorType: 'ConnectionError',
        upstreamErrorMessage: CONNECTION_MESSAGE,
        recovery: { hint: TRANSIENT_HINT },
      },
    });
    expect(blockText(result.content).trimEnd()).toMatch(
      /\(reason efts_degraded_response · retryable\)$/,
    );
  });
});

describe('a call whose SEC response body fails to read (#181)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    initEdgarApiService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fails as sec_unreachable on both surfaces after three attempts, with none of the runtime’s text', async () => {
    // Bun 1.4.4's own rejection for invalid chunk framing after valid headers: the
    // request URL in the message and on `path`.
    const fetchMock = vi.fn(
      async (url: string) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"0":{"ci'));
            },
            pull(controller) {
              controller.error(
                Object.assign(
                  new TypeError(
                    `InvalidHTTPResponse fetching "${url}". For more information, pass \`verbose: true\` in the second argument to fetch()`,
                  ),
                  { code: 'InvalidHTTPResponse', errno: 0, path: url },
                ),
              );
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = runToolContract(companySearchTool, { query: 'AAPL' });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.isError).toBe(true);
    const message =
      'The response body from SEC EDGAR (www.sec.gov) failed to read on the last of 3 attempts, which ended with InvalidHTTPResponse.';
    const hint =
      'SEC EDGAR (www.sec.gov) answered the last attempt, but its response body broke off or stalled before it finished — a network failure between this server and SEC, not a problem with the request. Retry the same call in a minute.';
    expect(envelope(result)).toEqual({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message,
      data: {
        reason: 'sec_unreachable',
        retryable: true,
        url: 'https://www.sec.gov/files/company_tickers.json',
        recovery: { hint },
      },
    });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: `Error: ${message}\n\nRecovery: ${hint}\n\n(reason sec_unreachable · retryable)`,
      },
    ]);
    const wire = JSON.stringify(result);
    expect(wire).not.toContain('verbose');
    expect(wire).not.toContain('fetching');
  });

  it('fails as sec_unreachable on both surfaces in one request when a 200 body is not JSON', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('<html><body>Temporarily unavailable</body></html>', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = runToolContract(companySearchTool, { query: 'AAPL' });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledOnce();
    const message =
      'SEC EDGAR (www.sec.gov) answered, but its response body is not the JSON this request expects.';
    const hint =
      'SEC EDGAR (www.sec.gov) answered with something other than the JSON it serves for this request, such as a temporary error page — not a problem with the request. Retry the same call in a minute.';
    expect(envelope(result)).toEqual({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message,
      data: {
        reason: 'sec_unreachable',
        retryable: true,
        url: 'https://www.sec.gov/files/company_tickers.json',
        recovery: { hint },
      },
    });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: `Error: ${message}\n\nRecovery: ${hint}\n\n(reason sec_unreachable · retryable)`,
      },
    ]);
    const wire = JSON.stringify(result);
    expect(wire).not.toContain('<html');
    expect(wire).not.toContain('Unexpected token');
    expect(wire).not.toContain('JSON Parse error');
  });
});

describe('a call whose submissions body lacks the shape its readers index (#186)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    initEdgarApiService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fails as sec_unreachable on both surfaces in one submissions request, with no runtime text', async () => {
    const tickers = { 0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } };
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string) => {
      requests.push(input);
      const { pathname } = new URL(input);
      if (pathname === '/files/company_tickers.json') return Response.json(tickers);
      if (pathname === '/files/company_tickers_mf.json') {
        return Response.json({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [] });
      }
      // A JSON object, but the ticker file's, not a submissions body.
      if (pathname === '/submissions/CIK0000320193.json') return Response.json(tickers);
      throw new Error(`unrouted fetch: ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = runToolContract(companySearchTool, { query: 'AAPL' });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(requests.filter((url) => url.includes('/submissions/'))).toHaveLength(1);
    expect(result.isError).toBe(true);
    const message =
      'SEC EDGAR (data.sec.gov) answered, but its response body is not the JSON this request expects.';
    const hint =
      'SEC EDGAR (data.sec.gov) answered with something other than the JSON it serves for this request, such as a temporary error page — not a problem with the request. Retry the same call in a minute.';
    expect(envelope(result)).toEqual({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message,
      data: {
        reason: 'sec_unreachable',
        retryable: true,
        url: 'https://data.sec.gov/submissions/CIK0000320193.json',
        recovery: { hint },
      },
    });
    expect(readCommonMark(blockText(result.content))).toBe(
      `Error: ${message}\n\nRecovery: ${hint}\n\n(reason sec_unreachable · retryable)`,
    );
    const wire = JSON.stringify(result);
    expect(wire).not.toContain('undefined is not an object');
    expect(wire).not.toContain('Cannot read properties');
  });
});

describe('a call SEC never answers (#173)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    initEdgarApiService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fails as sec_unreachable on both surfaces after three attempts, with none of the runtime’s text', async () => {
    // Bun 1.4.3's own rejection for a reset connection, the request URL on `path`.
    const fetchMock = vi.fn(async (url: string) => {
      throw Object.assign(
        new TypeError(
          'ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
        ),
        { code: 'ECONNRESET', errno: 0, path: url },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = runToolContract(companySearchTool, { query: 'AAPL' });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.isError).toBe(true);
    const message =
      'No HTTP response from SEC EDGAR (www.sec.gov) on the last of 3 attempts, which ended with ECONNRESET.';
    const hint =
      'SEC EDGAR (www.sec.gov) sent no HTTP response to the last attempt — a network failure between this server and SEC, not a problem with the request. Retry the same call in a minute.';
    expect(envelope(result)).toEqual({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message,
      data: {
        reason: 'sec_unreachable',
        retryable: true,
        url: 'https://www.sec.gov/files/company_tickers.json',
        recovery: { hint },
      },
    });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: `Error: ${message}\n\nRecovery: ${hint}\n\n(reason sec_unreachable · retryable)`,
      },
    ]);
    const wire = JSON.stringify(result);
    expect(wire).not.toContain('verbose');
    expect(wire).not.toContain('socket connection');
  });
});

describe('a call SEC keeps failing past its failure budget (#179)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    initEdgarApiService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fails as sec_unreachable on both surfaces inside 45 s when every request answers only its third attempt', async () => {
    /** SEC's answer for each route a cold company search reads; `undefined` for any other URL. */
    const route = (url: URL): Response | undefined => {
      if (url.hostname === 'www.sec.gov' && url.pathname === '/files/company_tickers.json') {
        return Response.json({ 0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } });
      }
      if (url.hostname === 'www.sec.gov' && url.pathname === '/files/company_tickers_mf.json') {
        return Response.json({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [] });
      }
      if (url.hostname === 'data.sec.gov' && url.pathname === '/submissions/CIK0000320193.json') {
        return Response.json({ cik: '0000320193', name: 'Apple Inc.', tickers: ['AAPL'] });
      }
      return;
    };
    const attempts = new Map<string, number>();
    const unrouted: string[] = [];
    const fetchMock = vi.fn((input: string, init: RequestInit) => {
      const response = route(new URL(input));
      if (!response) {
        unrouted.push(input);
        return Promise.reject(new Error(`unrouted fetch: ${input}`));
      }
      const attempt = (attempts.get(input) ?? 0) + 1;
      attempts.set(input, attempt);
      if (attempt >= 3) return Promise.resolve(response);
      // No response headers: the attempt ends only when its own timeout aborts it.
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    let settled = false;
    const pending = runToolContract(companySearchTool, { query: 'AAPL' }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(settled).toBe(true);
    const result = await pending;

    expect(unrouted).toEqual([]);
    expect(result.isError).toBe(true);
    const message =
      "No request sent to SEC EDGAR (data.sec.gov): retries stopped at this call's 40 s budget for SEC failures, which its earlier requests spent.";
    const hint =
      "SEC EDGAR (data.sec.gov) failed this call's earlier requests until its budget for SEC failures ran out — a network failure between this server and SEC, not a problem with the request. Retry the same call in a minute.";
    expect(envelope(result)).toEqual({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message,
      data: {
        reason: 'sec_unreachable',
        retryable: true,
        url: 'https://data.sec.gov/submissions/CIK0000320193.json',
        recovery: { hint },
      },
    });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: `Error: ${message}\n\nRecovery: ${hint}\n\n(reason sec_unreachable · retryable)`,
      },
    ]);
    // The ticker index spends 15 + 1 + 15 + 2 s before its third attempt answers, the
    // fund slice the last 7 s, and this call — charged for both while it waited — has
    // nothing left for the submissions request.
    expect(Object.fromEntries(attempts)).toEqual({
      'https://www.sec.gov/files/company_tickers.json': 3,
      'https://www.sec.gov/files/company_tickers_mf.json': 1,
    });
  });
});

describe('a call during SEC’s rate-limit block (#116)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    initEdgarApiService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('carries one reason on both surfaces, whether SEC answered or the call was never sent', async () => {
    const fetchMock = vi.fn(async () => new Response('blocked', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    const upstream = await runToolContract(companySearchTool, { query: 'AAPL' });
    await vi.advanceTimersByTimeAsync(90_000);
    const refused = await runToolContract(getFinancialsTool, {
      company: 'AAPL',
      concept: 'revenue',
    });

    // Only the first call reached SEC.
    expect(fetchMock).toHaveBeenCalledOnce();

    expect(upstream.isError).toBe(true);
    expect(envelope(upstream)).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryable: true, retryAfter: 600, status: 429 },
    });
    const upstreamText = blockText(upstream.content);
    expect(upstreamText).toContain('HTTP 429');
    expect(upstreamText).toContain('Recovery: SEC is rate-limiting');
    expect(upstreamText).toContain('retry in 600 seconds');
    // The thrown error carries the `retryable` its contract entry declares (#122).
    expect(upstreamText.trimEnd()).toMatch(/\(reason rate_limited · retryable\)$/);

    expect(refused.isError).toBe(true);
    expect(envelope(refused)).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryable: true, retryAfter: 510 },
    });
    expect(envelope(refused).data?.status).toBeUndefined();
    const refusedText = blockText(refused.content);
    expect(refusedText).toContain('request not sent');
    expect(refusedText).toContain('retry in 510 seconds');
    expect(refusedText.trimEnd()).toMatch(/\(reason rate_limited · retryable\)$/);
  });
});
