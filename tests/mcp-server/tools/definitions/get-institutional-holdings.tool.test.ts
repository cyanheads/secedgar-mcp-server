/**
 * @fileoverview Tests for get-institutional-holdings tool — 13F-HR quarterly holdings parsing.
 * @module tests/mcp-server/tools/definitions/get-institutional-holdings.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getInstitutionalHoldingsTool } from '@/mcp-server/tools/definitions/get-institutional-holdings.tool.js';
import type { EftsResponse, FilingIndex } from '@/services/edgar/types.js';

vi.mock('@/services/edgar/edgar-api-service.js', () => ({
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
}));

import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';

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
    const input = getInstitutionalHoldingsTool.input.parse({ ticker_or_cik: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    const apple = result.holdings.find((h) => h.issuer_name === 'APPLE INC')!;
    expect(apple.cusip).toBe('037833100');
    expect(apple.title_of_class).toBe('COM');
    expect(apple.value_in_thousands).toBe(5000000);
    expect(apple.shares_or_principal_amount).toBe(26000);
    expect(apple.shares_or_principal_type).toBe('SH');
    expect(apple.investment_discretion).toBe('SOLE');
    expect(apple.put_call).toBeUndefined();
  });

  it('uses EFTS search when quarter is specified', async () => {
    const mockEftsResponse: EftsResponse = {
      hits: {
        total: { value: 1, relation: 'eq' },
        hits: [
          {
            _id: 'test-id',
            _source: {
              adsh: '0000102909-24-000999',
              file_date: '2024-08-15',
              ciks: ['0000102909'],
              form: '13F-HR',
              display_names: ['Vanguard Group Inc'],
            },
          },
        ],
      },
      query: { from: 0, size: 5, query: 'cik:0000102909' },
    };
    mockApi.searchFilings.mockResolvedValue(mockEftsResponse);

    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      ticker_or_cik: '0000102909',
      quarter: '2024-Q2',
    });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(mockApi.searchFilings).toHaveBeenCalledOnce();
    expect(result.accession_number).toBe('0000102909-24-000999');
  });

  it('falls back to submissions API when EFTS returns no hits for quarter', async () => {
    const mockEftsEmpty: EftsResponse = {
      hits: { total: { value: 0, relation: 'eq' }, hits: [] },
      query: { from: 0, size: 5, query: 'cik:0000102909' },
    };
    mockApi.searchFilings.mockResolvedValue(mockEftsEmpty);

    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      ticker_or_cik: '0000102909',
      quarter: '2024-Q2',
    });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    // Falls back to submissions API (getRecentFilingsByForm)
    expect(mockApi.getRecentFilingsByForm).toHaveBeenCalled();
    expect(result.accession_number).toBe('0000102909-24-000001');
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
          value_in_thousands: 5000000,
          shares_or_principal_amount: 26000,
          shares_or_principal_type: 'SH' as const,
          put_call: undefined,
          investment_discretion: 'SOLE' as const,
        },
        {
          issuer_name: 'NVIDIA CORP',
          title_of_class: 'COM',
          cusip: '67066G104',
          value_in_thousands: 2500000,
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
    expect(blocks[0].text).toContain('$5000.00M');
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
// quarterToDateRange logic (tested indirectly via the tool's quarter behavior)
// ---------------------------------------------------------------------------

describe('quarter parameter date range behavior', () => {
  it('malformed quarter string triggers submissions API fallback', async () => {
    const mockApi2 = {
      resolveCik: vi.fn().mockResolvedValue({ cik: '0000102909', name: 'Test', ticker: undefined }),
      getRecentFilingsByForm: vi.fn().mockResolvedValue([
        {
          accessionNumber: '0000102909-24-000001',
          filingDate: '2024-02-15',
          primaryDocument: 'primary_doc.xml',
        },
      ]),
      searchFilings: vi.fn(),
      tryGetFilingIndex: vi.fn().mockResolvedValue(mockFilingIndex),
      tryGetFilingDocument: vi
        .fn()
        .mockImplementation(async (_cik: string, _accn: string, docName: string) => {
          if (docName === 'primary_doc.xml') return PRIMARY_DOC_XML;
          if (docName === 'infotable.xml') return INFO_TABLE_XML;
          return null;
        }),
    };
    vi.mocked(getEdgarApiService).mockReturnValue(mockApi2 as any);

    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    // 'badformat' doesn't match YYYY-QN — should fall through to submissions API
    const input = getInstitutionalHoldingsTool.input.parse({
      ticker_or_cik: '0000102909',
      quarter: 'badformat',
    });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(mockApi2.searchFilings).not.toHaveBeenCalled();
    expect(mockApi2.getRecentFilingsByForm).toHaveBeenCalled();
    expect(result.accession_number).toBe('0000102909-24-000001');
  });

  it.each([
    ['2024-Q1', '2024-03-01', '2024-05-28'],
    ['2024-Q2', '2024-06-01', '2024-08-28'],
    ['2024-Q3', '2024-09-01', '2024-11-28'],
    ['2024-Q4', '2024-12-01', '2025-02-28'],
  ])('quarter %s produces EFTS search with date range starting %s', async (quarter, startDate) => {
    const emptyEfts: EftsResponse = {
      hits: { total: { value: 0, relation: 'eq' }, hits: [] },
      query: { from: 0, size: 5, query: 'cik:0000102909' },
    };
    mockApi.searchFilings.mockResolvedValue(emptyEfts);

    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      ticker_or_cik: '0000102909',
      quarter,
    });
    await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(mockApi.searchFilings).toHaveBeenCalledWith(
      expect.objectContaining({ startDate, forms: ['13F-HR'] }),
    );
  });
});
