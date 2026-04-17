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
  getSubmissions: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as any);
  mockApi.findFilingCiks.mockResolvedValue(['0000320193']);
  mockApi.tryGetFilingIndex.mockResolvedValue(mockIndex);
  mockApi.tryGetFilingDocument.mockResolvedValue('<html><body><p>Filing content</p></body></html>');
  mockApi.getSubmissions.mockResolvedValue(mockSubmissions);
  vi.mocked(filingToText).mockReturnValue({
    text: 'Filing content',
    truncated: false,
    totalLength: 14,
  });
});

describe('getFilingTool', () => {
  it('returns filing content for a valid accession number', async () => {
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    const input = getFilingTool.input.parse({
      accession_number: '000032019323000106',
    });
    const result = await getFilingTool.handler(input, ctx);

    expect(result.accession_number).toBe('0000320193-23-000106');
  });

  it('derives CIK from accession number when not provided', async () => {
    const ctx = createMockContext();
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
    });
    await getFilingTool.handler(input, ctx);

    expect(mockApi.findFilingCiks).toHaveBeenCalledWith('0000320193-23-000106');
    expect(mockApi.tryGetFilingIndex).toHaveBeenCalledWith('0000320193', '0000320193-23-000106');
  });

  it('uses SEC search metadata to resolve accession-only lookups', async () => {
    mockApi.findFilingCiks.mockResolvedValue(['0000320193']);
    const ctx = createMockContext();
    const input = getFilingTool.input.parse({
      accession_number: '0001193125-14-383437',
    });
    const result = await getFilingTool.handler(input, ctx);

    expect(result.cik).toBe('0000320193');
    expect(mockApi.tryGetFilingIndex).toHaveBeenCalledWith('0000320193', '0001193125-14-383437');
  });

  it('fetches a specific document when specified', async () => {
    const ctx = createMockContext();
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
      cik: '320193',
      document: 'ex-21.htm',
    });
    const result = await getFilingTool.handler(input, ctx);

    expect(result.primary_document).toBe('ex-21.htm');
    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledWith(
      '0000320193',
      '0000320193-23-000106',
      'ex-21.htm',
    );
  });

  it('selects the largest HTML as primary document', async () => {
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
      cik: '320193',
      document: 'nonexistent.htm',
    });

    await expect(getFilingTool.handler(input, ctx)).rejects.toThrow(/not found in this filing/);
  });

  it('includes all documents in response', async () => {
    const ctx = createMockContext();
    const input = getFilingTool.input.parse({
      accession_number: '0000320193-23-000106',
      cik: '320193',
    });
    const result = await getFilingTool.handler(input, ctx);

    expect(result.documents).toHaveLength(3);
    expect(result.documents[0].name).toBe('aapl-20230930.htm');
    expect(result.documents[0].size).toBe(500000);
  });

  it('constructs correct filing URL', async () => {
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
      documents: [],
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
  });
});
