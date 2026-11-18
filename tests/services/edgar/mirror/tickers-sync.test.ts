/**
 * @fileoverview Tests for the ticker-layer ingester — merges company_tickers.json
 * (operating companies) and company_tickers_mf.json (ETFs/mutual funds) into one
 * page, ingests fund symbols with an empty name, lets operating-company tickers
 * win on a cross-file symbol collision, and deletes every stored symbol the page
 * does not write: fund rows only when the fund file loaded, nothing when
 * company_tickers.json lists no ticker, and nothing on a refresh that would
 * delete more than a quarter of either kind's stored rows (#247).
 * @module tests/services/edgar/mirror/tickers-sync
 */

import type {
  MirrorLogger,
  MirrorRow,
  SyncContext,
  SyncMode,
  SyncPage,
} from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTickersSync } from '@/services/edgar/mirror/tickers-sync.js';
import type { TickerRow } from '@/services/edgar/mirror/types.js';

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      'last-modified': 'Sat, 31 May 2026 03:00:00 GMT',
    },
  });

const MF_FIELDS = ['cik', 'seriesId', 'classId', 'symbol'];

/**
 * Run the ingester over `stored` and return the one page it yields. Each page lands in
 * `pages` as it is yielded, so a sync that fails can be shown to have yielded none.
 */
async function syncPage(
  options: { log?: MirrorLogger; mode?: SyncMode; pages?: SyncPage[]; stored?: TickerRow[] } = {},
): Promise<SyncPage> {
  const sync = makeTickersSync({
    userAgent: 'test test@example.com',
    storedRows: async () => options.stored ?? [],
    ...(options.log ? { log: options.log } : {}),
  });
  const ctx: SyncContext = {
    mode: options.mode ?? 'refresh',
    signal: new AbortController().signal,
  };
  const pages = options.pages ?? [];
  for await (const page of sync(ctx)) pages.push(page);
  expect(pages).toHaveLength(1);
  return pages[0] as SyncPage;
}

async function collectRecords(): Promise<MirrorRow[]> {
  return (await syncPage({ mode: 'init' })).records;
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

  it('uppercases each symbol, zero-pads each CIK, and checkpoints the file’s Last-Modified as ISO 8601', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('company_tickers_mf.json')) {
          return jsonResponse({ fields: MF_FIELDS, data: [[36405, 'S1', 'C1', 'voo']] });
        }
        return jsonResponse({ '0': { cik_str: 1067983, ticker: 'brk-b', title: 'BERKSHIRE' } });
      }),
    );

    const page = await syncPage({ mode: 'init' });

    expect(page.records).toEqual([
      { ticker: 'BRK-B', cik: '0001067983', name: 'BERKSHIRE' },
      { ticker: 'VOO', cik: '0000036405', name: '' },
    ]);
    expect(page.checkpoint).toBe('2026-05-31T03:00:00.000Z');
  });
});

/** A stored operating-company row. */
const equity = (ticker: string, cik: string, name = `${ticker} Inc.`): TickerRow => ({
  ticker,
  cik,
  name,
});

/** A stored fund row: the empty name is the schema's fund marker. */
const fund = (ticker: string, cik = '0000036405'): TickerRow => ({ ticker, cik, name: '' });

/** company_tickers.json listing `rows`. */
const tickerFile = (rows: TickerRow[]) =>
  Object.fromEntries(
    rows.map((row, i) => [
      String(i),
      { cik_str: Number(row.cik), ticker: row.ticker, title: row.name },
    ]),
  );

/** company_tickers_mf.json listing `rows`. */
const fundFile = (rows: TickerRow[]) => ({
  fields: MF_FIELDS,
  data: rows.map((row, i) => [Number(row.cik), `S${i}`, `C${i}`, row.ticker]),
});

/**
 * Serve the two ticker files: a status number as an empty answer with that status, an
 * `Error` as the fetch rejection, anything else as a 200 JSON body.
 */
function serveFiles(files: { mf: unknown; tickers: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const answer = url.includes('company_tickers_mf.json') ? files.mf : files.tickers;
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'number') return new Response(null, { status: answer });
      return jsonResponse(answer);
    }),
  );
}

const symbols = (rows: ReadonlyArray<{ ticker?: unknown }>) =>
  rows.map((row) => String(row.ticker)).sort();
const tombstonesOf = (page: SyncPage) => [...(page.tombstones ?? [])].sort();

/** Rows every store and file below lists, so the deletions under test stay within a refresh's quarter. */
const PAD_EQUITY = Array.from({ length: 6 }, (_, i) =>
  equity(`PAD${i}`, String(9000000 + i).padStart(10, '0')),
);
const PAD_FUNDS = Array.from({ length: 3 }, (_, i) => fund(`PADF${i}`));

const AAPL = equity('AAPL', '0000320193', 'Apple Inc.');
const AMRK = equity('AMRK', '0001591588', 'A-Mark Precious Metals, Inc.');
const GOLD = equity('GOLD', '0001591588', 'Gold.com, Inc.');
const MRO = equity('MRO', '0000101778', 'MARATHON OIL CORP');

describe('makeTickersSync — deleting what the files no longer list (#247)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('deletes every stored symbol neither file lists, of either kind, beside the rows it writes', async () => {
    serveFiles({
      tickers: tickerFile([...PAD_EQUITY, AAPL, GOLD]),
      mf: fundFile([...PAD_FUNDS, fund('VOO')]),
    });

    const page = await syncPage({
      stored: [...PAD_EQUITY, AAPL, AMRK, MRO, ...PAD_FUNDS, fund('VOO'), fund('OLDFX')],
    });

    expect(tombstonesOf(page)).toEqual(['AMRK', 'MRO', 'OLDFX']);
    expect(symbols(page.records)).toEqual(
      symbols([...PAD_EQUITY, AAPL, GOLD, ...PAD_FUNDS, fund('VOO')]),
    );
  });

  it('writes a symbol that moved between the files, and a symbol both files list once, deleting none of them', async () => {
    serveFiles({
      tickers: tickerFile([
        ...PAD_EQUITY,
        equity('WASFUND', '0001000001'),
        equity('SPCX', '0001181412'),
      ]),
      mf: fundFile([...PAD_FUNDS, fund('WASEQ', '0001000002'), fund('SPCX', '0001719812')]),
    });

    const page = await syncPage({
      stored: [
        ...PAD_EQUITY,
        equity('WASEQ', '0001000002'),
        equity('SPCX', '0001181412'),
        ...PAD_FUNDS,
        fund('WASFUND', '0001000001'),
      ],
    });

    expect(page.tombstones ?? []).toEqual([]);
    expect(
      page.records.filter((row) => ['WASEQ', 'WASFUND', 'SPCX'].includes(String(row.ticker))),
    ).toEqual([
      { ticker: 'WASFUND', cik: '0001000001', name: 'WASFUND Inc.' },
      { ticker: 'SPCX', cik: '0001181412', name: 'SPCX Inc.' },
      { ticker: 'WASEQ', cik: '0001000002', name: '' },
    ]);
  });

  it.each([
    ['a 503', 503],
    ['a body without the symbol column', { fields: ['cik'], data: [[36405]] }],
    [
      'a body without the cik column',
      {
        fields: ['seriesId', 'classId', 'symbol'],
        data: PAD_FUNDS.map((row, i) => [`S${i}`, `C${i}`, row.ticker]),
      },
    ],
    ['no HTTP response', new TypeError('fetch failed')],
  ])(
    'deletes no fund row when the fund file fails to load (%s), still deleting dropped operating-company symbols',
    async (_case, mf) => {
      serveFiles({ tickers: tickerFile([...PAD_EQUITY, AAPL]), mf });
      const log = { warning: vi.fn() };

      const page = await syncPage({
        log,
        stored: [...PAD_EQUITY, AAPL, MRO, ...PAD_FUNDS, fund('OLDFX')],
      });

      expect(tombstonesOf(page)).toEqual(['MRO']);
      expect(symbols(page.records)).toEqual(symbols([...PAD_EQUITY, AAPL]));
      expect(log.warning).toHaveBeenCalledOnce();
      expect(log.warning.mock.calls[0]?.[0]).toMatch(/company_tickers_mf\.json/);
    },
  );

  it('rethrows the caller’s cancellation from the fund-file fetch, yielding no page', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!url.includes('company_tickers_mf.json')) {
          return jsonResponse(tickerFile([...PAD_EQUITY, AAPL]));
        }
        controller.abort();
        throw controller.signal.reason;
      }),
    );
    const sync = makeTickersSync({
      userAgent: 'test test@example.com',
      storedRows: async () => [...PAD_EQUITY, AAPL, ...PAD_FUNDS],
    });
    const pages: SyncPage[] = [];
    const run = async () => {
      for await (const page of sync({ mode: 'refresh', signal: controller.signal })) {
        pages.push(page);
      }
    };

    await expect(run()).rejects.toMatchObject({ name: 'AbortError' });
    expect(pages).toEqual([]);
  });

  const EMPTY_TICKER = { '0': { cik_str: 320193, ticker: '', title: 'Apple Inc.' } };

  it.each([
    ['refresh', 'an empty object', {}],
    ['init', 'an empty object', {}],
    ['refresh', 'entries without a title', { '0': { cik_str: 320193, ticker: 'AAPL' } }],
    ['refresh', 'an entry with an empty ticker', EMPTY_TICKER],
    ['init', 'an entry with an empty ticker', EMPTY_TICKER],
  ] as const)(
    'fails a %s whose company_tickers.json is %s, yielding no page',
    async (mode, _case, body) => {
      serveFiles({ tickers: body, mf: fundFile(PAD_FUNDS) });
      const pages: SyncPage[] = [];

      await expect(
        syncPage({ mode, pages, stored: [...PAD_EQUITY, ...PAD_FUNDS] }),
      ).rejects.toThrow(/company_tickers\.json listed no ticker/);
      expect(pages).toEqual([]);
    },
  );

  it('skips an entry with an empty ticker beside valid ones, writing no row for it', async () => {
    serveFiles({
      tickers: tickerFile([...PAD_EQUITY, equity('', '0000320193', 'Apple Inc.'), MRO]),
      mf: fundFile(PAD_FUNDS),
    });

    const page = await syncPage({ stored: [...PAD_EQUITY, MRO, ...PAD_FUNDS] });

    expect(symbols(page.records)).toEqual(symbols([...PAD_EQUITY, MRO, ...PAD_FUNDS]));
    expect(page.tombstones ?? []).toEqual([]);
  });

  /**
   * A store of 8 operating-company and 8 fund rows, refreshed from files that drop the
   * first `dropped` rows of one kind and list every row of the other. Two of eight is
   * exactly a quarter.
   */
  const STORED_EQUITY = Array.from({ length: 8 }, (_, i) =>
    equity(`EQ${i}`, String(8000000 + i).padStart(10, '0')),
  );
  const STORED_FUNDS = Array.from({ length: 8 }, (_, i) => fund(`FD${i}`));

  it.each([
    ['operating-company', 'refresh', 2, 'deletes them'],
    ['operating-company', 'refresh', 3, 'fails'],
    ['operating-company', 'init', 3, 'deletes them'],
    ['fund', 'refresh', 2, 'deletes them'],
    ['fund', 'refresh', 3, 'fails'],
    ['fund', 'init', 3, 'deletes them'],
  ] as const)(
    'a %s drop: a %s missing %i of 8 stored rows %s',
    async (kind, mode, dropped, outcome) => {
      const listedEquity = kind === 'fund' ? STORED_EQUITY : STORED_EQUITY.slice(dropped);
      const listedFunds = kind === 'fund' ? STORED_FUNDS.slice(dropped) : STORED_FUNDS;
      serveFiles({ tickers: tickerFile(listedEquity), mf: fundFile(listedFunds) });
      const sync = syncPage({ mode, stored: [...STORED_EQUITY, ...STORED_FUNDS] });

      if (outcome === 'fails') {
        await expect(sync).rejects.toThrow(
          `would delete 3 of the 8 stored ${kind === 'fund' ? 'company_tickers_mf.json' : 'company_tickers.json'} symbols`,
        );
        return;
      }
      const gone = (kind === 'fund' ? STORED_FUNDS : STORED_EQUITY).slice(0, dropped);
      expect(tombstonesOf(await sync)).toEqual(symbols(gone));
    },
  );

  /** 20 stored operating-company rows: 5 is exactly a quarter, 6 the least past it. */
  const TWENTY_EQUITY = Array.from({ length: 20 }, (_, i) =>
    equity(`TW${i}`, String(7000000 + i).padStart(10, '0')),
  );

  it.each([
    [5, 'deletes all 5'],
    [6, 'fails, yielding no page'],
  ] as const)('a refresh missing %i of 20 stored rows of one kind %s', async (dropped, outcome) => {
    serveFiles({ tickers: tickerFile(TWENTY_EQUITY.slice(dropped)), mf: fundFile([]) });
    const pages: SyncPage[] = [];
    const sync = syncPage({ pages, stored: TWENTY_EQUITY });

    if (outcome === 'deletes all 5') {
      expect(tombstonesOf(await sync)).toEqual(symbols(TWENTY_EQUITY.slice(0, 5)));
      return;
    }
    await expect(sync).rejects.toThrow(
      'would delete 6 of the 20 stored company_tickers.json symbols, more than a quarter',
    );
    expect(pages).toEqual([]);
  });
});
