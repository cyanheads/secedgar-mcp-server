/**
 * @fileoverview Fund tickers as a caller sees them on a mirror deployment (#135).
 * The mirror stores fund symbols as bare ticker → CIK rows; the live fund file
 * carries each symbol's series and class. With both present, `get_fund_holdings`
 * must route a fund ticker through its series, and `company_search` must return
 * the series and class — the same answers the no-mirror path gives. Driven through
 * `runToolContract` over the real `EdgarApiService`, with the config and mirror
 * modules mocked and `globalThis.fetch` stubbed.
 * @module tests/mcp-server/tools/fund-ticker-resolution
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { config, mirrorRef } = vi.hoisted(() => ({
  config: {
    userAgent: 'test test@example.com',
    rateLimitRps: 1000,
    rateLimitCooldownSeconds: 600,
    tickerCacheTtl: 3600,
    mirrorFallbackLive: true,
    datasetTtlSeconds: 60,
  },
  mirrorRef: { current: undefined as Record<string, ReturnType<typeof vi.fn>> | undefined },
}));

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));
vi.mock('@/services/edgar/mirror/index.js', () => ({ getEdgarMirror: () => mirrorRef.current }));
vi.mock('@/services/canvas-bridge/canvas-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/canvas-bridge/canvas-bridge.js')>()),
  getCanvasBridge: () => undefined,
}));

import { companySearchTool } from '@/mcp-server/tools/definitions/company-search.tool.js';
import { getFundHoldingsTool } from '@/mcp-server/tools/definitions/get-fund-holdings.tool.js';
import { initEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { blockText } from '../../support/assertions.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const MF_FILE = {
  fields: ['cik', 'seriesId', 'classId', 'symbol'],
  data: [
    [36405, 'S000002839', 'C000092055', 'VOO'],
    [36405, 'S000002848', 'C000007773', 'VTI'],
  ],
};

const SUBMISSIONS = {
  cik: '36405',
  name: 'VANGUARD INDEX FUNDS',
  tickers: [],
  exchanges: [],
  sic: '',
  sicDescription: '',
  stateOfIncorporation: 'DE',
  fiscalYearEnd: '1231',
  filings: {
    recent: {
      accessionNumber: [],
      form: [],
      filingDate: [],
      reportDate: [],
      primaryDocument: [],
      primaryDocDescription: [],
    },
    files: [],
  },
};

/** Serve the ticker files and the trust's submissions; record every other request and answer it 404. */
function stubSec() {
  const requested: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requested.push(url);
      if (url.endsWith('/company_tickers_mf.json')) return json(MF_FILE);
      if (url.endsWith('/company_tickers.json')) {
        return json({ '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } });
      }
      if (url.endsWith('/submissions/CIK0000036405.json')) return json(SUBMISSIONS);
      return new Response('not found', { status: 404 });
    }),
  );
  return requested;
}

describe.each([
  ['with no mirror', false],
  ['on a mirror holding fund rows', true],
] as const)('fund tickers %s (#135)', (_label, withMirror) => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    mirrorRef.current = withMirror
      ? {
          tickersReady: vi.fn(async () => true),
          getTickerRows: vi.fn(async () => [
            { cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' },
            { cik: '0000036405', name: '', ticker: 'VOO' },
            { cik: '0000036405', name: '', ticker: 'VTI' },
          ]),
        }
      : undefined;
    initEdgarApiService();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('get_fund_holdings routes a fund ticker through its series, not series_required', async () => {
    const requested = stubSec();

    const result = await runToolContract(getFundHoldingsTool, { fund: 'VOO' });

    const reason = (result.structuredContent as { error?: { data?: { reason?: string } } }).error
      ?.data?.reason;
    expect(reason).not.toBe('series_required');
    expect(requested.find((url) => !url.includes('company_tickers'))).toContain(
      'browse-edgar?action=getcompany&CIK=S000002839&type=NPORT-P',
    );
  });

  it('company_search returns the series and class on both surfaces', async () => {
    stubSec();

    const result = await runToolContract(companySearchTool, {
      query: 'VOO',
      include_filings: false,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      cik: '0000036405',
      series_id: 'S000002839',
      class_id: 'C000092055',
    });
    expect(blockText(result.content)).toContain('Series ID: S000002839 | Class ID: C000092055');
  });
});
