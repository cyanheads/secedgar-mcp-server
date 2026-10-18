/**
 * @fileoverview The `rate_limited` failure as a caller sees it (#116). Every tool
 * that reaches SEC declares the reason on its contract, and a call made during
 * SEC's rate-limit block arrives on both client surfaces — `structuredContent`
 * and `content[]` — with the same reason whether SEC answered the 429 or the
 * server refused the call without sending it. The same tools declare
 * `sec_unreachable`, the failure once the last of three attempts gets no HTTP
 * response (#173). Driven through `runToolContract` over the real `EdgarApiService` with
 * `globalThis.fetch` stubbed.
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
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { initEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { blockText } from '../../support/assertions.js';

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
    for (const def of buildToolDefinitions({ dropEnabled: true })) {
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
    const defs = buildToolDefinitions({ dropEnabled: true });
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

  // A 503, a 502, then a reset ends here too, so the text claims only the last attempt.
  it('says the same of every ladder that ends this way, in one string on every tool', () => {
    const whens = buildToolDefinitions({ dropEnabled: true }).flatMap(
      (def) => def.errors?.filter((e) => e.reason === 'sec_unreachable').map((e) => e.when) ?? [],
    );
    expect(whens).toHaveLength(13);
    expect(new Set(whens)).toEqual(
      new Set([
        'The last of three attempts to reach SEC EDGAR got no HTTP response — the connection failed, or no response headers arrived within 15 seconds',
      ]),
    );
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
