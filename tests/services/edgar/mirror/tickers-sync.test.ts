/**
 * @fileoverview Tests for the ticker-layer ingester — merges company_tickers.json
 * (operating companies) and company_tickers_mf.json (ETFs/mutual funds) into one
 * page, ingests fund symbols with an empty name, and lets operating-company
 * tickers win on a cross-file symbol collision.
 * @module tests/services/edgar/mirror/tickers-sync
 */

import type { MirrorRow, SyncContext, SyncPage } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTickersSync } from '@/services/edgar/mirror/tickers-sync.js';

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      'last-modified': 'Sat, 31 May 2026 03:00:00 GMT',
    },
  });

async function collectRecords(): Promise<MirrorRow[]> {
  const sync = makeTickersSync({ userAgent: 'test test@example.com' });
  const ctx: SyncContext = { mode: 'init', signal: new AbortController().signal };
  const pages: SyncPage[] = [];
  for await (const page of sync(ctx)) pages.push(page);
  return pages.flatMap((p) => p.records);
}

describe('makeTickersSync', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('merges fund tickers (empty name) alongside operating-company tickers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('company_tickers_mf.json')) {
          return jsonResponse({
            fields: ['cik', 'seriesId', 'classId', 'symbol'],
            data: [[36405, 'S000002839', 'C000092055', 'VOO']],
          });
        }
        return jsonResponse({ '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } });
      }),
    );

    const records = await collectRecords();
    expect(records.find((r) => r.ticker === 'AAPL')).toMatchObject({
      cik: '0000320193',
      name: 'Apple Inc.',
    });
    expect(records.find((r) => r.ticker === 'VOO')).toMatchObject({ cik: '0000036405', name: '' });
  });

  it('skips a fund symbol that collides with an operating-company ticker (equity wins)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('company_tickers_mf.json')) {
          return jsonResponse({
            fields: ['cik', 'seriesId', 'classId', 'symbol'],
            data: [[1719812, 'S000000001', 'C000000001', 'SPCX']],
          });
        }
        return jsonResponse({ '0': { cik_str: 1181412, ticker: 'SPCX', title: 'Operating Co' } });
      }),
    );

    const records = await collectRecords();
    const spcx = records.filter((r) => r.ticker === 'SPCX');
    expect(spcx).toHaveLength(1);
    expect(spcx[0]).toMatchObject({ cik: '0001181412', name: 'Operating Co' });
  });

  it('degrades gracefully when the fund file is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('company_tickers_mf.json')) return new Response(null, { status: 404 });
        return jsonResponse({ '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } });
      }),
    );

    const records = await collectRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ticker: 'AAPL' });
  });
});
