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

describe('EdgarApiService.resolveEntityByName — EFTS entity-autocomplete (#73)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    const matches = await getEdgarApiService().resolveEntityByName('berkshire hathaway');

    // Bare _id is zero-padded to the 10-digit CIK the submissions API expects.
    expect(matches).toEqual([{ cik: '0001067983', name: 'BERKSHIRE HATHAWAY INC' }]);
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

    const matches = await getEdgarApiService().resolveEntityByName('vanguard group');

    expect(matches).toEqual([
      { cik: '0000735286', name: 'VANGUARD GROUP INC' },
      { cik: '0000102909', name: 'VANGUARD GROUP INC' },
    ]);
  });

  it('sends the typed name via the keysTyped query param', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ hits: { hits: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    await getEdgarApiService().resolveEntityByName('vanguard group');

    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('efts.sec.gov/LATEST/search-index');
    expect(calledUrl).toContain('keysTyped=vanguard+group');
  });

  it('returns an empty array when EFTS reports no hits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ hits: { total: { value: 0, relation: 'eq' }, hits: [] } })),
    );

    const matches = await getEdgarApiService().resolveEntityByName('zzqqxyzzy nonexistent');

    expect(matches).toEqual([]);
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

    const matches = await getEdgarApiService().resolveEntityByName('vanguard');

    expect(matches).toEqual([{ cik: '0000102909', name: 'VANGUARD GROUP INC' }]);
  });
});
