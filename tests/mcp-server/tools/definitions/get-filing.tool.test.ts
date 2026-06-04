/**
 * @fileoverview Tests for get-filing tool — filing retrieval by accession number.
 * @module tests/mcp-server/tools/definitions/get-filing.tool
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFilingTool } from '@/mcp-server/tools/definitions/get-filing.tool.js';
import type { FilingIndex, SubmissionsResponse } from '@/services/edgar/types.js';

vi.mock('@/services/edgar/edgar-api-service.js', () => ({
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
}));

vi.mock('@/services/edgar/filing-to-text.js', () => ({
  filingToText: vi.fn(),
}));

import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { filingToText } from '@/services/edgar/filing-to-text.js';

const mockIndex: FilingIndex = {
  directory: {
    name: '000032019323000106',
    item: [
      {
        name: 'aapl-20230930.htm',
        type: 'text/html',
        size: '500000',
        'last-modified': '2023-11-03',
      },
      { name: 'ex-21.htm', type: 'text/html', size: '10000', 'last-modified': '2023-11-03' },
      { name: 'R1.htm', type: 'text/html', size: '5000', 'last-modified': '2023-11-03' },
    ],
  },
};

const mockSubmissions: SubmissionsResponse = {
  cik: '0000320193',
  entityType: 'operating',
  exchanges: ['Nasdaq'],
  filings: {
    recent: {
      accessionNumber: ['0000320193-23-000106'],
      filingDate: ['2023-11-03'],
      form: ['10-K'],
      primaryDocDescription: ['10-K'],
      primaryDocument: ['aapl-20230930.htm'],
      reportDate: ['2023-09-30'],
    },
    files: [],
  },
  fiscalYearEnd: '0930',
  name: 'Apple Inc.',
  sic: '3571',
  sicDescription: 'ELECTRONIC COMPUTERS',
  tickers: ['AAPL'],
};

const mockApi = {
  findFilingCiks: vi.fn(),
  tryGetFilingIndex: vi.fn(),
  tryGetFilingDocument: vi.fn(),
  tryGetFilingHeaders: vi.fn(),
  getSubmissions: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as any);
  mockApi.findFilingCiks.mockResolvedValue(['0000320193']);
  mockApi.tryGetFilingIndex.mockResolvedValue(mockIndex);
  mockApi.tryGetFilingDocument.mockResolvedValue('<html><body><p>Filing content</p></body></html>');
  mockApi.tryGetFilingHeaders.mockResolvedValue(
    new Map([
      ['aapl-20230930.htm', { type: '10-K', sequence: '1', description: '10-K' }],
      ['ex-21.htm', { type: 'EX-21', sequence: '2', description: 'EX-21' }],
      ['R1.htm', { type: 'XML', sequence: '99' }],
    ]),
  );
  mockApi.getSubmissions.mockResolvedValue(mockSubmissions);
  vi.mocked(filingToText).mockReturnValue({
    text: 'Filing content',
    truncated: false,
    totalLength: 14,
  });
});

describe('getFilingTool', () => {
  it('returns filing content for a valid accession number', async () => {
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
      cik: '320193',
    });
    const result = await getFilingTool.handler(input, ctx);

    expect(result.accession_number).toBe('0000320193-23-000106');
    expect(result.company_name).toBe('Apple Inc.');
    expect(result.form).toBe('10-K');
    expect(result.content).toBe('Filing content');
    expect(result.content_truncated).toBe(false);
    expect(result.cik).toBe('0000320193');
  });

  it('normalizes accession number without dashes', async () => {
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '000032019323000106',
    });
    const result = await getFilingTool.handler(input, ctx);

    expect(result.accession_number).toBe('0000320193-23-000106');
  });

  it('derives CIK from accession number when not provided', async () => {
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
    });
    await getFilingTool.handler(input, ctx);

    expect(mockApi.findFilingCiks).toHaveBeenCalledWith('0000320193-23-000106');
    expect(mockApi.tryGetFilingIndex).toHaveBeenCalledWith('0000320193', '0000320193-23-000106');
  });

  it('uses SEC search metadata to resolve accession-only lookups', async () => {
    mockApi.findFilingCiks.mockResolvedValue(['0000320193']);
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0001193125-14-383437',
    });
    const result = await getFilingTool.handler(input, ctx);

    expect(result.cik).toBe('0000320193');
    expect(mockApi.tryGetFilingIndex).toHaveBeenCalledWith('0000320193', '0001193125-14-383437');
  });

  it('fetches a specific document when specified', async () => {
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
      cik: '320193',
      document: 'ex-21.htm',
    });
    const result = await getFilingTool.handler(input, ctx);

    // primary_document is the filing's actual primary (largest HTML), not the requested exhibit
    expect(result.primary_document).toBe('aapl-20230930.htm');
    // requested_document reflects the exhibit that was actually fetched
    expect(result.requested_document).toBe('ex-21.htm');
    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledWith(
      '0000320193',
      '0000320193-23-000106',
      'ex-21.htm',
    );
  });

  it('selects the largest HTML as primary document', async () => {
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
      cik: '320193',
    });
    const result = await getFilingTool.handler(input, ctx);

    // aapl-20230930.htm (500000) is largest, R1.htm is filtered out (starts with R)
    expect(result.primary_document).toBe('aapl-20230930.htm');
  });

  it('selects the primary XML document when only SEC index HTML files exist', async () => {
    mockApi.tryGetFilingIndex.mockResolvedValue({
      directory: {
        name: '000114036126013192',
        item: [
          {
            name: '0001140361-26-013192-index-headers.html',
            type: 'text/html',
            size: '',
            'last-modified': '2026-04-03',
          },
          {
            name: '0001140361-26-013192-index.html',
            type: 'text/html',
            size: '',
            'last-modified': '2026-04-03',
          },
          {
            name: '0001140361-26-013192.txt',
            type: 'text/plain',
            size: '',
            'last-modified': '2026-04-03',
          },
          {
            name: 'form4.xml',
            type: 'text/xml',
            size: '15823',
            'last-modified': '2026-04-03',
          },
        ],
      },
    });
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0001140361-26-013192',
      cik: '320193',
    });
    const result = await getFilingTool.handler(input, ctx);

    expect(result.primary_document).toBe('form4.xml');
    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledWith(
      '0000320193',
      '0001140361-26-013192',
      'form4.xml',
    );
  });

  it('tries another resolved CIK when the first archive path is missing the document', async () => {
    mockApi.findFilingCiks.mockResolvedValue(['0001140361', '0000320193']);
    mockApi.tryGetFilingIndex.mockResolvedValue({
      directory: {
        name: '000114036126013192',
        item: [
          {
            name: '0001140361-26-013192-index-headers.html',
            type: 'text/html',
            size: '',
            'last-modified': '2026-04-03',
          },
          {
            name: 'form4.xml',
            type: 'text/xml',
            size: '15823',
            'last-modified': '2026-04-03',
          },
        ],
      },
    });
    mockApi.tryGetFilingDocument
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('<xml><ownershipDocument /></xml>');
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0001140361-26-013192',
    });
    const result = await getFilingTool.handler(input, ctx);

    expect(result.cik).toBe('0000320193');
    expect(mockApi.tryGetFilingDocument).toHaveBeenNthCalledWith(
      1,
      '0001140361',
      '0001140361-26-013192',
      'form4.xml',
    );
    expect(mockApi.tryGetFilingDocument).toHaveBeenNthCalledWith(
      2,
      '0000320193',
      '0001140361-26-013192',
      'form4.xml',
    );
  });

  it('throws notFound when requested document does not exist', async () => {
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
      cik: '320193',
      document: 'nonexistent.htm',
    });

    await expect(getFilingTool.handler(input, ctx)).rejects.toThrow(/not found in this filing/);
  });

  it('document_not_found error data carries categorized documents, not a flat array', async () => {
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
      cik: '320193',
      document: 'nonexistent.htm',
    });

    // Error data should have documents.primary/exhibits/auxiliary, not available_documents[]
    await expect(getFilingTool.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'document_not_found',
        requested_document: 'nonexistent.htm',
        documents: {
          // aapl-20230930.htm is the largest non-R .htm → primary (type inferred from name pattern)
          primary: expect.arrayContaining([expect.objectContaining({ name: 'aapl-20230930.htm' })]),
          exhibits: expect.any(Array),
          auxiliary: expect.any(Array),
        },
      },
    });
    // Verify the old flat list is gone
    await expect(getFilingTool.handler(input, ctx)).rejects.not.toMatchObject({
      data: { available_documents: expect.any(Array) },
    });
  });

  it('document_not_found recovery hint names the primary document', async () => {
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
      cik: '320193',
      document: 'nonexistent.htm',
    });

    await expect(getFilingTool.handler(input, ctx)).rejects.toMatchObject({
      data: {
        recovery: { hint: expect.stringContaining('aapl-20230930.htm') },
      },
    });
  });

  it('document_not_found does not surface XBRL viewer artifacts in documents.primary or exhibits', async () => {
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
      cik: '320193',
      document: 'nonexistent.htm',
    });

    let thrown: unknown;
    try {
      await getFilingTool.handler(input, ctx);
    } catch (err) {
      thrown = err;
    }

    const error = thrown as {
      data: {
        documents: { primary: { name: string }[]; exhibits: { name: string }[]; xbrl?: unknown };
      };
    };
    const allSurfaced = [...error.data.documents.primary, ...error.data.documents.exhibits];
    const hasR1 = allSurfaced.some((d) => d.name === 'R1.htm');
    expect(hasR1).toBe(false);
    // XBRL artifacts are suppressed from the error payload by default
    expect(error.data.documents.xbrl).toBeUndefined();
  });

  it('categorizes documents into primary, exhibits, and auxiliary; suppresses XBRL by default', async () => {
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
      cik: '320193',
    });
    const result = await getFilingTool.handler(input, ctx);

    expect(result.documents.primary).toHaveLength(1);
    expect(result.documents.primary[0]).toMatchObject({
      name: 'aapl-20230930.htm',
      type: '10-K',
      size: 500000,
    });
    expect(result.documents.exhibits).toHaveLength(1);
    expect(result.documents.exhibits[0]).toMatchObject({ name: 'ex-21.htm', type: 'EX-21' });
    expect(result.documents.auxiliary).toEqual([]);
    // R1.htm is an XBRL viewer fragment — suppressed when include_xbrl=false (default)
    expect(result.documents.xbrl).toBeUndefined();
  });

  it('surfaces XBRL artifacts under documents.xbrl when include_xbrl=true', async () => {
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
      cik: '320193',
      include_xbrl: true,
    });
    const result = await getFilingTool.handler(input, ctx);

    expect(result.documents.xbrl).toHaveLength(1);
    expect(result.documents.xbrl?.[0]).toMatchObject({ name: 'R1.htm' });
  });

  it('falls back to name-pattern type inference when filing headers are unavailable', async () => {
    mockApi.tryGetFilingHeaders.mockResolvedValue(null);
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
      cik: '320193',
      include_xbrl: true,
    });
    const result = await getFilingTool.handler(input, ctx);

    // Without headers, primary still resolved by largest non-R .htm; ex-21.htm
    // lacks an "EX-" name pattern so falls into auxiliary; R1.htm is detected
    // as XBRL purely from its filename.
    expect(result.documents.primary[0]?.name).toBe('aapl-20230930.htm');
    expect(result.documents.primary[0]?.type).toBe('unknown');
    expect(result.documents.exhibits).toEqual([]);
    expect(result.documents.auxiliary[0]?.name).toBe('ex-21.htm');
    expect(result.documents.xbrl).toHaveLength(1);
    expect(result.documents.xbrl?.[0]).toMatchObject({ name: 'R1.htm', type: 'XBRL-VIEWER' });
  });

  it('constructs correct filing URL', async () => {
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
      cik: '320193',
    });
    const result = await getFilingTool.handler(input, ctx);

    expect(result.filing_url).toBe(
      'https://www.sec.gov/Archives/edgar/data/0000320193/000032019323000106/aapl-20230930.htm',
    );
  });

  it('passes content_limit to filingToText', async () => {
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
      cik: '320193',
      content_limit: 10000,
    });
    await getFilingTool.handler(input, ctx);

    expect(filingToText).toHaveBeenCalledWith(expect.any(String), 10000);
  });

  it('omits recent-window metadata for older filings', async () => {
    mockApi.getSubmissions.mockResolvedValue({
      ...mockSubmissions,
      filings: {
        ...mockSubmissions.filings,
        recent: {
          ...mockSubmissions.filings.recent,
          accessionNumber: ['0000320193-23-000106'],
        },
      },
    });
    const ctx = createMockContext({ errors: getFilingTool.errors });
    const input = getFilingTool.input.parse({
      accession_number: '0001193125-14-383437',
      cik: '320193',
    });
    const result = await getFilingTool.handler(input, ctx);

    expect(result.form).toBeUndefined();
    expect(result.filing_date).toBeUndefined();
  });

  it('uses default content_limit of 50000', () => {
    const input = getFilingTool.input.parse({ accession_number: '0000320193-23-000106' });
    expect(input.content_limit).toBe(50000);
  });

  it('formats output correctly', () => {
    const output = {
      accession_number: '0000320193-23-000106',
      form: '10-K',
      filing_date: '2023-11-03',
      company_name: 'Apple Inc.',
      cik: '0000320193',
      primary_document: 'aapl-20230930.htm',
      documents: {
        primary: [{ name: 'aapl-20230930.htm', type: '10-K' }],
        exhibits: [{ name: 'ex-21.htm', type: 'EX-21' }],
        auxiliary: [],
      },
      content: 'Sample filing text',
      content_truncated: true,
      content_total_length: 500000,
      filing_url: 'https://www.sec.gov/Archives/edgar/data/...',
    };
    const blocks = getFilingTool.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('10-K');
    expect(blocks[0].text).toContain('Apple Inc.');
    expect(blocks[0].text).toContain('truncated');
    expect(blocks[0].text).toContain('Exhibits (1)');
    expect(blocks[0].text).toContain('ex-21.htm [EX-21]');
  });
});
