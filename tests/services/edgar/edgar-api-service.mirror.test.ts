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

  // --- Live-path ticker cache: MF ticker merge (issue #40) ---

  it('merges MF tickers into byTicker so fund symbols resolve by ticker', async () => {
    // No mirror — exercise the live-path loadTickerCache.
    mirrorRef.current = undefined;

    const operatingTickers = {
      '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
    };
    const mfTickers = {
      fields: ['cik', 'seriesId', 'classId', 'symbol'],
      data: [[36405, 'S000002839', 'C000092055', 'VOO']],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('company_tickers_mf.json')) return jsonResponse(mfTickers);
        if (url.includes('company_tickers.json')) return jsonResponse(operatingTickers);
        return jsonResponse(null);
      }),
    );

    const vooMatch = await getEdgarApiService().resolveCik('VOO');
    expect(Array.isArray(vooMatch)).toBe(false);
    expect((vooMatch as { cik: string }).cik).toBe('0000036405');
  });

  it('carries seriesId and classId on MF resolved match', async () => {
    mirrorRef.current = undefined;

    const operatingTickers = {
      '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
    };
    const mfTickers = {
      fields: ['cik', 'seriesId', 'classId', 'symbol'],
      data: [[36405, 'S000002839', 'C000092055', 'VOO']],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('company_tickers_mf.json')) return jsonResponse(mfTickers);
        if (url.includes('company_tickers.json')) return jsonResponse(operatingTickers);
        return jsonResponse(null);
      }),
    );

    const vooMatch = await getEdgarApiService().resolveCik('VOO');
    const match = vooMatch as { cik: string; seriesId?: string; classId?: string };
    expect(match.seriesId).toBe('S000002839');
    expect(match.classId).toBe('C000092055');
  });

  it('does not add MF CIKs to byCik — equity AAPL resolve is unaffected', async () => {
    mirrorRef.current = undefined;

    const operatingTickers = {
      '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
    };
    const mfTickers = {
      // Same CIK 36405 as VOO — must not pollute byCik
      fields: ['cik', 'seriesId', 'classId', 'symbol'],
      data: [[36405, 'S000002839', 'C000092055', 'VOO']],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('company_tickers_mf.json')) return jsonResponse(mfTickers);
        if (url.includes('company_tickers.json')) return jsonResponse(operatingTickers);
        return jsonResponse(null);
      }),
    );

    const aaplMatch = await getEdgarApiService().resolveCik('AAPL');
    expect(Array.isArray(aaplMatch)).toBe(false);
    const m = aaplMatch as { cik: string; name?: string };
    expect(m.cik).toBe('0000320193');
    expect(m.name).toBe('Apple Inc.');
  });

  it('gracefully degrades when company_tickers_mf.json is unavailable', async () => {
    mirrorRef.current = undefined;

    const operatingTickers = {
      '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('company_tickers_mf.json')) return new Response(null, { status: 404 });
        if (url.includes('company_tickers.json')) return jsonResponse(operatingTickers);
        return jsonResponse(null);
      }),
    );

    // Equity ticker still resolves
    const aaplMatch = await getEdgarApiService().resolveCik('AAPL');
    expect(Array.isArray(aaplMatch)).toBe(false);
    expect((aaplMatch as { cik: string }).cik).toBe('0000320193');
  });

  it('operating-company ticker wins over a fund symbol on a cross-file collision (SPCX)', async () => {
    mirrorRef.current = undefined;

    const operatingTickers = {
      '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
      '1': { cik_str: 1181412, ticker: 'SPCX', title: 'Operating Co' },
    };
    const mfTickers = {
      fields: ['cik', 'seriesId', 'classId', 'symbol'],
      data: [
        [1719812, 'S000000001', 'C000000001', 'SPCX'], // collides with the equity SPCX above
        [36405, 'S000002839', 'C000092055', 'VOO'], // unique fund symbol — still resolves
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('company_tickers_mf.json')) return jsonResponse(mfTickers);
        if (url.includes('company_tickers.json')) return jsonResponse(operatingTickers);
        return jsonResponse(null);
      }),
    );

    const spcx = (await getEdgarApiService().resolveCik('SPCX')) as {
      cik: string;
      seriesId?: string;
    };
    expect(spcx.cik).toBe('0001181412'); // the equity CIK, not the fund 0001719812
    expect(spcx.seriesId).toBeUndefined();

    const voo = (await getEdgarApiService().resolveCik('VOO')) as { cik: string };
    expect(voo.cik).toBe('0000036405');
  });

  it('resolves a former name on the mirror path via the committed asset', async () => {
    const mirror = makeMirrorStub();
    mirror.tickersReady.mockResolvedValue(true);
    mirror.getTickerRows.mockResolvedValue([
      { cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' },
    ]);
    mirrorRef.current = mirror;
    // The former-name asset is committed, not fetched — no live call should fire.
    const fetchMock = vi.fn(() => {
      throw new Error('unexpected live fetch on the mirror path');
    });
    vi.stubGlobal('fetch', fetchMock);

    // "Facebook" matches a former-name tuple in the committed former-names.json asset.
    const match = (await getEdgarApiService().resolveCik('Facebook')) as { cik: string };
    expect(match.cik).toBe('0001326801');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
