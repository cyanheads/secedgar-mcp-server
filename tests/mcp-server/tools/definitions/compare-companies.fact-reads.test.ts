/**
 * @fileoverview How `secedgar_compare_companies` reads its companies' facts: every
 * company's companyfacts request goes out before any answer is awaited, the results are
 * assembled in input order whatever order SEC answers in, a failed read fails the call
 * with the first failure in input order once every read has settled, and the caller's
 * cancel reaches every read. Driven through `runToolContract` over the real
 * `EdgarApiService`, with fake timers and `globalThis.fetch` stubbed.
 * @module tests/mcp-server/tools/definitions/compare-companies.fact-reads
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
// The synthetic tickers below are real former tickers (`CCC`); no earlier holder is in play here.
vi.mock('@/services/edgar/data/former-tickers.json', () => ({ default: [] }));
vi.mock('@/services/canvas-bridge/canvas-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/canvas-bridge/canvas-bridge.js')>()),
  getCanvasBridge: () => undefined,
}));

import { compareCompaniesTool } from '@/mcp-server/tools/definitions/compare-companies.tool.js';
import { initEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import type { CompanyConceptUnit, CompanyFactsResponse } from '@/services/edgar/types.js';
import { blockText, wireError } from '../../../support/assertions.js';

/** The filers the ticker file lists: ticker → CIK and the month each fiscal year ends in. */
const FILERS = {
  AAA: { cik: 1, yearEnd: '12-31' },
  BBB: { cik: 2, yearEnd: '09-30' },
  CCC: { cik: 3, yearEnd: '12-31' },
  DDD: { cik: 4, yearEnd: '06-30' },
  EEE: { cik: 5, yearEnd: '12-31' },
} as const;
type Ticker = keyof typeof FILERS;
const TICKERS = Object.keys(FILERS) as Ticker[];

const padded = (cik: number) => String(cik).padStart(10, '0');
const factsPath = (ticker: Ticker) =>
  `/api/xbrl/companyfacts/CIK${padded(FILERS[ticker].cik)}.json`;
const factsUrl = (ticker: Ticker) => `https://data.sec.gov${factsPath(ticker)}`;

/** A filer's annual Revenues for 2023 and 2024, each year ending on its own fiscal year end. */
function companyFacts(ticker: Ticker): CompanyFactsResponse {
  const { cik, yearEnd } = FILERS[ticker];
  const year = (fy: number): CompanyConceptUnit => ({
    accn: `${padded(cik)}-${fy + 1}-000001`,
    end: `${fy}-${yearEnd}`,
    filed: `${fy + 1}-02-01`,
    form: '10-K',
    fp: 'FY',
    fy,
    frame: `CY${fy}`,
    val: cik * 1_000 + fy,
  });
  return {
    cik,
    entityName: `${ticker} INC`,
    facts: {
      'us-gaap': { Revenues: { label: 'Revenues', units: { USD: [year(2023), year(2024)] } } },
    },
  };
}

/** How SEC answers a filer's companyfacts read: its facts, or an HTTP status; `never` holds until aborted. */
type FactsAnswer = { delayMs: number; status?: number } | 'never';

/**
 * Stub SEC: the two ticker files answer at once, and each filer's companyfacts read answers
 * per `answers` (its facts after a 200 when no status is given). Records each companyfacts
 * request as `sent <ticker>` and each answer as `answered <ticker>`, in order, beside every
 * request's signal and the requests still unsettled.
 */
function stubSec(answers: Partial<Record<Ticker, FactsAnswer>>) {
  const events: string[] = [];
  const signals = new Map<Ticker, AbortSignal>();
  let pending = 0;
  const byPath = new Map(TICKERS.map((ticker) => [factsPath(ticker), ticker]));
  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.pathname === '/files/company_tickers.json') {
      return Promise.resolve(
        Response.json(
          Object.fromEntries(
            TICKERS.map((ticker, i) => [
              i,
              { cik_str: FILERS[ticker].cik, ticker, title: `${ticker} INC` },
            ]),
          ),
        ),
      );
    }
    if (url.pathname === '/files/company_tickers_mf.json') {
      return Promise.resolve(
        Response.json({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [] }),
      );
    }
    const ticker = byPath.get(url.pathname);
    const answer = ticker && answers[ticker];
    if (!ticker || !answer) return Promise.reject(new Error(`unrouted fetch: ${input}`));
    events.push(`sent ${ticker}`);
    if (init.signal) signals.set(ticker, init.signal);
    pending++;
    return new Promise<Response>((resolve, reject) => {
      const settle = () => {
        pending--;
        init.signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        clearTimeout(timer);
        settle();
        reject(init.signal?.reason);
      };
      init.signal?.addEventListener('abort', onAbort, { once: true });
      const timer =
        answer === 'never'
          ? undefined
          : setTimeout(() => {
              settle();
              events.push(`answered ${ticker}`);
              resolve(
                answer.status === undefined
                  ? Response.json(companyFacts(ticker))
                  : new Response(`status ${answer.status}`, { status: answer.status }),
              );
            }, answer.delayMs);
    });
  });
  return { events, signals, pending: () => pending };
}

/** Run the tool to completion, the clock advanced far enough for every stubbed answer. */
async function compare(companies: string[]) {
  const call = runToolContract(compareCompaniesTool, { companies, concepts: ['revenue'] });
  await vi.advanceTimersByTimeAsync(30_000);
  return call;
}

describe('compareCompaniesTool — companyfacts reads', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    initEdgarApiService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends every company’s companyfacts request before the first one answers', async () => {
    const sec = stubSec(Object.fromEntries(TICKERS.map((t) => [t, { delayMs: 2_000 }])));

    const result = await compare([...TICKERS]);

    expect(result.isError).toBeFalsy();
    expect(sec.events.slice(0, TICKERS.length)).toEqual(TICKERS.map((t) => `sent ${t}`));
    expect(sec.events.slice(TICKERS.length)).toEqual(TICKERS.map((t) => `answered ${t}`));
  });

  /**
   * Characterization: the matrix, its caveats and gaps, and the failures come out in input
   * order whatever order SEC answers in, identical to reads answered one after another.
   */
  it('builds the same result whichever order SEC answers in', async () => {
    const companies = ['AAA', 'ZZZZ', 'BBB', 'DDD', 'CCC', 'EEE'];
    // DDD and EEE report no XBRL: SEC answers their companyfacts 404.
    const run = (delays: Record<Ticker, number>) => {
      stubSec({
        AAA: { delayMs: delays.AAA },
        BBB: { delayMs: delays.BBB },
        CCC: { delayMs: delays.CCC },
        DDD: { delayMs: delays.DDD, status: 404 },
        EEE: { delayMs: delays.EEE, status: 404 },
      });
      return compare(companies);
    };

    const inInputOrder = await run({ AAA: 100, BBB: 900, DDD: 1_700, CCC: 2_500, EEE: 3_300 });
    const reversed = await run({ AAA: 3_300, BBB: 2_500, DDD: 1_700, CCC: 900, EEE: 100 });

    const structured = inInputOrder.structuredContent as {
      companies: Array<{ cik: string }>;
      failed_companies: Array<{ input: string; reason: string }>;
      cells: Array<{ cik: string; period: string }>;
      caveats: string[];
    };
    expect(structured.companies.map((c) => c.cik)).toEqual([padded(1), padded(2), padded(3)]);
    expect(structured.failed_companies.map((f) => [f.input, f.reason])).toEqual([
      ['ZZZZ', 'not_found'],
      ['DDD', 'no_company_facts'],
      ['EEE', 'no_company_facts'],
    ]);
    expect(structured.cells.map((c) => `${c.cik} ${c.period}`)).toEqual([
      `${padded(1)} CY2024`,
      `${padded(1)} CY2023`,
      `${padded(2)} CY2024`,
      `${padded(2)} CY2023`,
      `${padded(3)} CY2024`,
      `${padded(3)} CY2023`,
    ]);
    expect(structured.caveats).toEqual([
      'Period ends differ inside CY2024 — AAA INC ends 2024-12-31, BBB INC ends 2024-09-30, CCC INC ends 2024-12-31; also inside CY2023. Each company’s fiscal year sits under the calendar year SEC frames it as, and fiscal years ending months apart share that column, so the comparison is approximate; each cell carries its own period_end.',
    ]);
    expect(reversed.structuredContent).toEqual(inInputOrder.structuredContent);
    expect(reversed.content).toEqual(inInputOrder.content);
  });

  it('fails with the first failed read in input order, once every read has settled', async () => {
    // CCC's read fails first; BBB's, earlier in the input, fails later; AAA answers last.
    const sec = stubSec({
      AAA: { delayMs: 3_000 },
      BBB: { delayMs: 1_500, status: 403 },
      CCC: { delayMs: 100, status: 403 },
    });
    const call = runToolContract(compareCompaniesTool, {
      companies: ['AAA', 'BBB', 'CCC'],
      concepts: ['revenue'],
    }).then((result) => {
      sec.events.push('call settled');
      return result;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await call;

    expect(wireError(result)).toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { status: 403, url: factsUrl('BBB') },
    });
    expect(sec.events).toEqual([
      'sent AAA',
      'sent BBB',
      'sent CCC',
      'answered CCC',
      'answered BBB',
      'answered AAA',
      'call settled',
    ]);
    expect(sec.pending()).toBe(0);
  });

  it('ends every company’s read on the caller’s cancel, settling as RequestCancelled on both surfaces', async () => {
    const sec = stubSec({ AAA: 'never', BBB: 'never', CCC: 'never' });
    const caller = new AbortController();

    const call = runToolContract(
      compareCompaniesTool,
      { companies: ['AAA', 'BBB', 'CCC'], concepts: ['revenue'] },
      { context: { signal: caller.signal } },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sec.events).toEqual(['sent AAA', 'sent BBB', 'sent CCC']);
    caller.abort('client cancelled');
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await call;

    // The caller's own reason reached each read, as the MCP SDK aborts with it.
    expect([...sec.signals.values()].map((s) => s.reason)).toEqual([
      'client cancelled',
      'client cancelled',
      'client cancelled',
    ]);
    expect(sec.pending()).toBe(0);
    expect(sec.events).toEqual(['sent AAA', 'sent BBB', 'sent CCC']);
    expect((result.structuredContent as { error: unknown }).error).toEqual({
      code: JsonRpcErrorCode.RequestCancelled,
      message: 'client cancelled',
    });
    expect(blockText(result.content)).toBe('Error: client cancelled');
  });
});
