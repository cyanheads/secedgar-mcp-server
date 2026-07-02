/**
 * @fileoverview EFTS response shape-guard tests for `EdgarApiService.searchFilings`
 * (#61). EFTS can return a 2xx whose body omits `hits.total` — a degraded payload,
 * or a rejected request echoed as `{ error: ... }` with 200. The service must throw
 * a structured retryable ServiceUnavailable instead of letting a raw property-access
 * TypeError leak, while a genuine zero-hit response (hits.total.value: 0, empty
 * hits.hits) passes through as valid. `findFilingCiks` routes through the same
 * guard, so both call sites are covered.
 * @module tests/services/edgar/edgar-api-service.efts
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { config } = vi.hoisted(() => ({
  config: {
    userAgent: 'test test@example.com',
    rateLimitRps: 10,
    tickerCacheTtl: 3600,
    mirrorFallbackLive: true,
  },
}));

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));
vi.mock('@/services/edgar/mirror/index.js', () => ({ getEdgarMirror: () => undefined }));

import { getEdgarApiService, initEdgarApiService } from '@/services/edgar/edgar-api-service.js';

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('EdgarApiService.searchFilings — EFTS shape guard (#61)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      .searchFilings({ query: 'revenue' })
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
      .searchFilings({ query: 'revenue' })
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

    const response = await getEdgarApiService().searchFilings({ query: 'zzqqxyzzy' });

    expect(response.hits.total.value).toBe(0);
    expect(response.hits.hits).toEqual([]);
  });

  it('guards the findFilingCiks call site too — structured error, not a TypeError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({})),
    );

    const err = await getEdgarApiService()
      .findFilingCiks('0000320193-23-000106')
      .catch((e) => e);

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data.reason).toBe('efts_degraded_response');
  });
});
