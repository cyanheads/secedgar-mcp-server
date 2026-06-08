/**
 * @fileoverview Tests for get-institutional-holdings tool — 13F-HR quarterly holdings parsing.
 * @module tests/mcp-server/tools/definitions/get-institutional-holdings.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getInstitutionalHoldingsTool } from '@/mcp-server/tools/definitions/get-institutional-holdings.tool.js';
import type { FilingIndex } from '@/services/edgar/types.js';

vi.mock('@/services/edgar/edgar-api-service.js', () => ({
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
}));

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

/** A canvas bridge stub whose registerDataframe echoes the row count it received. */
function stubBridge() {
  return {
    registerDataframe: vi.fn(
      async (
        _ctx: unknown,
        opts: { rows: Array<Record<string, unknown>>; sourceTool: string; truncated?: boolean },
      ) => ({
        tableName: 'df_TEST0_TEST1',
        rowCount: opts.rows.length,
        expiresAt: '2026-12-31T00:00:00.000Z',
        columnSchema: [],
      }),
    ),
  };
}

const INFO_TABLE_XML = `<?xml version="1.0" ?>
<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
  <infoTable>
    <nameOfIssuer>APPLE INC</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>037833100</cusip>
    <value>5000000</value>
    <shrsOrPrnAmt>
      <sshPrnamt>26000</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
    <investmentDiscretion>SOLE</investmentDiscretion>
    <votingAuthority>
      <Sole>26000</Sole>
      <Shared>0</Shared>
      <None>0</None>
    </votingAuthority>
  </infoTable>
  <infoTable>
    <nameOfIssuer>MICROSOFT CORP</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>594918104</cusip>
    <value>3000000</value>
    <shrsOrPrnAmt>
      <sshPrnamt>8500</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
    <investmentDiscretion>SOLE</investmentDiscretion>
    <votingAuthority>
      <Sole>8500</Sole>
      <Shared>0</Shared>
      <None>0</None>
    </votingAuthority>
  </infoTable>
</informationTable>`;

// One issuer (APPLE) split across two info-table sub-lines plus a distinct issuer (MICROSOFT)
// — exercises consolidation (sub-line collapse, value sum, sort) and the raw-rows opt-out.
const SUBLINE_INFO_TABLE_XML = `<?xml version="1.0" ?>
<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
  <infoTable>
    <nameOfIssuer>APPLE INC</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>037833100</cusip>
    <value>3000000</value>
    <shrsOrPrnAmt>
      <sshPrnamt>10000</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
    <investmentDiscretion>SOLE</investmentDiscretion>
  </infoTable>
  <infoTable>
    <nameOfIssuer>APPLE INC</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>037833100</cusip>
    <value>2000000</value>
    <shrsOrPrnAmt>
      <sshPrnamt>8000</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
    <investmentDiscretion>DFND</investmentDiscretion>
  </infoTable>
  <infoTable>
    <nameOfIssuer>MICROSOFT CORP</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>594918104</cusip>
    <value>4000000</value>
    <shrsOrPrnAmt>
      <sshPrnamt>5000</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
    <investmentDiscretion>SOLE</investmentDiscretion>
  </infoTable>
</informationTable>`;

const PRIMARY_DOC_XML = `<?xml version="1.0"?>
<edgarSubmission>
  <filingManager>
    <name>Vanguard Group Inc</name>
  </filingManager>
  <periodOfReport>12-31-2024</periodOfReport>
</edgarSubmission>`;

const mockFilingIndex: FilingIndex = {
  directory: {
    name: '000102909124000001',
    item: [
      { name: 'primary_doc.xml', type: 'text/xml', size: '3000', 'last-modified': '2024-02-15' },
      {
        name: 'infotable.xml',
        type: 'text/xml',
        size: '250000',
        'last-modified': '2024-02-15',
      },
    ],
  },
};

const mockApi = {
  resolveCik: vi.fn(),
  getRecentFilingsByForm: vi.fn(),
  searchFilings: vi.fn(),
  tryGetFilingIndex: vi.fn(),
  tryGetFilingDocument: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default to no canvas — individual tests opt in by returning a stub bridge.
  vi.mocked(getCanvasBridge).mockReturnValue(undefined as never);
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as any);
  mockApi.resolveCik.mockResolvedValue({
    cik: '0000102909',
    name: 'Vanguard Group Inc',
    ticker: undefined,
  });
  mockApi.getRecentFilingsByForm.mockResolvedValue([
    {
      accessionNumber: '0000102909-24-000001',
      filingDate: '2024-02-15',
      primaryDocument: 'primary_doc.xml',
      reportDate: '2024-12-31',
    },
  ]);
  mockApi.tryGetFilingIndex.mockResolvedValue(mockFilingIndex);
  mockApi.tryGetFilingDocument.mockImplementation(
    async (_cik: string, _accn: string, docName: string) => {
      if (docName === 'primary_doc.xml') return PRIMARY_DOC_XML;
      if (docName === 'infotable.xml') return INFO_TABLE_XML;
      return null;
    },
  );
});

describe('getInstitutionalHoldingsTool', () => {
  it('returns holdings for a valid institution', async () => {
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(result.filer_cik).toBe('0000102909');
    expect(result.filing_date).toBe('2024-02-15');
    expect(result.accession_number).toBe('0000102909-24-000001');
    expect(result.total_holdings_in_filing).toBe(2);
    expect(result.holdings).toHaveLength(2);
  });

  it('parses reporting period from primary_doc.xml in MM-DD-YYYY format', async () => {
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    // MM-DD-YYYY → YYYY-MM-DD
    expect(result.reporting_period).toBe('2024-12-31');
  });

  it('extracts filer name from primary_doc.xml filingManager', async () => {
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(result.filer_name).toBe('Vanguard Group Inc');
  });

  it('falls back to resolved name when primary_doc.xml is unavailable', async () => {
    mockApi.tryGetFilingDocument.mockImplementation(
      async (_cik: string, _accn: string, docName: string) => {
        if (docName === 'primary_doc.xml') return null;
        if (docName === 'infotable.xml') return INFO_TABLE_XML;
        return null;
      },
    );
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(result.filer_name).toBe('Vanguard Group Inc'); // from resolveCik
    expect(result.reporting_period).toBeUndefined();
  });

  it('applies limit to holdings rows', async () => {
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      ticker_or_cik: '0000102909',
      limit: 1,
    });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(result.holdings).toHaveLength(1);
    expect(result.total_holdings_in_filing).toBe(2); // total unchanged
  });

  it('parses holdings row fields correctly', async () => {
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    // consolidate=false to assert raw-row fields (consolidation drops investment_discretion).
    const input = getInstitutionalHoldingsTool.input.parse({
      ticker_or_cik: '0000102909',
      consolidate: false,
    });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    const apple = result.holdings.find((h) => h.issuer_name === 'APPLE INC')!;
    expect(apple.cusip).toBe('037833100');
    expect(apple.title_of_class).toBe('COM');
    expect(apple.market_value_usd).toBe(5000000); // post-2023 filing → whole USD, unscaled
    expect(apple.shares_or_principal_amount).toBe(26000);
    expect(apple.shares_or_principal_type).toBe('SH');
    expect(apple.investment_discretion).toBe('SOLE');
    expect(apple.put_call).toBeUndefined();
  });

  it('normalizes pre-2023 filing values from thousands to whole USD', async () => {
    // Filing date before 2023-01-03 → Information Table Column 4 was reported in thousands.
    mockApi.getRecentFilingsByForm.mockResolvedValue([
      {
        accessionNumber: '0000102909-22-000001',
        filingDate: '2022-11-14',
        primaryDocument: 'primary_doc.xml',
      },
    ]);
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      ticker_or_cik: '0000102909',
      consolidate: false,
    });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    const apple = result.holdings.find((h) => h.issuer_name === 'APPLE INC')!;
    expect(apple.market_value_usd).toBe(5_000_000_000); // raw 5,000,000 thousands → 5B USD
  });

  it('consolidates info-table sub-lines into distinct positions sorted by value', async () => {
    mockApi.tryGetFilingDocument.mockImplementation(
      async (_cik: string, _accn: string, docName: string) => {
        if (docName === 'primary_doc.xml') return PRIMARY_DOC_XML;
        if (docName === 'infotable.xml') return SUBLINE_INFO_TABLE_XML;
        return null;
      },
    );
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(result.total_holdings_in_filing).toBe(3); // raw info-table rows
    expect(result.total_positions).toBe(2); // distinct positions
    expect(result.holdings).toHaveLength(2);
    // Sorted by value desc: APPLE (3M + 2M = 5M) ahead of MICROSOFT (4M).
    expect(result.holdings[0]!.issuer_name).toBe('APPLE INC');
    expect(result.holdings[0]!.market_value_usd).toBe(5000000);
    expect(result.holdings[0]!.shares_or_principal_amount).toBe(18000); // 10000 + 8000
    expect(result.holdings[0]!.investment_discretion).toBeUndefined(); // dropped on rollup
    expect(result.holdings[1]!.issuer_name).toBe('MICROSOFT CORP');
  });

  it('returns raw info-table rows in filing order when consolidate=false', async () => {
    mockApi.tryGetFilingDocument.mockImplementation(
      async (_cik: string, _accn: string, docName: string) => {
        if (docName === 'primary_doc.xml') return PRIMARY_DOC_XML;
        if (docName === 'infotable.xml') return SUBLINE_INFO_TABLE_XML;
        return null;
      },
    );
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      ticker_or_cik: '0000102909',
      consolidate: false,
    });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(result.total_holdings_in_filing).toBe(3);
    expect(result.total_positions).toBeUndefined();
    expect(result.holdings).toHaveLength(3);
    expect(result.holdings[0]!.issuer_name).toBe('APPLE INC');
    expect(result.holdings[0]!.investment_discretion).toBe('SOLE'); // preserved in raw mode
    expect(result.holdings[2]!.issuer_name).toBe('MICROSOFT CORP');
  });

  it('applies limit to consolidated positions, not raw rows', async () => {
    mockApi.tryGetFilingDocument.mockImplementation(
      async (_cik: string, _accn: string, docName: string) => {
        if (docName === 'primary_doc.xml') return PRIMARY_DOC_XML;
        if (docName === 'infotable.xml') return SUBLINE_INFO_TABLE_XML;
        return null;
      },
    );
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      ticker_or_cik: '0000102909',
      limit: 1,
    });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]!.issuer_name).toBe('APPLE INC'); // largest position
    expect(result.total_positions).toBe(2); // distinct positions before limit
  });

  it('selects the filing matching the requested quarter by reportDate', async () => {
    // Submissions list several 13F-HRs; the handler picks the one whose reportDate matches.
    mockApi.getRecentFilingsByForm.mockResolvedValue([
      {
        accessionNumber: '0000102909-25-000050',
        filingDate: '2025-02-14',
        primaryDocument: 'primary_doc.xml',
        reportDate: '2024-12-31',
      },
      {
        accessionNumber: '0000102909-24-000999',
        filingDate: '2024-08-14',
        primaryDocument: 'primary_doc.xml',
        reportDate: '2024-06-30',
      },
    ]);

    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      ticker_or_cik: '0000102909',
      quarter: '2024-Q2',
    });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(mockApi.searchFilings).not.toHaveBeenCalled(); // EFTS is not used for the quarter path
    expect(result.accession_number).toBe('0000102909-24-000999'); // the Q2 2024 filing
  });

  it('throws no_filings_found when no 13F-HR matches the requested quarter', async () => {
    // Filings exist, but none for the requested quarter — must not substitute another (issue #31).
    mockApi.getRecentFilingsByForm.mockResolvedValue([
      {
        accessionNumber: '0000102909-25-000050',
        filingDate: '2025-02-14',
        primaryDocument: 'primary_doc.xml',
        reportDate: '2024-12-31',
      },
      {
        accessionNumber: '0000102909-24-000700',
        filingDate: '2024-05-10',
        primaryDocument: 'primary_doc.xml',
        reportDate: '2024-03-31',
      },
    ]);

    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      ticker_or_cik: '0000102909',
      quarter: '2024-Q2',
    });

    await expect(getInstitutionalHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_filings_found' },
    });
  });

  it('throws company_not_found when resolveCik returns empty array', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: 'XYZNOTREAL' });

    await expect(getInstitutionalHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'company_not_found' },
    });
  });

  it('throws no_filings_found when no 13F filings exist', async () => {
    mockApi.getRecentFilingsByForm.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '0000102909' });

    await expect(getInstitutionalHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_filings_found' },
    });
  });

  it('throws no_info_table when filing index fetch fails', async () => {
    mockApi.tryGetFilingIndex.mockResolvedValue(null);
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '0000102909' });

    await expect(getInstitutionalHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_info_table' },
    });
  });

  it('throws no_info_table when filing index has no XML documents', async () => {
    mockApi.tryGetFilingIndex.mockResolvedValue({
      directory: {
        name: 'test',
        item: [
          {
            name: '0000102909-24-000001-index.html',
            type: 'text/html',
            size: '100',
            'last-modified': '2024-02-15',
          },
        ],
      },
    });
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '0000102909' });

    await expect(getInstitutionalHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_info_table' },
    });
  });

  it('throws no_info_table when info table XML document fetch returns null', async () => {
    mockApi.tryGetFilingDocument.mockImplementation(
      async (_cik: string, _accn: string, docName: string) => {
        if (docName === 'primary_doc.xml') return PRIMARY_DOC_XML;
        return null; // infotable.xml fetch fails
      },
    );
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '0000102909' });

    await expect(getInstitutionalHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_info_table' },
    });
  });

  it('enrichment notice set when holdings table is empty', async () => {
    mockApi.tryGetFilingDocument.mockImplementation(
      async (_cik: string, _accn: string, docName: string) => {
        if (docName === 'primary_doc.xml') return PRIMARY_DOC_XML;
        // Return an info table with no rows
        return '<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable"></informationTable>';
      },
    );
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(result.holdings).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('13F-HR');
  });

  it('resolves form13fInfoTable.xml doc name variant', async () => {
    mockApi.tryGetFilingIndex.mockResolvedValue({
      directory: {
        name: 'test',
        item: [
          {
            name: 'primary_doc.xml',
            type: 'text/xml',
            size: '1000',
            'last-modified': '2024-02-15',
          },
          {
            name: 'form13fInfoTable.xml',
            type: 'text/xml',
            size: '200000',
            'last-modified': '2024-02-15',
          },
        ],
      },
    });
    mockApi.tryGetFilingDocument.mockImplementation(
      async (_cik: string, _accn: string, docName: string) => {
        if (docName === 'primary_doc.xml') return PRIMARY_DOC_XML;
        if (docName === 'form13fInfoTable.xml') return INFO_TABLE_XML;
        return null;
      },
    );
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(result.holdings).toHaveLength(2);
  });

  it('default input values are applied', () => {
    const input = getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '0000102909' });
    expect(input.limit).toBe(20);
    expect(input.quarter).toBeUndefined();
  });

  it('validates ticker_or_cik must be non-empty', () => {
    expect(() => getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '' })).toThrow();
  });

  it('formats holdings output correctly', () => {
    const output = {
      filer_name: 'Vanguard Group Inc',
      filer_cik: '0000102909',
      reporting_period: '2024-12-31',
      filing_date: '2025-02-14',
      accession_number: '0000102909-25-000001',
      total_holdings_in_filing: 2,
      holdings: [
        {
          issuer_name: 'APPLE INC',
          title_of_class: 'COM',
          cusip: '037833100',
          market_value_usd: 5000000,
          shares_or_principal_amount: 26000,
          shares_or_principal_type: 'SH' as const,
          put_call: undefined,
          investment_discretion: 'SOLE' as const,
        },
        {
          issuer_name: 'NVIDIA CORP',
          title_of_class: 'COM',
          cusip: '67066G104',
          market_value_usd: 2_500_000_000,
          shares_or_principal_amount: 6000,
          shares_or_principal_type: 'SH' as const,
          put_call: 'Call' as const,
          investment_discretion: 'DFND' as const,
        },
      ],
    };
    const blocks = getInstitutionalHoldingsTool.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('Vanguard Group Inc');
    expect(blocks[0].text).toContain('0000102909');
    expect(blocks[0].text).toContain('APPLE INC');
    expect(blocks[0].text).toContain('037833100');
    expect(blocks[0].text).toContain('$5.00M'); // Apple position, millions scale
    expect(blocks[0].text).toContain('$2.50B'); // NVIDIA position, billions scale
    expect(blocks[0].text).toContain('26,000');
    expect(blocks[0].text).toContain('[Call]');
    expect(blocks[0].text).toContain('DFND');
    expect(blocks[0].text).toContain('2 of 2');
    expect(blocks[0].text).toContain('period: 2024-12-31');
  });

  it('formats empty holdings list', () => {
    const output = {
      filer_name: 'Test Fund',
      filer_cik: '0000000001',
      reporting_period: undefined,
      filing_date: '2024-01-01',
      accession_number: 'X-1',
      total_holdings_in_filing: 0,
      holdings: [],
    };
    const blocks = getInstitutionalHoldingsTool.format!(output);
    expect(blocks[0].text).toContain('0 of 0');
  });

  // Security: injection in ticker input
  it('handles path-traversal-style ticker gracefully', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      ticker_or_cik: '../../../etc/passwd',
    });
    await expect(getInstitutionalHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'company_not_found' },
    });
  });

  // Security: env var should not appear in output
  it('output does not contain EDGAR_USER_AGENT env var', async () => {
    process.env.EDGAR_USER_AGENT = 'SecretAgent secret@example.com';
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SecretAgent secret@example.com');
  });

  // Security: limit schema capped
  it('rejects limit above 500', () => {
    expect(() =>
      getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '0000102909', limit: 501 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// quarter parameter handling
// ---------------------------------------------------------------------------

describe('quarter parameter handling', () => {
  it('rejects a malformed quarter string', async () => {
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      ticker_or_cik: '0000102909',
      quarter: 'badformat',
    });

    // 'badformat' doesn't match YYYY-QN — rejected outright, not silently treated as "latest".
    await expect(getInstitutionalHoldingsTool.handler(input, ctx)).rejects.toThrow(/quarter/i);
    expect(mockApi.getRecentFilingsByForm).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// canvas dataframe registration (#39)
// ---------------------------------------------------------------------------

describe('getInstitutionalHoldingsTool — canvas registration (#39)', () => {
  it('omits dataset when the canvas is unavailable', async () => {
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(result.dataset).toBeUndefined();
  });

  it('registers the full position set and caps the inline list at limit', async () => {
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      ticker_or_cik: '0000102909',
      limit: 1,
    });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    // Inline preview is capped; the full 2-position set lands on the canvas.
    expect(result.holdings).toHaveLength(1);
    expect(bridge.registerDataframe).toHaveBeenCalledTimes(1);
    const opts = bridge.registerDataframe.mock.calls[0]![1];
    expect(opts.sourceTool).toBe('secedgar_get_institutional_holdings');
    expect(opts.rows).toHaveLength(2);
    // Filer + period metadata is denormalized onto every row for self-contained joins.
    expect(opts.rows[0]).toMatchObject({
      filer_cik: '0000102909',
      reporting_period: '2024-12-31',
      filing_date: '2024-02-15',
      accession_number: '0000102909-24-000001',
    });
    expect(result.dataset).toMatchObject({ name: 'df_TEST0_TEST1', row_count: 2 });
  });

  it('registers raw sub-line rows (with investment_discretion) when consolidate=false', async () => {
    mockApi.tryGetFilingDocument.mockImplementation(
      async (_cik: string, _accn: string, docName: string) =>
        docName === 'primary_doc.xml' ? PRIMARY_DOC_XML : SUBLINE_INFO_TABLE_XML,
    );
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      ticker_or_cik: '0000102909',
      consolidate: false,
    });
    await getInstitutionalHoldingsTool.handler(input, ctx);

    const rows = bridge.registerDataframe.mock.calls[0]![1].rows;
    expect(rows).toHaveLength(3); // raw sub-lines, not consolidated
    expect(rows.some((r) => r.investment_discretion === 'DFND')).toBe(true);
  });

  it('does not register a dataframe for an empty info table', async () => {
    mockApi.tryGetFilingDocument.mockImplementation(
      async (_cik: string, _accn: string, docName: string) =>
        docName === 'primary_doc.xml'
          ? PRIMARY_DOC_XML
          : '<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable"></informationTable>',
    );
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(bridge.registerDataframe).not.toHaveBeenCalled();
    expect(result.dataset).toBeUndefined();
  });
});
