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
import { seriesFromCompanyFacts } from '@/services/edgar/concept-series.js';
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
      // A June fiscal year: SEC frames FY2026 (July 2025 → June 2026) as CY2026.
      NetIncomeLoss: {
        label: 'Net Income (Loss)',
        units: {
          USD: [
            {
              start: '2025-07-01',
              end: '2026-06-30',
              val: 104000000000,
              frame: 'CY2026',
              accn: 'msft-fy2026',
              fy: 2026,
              fp: 'FY',
              form: '10-K',
              filed: '2026-07-29',
            },
          ],
        },
      },
    },
  },
};

/**
 * Amazon's shape (#142): FY2025 from the 10-K, then its Q2-2026 10-Q's
 * trailing-twelve-month figure holding the CY2026 frame.
 */
const amazon: CompanyFactsFile = {
  cik: 1018724,
  entityName: 'AMAZON COM INC',
  facts: {
    'us-gaap': {
      NetIncomeLoss: {
        label: 'Net Income (Loss)',
        units: {
          USD: [
            {
              start: '2025-01-01',
              end: '2025-12-31',
              val: 77670000000,
              frame: 'CY2025',
              accn: 'amzn-10k',
              fy: 2025,
              fp: 'FY',
              form: '10-K',
              filed: '2026-02-06',
            },
            {
              start: '2025-07-01',
              end: '2026-06-30',
              val: 135281000000,
              frame: 'CY2026',
              accn: '0001018724-26-000026',
              fy: 2026,
              fp: 'Q2',
              form: '10-Q',
              filed: '2026-07-31',
            },
          ],
        },
      },
    },
  },
};

/**
 * Merck's shape (#123): the DEF 14A pay-versus-performance fact holds the
 * CY2021 frame at a rounded figure; the 10-K reporting the same period carries
 * no frame. `Assets` is served the malformed way SEC serves some filers' units
 * (#141) — an object where an array belongs.
 */
const merck: CompanyFactsFile = {
  cik: 310158,
  entityName: 'Merck & Co., Inc.',
  facts: {
    'us-gaap': {
      NetIncomeLoss: {
        label: 'Net Income (Loss) Attributable to Parent',
        units: {
          USD: [
            {
              start: '2021-01-01',
              end: '2021-12-31',
              val: 12345000000,
              frame: 'CY2021',
              accn: '0001193125-26-147704',
              fy: null,
              fp: null,
              form: 'DEF 14A',
              filed: '2026-04-08',
            },
            {
              start: '2021-01-01',
              end: '2021-12-31',
              val: 13049000000,
              accn: '0000310158-22-000010',
              fy: 2021,
              fp: 'FY',
              form: '10-K',
              filed: '2022-02-25',
            },
          ],
        },
      },
      Revenues: {
        label: 'Revenues',
        units: { USD: {} as never },
      },
      // SEC serves some tags with no label; the ingester stores the tag in its place.
      InterestExpenseNonoperating: {
        units: {
          USD: [
            {
              start: '2025-01-01',
              end: '2025-12-31',
              val: 1100000000,
              frame: 'CY2025',
              accn: 'mrk-int',
              fy: 2025,
              fp: 'FY',
              form: '10-K',
              filed: '2026-02-24',
            },
          ],
        },
      },
      // A closed year only a later 10-Q frames (#142): CY2020 sits in the Q3-2021
      // 10-Q alone, and ends on the fiscal-year end the 10-K's CY2019 shows.
      AccountsReceivableSale: {
        label: 'Accounts Receivable, Sale',
        units: {
          USD: [
            {
              start: '2019-01-01',
              end: '2019-12-31',
              val: 1,
              frame: 'CY2019',
              accn: 'mrk-10k-2019',
              fy: 2019,
              fp: 'FY',
              form: '10-K',
              filed: '2020-02-26',
            },
            {
              start: '2020-01-01',
              end: '2020-12-31',
              val: 2,
              frame: 'CY2020',
              accn: 'mrk-q3-2021',
              fy: 2021,
              fp: 'Q3',
              form: '10-Q',
              filed: '2021-11-05',
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
    'CIK0000310158.json': strToU8(JSON.stringify(merck)),
    'CIK0001018724.json': strToU8(JSON.stringify(amazon)),
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

  it("reassembles one filer's whole fact set in companyfacts shape", async () => {
    const facts = await mirror.getCompanyFacts('320193');
    expect(facts?.cik).toBe(320193);
    expect(facts?.entityName).toBe('Apple Inc.');
    // Only this filer's rows — the cik index scopes the read.
    expect(Object.keys(facts?.facts['us-gaap'] ?? {}).sort()).toEqual([
      'EarningsPerShareDiluted',
      'Revenues',
    ]);
    const revenues = facts?.facts['us-gaap']?.Revenues;
    expect(revenues?.label).toBe('Revenues');
    expect(revenues?.description).toBe('Total revenue');
    expect(revenues?.units.USD).toHaveLength(2);
    expect(revenues?.units.USD?.[0]?.frame).toBe('CY2023');
    expect(revenues?.units.USD?.[0]?.val).toBe(383285000000);
  });

  it('accepts an unpadded cik and returns null for an unmirrored one', async () => {
    expect(await mirror.getCompanyFacts('789019')).not.toBeNull();
    expect(await mirror.getCompanyFacts('0000789019')).not.toBeNull();
    expect(await mirror.getCompanyFacts('999999')).toBeNull();
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

  it('answers a proxy-held frame with the latest fact from another form (#123)', async () => {
    const frame = await mirror.getFrames('us-gaap', 'NetIncomeLoss', 'USD', 'CY2021');
    expect(frame?.data).toEqual([
      {
        accn: '0000310158-22-000010',
        cik: 310158,
        end: '2021-12-31',
        entityName: 'Merck & Co., Inc.',
        loc: '',
        start: '2021-01-01',
        val: 13049000000,
      },
    ]);
    // The tool reads this to skip the live-frames caveats.
    expect(frame?.holderFormsResolved).toBe(true);
  });

  it('leaves a 10-Q trailing-twelve-month row out of an annual frame, keeping a June fiscal year (#142)', async () => {
    const frame = await mirror.getFrames('us-gaap', 'NetIncomeLoss', 'USD', 'CY2026');
    expect(frame?.data.map((d) => [d.cik, d.val, d.end])).toEqual([
      [789019, 104000000000, '2026-06-30'],
    ]);
    expect(frame?.pts).toBe(1);
    // The same filer's closed year stays in its own frame.
    const prior = await mirror.getFrames('us-gaap', 'NetIncomeLoss', 'USD', 'CY2025');
    expect(prior?.data.map((d) => [d.cik, d.val])).toEqual([[1018724, 77670000000]]);
  });

  it('reads a label the ingester filled with the tag as no label', async () => {
    const concept = await mirror.getCompanyConcept(
      '310158',
      'us-gaap',
      'InterestExpenseNonoperating',
    );
    expect(concept?.tag).toBe('InterestExpenseNonoperating');
    expect(concept?.label).toBe('');
    const facts = await mirror.getCompanyFacts('310158');
    const reported = facts?.facts['us-gaap']?.InterestExpenseNonoperating;
    expect(reported?.units.USD).toHaveLength(1);
    expect(reported).not.toHaveProperty('label');
    // A real label still reads through.
    expect(facts?.facts['us-gaap']?.NetIncomeLoss?.label).toBe(
      'Net Income (Loss) Attributable to Parent',
    );
  });

  it('resolves that tag with an empty label, so callers fall back to the concept label', async () => {
    const facts = await mirror.getCompanyFacts('310158');
    if (!facts) throw new Error('Expected mirrored company facts for 310158.');
    const series = seriesFromCompanyFacts(facts, 'us-gaap', ['InterestExpenseNonoperating']);
    expect(series?.tag).toBe('InterestExpenseNonoperating');
    expect(series?.label).toBe('');
  });

  it('keeps a real frame label, including a one-word tag’s own name', async () => {
    const frame = await mirror.getFrames('us-gaap', 'Revenues', 'USD', 'CY2023');
    expect(frame?.label).toBe('Revenues');
  });

  it('answers a frame for a tag SEC serves without a label with an empty label, as the live API does', async () => {
    // Live frames/us-gaap/InterestExpenseNonoperating/USD/CY2025.json carries `"label":""`.
    const frame = await mirror.getFrames('us-gaap', 'InterestExpenseNonoperating', 'USD', 'CY2025');
    expect(frame?.data.map((d) => d.cik)).toEqual([310158]);
    expect(frame?.label).toBe('');
  });

  it('keeps a closed fiscal year that only a later 10-Q frames (#142)', async () => {
    const frame = await mirror.getFrames('us-gaap', 'AccountsReceivableSale', 'USD', 'CY2020');
    expect(frame?.data).toEqual([
      expect.objectContaining({ cik: 310158, accn: 'mrk-q3-2021', end: '2020-12-31', val: 2 }),
    ]);
  });

  it('skips a unit served as an object instead of an array (#141)', async () => {
    // Merck's Revenues row carries `{"USD":{}}`; the other two filers still answer.
    const frame = await mirror.getFrames('us-gaap', 'Revenues', 'USD', 'CY2023');
    expect(frame?.data.map((d) => d.cik).sort()).toEqual([320193, 789019]);
  });

  it('returns null when no company reports the requested frame', async () => {
    expect(await mirror.getFrames('us-gaap', 'Revenues', 'USD', 'CY1999')).toBeNull();
    expect(await mirror.getFrames('us-gaap', 'Nope', 'USD', 'CY2023')).toBeNull();
  });
});
