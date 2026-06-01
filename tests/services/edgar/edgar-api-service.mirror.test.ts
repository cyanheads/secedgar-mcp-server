/**
 * @fileoverview Routing tests for EdgarApiService ↔ the local mirror. With the
 * config and mirror modules mocked, these assert the four branches the service
 * implements: mirror hit (no live call), mirror miss with live fallback, strict
 * mirror-only miss (null, no live call), and not-ready under strict (throws) —
 * plus the no-mirror path falling straight through to the live API.
 * @module tests/services/edgar/edgar-api-service.mirror
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { config, mirrorRef } = vi.hoisted(() => ({
  config: {
    userAgent: 'test test@example.com',
    rateLimitRps: 10,
    tickerCacheTtl: 3600,
    mirrorFallbackLive: true,
  },
  mirrorRef: { current: undefined as Record<string, ReturnType<typeof vi.fn>> | undefined },
}));

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));
vi.mock('@/services/edgar/mirror/index.js', () => ({ getEdgarMirror: () => mirrorRef.current }));

import { getEdgarApiService, initEdgarApiService } from '@/services/edgar/edgar-api-service.js';

function makeMirrorStub() {
  return {
    companyFactsReady: vi.fn(),
    companyFactsComplete: vi.fn(),
    tickersReady: vi.fn(),
    getCompanyConcept: vi.fn(),
    getFrames: vi.fn(),
    getTickerRows: vi.fn(),
  };
}

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('EdgarApiService — mirror routing', () => {
  beforeEach(() => {
    config.mirrorFallbackLive = true;
    mirrorRef.current = undefined;
    vi.clearAllMocks();
    initEdgarApiService();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('serves a concept from the mirror when ready, without a live call', async () => {
    const mirror = makeMirrorStub();
    mirror.companyFactsReady.mockResolvedValue(true);
    mirror.getCompanyConcept.mockResolvedValue({
      cik: 320193,
      entityName: 'Apple Inc.',
      taxonomy: 'us-gaap',
      tag: 'Revenues',
      label: 'Revenues',
      units: {},
    });
    mirrorRef.current = mirror;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await getEdgarApiService().tryGetCompanyConcept('320193', 'us-gaap', 'Revenues');

    expect(result?.entityName).toBe('Apple Inc.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the live API on a mirror miss when fallbackLive is on', async () => {
    const mirror = makeMirrorStub();
    mirror.companyFactsReady.mockResolvedValue(true);
    mirror.getCompanyConcept.mockResolvedValue(null);
    mirrorRef.current = mirror;
    const fetchMock = vi.fn(async () =>
      jsonResponse({ cik: 1, entityName: 'Live', tag: 'Revenues' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getEdgarApiService().tryGetCompanyConcept('320193', 'us-gaap', 'Revenues');

    expect((result as { entityName?: string } | null)?.entityName).toBe('Live');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns null on a mirror miss under strict mirror-only mode (no live call)', async () => {
    config.mirrorFallbackLive = false;
    const mirror = makeMirrorStub();
    mirror.companyFactsComplete.mockResolvedValue(true);
    mirror.getFrames.mockResolvedValue(null);
    mirrorRef.current = mirror;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await getEdgarApiService().tryGetFrames('us-gaap', 'Revenues', 'USD', 'CY2023');

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the mirror is enabled but not yet synced under strict mode', async () => {
    config.mirrorFallbackLive = false;
    const mirror = makeMirrorStub();
    mirror.companyFactsComplete.mockResolvedValue(false);
    mirrorRef.current = mirror;

    await expect(
      getEdgarApiService().tryGetFrames('us-gaap', 'Revenues', 'USD', 'CY2023'),
    ).rejects.toThrow(/not synced/);
  });

  it('falls frames back to live when the company-facts layer is not fully synced (#29)', async () => {
    // A partial or mid-(re)sync store: point-lookup readiness can be true, but the
    // frames aggregation gates on the stricter completeness marker. Frames must go
    // live rather than serve a silently-incomplete frame from a partial store.
    const mirror = makeMirrorStub();
    mirror.companyFactsReady.mockResolvedValue(true);
    mirror.companyFactsComplete.mockResolvedValue(false);
    mirrorRef.current = mirror;
    const fetchMock = vi.fn(async () => jsonResponse({ taxonomy: 'us-gaap', data: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await getEdgarApiService().tryGetFrames('us-gaap', 'Revenues', 'USD', 'CY2023');

    expect(mirror.getFrames).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('serves frames from the mirror when the layer is complete, without a live call', async () => {
    const mirror = makeMirrorStub();
    mirror.companyFactsComplete.mockResolvedValue(true);
    mirror.getFrames.mockResolvedValue({
      ccp: 'CY2023',
      data: [
        { accn: 'a', cik: 320193, end: '2023-09-30', entityName: 'Apple Inc.', loc: '', val: 1 },
      ],
      label: 'Revenues',
      pts: 1,
      tag: 'Revenues',
      taxonomy: 'us-gaap',
      uom: 'USD',
    });
    mirrorRef.current = mirror;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await getEdgarApiService().tryGetFrames('us-gaap', 'Revenues', 'USD', 'CY2023');

    expect((result as { pts?: number } | null)?.pts).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the live API directly when no mirror is registered', async () => {
    mirrorRef.current = undefined;
    const fetchMock = vi.fn(async () => jsonResponse({ cik: 1, data: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await getEdgarApiService().tryGetFrames('us-gaap', 'Revenues', 'USD', 'CY2023');

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
