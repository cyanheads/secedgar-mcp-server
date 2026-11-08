/**
 * @fileoverview How `secedgar_get_financials` reads a concept's tags: every tag's
 * companyconcept request goes out before any answer is awaited, the series is built in
 * tag order whatever order SEC answers in, and a failed read fails the call with the
 * first failure in tag order once every read has settled. Driven through
 * `runToolContract` over the real `EdgarApiService`, with fake timers and
 * `globalThis.fetch` stubbed.
 * @module tests/mcp-server/tools/definitions/get-financials.concept-reads
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    userAgent: 'test test@example.com',
    rateLimitRps: 10,
    rateLimitCooldownSeconds: 600,
    tickerCacheTtl: 3600,
    mirrorFallbackLive: true,
  }),
}));
vi.mock('@/services/edgar/mirror/index.js', () => ({ getEdgarMirror: () => undefined }));
vi.mock('@/services/canvas-bridge/canvas-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/canvas-bridge/canvas-bridge.js')>()),
  getCanvasBridge: () => undefined,
}));

import { getFinancialsTool } from '@/mcp-server/tools/definitions/get-financials.tool.js';
import { initEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import type { CompanyConceptResponse } from '@/services/edgar/types.js';
import { wireError } from '../../../support/assertions.js';

/** The `revenue` concept's us-gaap tags, in the catalog's priority order. */
const TAGS = [
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'Revenues',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'SalesRevenueNet',
  'SalesRevenueGoodsNet',
] as const;
type Tag = (typeof TAGS)[number];

const CIK = '0000000001';
const conceptPath = (tag: Tag) => `/api/xbrl/companyconcept/CIK${CIK}/us-gaap/${tag}.json`;
const conceptUrl = (tag: Tag) => `https://data.sec.gov${conceptPath(tag)}`;

/** One annual fact per fiscal year the tag reports, its value naming the tag. */
function concept(tag: Tag, years: number[]): CompanyConceptResponse {
  return {
    cik: 1,
    entityName: 'AAA INC',
    label: tag,
    tag,
    taxonomy: 'us-gaap',
    units: {
      USD: years.map((fy) => ({
        accn: `${CIK}-${fy + 1}-000001`,
        end: `${fy}-12-31`,
        filed: `${fy + 1}-02-01`,
        form: '10-K',
        fp: 'FY',
        fy,
        frame: `CY${fy}`,
        val: (TAGS.indexOf(tag) + 1) * 1_000_000 + fy,
      })),
    },
  };
}

/** How SEC answers one tag's companyconcept read: its facts for `years`, or an HTTP status. */
type ConceptAnswer = { delayMs: number; years?: number[]; status?: number };

/**
 * Stub SEC: the ticker files answer at once, and each tag's companyconcept read answers
 * per `answers` (a 404 for a tag without an entry, as SEC answers an unreported tag).
 * Records each companyconcept request as `sent <tag>` and each answer as `answered <tag>`.
 */
function stubSec(answers: Partial<Record<Tag, ConceptAnswer>>) {
  const events: string[] = [];
  let pending = 0;
  const byPath = new Map(TAGS.map((tag) => [conceptPath(tag), tag]));
  vi.stubGlobal('fetch', (input: string) => {
    const url = new URL(input);
    if (url.pathname === '/files/company_tickers.json') {
      return Promise.resolve(Response.json({ 0: { cik_str: 1, ticker: 'AAA', title: 'AAA INC' } }));
    }
    if (url.pathname === '/files/company_tickers_mf.json') {
      return Promise.resolve(
        Response.json({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [] }),
      );
    }
    const tag = byPath.get(url.pathname);
    if (!tag) return Promise.reject(new Error(`unrouted fetch: ${input}`));
    const answer = answers[tag] ?? { delayMs: 0, status: 404 };
    events.push(`sent ${tag}`);
    pending++;
    return new Promise<Response>((resolve) => {
      setTimeout(() => {
        pending--;
        events.push(`answered ${tag}`);
        resolve(
          answer.status === undefined
            ? Response.json(concept(tag, answer.years ?? []))
            : new Response(`status ${answer.status}`, { status: answer.status }),
        );
      }, answer.delayMs);
    });
  });
  return { events, pending: () => pending };
}

/** Run the tool to completion, the clock advanced far enough for every stubbed answer. */
async function getRevenue() {
  const call = runToolContract(getFinancialsTool, { company: 'AAA', concept: 'revenue' });
  await vi.advanceTimersByTimeAsync(30_000);
  return call;
}

describe('getFinancialsTool — companyconcept reads', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    initEdgarApiService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends every tag’s companyconcept request before the first one answers', async () => {
    const sec = stubSec(
      Object.fromEntries(TAGS.map((tag) => [tag, { delayMs: 2_000, years: [2024] }])),
    );

    const result = await getRevenue();

    expect(result.isError).toBeFalsy();
    expect(sec.events.slice(0, TAGS.length)).toEqual(TAGS.map((tag) => `sent ${tag}`));
    expect(sec.events.slice(TAGS.length)).toEqual(TAGS.map((tag) => `answered ${tag}`));
  });

  it('builds the same series whichever order SEC answers in', async () => {
    // The preferred tag holds 2023-2024, `Revenues` 2021-2024, a deprecated tag 2019-2020.
    const run = (delays: [number, number, number]) => {
      stubSec({
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          delayMs: delays[0],
          years: [2023, 2024],
        },
        Revenues: { delayMs: delays[1], years: [2021, 2022, 2023, 2024] },
        SalesRevenueNet: { delayMs: delays[2], years: [2019, 2020] },
      });
      return getRevenue();
    };

    const inTagOrder = await run([100, 900, 1_700]);
    const reversed = await run([1_700, 900, 100]);

    const structured = inTagOrder.structuredContent as {
      data: Array<{ period: string; value: number; tag: string }>;
    };
    expect(structured.data.map((v) => `${v.period} ${v.value} ${v.tag}`)).toEqual([
      'CY2024 1002024 RevenueFromContractWithCustomerExcludingAssessedTax',
      'CY2023 1002023 RevenueFromContractWithCustomerExcludingAssessedTax',
      'CY2022 2002022 Revenues',
      'CY2021 2002021 Revenues',
      'CY2020 4002020 SalesRevenueNet',
      'CY2019 4002019 SalesRevenueNet',
    ]);
    expect(reversed.structuredContent).toEqual(inTagOrder.structuredContent);
    expect(reversed.content).toEqual(inTagOrder.content);
  });

  it('fails with the first failed read in tag order, once every read has settled', async () => {
    // SalesRevenueNet fails first; Revenues, earlier in tag order, fails later; the two
    // tags without an entry answer 404 last.
    const sec = stubSec({
      RevenueFromContractWithCustomerExcludingAssessedTax: { delayMs: 3_000, years: [2024] },
      Revenues: { delayMs: 2_000, status: 403 },
      RevenueFromContractWithCustomerIncludingAssessedTax: { delayMs: 4_000, status: 404 },
      SalesRevenueNet: { delayMs: 1_000, status: 403 },
      SalesRevenueGoodsNet: { delayMs: 4_000, status: 404 },
    });
    const call = runToolContract(getFinancialsTool, { company: 'AAA', concept: 'revenue' }).then(
      (result) => {
        sec.events.push('call settled');
        return result;
      },
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await call;

    expect(wireError(result)).toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { status: 403, url: conceptUrl('Revenues') },
    });
    expect(sec.events).toEqual([
      ...TAGS.map((tag) => `sent ${tag}`),
      'answered SalesRevenueNet',
      'answered Revenues',
      'answered RevenueFromContractWithCustomerExcludingAssessedTax',
      'answered RevenueFromContractWithCustomerIncludingAssessedTax',
      'answered SalesRevenueGoodsNet',
      'call settled',
    ]);
    expect(sec.pending()).toBe(0);
  });
});
