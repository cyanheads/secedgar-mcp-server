/**
 * @fileoverview The `rate_limited` failure as a caller sees it (#116). Every tool
 * that reaches SEC declares the reason on its contract, and a call made during
 * SEC's rate-limit block arrives on both client surfaces — `structuredContent`
 * and `content[]` — with the same reason whether SEC answered the 429 or the
 * server refused the call without sending it. Driven through `runToolContract`
 * over the real `EdgarApiService` with `globalThis.fetch` stubbed.
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
