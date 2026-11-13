/**
 * @fileoverview A listed symbol's earlier holder as a caller sees it (#237): `XOM` now names
 * ExxonMobil Holdings Corp, which has filed no 10-K, while EXXON MOBIL CORP (0000034088) holds
 * every one. `company_search` for its 10-Ks answers the current holder with no filings, and the
 * `resolvedAs` note naming the earlier holder arrives on both surfaces beside the empty-filings
 * notice. Driven through `runToolContract` over the real `EdgarApiService`, with the config and
 * mirror modules mocked, the former-ticker asset replaced by its XOM row, and
 * `globalThis.fetch` stubbed.
 * @module tests/mcp-server/tools/former-ticker-resolution
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { config } = vi.hoisted(() => ({
  config: {
    userAgent: 'test test@example.com',
    rateLimitRps: 1000,
    rateLimitCooldownSeconds: 600,
    tickerCacheTtl: 3600,
    mirrorFallbackLive: true,
    datasetTtlSeconds: 60,
  },
}));

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));
vi.mock('@/services/edgar/mirror/index.js', () => ({ getEdgarMirror: () => undefined }));
vi.mock('@/services/canvas-bridge/canvas-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/canvas-bridge/canvas-bridge.js')>()),
  getCanvasBridge: () => undefined,
}));
// The committed asset's XOM row.
vi.mock('@/services/edgar/data/former-tickers.json', () => ({
  default: [['XOM', '0000034088', '2026-04', 'EXXON MOBIL CORP']],
}));

import { companySearchTool } from '@/mcp-server/tools/definitions/company-search.tool.js';
import { initEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { allText, bag } from '../../support/assertions.js';
import { readCommonMark } from '../../support/commonmark.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const READING =
  "XOM was earlier the ticker of EXXON MOBIL CORP (CIK 0000034088) as late as 2026-04 in SEC's ticker file";

/** ExxonMobil Holdings Corp's submissions: an 8-K, and no 10-K anywhere in its history. */
const SUBMISSIONS = {
  cik: '2115436',
  name: 'ExxonMobil Holdings Corp',
  tickers: ['XOM'],
  exchanges: ['NYSE'],
  sic: '2911',
  sicDescription: 'Petroleum Refining',
  stateOfIncorporation: 'TX',
  fiscalYearEnd: '1231',
  filings: {
    recent: {
      accessionNumber: ['0002115436-26-000002'],
      form: ['8-K'],
      filingDate: ['2026-07-01'],
      reportDate: ['2026-07-01'],
      primaryDocument: ['xom-8k.htm'],
      primaryDocDescription: ['8-K'],
    },
    files: [],
  },
};

describe('a listed symbol with an earlier holder (#237)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/company_tickers_mf.json')) {
          return json({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [] });
        }
        if (url.endsWith('/company_tickers.json')) {
          return json({
            '0': { cik_str: 2115436, ticker: 'XOM', title: 'ExxonMobil Holdings Corp' },
          });
        }
        if (url.endsWith('/submissions/CIK0002115436.json')) return json(SUBMISSIONS);
        return new Response('not found', { status: 404 });
      }),
    );
    initEdgarApiService();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('company_search names the earlier holder beside its empty-filings notice, on both surfaces', async () => {
    const result = await runToolContract(companySearchTool, { query: 'XOM', forms: ['10-K'] });

    expect(result.isError).toBeFalsy();
    const structured = bag(result.structuredContent);
    expect(structured).toMatchObject({ cik: '0002115436', resolvedAs: READING });
    expect(structured.notice).toContain('No filings matched form types [10-K]');
    expect(readCommonMark(allText(result))).toContain(
      `⟨strong⟩Resolved as:⟨/strong⟩ ⟨code_inline:${READING}⟩`,
    );
  });
});
