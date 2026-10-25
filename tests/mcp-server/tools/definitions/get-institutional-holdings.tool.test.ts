/**
 * @fileoverview Tests for get-institutional-holdings tool — 13F-HR quarterly holdings parsing.
 * @module tests/mcp-server/tools/definitions/get-institutional-holdings.tool
 */

import { readFileSync } from 'node:fs';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGetInstitutionalHoldingsTool,
  getInstitutionalHoldingsTool,
} from '@/mcp-server/tools/definitions/get-institutional-holdings.tool.js';
import { CallScope } from '@/services/edgar/call-scope.js';
import type { FilingIndex, FilingsRecent, SubmissionsResponse } from '@/services/edgar/types.js';

vi.mock('@/services/edgar/edgar-api-service.js', () => ({
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
}));

import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';

// Partial mock: the canvas accessors are stubbed, but `dataframeGuidance` stays
// real so the staged-dataframe pointer is asserted against the shipped wording.
vi.mock('@/services/canvas-bridge/canvas-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/canvas-bridge/canvas-bridge.js')>()),
  getCanvasBridge: vi.fn(),
  toDatasetField: (r: { tableName: string; rowCount: number; expiresAt: string }) => ({
    name: r.tableName,
    row_count: r.rowCount,
    expires_at: r.expiresAt,
  }),
}));

import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import {
  blockAt,
  blockText,
  caught,
  records,
  recoveryHint,
  wireError,
} from '../../../support/assertions.js';
import { readCommonMark } from '../../../support/commonmark.js';

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

/**
 * Build a SubmissionsResponse from a filing list + identity, for the direct
 * getSubmissions path the tool now takes (#76/#86). Only the fields the handler reads
 * (filings.recent, name, tickers) carry meaningful values.
 */
interface FilingSpec {
  acceptanceDateTime?: string;
  accessionNumber: string;
  filingDate: string;
  form: string;
  primaryDocument?: string;
  reportDate?: string;
}

/** A submissions parallel-array block — the recent window or one archive page. */
function filingsBlock(filings: FilingSpec[]): FilingsRecent {
  return {
    ...(filings.some((f) => f.acceptanceDateTime) && {
      acceptanceDateTime: filings.map((f) => f.acceptanceDateTime ?? ''),
    }),
    accessionNumber: filings.map((f) => f.accessionNumber),
    filingDate: filings.map((f) => f.filingDate),
    form: filings.map((f) => f.form),
    primaryDocDescription: filings.map(() => ''),
    primaryDocument: filings.map((f) => f.primaryDocument ?? 'primary_doc.xml'),
    reportDate: filings.map((f) => f.reportDate ?? ''),
  };
}

function buildSubmissions(opts: {
  name?: string;
  tickers?: string[];
  filings: FilingSpec[];
  files?: SubmissionsResponse['filings']['files'];
}): SubmissionsResponse {
  return {
    cik: '0000102909',
    entityType: 'other',
    exchanges: [],
    filings: {
      recent: filingsBlock(opts.filings),
      files: opts.files ?? [],
    },
    fiscalYearEnd: null,
    name: opts.name ?? 'VANGUARD GROUP INC',
    sic: '',
    sicDescription: '',
    tickers: opts.tickers ?? [],
  };
}

const mockApi = {
  resolveCik: vi.fn(),
  resolveEntityByName: vi.fn(),
  getSubmissions: vi.fn(),
  searchFilings: vi.fn(),
  tryGetFilingIndex: vi.fn(),
  tryGetFilingDocument: vi.fn(),
  fetchArchivePage: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default to no canvas — individual tests opt in by returning a stub bridge.
  vi.mocked(getCanvasBridge).mockReturnValue(undefined as never);
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as any);
  // An archive read nobody arranged is a bug in the walk, not a fixture gap.
  mockApi.fetchArchivePage.mockRejectedValue(new Error('unexpected archive page read'));
  mockApi.resolveCik.mockResolvedValue({
    cik: '0000102909',
    name: 'Vanguard Group Inc',
    ticker: undefined,
  });
  // Ticker-cache miss falls back to EFTS entity-autocomplete; default to no hit so tests
  // opt into name resolution explicitly.
  mockApi.resolveEntityByName.mockResolvedValue([]);
  mockApi.getSubmissions.mockResolvedValue(
    buildSubmissions({
      filings: [
        {
          form: '13F-HR',
          accessionNumber: '0000102909-24-000001',
          filingDate: '2024-02-15',
          reportDate: '2024-12-31',
        },
      ],
    }),
  );
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
  it.each([
    null,
    '<edgarSubmission/>',
    '<amendmentInfo><amendmentType>UNKNOWN</amendmentType></amendmentInfo>',
  ])('retains amendment identity when its header is unreadable: %s', async (header) => {
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        filings: [
          {
            form: '13F-HR/A',
            accessionNumber: 'amend',
            filingDate: '2025-08-14',
            reportDate: '2024-12-31',
          },
          {
            form: '13F-HR',
            accessionNumber: 'original',
            filingDate: '2025-02-15',
            reportDate: '2024-12-31',
          },
        ],
      }),
    );
    mockApi.tryGetFilingDocument.mockImplementation(async (_cik, accession, document) =>
      accession === 'amend'
        ? header
        : document === 'primary_doc.xml'
          ? PRIMARY_DOC_XML
          : INFO_TABLE_XML,
    );
    const result = await runToolContract(getInstitutionalHoldingsTool, { company: '0000102909' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      total_positions: 2,
      amendments: [
        {
          accession_number: 'amend',
          filing_date: '2025-08-14',
          amendment_type: 'UNAVAILABLE',
          unavailable_reason: header ? 'unreadable_header' : 'missing_header',
        },
      ],
    });
    expect(blockText(result.content)).toContain('UNAVAILABLE');
    expect(blockText(result.content)).toContain(header ? 'unreadable_header' : 'missing_header');
  });

  it.each([0, 1, 100])(
    'composes amendment, paging and dataframe notices at offset %s',
    async (offset) => {
      mockApi.getSubmissions.mockResolvedValue(
        buildSubmissions({
          filings: [
            {
              form: '13F-HR/A',
              accessionNumber: 'amend',
              filingDate: '2025-08-14',
              reportDate: '2024-12-31',
            },
            {
              form: '13F-HR',
              accessionNumber: 'original',
              filingDate: '2025-02-15',
              reportDate: '2024-12-31',
            },
          ],
        }),
      );
      const bridge = stubBridge();
      vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);
      const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
      const result = await getInstitutionalHoldingsTool.handler(
        getInstitutionalHoldingsTool.input.parse({ company: '0000102909', limit: 1, offset }),
        ctx,
      );
      expect(result.holdings).toHaveLength(offset >= 2 ? 0 : 1);
      expect(bridge.registerDataframe.mock.calls[0]?.[1].rows).toHaveLength(2);
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain(
        'amend (filed 2025-08-14, UNAVAILABLE: unreadable_header, not_applied)',
      );
      expect(notice).toContain(
        'Not applied, since the type or information table could not be read: amend — inspect with secedgar_get_filing.',
      );
      expect(notice).toContain('df_TEST0_TEST1');
      if (offset === 100) expect(notice).toContain('at or past');
      if (offset === 0) expect(getEnrichment(ctx).truncated).toBe(true);
    },
  );

  it('continues the archive after finding the original and keeps recent same-period amendments', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        filings: [
          {
            form: '13F-HR/A',
            accessionNumber: 'recent-amend',
            filingDate: '2026-08-14',
            reportDate: '2024-12-31',
          },
          { form: '8-K', accessionNumber: 'recent-other', filingDate: '2026-01-01' },
        ],
        files: [
          { name: 'older', filingCount: 2, filingFrom: '2024-12-31', filingTo: '2025-03-31' },
          { name: 'later', filingCount: 1, filingFrom: '2025-04-01', filingTo: '2025-12-31' },
        ],
      }),
    );
    mockApi.fetchArchivePage.mockImplementation(async (name) =>
      filingsBlock(
        name === 'older'
          ? [
              {
                form: '13F-HR',
                accessionNumber: 'original',
                filingDate: '2025-02-15',
                reportDate: '2024-12-31',
              },
            ]
          : [
              {
                form: '13F-HR/A',
                accessionNumber: 'later-amend',
                filingDate: '2025-08-14',
                reportDate: '2024-12-31',
              },
              {
                form: '13F-HR/A',
                accessionNumber: 'other-period',
                filingDate: '2025-08-14',
                reportDate: '2025-03-31',
              },
            ],
      ),
    );
    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0000102909',
      quarter: '2024-Q4',
    });
    expect(result.structuredContent).toMatchObject({
      accession_number: 'original',
      amendment_search_complete: true,
      amendments: [{ accession_number: 'recent-amend' }, { accession_number: 'later-amend' }],
    });
    expect(mockApi.fetchArchivePage.mock.calls.map((c) => c[0])).toEqual(['older', 'later']);
    const scopes = [
      ...mockApi.fetchArchivePage.mock.calls.map((c) => c[1]),
      ...mockApi.tryGetFilingDocument.mock.calls.map((c) => c[3]),
    ];
    expect(new Set(scopes).size).toBe(1);
  });

  it('keeps an original when optional archive discovery fails operationally', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        filings: [
          {
            form: '13F-HR',
            accessionNumber: 'original',
            filingDate: '2025-02-15',
            reportDate: '2024-12-31',
          },
        ],
        files: [
          { name: 'archive', filingCount: 1, filingFrom: '2024-12-31', filingTo: '2025-01-31' },
        ],
      }),
    );
    mockApi.fetchArchivePage.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'SEC unavailable'),
    );
    const result = await runToolContract(getInstitutionalHoldingsTool, { company: '0000102909' });
    expect(result.structuredContent).toMatchObject({
      total_positions: 2,
      amendment_search_complete: false,
    });
    expect(blockText(result.content)).toContain('discovery incomplete');
  });

  it('marks bounded amendment discovery incomplete at ten pages', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        filings: [
          {
            form: '13F-HR',
            accessionNumber: 'original',
            filingDate: '2025-12-31',
            reportDate: '2024-12-31',
          },
        ],
        files: Array.from({ length: 11 }, (_, i) => ({
          name: `archive-${i}`,
          filingCount: 1,
          filingFrom: `2025-${String(i + 1).padStart(2, '0')}-01`,
          filingTo: `2025-${String(i + 1).padStart(2, '0')}-28`,
        })),
      }),
    );
    mockApi.fetchArchivePage.mockResolvedValue(filingsBlock([]));
    const result = await runToolContract(getInstitutionalHoldingsTool, { company: '0000102909' });
    expect(mockApi.fetchArchivePage).toHaveBeenCalledTimes(10);
    expect(result.structuredContent).toMatchObject({ amendment_search_complete: false });
    const text = result.content.map((_, i) => blockText(result.content, i)).join('\n');
    expect(text).toContain('10 pages');
    expect(text).toContain('Additional amendments may exist');
  });
  it('characterizes original-only rows with an unrelated-period amendment', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        filings: [
          {
            form: '13F-HR/A',
            accessionNumber: 'amend-other',
            filingDate: '2025-08-14',
            reportDate: '2024-09-30',
          },
          {
            form: '13F-HR',
            accessionNumber: 'original',
            filingDate: '2025-02-15',
            reportDate: '2024-12-31',
          },
        ],
      }),
    );
    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0000102909',
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({
      accession_number: 'original',
      total_positions: 2,
      next_offset: 1,
      holdings: [{ cusip: '037833100', market_value_usd: 5000000 }],
    });
    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledTimes(2);
  });

  it('discloses a same-period amendment and pages the composed rows', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        filings: [
          {
            form: '13F-HR/A',
            accessionNumber: 'amend',
            filingDate: '2025-08-14',
            reportDate: '2024-12-31',
          },
          {
            form: '13F-HR',
            accessionNumber: 'original',
            filingDate: '2025-02-15',
            reportDate: '2024-12-31',
          },
        ],
      }),
    );
    const added = SUBLINE_INFO_TABLE_XML.replace(
      '<cusip>037833100</cusip>',
      '<cusip>67066G104</cusip>',
    );
    mockApi.tryGetFilingDocument.mockImplementation(async (_cik, accession, document) =>
      accession === 'amend'
        ? document === 'primary_doc.xml'
          ? '<edgarSubmission><formData><coverPage><amendmentInfo><amendmentType>NEW HOLDINGS</amendmentType></amendmentInfo></coverPage></formData></edgarSubmission>'
          : added
        : document === 'primary_doc.xml'
          ? PRIMARY_DOC_XML
          : INFO_TABLE_XML,
    );
    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0000102909',
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({
      accession_number: 'original',
      total_holdings_in_filing: 2,
      total_holdings_composed: 5,
      total_positions: 3,
      next_offset: 1,
      amendments: [
        {
          accession_number: 'amend',
          filing_date: '2025-08-14',
          amendment_type: 'NEW HOLDINGS',
          applied_as: 'new_holdings',
        },
      ],
    });
    const text = result.content.map((_, i) => blockText(result.content, i)).join('\n');
    expect(text).toContain('NEW HOLDINGS');
    expect(text).toContain('applied as new_holdings');
    expect(text).toContain('Composed from: original, amend');
  });
  it('returns holdings for a valid institution', async () => {
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(result.filer_cik).toBe('0000102909');
    expect(result.filing_date).toBe('2024-02-15');
    expect(result.accession_number).toBe('0000102909-24-000001');
    expect(result.total_holdings_in_filing).toBe(2);
    expect(result.holdings).toHaveLength(2);
  });

  it('parses reporting period from primary_doc.xml in MM-DD-YYYY format', async () => {
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    // MM-DD-YYYY → YYYY-MM-DD
    expect(result.reporting_period).toBe('2024-12-31');
  });

  it('extracts filer name from primary_doc.xml filingManager', async () => {
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0000102909' });
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
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(result.filer_name).toBe('Vanguard Group Inc'); // from resolveCik
    expect(result.reporting_period).toBeUndefined();
  });

  it('applies limit to holdings rows', async () => {
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      company: '0000102909',
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
      company: '0000102909',
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
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        filings: [
          {
            form: '13F-HR',
            accessionNumber: '0000102909-22-000001',
            filingDate: '2022-11-14',
          },
        ],
      }),
    );
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      company: '0000102909',
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
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0000102909' });
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
      company: '0000102909',
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
      company: '0000102909',
      limit: 1,
    });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]!.issuer_name).toBe('APPLE INC'); // largest position
    expect(result.total_positions).toBe(2); // distinct positions before limit
  });

  it('selects the filing matching the requested quarter by reportDate', async () => {
    // Submissions list several 13F-HRs; the handler picks the one whose reportDate matches.
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        filings: [
          {
            form: '13F-HR',
            accessionNumber: '0000102909-25-000050',
            filingDate: '2025-02-14',
            reportDate: '2024-12-31',
          },
          {
            form: '13F-HR',
            accessionNumber: '0000102909-24-000999',
            filingDate: '2024-08-14',
            reportDate: '2024-06-30',
          },
        ],
      }),
    );

    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      company: '0000102909',
      quarter: '2024-Q2',
    });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(mockApi.searchFilings).not.toHaveBeenCalled(); // EFTS is not used for the quarter path
    expect(result.accession_number).toBe('0000102909-24-000999'); // the Q2 2024 filing
  });

  it('throws no_filings_found when no 13F-HR matches the requested quarter', async () => {
    // Filings exist, but none for the requested quarter — must not substitute another (issue #31).
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        filings: [
          {
            form: '13F-HR',
            accessionNumber: '0000102909-25-000050',
            filingDate: '2025-02-14',
            reportDate: '2024-12-31',
          },
          {
            form: '13F-HR',
            accessionNumber: '0000102909-24-000700',
            filingDate: '2024-05-10',
            reportDate: '2024-03-31',
          },
        ],
      }),
    );

    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      company: '0000102909',
      quarter: '2024-Q2',
    });

    await expect(getInstitutionalHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_filings_found' },
    });
  });

  it('throws company_not_found when resolveCik returns empty array', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ company: 'XYZNOTREAL' });

    await expect(getInstitutionalHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'company_not_found' },
    });
  });

  it('throws no_filings_found when the entity files no 13F and shows no operating-company signal', async () => {
    // Submissions exist but carry no 13F-HR and no 10-K/10-Q/8-K — a true non-13F,
    // non-operating filer (e.g. a filing agent). Stays the generic no_filings_found.
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        name: 'SOME FILING AGENT',
        filings: [
          { form: 'TA-1', accessionNumber: '0000000000-24-000001', filingDate: '2024-01-01' },
        ],
      }),
    );
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0000102909' });

    await expect(getInstitutionalHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_filings_found' },
    });
  });

  it('throws no_info_table when filing index fetch fails', async () => {
    mockApi.tryGetFilingIndex.mockResolvedValue(null);
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0000102909' });

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
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0000102909' });

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
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0000102909' });

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
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0000102909' });
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
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(result.holdings).toHaveLength(2);
  });

  it('default input values are applied', () => {
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0000102909' });
    expect(input.limit).toBe(20);
    expect(input.quarter).toBeUndefined();
  });

  it('validates company must be non-empty', () => {
    expect(() => getInstitutionalHoldingsTool.input.parse({ company: '' })).toThrow();
  });

  it('formats holdings output correctly', () => {
    const output = {
      filer_name: 'Vanguard Group Inc',
      filer_cik: '0000102909',
      reporting_period: '2024-12-31',
      filing_date: '2025-02-14',
      accession_number: '0000102909-25-000001',
      composed_accessions: ['0000102909-25-000001'],
      total_holdings_in_filing: 2,
      total_holdings_composed: 2,
      offset: 0,
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
          source_accession_numbers: ['0000102909-25-000001'],
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
          source_accession_numbers: ['0000102909-25-000001'],
        },
      ],
    };
    const blocks = getInstitutionalHoldingsTool.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blockAt(blocks).type).toBe('text');
    expect(blockText(blocks)).toContain('Vanguard Group Inc');
    expect(blockText(blocks)).toContain('0000102909');
    expect(blockText(blocks)).toContain('APPLE INC');
    expect(blockText(blocks)).toContain('037833100');
    expect(blockText(blocks)).toContain('$5.00M'); // Apple position, millions scale
    expect(blockText(blocks)).toContain('$2.50B'); // NVIDIA position, billions scale
    expect(blockText(blocks)).toContain('26,000');
    expect(blockText(blocks)).toContain('[Call]');
    expect(blockText(blocks)).toContain('DFND');
    expect(blockText(blocks)).toContain('2 of 2');
    expect(blockText(blocks)).toContain('period: 2024-12-31');
  });

  it('formats empty holdings list', () => {
    const output = {
      filer_name: 'Test Fund',
      filer_cik: '0000000001',
      reporting_period: undefined,
      filing_date: '2024-01-01',
      accession_number: 'X-1',
      composed_accessions: ['X-1'],
      total_holdings_in_filing: 0,
      total_holdings_composed: 0,
      offset: 0,
      holdings: [],
    };
    const blocks = getInstitutionalHoldingsTool.format!(output);
    expect(blockText(blocks)).toContain('0 of 0');
  });

  // Security: injection in ticker input
  it('handles path-traversal-style ticker gracefully', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      company: '../../../etc/passwd',
    });
    await expect(getInstitutionalHoldingsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'company_not_found' },
    });
  });

  // Security: env var should not appear in output
  it('output does not contain EDGAR_USER_AGENT env var', async () => {
    process.env.EDGAR_USER_AGENT = 'SecretAgent secret@example.com';
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SecretAgent secret@example.com');
  });

  // Security: limit schema bounded (served at 500 above 500, #197)
  it('rejects limit above 1000', () => {
    expect(() =>
      getInstitutionalHoldingsTool.input.parse({ company: '0000102909', limit: 1001 }),
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
      company: '0000102909',
      quarter: 'badformat',
    });

    // 'badformat' doesn't match YYYY-QN — rejected outright, not silently treated as "latest".
    await expect(getInstitutionalHoldingsTool.handler(input, ctx)).rejects.toThrow(/quarter/i);
    expect(mockApi.getSubmissions).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// canvas dataframe registration (#39)
// ---------------------------------------------------------------------------

describe('getInstitutionalHoldingsTool — canvas registration (#39)', () => {
  it('omits dataset when the canvas is unavailable', async () => {
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(result.dataset).toBeUndefined();
  });

  it('registers the full position set and caps the inline list at limit', async () => {
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      company: '0000102909',
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
      company: '0000102909',
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
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0000102909' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(bridge.registerDataframe).not.toHaveBeenCalled();
    expect(result.dataset).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// entity resolution & routing (#73 name→CIK, #76 no-submissions 404, #86 operating-company)
// ---------------------------------------------------------------------------

describe('getInstitutionalHoldingsTool — entity resolution & routing', () => {
  it('resolves a name to one filer via EFTS entity-autocomplete (#73)', async () => {
    // Ticker cache misses the institutional name; EFTS resolves it to a single CIK.
    mockApi.resolveCik.mockResolvedValue([]);
    mockApi.resolveEntityByName.mockResolvedValue([
      { cik: '0000102909', name: 'VANGUARD GROUP INC' },
    ]);
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ company: 'vanguard group inc' });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(mockApi.resolveEntityByName).toHaveBeenCalledWith(
      'vanguard group inc',
      expect.any(CallScope),
    );
    // The scope carries the caller's own signal, so a cancel reaches SEC (#179).
    expect(mockApi.resolveEntityByName.mock.calls[0]?.[1].signal).toBe(ctx.signal);
    expect(result.filer_cik).toBe('0000102909');
    expect(result.holdings).toHaveLength(2);
  });

  it('returns ambiguous_entity when a name resolves to multiple filers (#73)', async () => {
    // "vanguard group" resolves to the transfer agent AND the 13F filer — must list both.
    mockApi.resolveCik.mockResolvedValue([]);
    mockApi.resolveEntityByName.mockResolvedValue([
      { cik: '0000735286', name: 'VANGUARD GROUP INC' },
      { cik: '0000102909', name: 'VANGUARD GROUP INC' },
    ]);
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ company: 'vanguard group' });

    const err = await caught(getInstitutionalHoldingsTool.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('ambiguous_entity');
    expect(records(err.data.matches).map((m) => m.cik)).toEqual(['0000735286', '0000102909']);
    // Both CIKs surface in the message so the caller can disambiguate; never auto-picks.
    expect(err.message).toContain('0000735286');
    expect(err.message).toContain('0000102909');
    expect(mockApi.getSubmissions).not.toHaveBeenCalled();
  });

  it('returns ambiguous_entity when the ticker cache returns multiple matches (#73)', async () => {
    // The handler previously took resolved[0] silently — now the >1 branch fires.
    mockApi.resolveCik.mockResolvedValue([
      { cik: '0000111111', name: 'CAPITAL GROUP A', ticker: 'CGA' },
      { cik: '0000222222', name: 'CAPITAL GROUP B', ticker: 'CGB' },
    ]);
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ company: 'capital group' });

    const err = await caught(getInstitutionalHoldingsTool.handler(input, ctx));
    expect(err.data.reason).toBe('ambiguous_entity');
    expect(mockApi.resolveEntityByName).not.toHaveBeenCalled(); // cache already had hits
    expect(mockApi.getSubmissions).not.toHaveBeenCalled();
  });

  it('converts a bare-CIK 404 to company_not_found with the SEC URL stripped (#76)', async () => {
    // A numeric CIK absent from the ticker cache resolves to a bare { cik }; its
    // submissions feed 404s (a filer/transmitter CIK). Convert to a declared error.
    mockApi.resolveCik.mockResolvedValue({ cik: '0001193125' });
    mockApi.getSubmissions.mockRejectedValue(
      notFound(
        'SEC EDGAR API returned 404 for https://data.sec.gov/submissions/CIK0001193125.json',
        { url: 'https://data.sec.gov/submissions/CIK0001193125.json', status: 404 },
      ),
    );
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0001193125' });

    const err = await caught(getInstitutionalHoldingsTool.handler(input, ctx));
    expect(err.data.reason).toBe('company_not_found');
    expect(err.message).toMatch(/accession-number prefix/i);
    // No raw SEC URL leaked anywhere on the message or the structured data.
    expect(err.message).not.toContain('data.sec.gov');
    expect(err.message).not.toContain('https://');
    expect(JSON.stringify(err.data)).not.toContain('data.sec.gov');
  });

  it('propagates a 404 unchanged when the match came from the ticker cache (#76)', async () => {
    // Default resolveCik returns a name-bearing (cache-hit) match. A 404 here is an
    // EDGAR-side anomaly, not a bad query — propagate raw, never reclassify.
    mockApi.getSubmissions.mockRejectedValue(
      notFound(
        'SEC EDGAR API returned 404 for https://data.sec.gov/submissions/CIK0000102909.json',
        { url: 'https://data.sec.gov/submissions/CIK0000102909.json', status: 404 },
      ),
    );
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0000102909' });

    const err = await caught(getInstitutionalHoldingsTool.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data?.reason).toBeUndefined(); // not reclassified to a declared reason
    expect(err.message).toContain('data.sec.gov'); // raw error propagated unchanged
  });

  it('classifies an operating-company CIK on no-13F and routes to the right tools (#86)', async () => {
    mockApi.resolveCik.mockResolvedValue({
      cik: '0000789019',
      name: 'MICROSOFT CORP',
      ticker: 'MSFT',
    });
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        name: 'MICROSOFT CORP',
        tickers: ['MSFT'],
        filings: [
          {
            form: '10-K',
            accessionNumber: 'a',
            filingDate: '2024-07-30',
            reportDate: '2024-06-30',
          },
          {
            form: '10-Q',
            accessionNumber: 'b',
            filingDate: '2024-10-24',
            reportDate: '2024-09-30',
          },
          { form: '8-K', accessionNumber: 'c', filingDate: '2024-11-01' },
        ],
      }),
    );
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0000789019' });

    const err = await caught(getInstitutionalHoldingsTool.handler(input, ctx));
    expect(err.data.reason).toBe('no_filings_found');
    expect(err.message).toContain('MICROSOFT CORP');
    expect(err.message).toContain('operating company');
    expect(err.message).toContain('MSFT');
    expect(err.data.resolved_cik).toBe('0000789019');
    // An issuer passed here is nearly always a reverse-lookup attempt, so
    // secedgar_find_holders leads the routing (#81); the financial/filing tools
    // stay behind it for callers who wanted the company itself.
    expect(records(err.data.suggestions).map((s) => s.tool)).toEqual([
      'secedgar_find_holders',
      'secedgar_get_financials',
      'secedgar_search_filings',
    ]);
    // Recovery hint mirrors to the text surface and names the routed tool.
    expect(recoveryHint(err)).toContain('secedgar_find_holders');
  });

  it('does not classify a bare-CIK match that has submissions but no operating forms (#86)', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0001193125' });
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        name: 'SOME FILING AGENT',
        filings: [{ form: 'TA-1', accessionNumber: 'x', filingDate: '2024-01-01' }],
      }),
    );
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({ company: '0001193125' });

    const err = await caught(getInstitutionalHoldingsTool.handler(input, ctx));
    expect(err.data.reason).toBe('no_filings_found');
    expect(err.data.suggestions).toBeUndefined(); // no operating-company routing
    expect(err.message).toContain('SOME FILING AGENT');
  });
});

// --- Offset pagination fallback when no canvas is available (#94) ---

/** An information table of `n` distinct positions with strictly descending values. */
function infoTableWith(n: number): string {
  const rows = Array.from(
    { length: n },
    (_, i) => `  <infoTable>
    <nameOfIssuer>ISSUER ${String(i).padStart(3, '0')}</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>${String(100000000 + i)}</cusip>
    <value>${(n - i) * 1000}</value>
    <shrsOrPrnAmt>
      <sshPrnamt>${(n - i) * 10}</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
    <investmentDiscretion>SOLE</investmentDiscretion>
  </infoTable>`,
  ).join('\n');
  return `<?xml version="1.0" ?>
<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
${rows}
</informationTable>`;
}

/** Identity of one returned holding — CUSIP + market value, independent of page position. */
const holdingIds = (result: {
  holdings: Array<{ cusip?: string | undefined; market_value_usd?: number | undefined }>;
}) => result.holdings.map((h) => `${h.cusip}:${h.market_value_usd}`);

describe('getInstitutionalHoldingsTool offset pagination (#94)', () => {
  beforeEach(() => {
    mockApi.tryGetFilingDocument.mockImplementation(
      async (_cik: string, _accn: string, docName: string) => {
        if (docName === 'primary_doc.xml') return PRIMARY_DOC_XML;
        if (docName === 'infotable.xml') return infoTableWith(12);
        return null;
      },
    );
  });

  it('pages contiguously — two half pages reconstruct the double page exactly', async () => {
    const run = async (offset: number, limit: number) => {
      const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
      const input = getInstitutionalHoldingsTool.input.parse({
        company: '0000102909',
        limit,
        offset,
      });
      return await getInstitutionalHoldingsTool.handler(input, ctx);
    };

    const first = await run(0, 5);
    const second = await run(5, 5);
    const combined = await run(0, 10);

    expect([...holdingIds(first), ...holdingIds(second)]).toEqual(holdingIds(combined));
    expect(first.offset).toBe(0);
    expect(first.next_offset).toBe(5);
    expect(second.offset).toBe(5);
    expect(second.next_offset).toBe(10);
  });

  it('omits next_offset on the last page', async () => {
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      company: '0000102909',
      limit: 5,
      offset: 10,
    });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(result.holdings).toHaveLength(2);
    expect(result.next_offset).toBeUndefined();
  });

  it('explains an offset past the end instead of claiming an empty information table', async () => {
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      company: '0000102909',
      limit: 5,
      offset: 50,
    });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(result.holdings).toHaveLength(0);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('50');
    expect(notice).not.toContain('13F-NT');
  });

  it('renders both paging controls in format() so content[] matches structuredContent', async () => {
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      company: '0000102909',
      limit: 5,
      offset: 5,
    });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);
    const text = blockText(getInstitutionalHoldingsTool.format!(result));

    expect(text).toContain('Page offset: 5');
    expect(text).toContain('Next offset: 10');
  });

  it('leaves the dataframe holding every position regardless of the page window', async () => {
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);
    const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
    const input = getInstitutionalHoldingsTool.input.parse({
      company: '0000102909',
      limit: 5,
      offset: 5,
    });
    const result = await getInstitutionalHoldingsTool.handler(input, ctx);

    expect(bridge.registerDataframe.mock.calls[0]![1].rows).toHaveLength(12);
    expect(result.dataset?.row_count).toBe(12);
  });

  describe('staged-dataframe pointer (#104)', () => {
    it('carries the pointer in the truncation guidance when a page caps the positions', async () => {
      vi.mocked(getCanvasBridge).mockReturnValue(stubBridge() as never);
      const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
      const input = getInstitutionalHoldingsTool.input.parse({
        company: '0000102909',
        limit: 5,
      });
      await getInstitutionalHoldingsTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(true);
      const notice = String(enrichment.notice);
      expect(notice).toContain('df_TEST0_TEST1');
      expect(notice).toContain('secedgar_dataframe_describe');
      expect(notice).toContain('secedgar_dataframe_query');
      expect(notice.match(/secedgar_dataframe_describe/g)).toHaveLength(1);
    });

    it('names both dataframe tools when the whole filing fit on one page', async () => {
      vi.mocked(getCanvasBridge).mockReturnValue(stubBridge() as never);
      const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
      const input = getInstitutionalHoldingsTool.input.parse({
        company: '0000102909',
        limit: 500,
      });
      await getInstitutionalHoldingsTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBeUndefined();
      expect(String(enrichment.notice)).toContain('secedgar_dataframe_describe');
    });

    it('composes the pointer into the offset-past-the-end notice', async () => {
      vi.mocked(getCanvasBridge).mockReturnValue(stubBridge() as never);
      const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
      const input = getInstitutionalHoldingsTool.input.parse({
        company: '0000102909',
        offset: 999,
      });
      const result = await getInstitutionalHoldingsTool.handler(input, ctx);

      expect(result.holdings).toHaveLength(0);
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('Offset (999)');
      expect(notice).toContain('secedgar_dataframe_describe');
      expect(notice.match(/secedgar_dataframe_describe/g)).toHaveLength(1);
    });

    it('promises no pointer when the canvas is unavailable', async () => {
      vi.mocked(getCanvasBridge).mockReturnValue(undefined);
      const ctx = createMockContext({ errors: getInstitutionalHoldingsTool.errors });
      const input = getInstitutionalHoldingsTool.input.parse({
        company: '0000102909',
        limit: 5,
      });
      const result = await getInstitutionalHoldingsTool.handler(input, ctx);

      expect(result.dataset).toBeUndefined();
      expect(getEnrichment(ctx).truncated).toBe(true);
      expect(String(getEnrichment(ctx).notice ?? '')).not.toContain('secedgar_dataframe_describe');
    });
  });
});

// Through the real argument-parsing path, where `inputAliases` is applied (#115).
describe('getInstitutionalHoldingsTool parameter names (#115)', () => {
  const call = (args: Record<string, unknown>) =>
    runToolContract(getInstitutionalHoldingsTool, args as never);

  it.each([
    ['company', '0000102909'],
    ['cik', '0000102909'],
    ['ticker', '0000102909'],
    ['ticker_or_cik', '0000102909'],
  ])('accepts %s and hands its value to the handler as company', async (key, value) => {
    const result = await call({ [key]: value });

    expect(result.isError).toBeFalsy();
    expect(mockApi.resolveCik).toHaveBeenCalledWith(value, expect.any(CallScope));
    expect(result.structuredContent).toMatchObject({
      filer_cik: '0000102909',
      accession_number: '0000102909-24-000001',
    });
    expect(blockText(result.content)).toContain('13F-HR Holdings');
    expect(blockText(result.content)).toContain('CIK 0000102909');
  });

  it('still rejects an unrelated unknown key by name', async () => {
    const result = await call({ company: '0000102909', bogus: true });

    expect(result.isError).toBe(true);
    expect(blockText(result.content)).toContain('bogus');
    expect(mockApi.resolveCik).not.toHaveBeenCalled();
  });

  it('keeps issuer out of the alias set — it names the other direction', async () => {
    const result = await call({ issuer: 'AAPL' });

    expect(result.isError).toBe(true);
    expect(blockText(result.content)).toContain('issuer');
    expect(mockApi.resolveCik).not.toHaveBeenCalled();
  });
});

// --- Quarters older than the recent window (#117), 13F-NT notices (#133) ---

/** Vanguard-shaped recent window: begins 2025-08-27, holds two 13F-HRs and a 13F-NT. */
const VANGUARD_RECENT: FilingSpec[] = [
  {
    form: '13F-NT',
    accessionNumber: '0000102909-26-002714',
    filingDate: '2026-08-13',
    reportDate: '2026-06-30',
  },
  {
    form: '13F-HR',
    accessionNumber: '0000102909-26-000200',
    filingDate: '2026-01-29',
    reportDate: '2025-12-31',
  },
  {
    form: '13F-HR',
    accessionNumber: '0000102909-25-000900',
    filingDate: '2025-11-07',
    reportDate: '2025-09-30',
  },
  { form: 'SCHEDULE 13G/A', accessionNumber: '0000102909-25-000800', filingDate: '2025-08-27' },
];

const VANGUARD_FILES = [
  {
    name: 'CIK0000102909-submissions-001.json',
    filingCount: 3000,
    filingFrom: '2024-11-04',
    filingTo: '2025-08-25',
  },
  {
    name: 'CIK0000102909-submissions-002.json',
    filingCount: 3000,
    filingFrom: '2023-06-01',
    filingTo: '2024-11-01',
  },
];

const VANGUARD_PAGES: Record<string, FilingsRecent> = {
  'CIK0000102909-submissions-001.json': filingsBlock([
    { form: 'SCHEDULE 13G/A', accessionNumber: 'x-1', filingDate: '2025-08-25' },
    {
      form: '13F-HR',
      accessionNumber: '0001752724-25-100000',
      filingDate: '2025-05-12',
      reportDate: '2025-03-31',
    },
    {
      form: '13F-HR',
      accessionNumber: '0001752724-25-022205',
      filingDate: '2025-02-11',
      reportDate: '2024-12-31',
    },
  ]),
  'CIK0000102909-submissions-002.json': filingsBlock([
    {
      form: '13F-HR',
      accessionNumber: '0001752724-24-200000',
      filingDate: '2024-08-13',
      reportDate: '2024-06-30',
    },
    {
      form: '13F-NT',
      accessionNumber: '0000102909-24-000111',
      filingDate: '2024-05-14',
      reportDate: '2024-03-31',
    },
  ]),
};

describe('getInstitutionalHoldingsTool — quarters older than the recent window (#117)', () => {
  beforeEach(() => {
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({ filings: VANGUARD_RECENT, files: VANGUARD_FILES }),
    );
    mockApi.fetchArchivePage.mockImplementation(async (name: string) => {
      const page = VANGUARD_PAGES[name];
      if (!page) throw new Error(`unexpected archive page ${name}`);
      return page;
    });
  });

  const call = (args: Record<string, unknown>) =>
    runToolContract(getInstitutionalHoldingsTool, args as never);

  it('finds a quarter filed before the recent window on the page covering its end', async () => {
    const result = await call({ ticker_or_cik: '0000102909', quarter: '2024-Q4' });

    expect(result.isError).toBeFalsy();
    expect(mockApi.fetchArchivePage).toHaveBeenCalledTimes(1);
    expect(mockApi.fetchArchivePage).toHaveBeenCalledWith(
      'CIK0000102909-submissions-001.json',
      expect.any(CallScope),
    );
    expect(result.structuredContent).toMatchObject({
      accession_number: '0001752724-25-022205',
      filing_date: '2025-02-11',
    });
    expect(blockText(result.content)).toContain('Accession: 0001752724-25-022205');
    expect(mockApi.tryGetFilingIndex).toHaveBeenCalledWith(
      '0000102909',
      '0001752724-25-022205',
      expect.any(CallScope),
    );
  });

  it('reads no archive page for a quarter ending on or after the recent window’s oldest date', async () => {
    const result = await call({ company: '0000102909', quarter: '2025-Q3' });

    expect(result.isError).toBeFalsy();
    expect(mockApi.fetchArchivePage).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ accession_number: '0000102909-25-000900' });
  });

  it('reads no archive page and reports the miss for an in-window quarter with no filing', async () => {
    const err = await caught(
      getInstitutionalHoldingsTool.handler(
        getInstitutionalHoldingsTool.input.parse({ company: '0000102909', quarter: '2026-Q1' }),
        createMockContext({ errors: getInstitutionalHoldingsTool.errors }),
      ),
    );

    expect(err.data.reason).toBe('no_filings_found');
    expect(err.message).toContain('"2026-Q1"');
    expect(mockApi.fetchArchivePage).not.toHaveBeenCalled();
  });

  it('walks forward and reports the quarter after the pages read hold no match', async () => {
    const err = await caught(
      getInstitutionalHoldingsTool.handler(
        getInstitutionalHoldingsTool.input.parse({ company: '0000102909', quarter: '2023-Q4' }),
        createMockContext({ errors: getInstitutionalHoldingsTool.errors }),
      ),
    );

    // Forward from the page covering 2023-12-31: page 002, then page 001.
    expect(mockApi.fetchArchivePage.mock.calls.map(([name]) => name)).toEqual([
      'CIK0000102909-submissions-002.json',
      'CIK0000102909-submissions-001.json',
    ]);
    expect(err.data.reason).toBe('no_filings_found');
    expect(err.message).toContain('for quarter "2023-Q4"');
    expect(err.message).toContain('2 archive pages');
    expect(err.message).not.toContain('operating company');
  });

  it('takes the newest-filed 13F-HR for the period within the page that holds it', async () => {
    mockApi.fetchArchivePage.mockResolvedValue(
      filingsBlock([
        {
          form: '13F-HR',
          accessionNumber: '0001752724-25-099999',
          filingDate: '2025-03-01',
          reportDate: '2024-12-31',
        },
        {
          form: '13F-HR',
          accessionNumber: '0001752724-25-022205',
          filingDate: '2025-02-11',
          reportDate: '2024-12-31',
        },
      ]),
    );
    const result = await call({ company: '0000102909', quarter: '2024-Q4' });

    expect(result.structuredContent).toMatchObject({ accession_number: '0001752724-25-099999' });
  });

  it('stops at the shared archive page cap', async () => {
    const files = Array.from({ length: 14 }, (_, i) => ({
      name: `CIK0000102909-submissions-${String(i + 1).padStart(3, '0')}.json`,
      filingCount: 100,
      filingFrom: `${2024 - i}-01-01`,
      filingTo: `${2024 - i}-12-31`,
    }));
    mockApi.getSubmissions.mockResolvedValue(buildSubmissions({ filings: VANGUARD_RECENT, files }));
    mockApi.fetchArchivePage.mockResolvedValue(
      filingsBlock([
        {
          form: '13F-HR',
          accessionNumber: 'other-period',
          filingDate: '2000-02-01',
          reportDate: '1999-12-31',
        },
      ]),
    );

    const err = await caught(
      getInstitutionalHoldingsTool.handler(
        getInstitutionalHoldingsTool.input.parse({ company: '0000102909', quarter: '2009-Q4' }),
        createMockContext({ errors: getInstitutionalHoldingsTool.errors }),
      ),
    );

    // All 14 pages end after 2009-12-31; forward from the oldest (014), 10 are read.
    expect(mockApi.fetchArchivePage).toHaveBeenCalledTimes(10);
    expect(mockApi.fetchArchivePage).toHaveBeenNthCalledWith(
      1,
      'CIK0000102909-submissions-014.json',
      expect.any(CallScope),
    );
    expect(err.data.reason).toBe('no_filings_found');
    expect(err.message).toContain('10 archive pages');
    expect(err.message).toContain('page cap');
  });

  it('still routes an operating company to the right tools after the walk (#86)', async () => {
    mockApi.resolveCik.mockResolvedValue({
      cik: '0000789019',
      name: 'MICROSOFT CORP',
      ticker: 'MSFT',
    });
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        name: 'MICROSOFT CORP',
        tickers: ['MSFT'],
        filings: [
          {
            form: '10-K',
            accessionNumber: 'a',
            filingDate: '2026-07-30',
            reportDate: '2026-06-30',
          },
          { form: '8-K', accessionNumber: 'c', filingDate: '2020-08-07' },
        ],
        files: [
          {
            name: 'CIK0000789019-submissions-001.json',
            filingCount: 2002,
            filingFrom: '2008-08-13',
            filingTo: '2020-08-05',
          },
          {
            name: 'CIK0000789019-submissions-002.json',
            filingCount: 1521,
            filingFrom: '1994-02-14',
            filingTo: '2008-08-11',
          },
        ],
      }),
    );
    mockApi.fetchArchivePage.mockResolvedValue(
      filingsBlock([
        { form: '10-Q', accessionNumber: 'q', filingDate: '2020-04-29', reportDate: '2020-03-31' },
        { form: '10-Q', accessionNumber: 'r', filingDate: '2020-01-29', reportDate: '2019-12-31' },
      ]),
    );

    const err = await caught(
      getInstitutionalHoldingsTool.handler(
        getInstitutionalHoldingsTool.input.parse({ company: '789019', quarter: '2019-Q4' }),
        createMockContext({ errors: getInstitutionalHoldingsTool.errors }),
      ),
    );

    expect(mockApi.fetchArchivePage).toHaveBeenCalledTimes(1);
    expect(mockApi.fetchArchivePage).toHaveBeenCalledWith(
      'CIK0000789019-submissions-001.json',
      expect.any(CallScope),
    );
    expect(err.data.reason).toBe('no_filings_found');
    expect(err.message).toContain('operating company');
    expect(records(err.data.suggestions).map((s) => s.tool)).toContain('secedgar_find_holders');
  });

  it('walks nothing for a call without a quarter', async () => {
    const result = await call({ company: '0000102909' });

    expect(mockApi.fetchArchivePage).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ accession_number: '0000102909-26-000200' });
  });
});

describe('getInstitutionalHoldingsTool — 13F-NT notice for the quarter (#133)', () => {
  beforeEach(() => {
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({ filings: VANGUARD_RECENT, files: VANGUARD_FILES }),
    );
    mockApi.fetchArchivePage.mockImplementation(async (name: string) => {
      const page = VANGUARD_PAGES[name];
      if (!page) throw new Error(`unexpected archive page ${name}`);
      return page;
    });
  });

  it('says the manager filed a notice for the quarter, naming its accession', async () => {
    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0000102909',
      quarter: '2026-Q2',
    } as never);

    expect(result.isError).toBe(true);
    const text = blockText(result.content);
    expect(text).toContain('13F-NT');
    expect(text).toContain('0000102909-26-002714');
    expect(text).toContain('reported by other managers');
    expect(text).not.toContain('check that the entity is an institutional investment manager');
    expect(text).toContain('secedgar_get_filing');
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'no_filings_found',
          notice_accession_number: '0000102909-26-002714',
          notice_form: '13F-NT',
        },
      },
    });
    expect(mockApi.fetchArchivePage).not.toHaveBeenCalled();
  });

  it('finds a notice on an archive page and stops the walk there', async () => {
    const err = await caught(
      getInstitutionalHoldingsTool.handler(
        getInstitutionalHoldingsTool.input.parse({ company: '0000102909', quarter: '2024-Q1' }),
        createMockContext({ errors: getInstitutionalHoldingsTool.errors }),
      ),
    );

    expect(mockApi.fetchArchivePage).toHaveBeenCalledTimes(1);
    expect(mockApi.fetchArchivePage).toHaveBeenCalledWith(
      'CIK0000102909-submissions-002.json',
      expect.any(CallScope),
    );
    expect(err.data.notice_accession_number).toBe('0000102909-24-000111');
    expect(recoveryHint(err)).toContain('0000102909-24-000111');
  });

  it('recognizes an amended notice (13F-NT/A)', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        filings: [
          {
            form: '13F-NT/A',
            accessionNumber: '0000102909-26-003000',
            filingDate: '2026-09-01',
            reportDate: '2026-06-30',
          },
          ...VANGUARD_RECENT.slice(1),
        ],
      }),
    );
    const err = await caught(
      getInstitutionalHoldingsTool.handler(
        getInstitutionalHoldingsTool.input.parse({ company: '0000102909', quarter: '2026-Q2' }),
        createMockContext({ errors: getInstitutionalHoldingsTool.errors }),
      ),
    );

    expect(err.data.notice_form).toBe('13F-NT/A');
    expect(err.message).toContain('0000102909-26-003000');
  });

  it('prefers a 13F-HR over a notice for the same period', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        filings: [
          ...VANGUARD_RECENT,
          {
            form: '13F-HR',
            accessionNumber: '0000102909-26-002000',
            filingDate: '2026-08-01',
            reportDate: '2026-06-30',
          },
        ],
      }),
    );
    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0000102909',
      quarter: '2026-Q2',
    } as never);

    expect(result.structuredContent).toMatchObject({ accession_number: '0000102909-26-002000' });
  });

  it('names the newest notice for a notice-only manager called without a quarter', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        name: 'NOTICE ONLY ADVISORS LLC',
        filings: [
          {
            form: '13F-NT',
            accessionNumber: '0000900000-26-000020',
            filingDate: '2026-08-10',
            reportDate: '2026-06-30',
          },
          {
            form: '13F-NT',
            accessionNumber: '0000900000-26-000010',
            filingDate: '2026-05-11',
            reportDate: '2026-03-31',
          },
          { form: 'SCHEDULE 13G', accessionNumber: 'x', filingDate: '2026-02-01' },
        ],
      }),
    );
    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0000900000',
    } as never);

    expect(result.isError).toBe(true);
    const text = blockText(result.content);
    expect(text).toContain('13F-NT notice');
    expect(text).toContain('0000900000-26-000020');
    expect(text).toContain('2026-06-30');
    expect(text).toContain('reported by other managers');
    expect(text).not.toContain('not a 13F institutional filer');
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'no_filings_found',
          notice_accession_number: '0000900000-26-000020',
          notice_form: '13F-NT',
          notice_period: '2026-06-30',
        },
      },
    });
    expect(mockApi.fetchArchivePage).not.toHaveBeenCalled();
  });

  it('gives a notice-only manager the quarter miss, not the not-a-13F-filer classification', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        name: 'NOTICE ONLY ADVISORS LLC',
        filings: [
          {
            form: '13F-NT',
            accessionNumber: '0000900000-26-000020',
            filingDate: '2026-08-10',
            reportDate: '2026-06-30',
          },
          { form: 'SCHEDULE 13G', accessionNumber: 'x', filingDate: '2026-02-01' },
        ],
      }),
    );
    const err = await caught(
      getInstitutionalHoldingsTool.handler(
        getInstitutionalHoldingsTool.input.parse({ company: '0000900000', quarter: '2025-Q4' }),
        createMockContext({ errors: getInstitutionalHoldingsTool.errors }),
      ),
    );

    expect(err.data.reason).toBe('no_filings_found');
    expect(err.message).toContain('for quarter "2025-Q4"');
    expect(err.message).not.toContain('not a 13F institutional filer');
    expect(err.data.notice_accession_number).toBeUndefined();
  });

  it('keeps the #86 routing for an entity with neither a 13F-HR nor a 13F-NT, called without a quarter', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      buildSubmissions({
        name: 'MICROSOFT CORP',
        tickers: ['MSFT'],
        filings: [{ form: '10-K', accessionNumber: 'a', filingDate: '2026-07-30' }],
      }),
    );
    const err = await caught(
      getInstitutionalHoldingsTool.handler(
        getInstitutionalHoldingsTool.input.parse({ company: '789019' }),
        createMockContext({ errors: getInstitutionalHoldingsTool.errors }),
      ),
    );

    expect(err.message).toContain('operating company');
    expect(err.data.notice_accession_number).toBeUndefined();
  });
});

describe('getInstitutionalHoldingsTool — filer_name entity decoding (#132)', () => {
  const primaryDoc = (name: string, prefix = '') => `<?xml version="1.0"?>
<${prefix}edgarSubmission>
  <${prefix}headerData><${prefix}filerInfo><${prefix}periodOfReport>12-31-2025</${prefix}periodOfReport></${prefix}filerInfo></${prefix}headerData>
  <${prefix}formData><${prefix}coverPage>
    <${prefix}reportCalendarOrQuarter>12-31-2025</${prefix}reportCalendarOrQuarter>
    <${prefix}filingManager><${prefix}name>${name}</${prefix}name><${prefix}address><${prefix}city>NEW YORK</${prefix}city></${prefix}address></${prefix}filingManager>
  </${prefix}coverPage>
  <${prefix}signatureBlock><${prefix}name>Jane Signer</${prefix}name></${prefix}signatureBlock></${prefix}formData>
</${prefix}edgarSubmission>`;

  function servePrimaryDoc(xml: string) {
    mockApi.tryGetFilingDocument.mockImplementation(
      async (_cik: string, _accn: string, docName: string) => {
        if (docName === 'primary_doc.xml') return xml;
        if (docName === 'infotable.xml') return INFO_TABLE_XML;
        return null;
      },
    );
  }

  it('decodes &amp; in structuredContent, content, and the dataframe', async () => {
    servePrimaryDoc(primaryDoc('JPMORGAN CHASE &amp; CO'));
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);

    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0000102909',
    } as never);

    expect(result.structuredContent).toMatchObject({
      filer_name: 'JPMORGAN CHASE & CO',
      reporting_period: '2025-12-31',
    });
    expect(blockText(result.content)).toContain('**13F-HR Holdings** — JPMORGAN CHASE & CO');
    expect(blockText(result.content)).not.toContain('&amp;');
    const rows = bridge.registerDataframe.mock.calls[0]?.[1].rows ?? [];
    expect(rows[0]?.filer_name).toBe('JPMORGAN CHASE & CO');
  });

  it('decodes the predefined entities and numeric references, leaving unknown ones untouched', async () => {
    servePrimaryDoc(
      primaryDoc('A &lt;B&gt; &quot;C&quot; &apos;D&apos; &#38; &#x26; &foo; &constructor;'),
    );
    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0000102909',
    } as never);

    expect(result.structuredContent).toMatchObject({
      filer_name: `A <B> "C" 'D' & & &foo; &constructor;`,
    });
  });

  it('reads a namespace-prefixed cover page the same way', async () => {
    servePrimaryDoc(primaryDoc('SMITH &amp; WESSON ADVISORS', 'ns1:'));
    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0000102909',
    } as never);

    expect(result.structuredContent).toMatchObject({
      filer_name: 'SMITH & WESSON ADVISORS',
      reporting_period: '2025-12-31',
    });
  });
});

// ---------------------------------------------------------------------------
// same-period amendment composition (#198)
// ---------------------------------------------------------------------------

describe('getInstitutionalHoldingsTool — amendment composition (#198)', () => {
  const fixture = (name: string) =>
    readFileSync(new URL(`../../../fixtures/13f/${name}`, import.meta.url), 'utf8');

  /** A cover page carrying an amendment type (or none, for an original). */
  const cover = (type?: string, period = '12-31-2024') =>
    `<edgarSubmission><formData><coverPage><reportCalendarOrQuarter>${period}</reportCalendarOrQuarter>${type ? `<isAmendment>true</isAmendment><amendmentInfo><amendmentType>${type}</amendmentType></amendmentInfo>` : ''}<filingManager><name>Manager LLC</name></filingManager></coverPage></formData></edgarSubmission>`;

  interface Row {
    cusip: string;
    discretion?: string;
    name?: string;
    putCall?: string;
    shares: number;
    shareType?: string;
    title?: string;
    value: number;
  }
  const table = (rows: Row[]) =>
    `<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">${rows
      .map(
        (r) =>
          `<infoTable><nameOfIssuer>${r.name ?? `ISSUER ${r.cusip}`}</nameOfIssuer><titleOfClass>${r.title ?? 'COM'}</titleOfClass><cusip>${r.cusip}</cusip><value>${r.value}</value><shrsOrPrnAmt><sshPrnamt>${r.shares}</sshPrnamt><sshPrnamtType>${r.shareType ?? 'SH'}</sshPrnamtType></shrsOrPrnAmt>${r.putCall ? `<putCall>${r.putCall}</putCall>` : ''}<investmentDiscretion>${r.discretion ?? 'SOLE'}</investmentDiscretion></infoTable>`,
      )
      .join('')}</informationTable>`;

  interface Served {
    cover: string | null;
    index?: FilingIndex | null;
    table?: string | null;
  }

  /** Route every read by accession; a read of an unlisted accession fails the test. */
  function serve(filings: Record<string, Served>) {
    mockApi.tryGetFilingIndex.mockImplementation(async (_cik: string, accession: string) => {
      const f = filings[accession];
      if (!f) throw new Error(`unexpected index read: ${accession}`);
      return f.index === undefined ? mockFilingIndex : f.index;
    });
    mockApi.tryGetFilingDocument.mockImplementation(
      async (_cik: string, accession: string, doc: string) => {
        const f = filings[accession];
        if (!f) throw new Error(`unexpected document read: ${accession}/${doc}`);
        if (doc === 'primary_doc.xml') return f.cover;
        if (doc === 'infotable.xml') return f.table ?? null;
        return null;
      },
    );
  }

  /** Accessions whose information table was requested, in request order. */
  const tableReads = () =>
    mockApi.tryGetFilingDocument.mock.calls
      .filter((c) => c[2] !== 'primary_doc.xml')
      .map((c) => c[1]);

  const submissionsOf = (filings: FilingSpec[]) =>
    mockApi.getSubmissions.mockResolvedValue(buildSubmissions({ filings }));
  /** An original 13F-HR or a 13F-HR/A row for the 2024-Q4 period unless another is given. */
  const hr = (accessionNumber: string, filingDate: string, reportDate = '2024-12-31') => ({
    form: '13F-HR',
    accessionNumber,
    filingDate,
    reportDate,
  });
  const hra = (accessionNumber: string, filingDate: string, reportDate = '2024-12-31') => ({
    ...hr(accessionNumber, filingDate, reportDate),
    form: '13F-HR/A',
  });

  const contentOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    readCommonMark(result.content.map((_, i) => blockText(result.content, i)).join('\n'));

  type Holding = { cusip?: string; source_accession_numbers?: string[] } & Record<string, unknown>;
  const holdingsOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { holdings: Holding[] }).holdings;

  const BRK_ORIGINAL = '0000950123-25-005701';
  const BRK_NEW = '0000950123-25-008361';

  function serveBerkshire() {
    submissionsOf([
      {
        form: '13F-HR/A',
        accessionNumber: BRK_NEW,
        filingDate: '2025-08-14',
        reportDate: '2025-03-31',
        acceptanceDateTime: '2025-08-14T20:10:02.000Z',
      },
      {
        form: '13F-HR',
        accessionNumber: BRK_ORIGINAL,
        filingDate: '2025-05-15',
        reportDate: '2025-03-31',
        acceptanceDateTime: '2025-05-15T20:06:43.000Z',
      },
    ]);
    serve({
      [BRK_ORIGINAL]: {
        cover: fixture('berkshire-2025q1-original-primary_doc.xml'),
        table: fixture('berkshire-2025q1-original-infotable.xml'),
      },
      [BRK_NEW]: {
        cover: fixture('berkshire-2025q1-new-holdings-primary_doc.xml'),
        table: fixture('berkshire-2025q1-new-holdings-infotable.xml'),
      },
    });
  }

  it('appends a NEW HOLDINGS amendment and consolidates across filings (Berkshire 2025-Q1)', async () => {
    serveBerkshire();
    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0001067983',
      quarter: '2025-Q1',
      limit: 500,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      accession_number: BRK_ORIGINAL,
      filing_date: '2025-05-15',
      total_holdings_in_filing: 110,
      total_holdings_composed: 114,
      total_positions: 39,
      composed_accessions: [BRK_ORIGINAL, BRK_NEW],
      amendments: [
        { accession_number: BRK_NEW, amendment_type: 'NEW HOLDINGS', applied_as: 'new_holdings' },
      ],
    });
    const holdings = holdingsOf(result);
    expect(holdings).toHaveLength(39);
    expect(holdings.find((h) => h.cusip === '670346105')).toMatchObject({
      market_value_usd: 692_738_413,
      source_accession_numbers: [BRK_NEW],
    });
    expect(holdings.find((h) => h.cusip === '526057302')).toMatchObject({
      shares_or_principal_amount: 152_774,
      market_value_usd: 16_663_060,
      source_accession_numbers: [BRK_ORIGINAL, BRK_NEW],
    });
    expect(holdings.find((h) => h.cusip === 'H1467J104')).toMatchObject({
      source_accession_numbers: [BRK_ORIGINAL],
    });
    // content[] carries the composed counts, each amendment's role, and each row's sources.
    const text = contentOf(result);
    expect(text).toContain('Showing 39 of 39 positions (consolidated from 114 info-table rows)');
    expect(text).toContain(
      `Composed from: ${BRK_ORIGINAL}, ${BRK_NEW} (114 rows; original 13F-HR: 110)`,
    );
    expect(text).toContain(
      `Amendment: ${BRK_NEW}, filed 2025-08-14, NEW HOLDINGS — applied as new_holdings.`,
    );
    expect(text).toContain(`source: ${BRK_ORIGINAL}, ${BRK_NEW}`);
  });

  it('returns the original rows in filing order, then the amendment rows, with consolidate=false', async () => {
    serveBerkshire();
    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0001067983',
      quarter: '2025-Q1',
      limit: 500,
      consolidate: false,
    });
    const holdings = holdingsOf(result);
    expect(holdings).toHaveLength(114);
    expect(holdings[0]?.cusip).toBe('02005N100');
    expect(holdings[109]?.cusip).toBe('H1467J104');
    // Raw rows are never merged, so each names exactly the one accession it came from.
    expect(holdings.slice(0, 110).map((h) => h.source_accession_numbers)).toEqual(
      Array.from({ length: 110 }, () => [BRK_ORIGINAL]),
    );
    expect(holdings.slice(110).map((h) => [h.cusip, h.source_accession_numbers])).toEqual([
      ['23331A109', [BRK_NEW]],
      ['526057104', [BRK_NEW]],
      ['526057302', [BRK_NEW]],
      ['670346105', [BRK_NEW]],
    ]);
  });

  it('pages and stages the composed set, keeping the original on the accession column', async () => {
    serveBerkshire();
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);
    const page = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0001067983',
      quarter: '2025-Q1',
      consolidate: false,
      limit: 3,
      offset: 111,
    });
    expect(page.structuredContent).toMatchObject({ offset: 111, next_offset: undefined });
    expect(holdingsOf(page).map((h) => h.cusip)).toEqual(['526057104', '526057302', '670346105']);
    const rows = bridge.registerDataframe.mock.calls[0]?.[1].rows ?? [];
    expect(rows).toHaveLength(114);
    expect(rows[113]).toMatchObject({
      accession_number: BRK_ORIGINAL,
      cusip: '670346105',
      source_accession_numbers: [BRK_NEW],
    });
    expect(page.structuredContent).toMatchObject({ dataset: { row_count: 114 } });
  });

  const A: Row = { cusip: 'AAAAAAAA1', shares: 100, value: 1000, discretion: 'SOLE' };
  const B: Row = { cusip: 'BBBBBBBB2', shares: 200, value: 2000, discretion: 'DFND' };
  const C: Row = { cusip: 'CCCCCCCC3', shares: 300, value: 3000 };

  it('applies a NEW HOLDINGS amendment that repeats every composed row as a restatement (First Eagle shape)', async () => {
    submissionsOf([hra('fe-amend', '2026-09-01'), hr('fe-orig', '2026-08-14')]);
    serve({
      'fe-orig': { cover: cover(), table: table([A, B]) },
      // Every original row again (value is not part of the match), plus one new row.
      'fe-amend': { cover: cover('NEW HOLDINGS'), table: table([{ ...A, value: 1100 }, B, C]) },
    });
    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0000102909',
      consolidate: false,
    });
    expect(result.structuredContent).toMatchObject({
      total_holdings_in_filing: 2,
      total_holdings_composed: 3,
      composed_accessions: ['fe-amend'],
      amendments: [{ accession_number: 'fe-amend', applied_as: 'restatement' }],
    });
    expect(
      holdingsOf(result).map((h) => [h.cusip, h.market_value_usd, h.source_accession_numbers]),
    ).toEqual([
      ['AAAAAAAA1', 1100, ['fe-amend']],
      ['BBBBBBBB2', 2000, ['fe-amend']],
      ['CCCCCCCC3', 3000, ['fe-amend']],
    ]);
  });

  it('appends a NEW HOLDINGS table that repeats a composed row fewer times than it appears', async () => {
    submissionsOf([hra('nh', '2026-09-01'), hr('orig', '2026-08-14')]);
    serve({
      orig: { cover: cover(), table: table([A, A]) },
      nh: { cover: cover('NEW HOLDINGS'), table: table([A, C]) },
    });
    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0000102909',
      consolidate: false,
    });
    expect(result.structuredContent).toMatchObject({
      total_holdings_composed: 4,
      composed_accessions: ['orig', 'nh'],
      amendments: [{ applied_as: 'new_holdings' }],
    });
  });

  // A row matches only on every identity field; one that differs in any of them is a
  // new row, so the amendment appends instead of restating.
  it.each<[string, Row]>([
    ['CUSIP', { ...A, cusip: 'AAAAAAAA9' }],
    ['title of class', { ...A, title: 'CL B' }],
    ['put/call', { ...A, putCall: 'Put' }],
    ['investment discretion', { ...A, discretion: 'OTR' }],
    ['share amount', { ...A, shares: 101 }],
    ['share type', { ...A, shareType: 'PRN' }],
  ])(
    'appends a NEW HOLDINGS table whose copy of a composed row differs in %s',
    async (_field, changed) => {
      submissionsOf([hra('nh', '2026-09-01'), hr('orig', '2026-08-14')]);
      serve({
        orig: { cover: cover(), table: table([A, B]) },
        nh: { cover: cover('NEW HOLDINGS'), table: table([changed, B, C]) },
      });
      const result = await runToolContract(getInstitutionalHoldingsTool, {
        company: '0000102909',
        consolidate: false,
      });
      expect(result.structuredContent).toMatchObject({
        total_holdings_composed: 5,
        composed_accessions: ['orig', 'nh'],
        amendments: [{ accession_number: 'nh', applied_as: 'new_holdings' }],
      });
    },
  );

  it('keeps only the last restatement and reads no superseded table (Corient shape)', async () => {
    submissionsOf([hra('r2', '2026-09-20'), hra('r1', '2026-09-10'), hr('orig', '2026-08-14')]);
    serve({
      orig: { cover: cover(), table: table([A, B]) },
      r1: { cover: cover('RESTATEMENT'), table: table([A]) },
      r2: { cover: cover('RESTATEMENT'), table: table([B, C]) },
    });
    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0000102909',
      consolidate: false,
    });
    expect(result.structuredContent).toMatchObject({
      accession_number: 'orig',
      total_holdings_in_filing: 2,
      total_holdings_composed: 2,
      composed_accessions: ['r2'],
      amendments: [
        { accession_number: 'r2', applied_as: 'restatement' },
        { accession_number: 'r1', applied_as: 'superseded' },
      ],
    });
    expect(holdingsOf(result).map((h) => h.cusip)).toEqual(['BBBBBBBB2', 'CCCCCCCC3']);
    expect(tableReads()).toEqual(['orig', 'r2']);
    expect(mockApi.tryGetFilingIndex.mock.calls.map((c) => c[1])).toEqual(['orig', 'r2']);
  });

  it('applies a restatement, then a later NEW HOLDINGS, superseding the original (Berkshire 2023-Q3 shape)', async () => {
    submissionsOf([
      hra('nh', '2027-05-15'),
      hra('restate', '2026-09-01'),
      hr('orig', '2026-08-14'),
    ]);
    serve({
      orig: { cover: cover(), table: table([A]) },
      restate: { cover: cover('RESTATEMENT'), table: table([B]) },
      nh: { cover: cover('NEW HOLDINGS'), table: table([C]) },
    });
    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0000102909',
      consolidate: false,
    });
    expect(result.structuredContent).toMatchObject({
      composed_accessions: ['restate', 'nh'],
      amendments: [
        { accession_number: 'nh', applied_as: 'new_holdings' },
        { accession_number: 'restate', applied_as: 'restatement' },
      ],
    });
    expect(holdingsOf(result).map((h) => [h.cusip, h.source_accession_numbers])).toEqual([
      ['BBBBBBBB2', ['restate']],
      ['CCCCCCCC3', ['nh']],
    ]);
  });

  it('orders same-day amendments by acceptance time, not accession or listing order (AAM 2020-Q2 shape)', async () => {
    submissionsOf([
      {
        form: '13F-HR/A',
        accessionNumber: '0001999371-26-018935',
        filingDate: '2026-08-27',
        reportDate: '2024-12-31',
        acceptanceDateTime: '2026-08-27T17:49:03.000Z',
      },
      {
        form: '13F-HR/A',
        accessionNumber: '0001999371-26-018936',
        filingDate: '2026-08-27',
        reportDate: '2024-12-31',
        acceptanceDateTime: '2026-08-27T17:48:03.000Z',
      },
      {
        form: '13F-HR',
        accessionNumber: 'orig',
        filingDate: '2020-08-14',
        reportDate: '2024-12-31',
        acceptanceDateTime: '2020-08-14T16:00:00.000Z',
      },
    ]);
    serve({
      orig: { cover: cover(), table: table([A]) },
      '0001999371-26-018936': { cover: cover('RESTATEMENT'), table: table([B]) },
      '0001999371-26-018935': { cover: cover('NEW HOLDINGS'), table: table([C]) },
    });
    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0000102909',
      consolidate: false,
    });
    expect(result.structuredContent).toMatchObject({
      composed_accessions: ['0001999371-26-018936', '0001999371-26-018935'],
    });
    // The 2026 restatement reports whole dollars; only the 2020 original was in thousands.
    expect(holdingsOf(result).map((h) => [h.cusip, h.market_value_usd])).toEqual([
      ['BBBBBBBB2', 2000],
      ['CCCCCCCC3', 3000],
    ]);
  });

  it('normalizes each accession by its own filing date (Whitebox 2022-Q3 shape)', async () => {
    submissionsOf([
      hra('nh-2026', '2026-05-01', '2022-09-30'),
      hr('orig-2022', '2022-11-14', '2022-09-30'),
    ]);
    serve({
      'orig-2022': { cover: cover(undefined, '09-30-2022'), table: table([A]) },
      'nh-2026': {
        cover: cover('NEW HOLDINGS', '09-30-2022'),
        table: table([{ ...C, value: 3105 }]),
      },
    });
    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0000102909',
      consolidate: false,
    });
    expect(holdingsOf(result).map((h) => [h.cusip, h.market_value_usd])).toEqual([
      ['AAAAAAAA1', 1_000_000],
      ['CCCCCCCC3', 3105],
    ]);
  });

  it('supersedes an amendment accepted before the original it would amend, reading no table for it', async () => {
    submissionsOf([hr('late-orig', '2026-09-01'), hra('early-nh', '2026-08-01')]);
    serve({
      'late-orig': { cover: cover(), table: table([A]) },
      'early-nh': { cover: cover('NEW HOLDINGS'), table: table([C]) },
    });
    const result = await runToolContract(getInstitutionalHoldingsTool, { company: '0000102909' });
    expect(result.structuredContent).toMatchObject({
      composed_accessions: ['late-orig'],
      amendments: [{ accession_number: 'early-nh', applied_as: 'superseded' }],
    });
    expect(tableReads()).toEqual(['late-orig']);
  });

  it.each<[string, Served]>([
    ['its index is unavailable', { cover: cover('NEW HOLDINGS'), index: null }],
    [
      'its index lists no information table',
      {
        cover: cover('NEW HOLDINGS'),
        index: {
          directory: {
            name: 'x',
            item: [{ name: 'primary_doc.xml', type: '', size: '1', 'last-modified': '' }],
          },
        },
      },
    ],
    ['its table is unavailable', { cover: cover('NEW HOLDINGS'), table: null }],
    ['its table holds no rows', { cover: cover('NEW HOLDINGS'), table: table([]) }],
  ])(
    'does not apply a NEW HOLDINGS amendment when %s, and names it in the notice',
    async (_label, served) => {
      submissionsOf([hra('bad', '2026-09-01'), hr('orig', '2026-08-14')]);
      serve({ orig: { cover: cover(), table: table([A]) }, bad: served });
      const result = await runToolContract(getInstitutionalHoldingsTool, { company: '0000102909' });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        composed_accessions: ['orig'],
        total_holdings_composed: 1,
        amendments: [
          { accession_number: 'bad', amendment_type: 'NEW HOLDINGS', applied_as: 'not_applied' },
        ],
      });
      const text = contentOf(result);
      expect(text).toContain(
        'Not applied, since the type or information table could not be read: bad',
      );
    },
  );

  it('falls back to the earlier base when the last restatement table cannot be read', async () => {
    submissionsOf([
      hra('nh', '2026-09-20'),
      hra('r-bad', '2026-09-10'),
      hra('r-good', '2026-09-01'),
      hr('orig', '2026-08-14'),
    ]);
    serve({
      orig: { cover: cover(), table: table([A]) },
      'r-good': { cover: cover('RESTATEMENT'), table: table([B]) },
      'r-bad': { cover: cover('RESTATEMENT'), table: null },
      nh: { cover: cover('NEW HOLDINGS'), table: table([C]) },
    });
    const result = await runToolContract(getInstitutionalHoldingsTool, {
      company: '0000102909',
      consolidate: false,
    });
    expect(result.structuredContent).toMatchObject({
      composed_accessions: ['r-good', 'nh'],
      amendments: [
        { accession_number: 'nh', applied_as: 'new_holdings' },
        { accession_number: 'r-bad', applied_as: 'not_applied' },
        { accession_number: 'r-good', applied_as: 'restatement' },
      ],
    });
    expect(holdingsOf(result).map((h) => h.cusip)).toEqual(['BBBBBBBB2', 'CCCCCCCC3']);
  });

  it('does not apply an amendment whose type is unavailable, and reads no table for it', async () => {
    submissionsOf([hra('untyped', '2026-09-01'), hr('orig', '2026-08-14')]);
    serve({
      orig: { cover: cover(), table: table([A]) },
      untyped: { cover: cover(), table: table([C]) },
    });
    const result = await runToolContract(getInstitutionalHoldingsTool, { company: '0000102909' });
    expect(result.structuredContent).toMatchObject({
      composed_accessions: ['orig'],
      amendments: [
        {
          amendment_type: 'UNAVAILABLE',
          unavailable_reason: 'unreadable_header',
          applied_as: 'not_applied',
        },
      ],
    });
    expect(tableReads()).toEqual(['orig']);
  });

  it('adds only the additive fields to a quarter with no amendment', async () => {
    const result = await runToolContract(getInstitutionalHoldingsTool, { company: '0000102909' });
    expect(result.structuredContent).toMatchObject({
      accession_number: '0000102909-24-000001',
      total_holdings_in_filing: 2,
      total_holdings_composed: 2,
      total_positions: 2,
      composed_accessions: ['0000102909-24-000001'],
      holdings: [
        {
          cusip: '037833100',
          market_value_usd: 5000000,
          source_accession_numbers: ['0000102909-24-000001'],
        },
        {
          cusip: '594918104',
          market_value_usd: 3000000,
          source_accession_numbers: ['0000102909-24-000001'],
        },
      ],
    });
    expect((result.structuredContent as { amendments?: unknown }).amendments).toBeUndefined();
    expect(mockApi.tryGetFilingIndex).toHaveBeenCalledTimes(1);
    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledTimes(2);
  });

  it('shares one CallScope across every cover, index, and table read', async () => {
    serveBerkshire();
    await runToolContract(getInstitutionalHoldingsTool, {
      company: '0001067983',
      quarter: '2025-Q1',
    });
    const scopes = [
      ...mockApi.tryGetFilingIndex.mock.calls.map((c) => c[2]),
      ...mockApi.tryGetFilingDocument.mock.calls.map((c) => c[3]),
    ];
    expect(scopes).toHaveLength(6);
    expect(new Set(scopes).size).toBe(1);
    expect(scopes[0]).toBeInstanceOf(CallScope);
  });
});

// A limit above the 500-row page is served at 500 while EDGAR_CLAMP_OVERSIZED_LIMITS is
// on; the mechanism itself is tabled in tests/mcp-server/tools/limit-clamp.test.ts (#197).
describe('getInstitutionalHoldingsTool — limit above the 500 cap (#197)', () => {
  beforeEach(() => {
    mockApi.tryGetFilingDocument.mockImplementation(
      async (_cik: string, _accn: string, docName: string) => {
        if (docName === 'primary_doc.xml') return PRIMARY_DOC_XML;
        if (docName === 'infotable.xml') return infoTableWith(600);
        return null;
      },
    );
  });

  const args = { company: '0000102909' };

  it('answers limit 501 exactly as limit 500, cap and next_offset included', async () => {
    const at500 = await runToolContract(getInstitutionalHoldingsTool, { ...args, limit: 500 });
    const at501 = await runToolContract(getInstitutionalHoldingsTool, { ...args, limit: 501 });

    expect(at501).toEqual(at500);
    expect(at501.structuredContent).toMatchObject({ next_offset: 500, cap: 500, shown: 500 });
    expect(readCommonMark(blockText(at501.content))).toContain('Next offset: 500');
  });

  it('answers limit 501 exactly as limit 500 when the positions are staged as a dataframe', async () => {
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);

    const at500 = await runToolContract(getInstitutionalHoldingsTool, { ...args, limit: 500 });
    const at501 = await runToolContract(getInstitutionalHoldingsTool, { ...args, limit: 501 });

    expect(bridge.registerDataframe).toHaveBeenCalledTimes(2);
    expect(bridge.registerDataframe.mock.calls[1]?.[1]).toEqual(
      bridge.registerDataframe.mock.calls[0]?.[1],
    );
    expect(at501).toEqual(at500);
  });

  it('accepts up to 1000 with the switch on; off, advertises 500 and rejects 501', async () => {
    const maximum = (clampOversizedLimits: boolean) => {
      const { input } = createGetInstitutionalHoldingsTool({ clampOversizedLimits });
      const limit = z.toJSONSchema(input, { io: 'input' }).properties?.limit;
      return typeof limit === 'object' ? limit.maximum : undefined;
    };
    expect(maximum(true)).toBe(1000);
    expect(maximum(false)).toBe(500);
    expect(getInstitutionalHoldingsTool.input.safeParse({ ...args, limit: 1000 }).success).toBe(
      true,
    );

    const off = createGetInstitutionalHoldingsTool({ clampOversizedLimits: false });
    const rejected = await runToolContract(off, { ...args, limit: 501 });
    expect(rejected.isError).toBe(true);
    expect(wireError(rejected).code).toBe(JsonRpcErrorCode.InvalidParams);
  });
});
