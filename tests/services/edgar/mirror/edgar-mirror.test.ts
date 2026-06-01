/**
 * @fileoverview Integration test for the EDGAR mirror: a full `runInit` (live
 * SEC fetch mocked) streams a small zip + ticker directory into temp SQLite
 * stores, then the read helpers are exercised — concept reconstruction, the
 * cross-company frame assembly, the dashed→slashed unit mapping, and the absent
 * `loc`. Runs against the real `better-sqlite3` store under vitest/Node.
 * @module tests/services/edgar/mirror/edgar-mirror
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CompanyFactsFile } from '@/services/edgar/mirror/companyfacts-sync.js';
import { EdgarMirror } from '@/services/edgar/mirror/index.js';

const LM = 'Sat, 31 May 2026 03:00:00 GMT';

const apple: CompanyFactsFile = {
  cik: 320193,
  entityName: 'Apple Inc.',
  facts: {
    'us-gaap': {
      Revenues: {
        label: 'Revenues',
        description: 'Total revenue',
        units: {
          USD: [
            {
              end: '2023-09-30',
              val: 383285000000,
              frame: 'CY2023',
              accn: '0000320193-23-000106',
              fy: 2023,
              fp: 'FY',
              form: '10-K',
              filed: '2023-11-03',
            },
            {
              end: '2022-09-24',
              val: 394328000000,
              frame: 'CY2022',
              accn: 'older',
              fy: 2022,
              fp: 'FY',
              form: '10-K',
              filed: '2022-10-28',
            },
          ],
        },
      },
      EarningsPerShareDiluted: {
        label: 'EPS diluted',
        units: {
          'USD/shares': [
            {
              end: '2023-09-30',
              val: 6.13,
              frame: 'CY2023',
              accn: 'eps',
              fy: 2023,
              fp: 'FY',
              form: '10-K',
              filed: '2023-11-03',
            },
          ],
        },
      },
    },
  },
};

const msft: CompanyFactsFile = {
  cik: 789019,
  entityName: 'Microsoft Corporation',
  facts: {
    'us-gaap': {
      Revenues: {
        label: 'Revenues',
        units: {
          USD: [
            {
              end: '2023-06-30',
              val: 211915000000,
              frame: 'CY2023',
              accn: 'msft',
              fy: 2023,
              fp: 'FY',
              form: '10-K',
              filed: '2023-07-27',
            },
          ],
        },
      },
    },
  },
};

const tickersJson = {
  '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  '1': { cik_str: 789019, ticker: 'MSFT', title: 'MICROSOFT CORP' },
};

function makeFetchMock() {
  const zip = zipSync({
    'CIK0000320193.json': strToU8(JSON.stringify(apple)),
    'CIK0000789019.json': strToU8(JSON.stringify(msft)),
  });
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('company_tickers.json')) {
      return new Response(JSON.stringify(tickersJson), { headers: { 'last-modified': LM } });
    }
    if (u.includes('companyfacts.zip')) {
      return init?.method === 'HEAD'
        ? new Response(null, { status: 200, headers: { 'last-modified': LM } })
        : new Response(zip, { headers: { 'last-modified': LM } });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
}

describe('EdgarMirror — init + read helpers', () => {
  let dir: string;
  let mirror: EdgarMirror;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'edgar-mirror-test-'));
    vi.stubGlobal('fetch', makeFetchMock());
    mirror = new EdgarMirror({ dir, userAgent: 'test test@example.com' });
    await mirror.runInit({ signal: new AbortController().signal });
  });

  afterAll(async () => {
    await mirror.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks both layers ready after init', async () => {
    expect(await mirror.tickersReady()).toBe(true);
    expect(await mirror.companyFactsReady()).toBe(true);
  });

  it('reports the company-facts layer complete after a clean init (#29)', async () => {
    // The frames aggregation gates on this stricter marker, not on the durable
    // readiness flag; a clean init leaves status === 'complete'.
    expect(await mirror.companyFactsComplete()).toBe(true);
  });

  it('returns all ticker rows', async () => {
    const rows = await mirror.getTickerRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.ticker === 'AAPL')?.cik).toBe('0000320193');
  });

  it('reconstructs a company concept in companyconcept shape', async () => {
    const concept = await mirror.getCompanyConcept('320193', 'us-gaap', 'Revenues');
    expect(concept?.entityName).toBe('Apple Inc.');
    expect(concept?.tag).toBe('Revenues');
    expect(concept?.description).toBe('Total revenue');
    expect(concept?.units.USD).toHaveLength(2);
    expect(concept?.units.USD?.[0]?.val).toBe(383285000000);
  });

  it('returns null for an unmirrored concept or unknown cik', async () => {
    expect(await mirror.getCompanyConcept('320193', 'us-gaap', 'NotReported')).toBeNull();
    expect(await mirror.getCompanyConcept('000000', 'us-gaap', 'Revenues')).toBeNull();
  });

  it('assembles a cross-company frame for one concept × period', async () => {
    const frame = await mirror.getFrames('us-gaap', 'Revenues', 'USD', 'CY2023');
    expect(frame?.pts).toBe(2);
    const byCik = new Map(frame?.data.map((d) => [d.cik, d]));
    expect(byCik.get(320193)?.val).toBe(383285000000);
    expect(byCik.get(789019)?.val).toBe(211915000000);
    expect(byCik.get(320193)?.accn).toBe('0000320193-23-000106');
    // companyfacts carries no business location — loc is empty (tool treats as absent).
    expect(byCik.get(320193)?.loc).toBe('');
  });

  it('maps the dashed unit wire form (USD-per-shares) to the companyfacts key (USD/shares)', async () => {
    const frame = await mirror.getFrames(
      'us-gaap',
      'EarningsPerShareDiluted',
      'USD-per-shares',
      'CY2023',
    );
    expect(frame?.pts).toBe(1);
    expect(frame?.data[0]?.val).toBe(6.13);
    expect(frame?.uom).toBe('USD-per-shares');
  });

  it('returns null when no company reports the requested frame', async () => {
    expect(await mirror.getFrames('us-gaap', 'Revenues', 'USD', 'CY1999')).toBeNull();
    expect(await mirror.getFrames('us-gaap', 'Nope', 'USD', 'CY2023')).toBeNull();
  });
});
