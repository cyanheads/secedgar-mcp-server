/**
 * @fileoverview Tests for get-fund-holdings. Routing is the substance of this tool, so most
 * of the coverage is there: series-scoped browse as the primary path, the bounded header
 * scan as its fallback, the registrant that must name a series before it can be answered,
 * and the ordering rule that keeps an amendment restating an old period from presenting
 * itself as the current portfolio. The rest covers period targeting, paging, and the
 * publication lag every result is dated by.
 * @module tests/mcp-server/tools/definitions/get-fund-holdings.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFundHoldingsTool } from '@/mcp-server/tools/definitions/get-fund-holdings.tool.js';
import type { FilingsRecent } from '@/services/edgar/types.js';

vi.mock('@/services/edgar/edgar-api-service.js', async (importActual) => {
  const actual = await importActual<typeof import('@/services/edgar/edgar-api-service.js')>();
  return { ...actual, getEdgarApiService: vi.fn(), initEdgarApiService: vi.fn() };
});

import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: vi.fn(),
  toDatasetField: (r: { tableName: string; rowCount: number; expiresAt: string }) => ({
    name: r.tableName,
    row_count: r.rowCount,
    expires_at: r.expiresAt,
  }),
}));

import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

interface FilingRow {
  accessionNumber: string;
  filingDate: string;
  form?: string;
  reportDate: string;
}

function recent(rows: FilingRow[]): FilingsRecent {
  return {
    form: rows.map((r) => r.form ?? 'NPORT-P'),
    accessionNumber: rows.map((r) => r.accessionNumber),
    filingDate: rows.map((r) => r.filingDate),
    reportDate: rows.map((r) => r.reportDate),
    primaryDocument: rows.map(() => 'xslFormNPORT-P_X01/primary_doc.xml'),
    primaryDocDescription: rows.map(() => ''),
  };
}

/** An NPORT-P report body, sized by the position list handed in. */
function report(opts: {
  seriesId?: string | undefined;
  seriesName?: string;
  reportDate: string;
  holdings: Array<{ name: string; pct: number; value: number; cusip?: string }>;
}): string {
  const seriesBlock = opts.seriesId
    ? `<seriesClassInfo><seriesId>${opts.seriesId}</seriesId><classId>C000007774</classId></seriesClassInfo>`
    : '';
  return `<?xml version="1.0"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/nport">
  <headerData><submissionType>NPORT-P</submissionType><filerInfo>${seriesBlock}</filerInfo></headerData>
  <formData>
    <genInfo>
      <regName>Vanguard Index Funds</regName>
      <regCik>0000036405</regCik>
      <seriesName>${opts.seriesName ?? 'N/A'}</seriesName>
      ${opts.seriesId ? `<seriesId>${opts.seriesId}</seriesId>` : ''}
      <repPdEnd>2026-12-31</repPdEnd>
      <repPdDate>${opts.reportDate}</repPdDate>
      <isFinalFiling>N</isFinalFiling>
    </genInfo>
    <fundInfo><totAssets>1000</totAssets><totLiabs>10</totLiabs><netAssets>990</netAssets></fundInfo>
    <invstOrSecs>
      ${opts.holdings
        .map(
          (h) => `<invstOrSec>
        <name>${h.name}</name>
        ${h.cusip ? `<cusip>${h.cusip}</cusip>` : ''}
        <balance>100</balance><units>NS</units><curCd>USD</curCd>
        <valUSD>${h.value}</valUSD><pctVal>${h.pct}</pctVal>
        <assetCat>EC</assetCat>
      </invstOrSec>`,
        )
        .join('\n')}
    </invstOrSecs>
  </formData>
</edgarSubmission>`;
}

const VOO_REPORT = report({
  seriesId: 'S000002839',
  seriesName: 'VANGUARD 500 INDEX FUND',
  reportDate: '2026-03-31',
  holdings: [
    { name: 'Apple Inc', pct: 6.6, value: 200, cusip: '037833100' },
    { name: 'NVIDIA Corp', pct: 7.5, value: 300, cusip: '67066G104' },
    { name: 'Microsoft Corp', pct: 4.9, value: 100, cusip: '594918104' },
  ],
});

function stubBridge() {
  return {
    registerDataframe: vi.fn(
      async (_ctx: unknown, opts: { rows: Array<Record<string, unknown>> }) => ({
        tableName: 'df_TEST0_TEST1',
        rowCount: opts.rows.length,
        expiresAt: '2026-12-31T00:00:00.000Z',
        columnSchema: [],
      }),
    ),
  };
}

const mockApi = {
  resolveCik: vi.fn(),
  resolveFundSeries: vi.fn(),
  listFundSeries: vi.fn(),
  getFundSeriesFilings: vi.fn(),
  getSubmissions: vi.fn(),
  tryGetFilingDocument: vi.fn(),
  tryGetFilingDocumentHead: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCanvasBridge).mockReturnValue(undefined as never);
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as never);

  mockApi.resolveCik.mockResolvedValue({
    cik: '0000036405',
    ticker: 'VOO',
    seriesId: 'S000002839',
    classId: 'C000092055',
  });
  mockApi.resolveFundSeries.mockResolvedValue({ cik: '0000036405', ticker: 'VFINX' });
  mockApi.listFundSeries.mockResolvedValue([]);
  mockApi.getFundSeriesFilings.mockResolvedValue({
    registrantCik: '0000036405',
    registrantName: 'VANGUARD INDEX FUNDS',
    filings: [
      { accessionNumber: '0000036405-26-000325', filingDate: '2026-05-28', form: 'NPORT-P' },
      { accessionNumber: '0000036405-26-000063', filingDate: '2026-02-26', form: 'NPORT-P' },
    ],
  });
  mockApi.getSubmissions.mockResolvedValue({
    name: 'VANGUARD INDEX FUNDS',
    filings: {
      recent: recent([
        {
          accessionNumber: '0000036405-26-000325',
          filingDate: '2026-05-28',
          reportDate: '2026-03-31',
        },
        {
          accessionNumber: '0000036405-26-000063',
          filingDate: '2026-02-26',
          reportDate: '2025-12-31',
        },
      ]),
    },
  });
  mockApi.tryGetFilingDocument.mockResolvedValue(VOO_REPORT);
});

describe('getFundHoldingsTool — routing', () => {
  it('routes a fund ticker through its series, not through the registrant filing list', async () => {
    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'VOO' });
    const result = await getFundHoldingsTool.handler(input, ctx);

    expect(mockApi.getFundSeriesFilings).toHaveBeenCalledWith('S000002839', 'NPORT-P', 40);
    expect(mockApi.tryGetFilingDocumentHead).not.toHaveBeenCalled();
    expect(result.series_id).toBe('S000002839');
    expect(result.accession_number).toBe('0000036405-26-000325');
  });

  it('accepts a bare series ID and takes the registrant from the series index', async () => {
    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 's000002839' });
    const result = await getFundHoldingsTool.handler(input, ctx);

    expect(mockApi.resolveCik).not.toHaveBeenCalled();
    expect(mockApi.getFundSeriesFilings).toHaveBeenCalledWith('S000002839', 'NPORT-P', 40);
    expect(result.registrant_cik).toBe('0000036405');
  });

  it('lets an explicit series_id override the series the fund input implies', async () => {
    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({
      fund: 'VOO',
      series_id: 'S000002848',
    });
    await getFundHoldingsTool.handler(input, ctx);

    expect(mockApi.getFundSeriesFilings).toHaveBeenCalledWith('S000002848', 'NPORT-P', 40);
  });

  it('takes the registrant from the series feed when series_id names another trust (#80)', async () => {
    // fund resolves to one trust, series_id to a series of a different one. The archive path
    // is keyed on the registrant, so reading the series under the resolved trust 404s.
    mockApi.getFundSeriesFilings.mockResolvedValue({
      registrantCik: '0001100663',
      registrantName: 'iSHARES TRUST',
      filings: [
        { accessionNumber: '0002071691-26-012459', filingDate: '2026-05-28', form: 'NPORT-P' },
      ],
    });
    mockApi.getSubmissions.mockResolvedValue({
      name: 'iSHARES TRUST',
      filings: {
        recent: recent([
          {
            accessionNumber: '0002071691-26-012459',
            filingDate: '2026-05-28',
            reportDate: '2026-03-31',
          },
        ]),
      },
    });
    mockApi.tryGetFilingDocument.mockResolvedValue(
      report({
        seriesId: 'S000004310',
        seriesName: 'iShares Core S&P 500 ETF',
        reportDate: '2026-03-31',
        holdings: [{ name: 'Apple Inc', pct: 7, value: 5 }],
      }),
    );

    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'VOO', series_id: 'S000004310' });
    const result = await getFundHoldingsTool.handler(input, ctx);

    expect(mockApi.getSubmissions).toHaveBeenCalledWith('0001100663');
    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledWith(
      '0001100663',
      '0002071691-26-012459',
      'primary_doc.xml',
    );
    expect(result.registrant_cik).toBe('0001100663');
    expect(result.series_id).toBe('S000004310');
  });

  it('fetches the raw XML from the registrant archive path', async () => {
    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'VOO' });
    await getFundHoldingsTool.handler(input, ctx);

    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledWith(
      '0000036405',
      '0000036405-26-000325',
      'primary_doc.xml',
    );
  });

  it('reads headers to find the series when the series index returns nothing', async () => {
    mockApi.getFundSeriesFilings.mockResolvedValue({
      registrantCik: undefined,
      registrantName: undefined,
      filings: [],
    });
    mockApi.getSubmissions.mockResolvedValue({
      name: 'VANGUARD INDEX FUNDS',
      filings: {
        recent: recent([
          {
            accessionNumber: '0000036405-26-000324',
            filingDate: '2026-05-28',
            reportDate: '2026-03-31',
          },
          {
            accessionNumber: '0000036405-26-000325',
            filingDate: '2026-05-28',
            reportDate: '2026-03-31',
          },
        ]),
      },
    });
    mockApi.tryGetFilingDocumentHead
      .mockResolvedValueOnce(
        report({ seriesId: 'S000009999', reportDate: '2026-03-31', holdings: [] }),
      )
      .mockResolvedValueOnce(VOO_REPORT);

    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'VOO' });
    const result = await getFundHoldingsTool.handler(input, ctx);

    expect(mockApi.tryGetFilingDocumentHead).toHaveBeenCalledTimes(2);
    expect(mockApi.tryGetFilingDocumentHead).toHaveBeenLastCalledWith(
      '0000036405',
      '0000036405-26-000325',
      'primary_doc.xml',
      { maxBytes: 65_536, stopAt: '</genInfo>' },
    );
    expect(result.accession_number).toBe('0000036405-26-000325');
  });

  it('stops the header scan as soon as the series matches', async () => {
    mockApi.getFundSeriesFilings.mockResolvedValue({
      registrantCik: undefined,
      registrantName: undefined,
      filings: [],
    });
    mockApi.getSubmissions.mockResolvedValue({
      name: 'VANGUARD INDEX FUNDS',
      filings: {
        recent: recent(
          Array.from({ length: 12 }, (_, i) => ({
            accessionNumber: `0000036405-26-0003${String(i).padStart(2, '0')}`,
            filingDate: '2026-05-28',
            reportDate: '2026-03-31',
          })),
        ),
      },
    });
    mockApi.tryGetFilingDocumentHead.mockResolvedValue(VOO_REPORT);

    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'VOO' });
    await getFundHoldingsTool.handler(input, ctx);

    expect(mockApi.tryGetFilingDocumentHead).toHaveBeenCalledTimes(1);
  });

  it('says the scan stopped at its bound rather than implying the series is absent', async () => {
    mockApi.getFundSeriesFilings.mockResolvedValue({
      registrantCik: undefined,
      registrantName: undefined,
      filings: [],
    });
    mockApi.getSubmissions.mockResolvedValue({
      name: 'iSHARES TRUST',
      filings: {
        recent: recent(
          Array.from({ length: 40 }, (_, i) => ({
            accessionNumber: `0000036405-26-0003${String(i).padStart(2, '0')}`,
            filingDate: '2026-05-28',
            reportDate: '2026-03-31',
          })),
        ),
      },
    });
    mockApi.tryGetFilingDocumentHead.mockResolvedValue(
      report({ seriesId: 'S000009999', reportDate: '2026-03-31', holdings: [] }),
    );

    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'VOO' });

    await expect(getFundHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_filings_found' },
    });
    expect(mockApi.tryGetFilingDocumentHead).toHaveBeenCalledTimes(20);
    await expect(getFundHoldingsTool.handler(input, ctx)).rejects.toThrow(
      /20 most recent of its 40 NPORT-P reports/,
    );
  });

  it('answers a registrant that runs exactly one listed fund without asking for a series', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0001067839', name: 'INVESCO QQQ TRUST' });
    mockApi.listFundSeries.mockResolvedValue([{ seriesId: 'S000101292', ticker: 'QQQ' }]);

    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: '0001067839' });
    await getFundHoldingsTool.handler(input, ctx);

    expect(mockApi.getFundSeriesFilings).toHaveBeenCalledWith('S000101292', 'NPORT-P', 40);
  });

  it('names the registrant series instead of picking one when several exist', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000036405', name: 'VANGUARD INDEX FUNDS' });
    mockApi.listFundSeries.mockResolvedValue([
      { seriesId: 'S000002839', ticker: 'VFINX' },
      { seriesId: 'S000002848', ticker: 'VTSMX' },
    ]);

    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'Vanguard Index Funds' });

    await expect(getFundHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'series_required',
        series: [
          { series_id: 'S000002839', ticker: 'VFINX' },
          { series_id: 'S000002848', ticker: 'VTSMX' },
        ],
      },
    });
    expect(mockApi.getFundSeriesFilings).not.toHaveBeenCalled();
    expect(mockApi.getSubmissions).not.toHaveBeenCalled();
  });

  it('reads the registrant filings directly when it files as a single fund with no series', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000884394', name: 'SPDR S&P 500 ETF TRUST' });
    mockApi.listFundSeries.mockResolvedValue([]);
    mockApi.getSubmissions.mockResolvedValue({
      name: 'SPDR S&P 500 ETF TRUST',
      filings: {
        recent: recent([
          {
            accessionNumber: '0001410368-26-055357',
            filingDate: '2026-05-28',
            reportDate: '2026-03-31',
          },
        ]),
      },
    });
    // The report names no series at all, which is the only evidence that the registrant
    // files as one fund — a single report for the newest period is not, since staggered
    // fiscal quarters leave one series reporting the latest period of several.
    mockApi.tryGetFilingDocumentHead.mockResolvedValue(
      report({ reportDate: '2026-03-31', holdings: [] }),
    );
    mockApi.tryGetFilingDocument.mockResolvedValue(
      report({ reportDate: '2026-03-31', holdings: [{ name: 'Apple Inc', pct: 7, value: 5 }] }),
    );

    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: '0000884394' });
    const result = await getFundHoldingsTool.handler(input, ctx);

    expect(mockApi.getFundSeriesFilings).not.toHaveBeenCalled();
    expect(mockApi.tryGetFilingDocumentHead).toHaveBeenCalledTimes(1);
    expect(result.series_id).toBeUndefined();
    expect(result.series_name).toBeUndefined();
    expect(result.total_holdings).toBe(1);
  });

  it('scopes a seriesless registrant to the series its newest report names (#80)', async () => {
    // A trust whose series carry no listed ticker and whose fiscal quarters are staggered:
    // one report closes the latest period, but the registrant's own filing list interleaves
    // both series, so a report_date drawn from that list would answer with the other fund.
    mockApi.resolveCik.mockResolvedValue({ cik: '0000803013', name: 'GARRISON STREET TRUST' });
    mockApi.listFundSeries.mockResolvedValue([]);
    mockApi.getSubmissions.mockResolvedValue({
      name: 'GARRISON STREET TRUST',
      filings: {
        recent: recent([
          { accessionNumber: 'A-26-000002', filingDate: '2026-07-24', reportDate: '2026-05-31' },
          { accessionNumber: 'B-26-000001', filingDate: '2026-05-26', reportDate: '2026-03-31' },
          { accessionNumber: 'A-26-000001', filingDate: '2026-04-24', reportDate: '2026-02-28' },
        ]),
      },
    });
    mockApi.tryGetFilingDocumentHead.mockResolvedValue(
      report({
        seriesId: 'S000071949',
        seriesName: 'Fund A',
        reportDate: '2026-05-31',
        holdings: [],
      }),
    );
    mockApi.getFundSeriesFilings.mockResolvedValue({
      registrantCik: '0000803013',
      registrantName: 'GARRISON STREET TRUST',
      filings: [
        { accessionNumber: 'A-26-000002', filingDate: '2026-07-24', form: 'NPORT-P' },
        { accessionNumber: 'A-26-000001', filingDate: '2026-04-24', form: 'NPORT-P' },
      ],
    });
    mockApi.tryGetFilingDocument.mockResolvedValue(
      report({
        seriesId: 'S000071949',
        seriesName: 'Fund A',
        reportDate: '2026-05-31',
        holdings: [{ name: 'Apple Inc', pct: 7, value: 5 }],
      }),
    );

    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: '0000803013' });
    const result = await getFundHoldingsTool.handler(input, ctx);

    expect(mockApi.getFundSeriesFilings).toHaveBeenCalledWith('S000071949', 'NPORT-P', 40);
    expect(result.series_id).toBe('S000071949');
    // The other series' 2026-03-31 report is not offered as this fund's period.
    expect(result.available_report_periods).toEqual(['2026-05-31', '2026-02-28']);
  });

  it('names the unlisted series when a seriesless registrant turns out to run several', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000999999', name: 'INSTITUTIONAL TRUST' });
    mockApi.listFundSeries.mockResolvedValue([]);
    mockApi.getSubmissions.mockResolvedValue({
      name: 'INSTITUTIONAL TRUST',
      filings: {
        recent: recent([
          {
            accessionNumber: '0000999999-26-000001',
            filingDate: '2026-05-28',
            reportDate: '2026-03-31',
          },
          {
            accessionNumber: '0000999999-26-000002',
            filingDate: '2026-05-28',
            reportDate: '2026-03-31',
          },
        ]),
      },
    });
    mockApi.tryGetFilingDocumentHead
      .mockResolvedValueOnce(
        report({
          seriesId: 'S000000011',
          seriesName: 'Alpha Fund',
          reportDate: '2026-03-31',
          holdings: [],
        }),
      )
      .mockResolvedValueOnce(
        report({
          seriesId: 'S000000022',
          seriesName: 'Beta Fund',
          reportDate: '2026-03-31',
          holdings: [],
        }),
      );

    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: '0000999999' });

    await expect(getFundHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'series_required',
        series: [
          { series_id: 'S000000011', series_name: 'Alpha Fund' },
          { series_id: 'S000000022', series_name: 'Beta Fund' },
        ],
      },
    });
  });
});

describe('getFundHoldingsTool — report selection', () => {
  it('takes the newest period reported, not the newest filing date', async () => {
    // An amendment restating an old period is filed after every report that followed it.
    mockApi.getFundSeriesFilings.mockResolvedValue({
      registrantCik: '0001100663',
      registrantName: 'iSHARES TRUST',
      filings: [
        { accessionNumber: '0002071691-26-015790', filingDate: '2026-07-13', form: 'NPORT-P/A' },
        { accessionNumber: '0002071691-26-012459', filingDate: '2026-05-28', form: 'NPORT-P' },
      ],
    });
    mockApi.getSubmissions.mockResolvedValue({
      name: 'iSHARES TRUST',
      filings: {
        recent: recent([
          {
            accessionNumber: '0002071691-26-015790',
            filingDate: '2026-07-13',
            form: 'NPORT-P/A',
            reportDate: '2025-09-30',
          },
          {
            accessionNumber: '0002071691-26-012459',
            filingDate: '2026-05-28',
            reportDate: '2026-03-31',
          },
        ]),
      },
    });

    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'VOO' });
    const result = await getFundHoldingsTool.handler(input, ctx);

    expect(result.accession_number).toBe('0002071691-26-012459');
    expect(result.form).toBe('NPORT-P');
  });

  it('prefers the amendment over the original of the same period', async () => {
    mockApi.getFundSeriesFilings.mockResolvedValue({
      registrantCik: '0000036405',
      registrantName: 'VANGUARD INDEX FUNDS',
      filings: [
        { accessionNumber: '0000036405-26-000900', filingDate: '2026-06-10', form: 'NPORT-P/A' },
        { accessionNumber: '0000036405-26-000325', filingDate: '2026-05-28', form: 'NPORT-P' },
      ],
    });
    mockApi.getSubmissions.mockResolvedValue({
      name: 'VANGUARD INDEX FUNDS',
      filings: {
        recent: recent([
          {
            accessionNumber: '0000036405-26-000900',
            filingDate: '2026-06-10',
            form: 'NPORT-P/A',
            reportDate: '2026-03-31',
          },
          {
            accessionNumber: '0000036405-26-000325',
            filingDate: '2026-05-28',
            reportDate: '2026-03-31',
          },
        ]),
      },
    });

    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'VOO' });
    const result = await getFundHoldingsTool.handler(input, ctx);

    expect(result.accession_number).toBe('0000036405-26-000900');
  });

  it('targets a named period and lists the periods it could have used', async () => {
    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'VOO', report_date: '2025-12-31' });
    const result = await getFundHoldingsTool.handler(input, ctx);

    expect(result.accession_number).toBe('0000036405-26-000063');
    expect(result.available_report_periods).toEqual(['2026-03-31', '2025-12-31']);
  });

  it('names the periods it does have when the requested one is missing', async () => {
    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'VOO', report_date: '2019-12-31' });

    await expect(getFundHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'no_filings_found',
        available_report_periods: ['2026-03-31', '2025-12-31'],
      },
    });
  });

  it('fails when the registrant files no NPORT-P at all', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
    mockApi.listFundSeries.mockResolvedValue([]);
    mockApi.getSubmissions.mockResolvedValue({
      name: 'Apple Inc.',
      filings: {
        recent: {
          form: ['10-K'],
          accessionNumber: ['0000320193-26-000001'],
          filingDate: ['2026-01-30'],
          reportDate: ['2025-09-27'],
          primaryDocument: ['aapl-20250927.htm'],
          primaryDocDescription: [''],
        },
      },
    });

    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'AAPL' });

    await expect(getFundHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_filings_found' },
    });
  });

  it('fails when neither the fund nor the series resolves to a registrant', async () => {
    mockApi.resolveFundSeries.mockResolvedValue(undefined);
    mockApi.getFundSeriesFilings.mockResolvedValue({
      registrantCik: undefined,
      registrantName: undefined,
      filings: [],
    });

    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'S000999999' });

    await expect(getFundHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'fund_not_found' },
    });
  });

  it('fails on an ambiguous fund name rather than picking one', async () => {
    mockApi.resolveCik.mockResolvedValue([
      { cik: '0000036405', name: 'Vanguard Index Funds' },
      { cik: '0000052848', name: 'Vanguard World Funds' },
    ]);
    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'Vanguard' });

    await expect(getFundHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'ambiguous_fund' },
    });
  });
});

describe('getFundHoldingsTool — response', () => {
  it('orders positions largest first by percent of net assets', async () => {
    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'VOO' });
    const result = await getFundHoldingsTool.handler(input, ctx);

    expect(result.holdings.map((h) => h.name)).toEqual([
      'NVIDIA Corp',
      'Apple Inc',
      'Microsoft Corp',
    ]);
  });

  it('pages the ordered list and hands back the offset to continue from', async () => {
    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'VOO', limit: 2 });
    const result = await getFundHoldingsTool.handler(input, ctx);

    expect(result.holdings).toHaveLength(2);
    expect(result.total_holdings).toBe(3);
    expect(result.next_offset).toBe(2);
    expect(getEnrichment(ctx).truncated).toBe(true);
    expect(getEnrichment(ctx).cap).toBe(2);
  });

  it('drops next_offset on the last page', async () => {
    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'VOO', limit: 2, offset: 2 });
    const result = await getFundHoldingsTool.handler(input, ctx);

    expect(result.holdings.map((h) => h.name)).toEqual(['Microsoft Corp']);
    expect(result.next_offset).toBeUndefined();
  });

  it('explains an offset past the end of the portfolio', async () => {
    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'VOO', offset: 50 });
    const result = await getFundHoldingsTool.handler(input, ctx);

    expect(result.holdings).toEqual([]);
    expect(getEnrichment(ctx).notice).toContain('at or past the 3 positions');
  });

  it('dates every result to the portfolio date and states the publication lag', async () => {
    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'VOO' });
    const result = await getFundHoldingsTool.handler(input, ctx);

    expect(result.report_period_date).toBe('2026-03-31');
    expect(result.publication_lag_days).toBe(58);
    expect(getEnrichment(ctx).as_of).toContain('Portfolio as of 2026-03-31');
    expect(getEnrichment(ctx).as_of).toContain('58 days later');
  });

  it('registers the whole portfolio on the canvas while the inline list stays a preview', async () => {
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);

    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'VOO', limit: 1 });
    const result = await getFundHoldingsTool.handler(input, ctx);

    expect(result.holdings).toHaveLength(1);
    expect(result.dataset?.row_count).toBe(3);
    const rows = bridge.registerDataframe.mock.calls[0]?.[1].rows;
    expect(rows?.[0]).toMatchObject({
      registrant_cik: '0000036405',
      series_id: 'S000002839',
      report_period_date: '2026-03-31',
      accession_number: '0000036405-26-000325',
      name: 'NVIDIA Corp',
      cusip: '67066G104',
    });
  });

  it('explains an empty report rather than returning a bare zero', async () => {
    mockApi.tryGetFilingDocument.mockResolvedValue(
      report({ seriesId: 'S000002839', reportDate: '2026-03-31', holdings: [] }),
    );
    const ctx = createMockContext({ errors: getFundHoldingsTool.errors });
    const input = getFundHoldingsTool.input.parse({ fund: 'VOO' });
    const result = await getFundHoldingsTool.handler(input, ctx);

    expect(result.total_holdings).toBe(0);
    expect(result.dataset).toBeUndefined();
    expect(getEnrichment(ctx).notice).toContain('lists no portfolio positions');
  });

  it('rejects a malformed series ID, report date, and out-of-range paging at the schema', () => {
    expect(() => getFundHoldingsTool.input.parse({ fund: 'VOO', series_id: 'S123' })).toThrow();
    expect(() =>
      getFundHoldingsTool.input.parse({ fund: 'VOO', series_id: '000002839' }),
    ).toThrow();
    expect(() =>
      getFundHoldingsTool.input.parse({ fund: 'VOO', report_date: '03/31/2026' }),
    ).toThrow();
    expect(() => getFundHoldingsTool.input.parse({ fund: 'VOO', limit: 101 })).toThrow();
    expect(() => getFundHoldingsTool.input.parse({ fund: 'VOO', offset: -1 })).toThrow();
    expect(() => getFundHoldingsTool.input.parse({ fund: '   ' })).toThrow();
  });

  it('leads the rendered report with the portfolio date and carries exact dollar values', () => {
    const text = getFundHoldingsTool.format?.({
      fund: 'VOO',
      series_id: 'S000002839',
      series_name: 'VANGUARD 500 INDEX FUND',
      class_ids: ['C000092055'],
      registrant_cik: '0000036405',
      registrant_name: 'VANGUARD INDEX FUNDS',
      report_period_date: '2026-03-31',
      filing_date: '2026-05-28',
      publication_lag_days: 58,
      form: 'NPORT-P',
      accession_number: '0000036405-26-000325',
      net_assets_usd: 1421263311402.89,
      total_holdings: 519,
      offset: 0,
      next_offset: 1,
      available_report_periods: ['2026-03-31'],
      holdings: [
        {
          name: 'NVIDIA Corp',
          cusip: '67066G104',
          balance: 617520783,
          units: 'NS',
          value_usd: 107695624555.2,
          percent_of_net_assets: 7.5775,
        },
      ],
      dataset: undefined,
    })?.[0];

    const rendered = text?.type === 'text' ? text.text : '';
    expect(rendered).toContain('Portfolio as of 2026-03-31, filed 2026-05-28 (58 days later)');
    expect(rendered).toContain('net assets $1.42T ($1,421,263,311,402.89)');
    expect(rendered).toContain('7.5775% of net assets');
    expect(rendered).toContain('Next offset: 1');
  });
});
