/**
 * @fileoverview Tests for the pre-2001 full-index support on `EdgarApiService`
 * (#77): `parseMasterIndex` (pipe-delimited `master.idx` → filing rows),
 * `quartersInRange` (calendar-quarter enumeration, newest-first), and
 * `fetchFullIndexQuarter` (fetch + parse + cache). The fixture is a small inline
 * `master.idx` — never a committed multi-MB real index.
 * @module tests/services/edgar/edgar-api-service.full-index
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { config } = vi.hoisted(() => ({
  config: {
    userAgent: 'test test@example.com',
    rateLimitRps: 10,
    tickerCacheTtl: 3600,
    mirrorFallbackLive: true,
  },
}));

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));
vi.mock('@/services/edgar/mirror/index.js', () => ({ getEdgarMirror: () => undefined }));

import {
  getEdgarApiService,
  initEdgarApiService,
  parseMasterIndex,
  quartersInRange,
} from '@/services/edgar/edgar-api-service.js';

/**
 * A small master.idx fixture in the real EDGAR shape: metadata preamble, column
 * header, dashed separator, then pipe-delimited rows — including an amendment,
 * and a malformed row that must be skipped.
 */
const MASTER_IDX_FIXTURE = `Description:           Master Index of EDGAR Dissemination Feed
Last Data Received:    March 31, 1998
Comments:              webmaster@sec.gov
Anonymous FTP:         ftp://ftp.sec.gov/edgar/
Cloud HTTP:            https://www.sec.gov/Archives/


CIK|Company Name|Form Type|Date Filed|Filename
--------------------------------------------------------------------------------
320193|APPLE COMPUTER INC|10-K|1997-12-05|edgar/data/320193/0000320193-97-000010.txt
320193|APPLE COMPUTER INC|10-K/A|1998-01-15|edgar/data/320193/0000320193-98-000001.txt
1000015|META GROUP INC|10-K|1998-03-31|edgar/data/1000015/0001000015-98-000009.txt
this is a malformed row with no pipes and should be skipped
1000045|NICHOLAS FINANCIAL INC|10-Q|1998-02-13|edgar/data/1000045/0000914317-98-000107.txt
`;

const textResponse = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/plain' } });

describe('parseMasterIndex', () => {
  it('parses valid rows, skips preamble/header/separator/malformed', () => {
    const entries = parseMasterIndex(MASTER_IDX_FIXTURE);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({
      cik: '0000320193',
      companyName: 'APPLE COMPUTER INC',
      form: '10-K',
      filingDate: '1997-12-05',
      accessionNumber: '0000320193-97-000010',
    });
  });

  it('zero-pads the CIK to 10 digits', () => {
    const entries = parseMasterIndex(MASTER_IDX_FIXTURE);
    expect(entries.every((e) => e.cik.length === 10)).toBe(true);
    expect(entries.find((e) => e.companyName === 'META GROUP INC')?.cik).toBe('0001000015');
  });

  it('derives the dashed accession number from the filename basename', () => {
    const entries = parseMasterIndex(MASTER_IDX_FIXTURE);
    const amendment = entries.find((e) => e.form === '10-K/A');
    expect(amendment?.accessionNumber).toBe('0000320193-98-000001');
  });

  it('handles CRLF line endings', () => {
    const entries = parseMasterIndex(MASTER_IDX_FIXTURE.replace(/\n/g, '\r\n'));
    expect(entries).toHaveLength(4);
    expect(entries[3]?.accessionNumber).toBe('0000914317-98-000107');
  });

  it('returns an empty array for a header-only / empty index', () => {
    expect(parseMasterIndex('')).toEqual([]);
    expect(
      parseMasterIndex('CIK|Company Name|Form Type|Date Filed|Filename\n----------\n'),
    ).toEqual([]);
  });
});

describe('quartersInRange', () => {
  it('returns a single quarter for a same-quarter range', () => {
    expect(quartersInRange('1998-01-01', '1998-03-31')).toEqual([{ year: 1998, quarter: 1 }]);
  });

  it('maps months to quarters (May → Q2)', () => {
    expect(quartersInRange('1998-05-10', '1998-05-10')).toEqual([{ year: 1998, quarter: 2 }]);
  });

  it('returns quarters newest-first across a year boundary', () => {
    expect(quartersInRange('1997-11-01', '1998-02-15')).toEqual([
      { year: 1998, quarter: 1 },
      { year: 1997, quarter: 4 },
    ]);
  });

  it('enumerates every quarter of a multi-year range, newest-first', () => {
    const quarters = quartersInRange('1999-01-01', '2000-12-31');
    expect(quarters).toHaveLength(8);
    expect(quarters[0]).toEqual({ year: 2000, quarter: 4 });
    expect(quarters[7]).toEqual({ year: 1999, quarter: 1 });
  });
});

describe('EdgarApiService.fetchFullIndexQuarter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initEdgarApiService();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('fetches the QTR master.idx and returns parsed rows', async () => {
    const fetchMock = vi.fn(async () => textResponse(MASTER_IDX_FIXTURE));
    vi.stubGlobal('fetch', fetchMock);

    const entries = await getEdgarApiService().fetchFullIndexQuarter(1998, 1);

    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toBe('https://www.sec.gov/Archives/edgar/full-index/1998/QTR1/master.idx');
    expect(entries).toHaveLength(4);
    expect(entries[0]?.accessionNumber).toBe('0000320193-97-000010');
  });

  it('caches within the TTL — a second call does not re-fetch', async () => {
    const fetchMock = vi.fn(async () => textResponse(MASTER_IDX_FIXTURE));
    vi.stubGlobal('fetch', fetchMock);

    const api = getEdgarApiService();
    await api.fetchFullIndexQuarter(1998, 1);
    await api.fetchFullIndexQuarter(1998, 1);

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
