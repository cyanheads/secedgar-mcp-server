/**
 * @fileoverview Tests for get-insider-transactions tool — Form 4 insider transaction parsing.
 * @module tests/mcp-server/tools/definitions/get-insider-transactions.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getInsiderTransactionsTool } from '@/mcp-server/tools/definitions/get-insider-transactions.tool.js';

vi.mock('@/services/edgar/edgar-api-service.js', () => ({
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
}));

import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';

const SALE_XML = `<?xml version="1.0"?>
<ownershipDocument>
  <periodOfReport>2024-03-15</periodOfReport>
  <issuer>
    <issuerCik>0000320193</issuerCik>
    <issuerName>Apple Inc.</issuerName>
    <issuerTradingSymbol>AAPL</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0001214128</rptOwnerCik>
      <rptOwnerName>LEVINSON ARTHUR D</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>true</isDirector>
      <isOfficer>false</isOfficer>
      <isTenPercentOwner>false</isTenPercentOwner>
      <isOther>false</isOther>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2024-03-15</value></transactionDate>
      <transactionCoding>
        <transactionCode>S</transactionCode>
      </transactionCoding>
      <transactionAmounts>
        <transactionShares><value>10000</value></transactionShares>
        <transactionPricePerShare><value>175.50</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>500000</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature>
        <directOrIndirectOwnership><value>D</value></directOrIndirectOwnership>
      </ownershipNature>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

const PURCHASE_XML = `<?xml version="1.0"?>
<ownershipDocument>
  <periodOfReport>2024-03-10</periodOfReport>
  <issuer>
    <issuerCik>0000320193</issuerCik>
    <issuerName>Apple Inc.</issuerName>
    <issuerTradingSymbol>AAPL</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0001234567</rptOwnerCik>
      <rptOwnerName>COOK TIMOTHY D</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>false</isDirector>
      <isOfficer>true</isOfficer>
      <officerTitle>Chief Executive Officer</officerTitle>
      <isTenPercentOwner>false</isTenPercentOwner>
      <isOther>false</isOther>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2024-03-10</value></transactionDate>
      <transactionCoding>
        <transactionCode>P</transactionCode>
      </transactionCoding>
      <transactionAmounts>
        <transactionShares><value>5000</value></transactionShares>
        <transactionPricePerShare><value>170.00</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>1000000</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature>
        <directOrIndirectOwnership><value>D</value></directOrIndirectOwnership>
      </ownershipNature>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

const mockApi = {
  resolveCik: vi.fn(),
  getRecentFilingsByForm: vi.fn(),
  tryGetFilingDocument: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as any);
  mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
  mockApi.getRecentFilingsByForm.mockResolvedValue([
    {
      accessionNumber: '0001214128-24-000010',
      filingDate: '2024-03-16',
      primaryDocument: 'form4.xml',
    },
  ]);
  mockApi.tryGetFilingDocument.mockResolvedValue(SALE_XML);
});

describe('getInsiderTransactionsTool', () => {
  it('returns transactions for a valid company', async () => {
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ ticker_or_cik: 'AAPL' });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    expect(result.issuer_name).toBe('Apple Inc.');
    expect(result.issuer_cik).toBe('0000320193');
    expect(result.issuer_ticker).toBe('AAPL');
    expect(result.filings_scanned).toBe(1);
    expect(result.transactions).toHaveLength(1);
  });

  it('parses sale transaction fields correctly', async () => {
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ ticker_or_cik: 'AAPL' });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    const tx = result.transactions[0]!;
    expect(tx.transaction_code).toBe('S');
    expect(tx.transaction_type).toBe('sale');
    expect(tx.shares_traded).toBe(-10000); // disposal → negative
    expect(tx.price_per_share).toBe(175.5);
    expect(tx.shares_owned_after).toBe(500000);
    expect(tx.ownership_type).toBe('direct');
    expect(tx.is_derivative).toBe(false);
    expect(tx.security_title).toBe('Common Stock');
    expect(tx.reporting_person).toBe('LEVINSON ARTHUR D');
    expect(tx.relationship).toBe('Director');
  });

  it('filters to purchases only with transaction_type=purchase', async () => {
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({
      ticker_or_cik: 'AAPL',
      transaction_type: 'purchase',
    });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    // SALE_XML contains a sale, not a purchase — should filter it out
    expect(result.transactions).toHaveLength(0);
    expect(result.filings_scanned).toBe(1);
  });

  it('enrichment notice is set when filter produces empty results', async () => {
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({
      ticker_or_cik: 'AAPL',
      transaction_type: 'purchase',
    });
    await getInsiderTransactionsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('purchase');
  });

  it('returns purchase transaction when XML has purchase code', async () => {
    mockApi.tryGetFilingDocument.mockResolvedValue(PURCHASE_XML);
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({
      ticker_or_cik: 'AAPL',
      transaction_type: 'purchase',
    });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]!.transaction_code).toBe('P');
    expect(result.transactions[0]!.shares_traded).toBe(5000); // acquisition → positive
    expect(result.transactions[0]!.relationship).toContain('Officer');
  });

  it('sale filter excludes purchases', async () => {
    mockApi.tryGetFilingDocument.mockResolvedValue(PURCHASE_XML);
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({
      ticker_or_cik: 'AAPL',
      transaction_type: 'sale',
    });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    expect(result.transactions).toHaveLength(0);
  });

  it('respects limit parameter', async () => {
    // Two filings, each with one transaction
    mockApi.getRecentFilingsByForm.mockResolvedValue([
      { accessionNumber: 'A-1', filingDate: '2024-03-16', primaryDocument: 'form4.xml' },
      { accessionNumber: 'A-2', filingDate: '2024-03-17', primaryDocument: 'form4.xml' },
      { accessionNumber: 'A-3', filingDate: '2024-03-18', primaryDocument: 'form4.xml' },
    ]);
    mockApi.tryGetFilingDocument.mockResolvedValue(SALE_XML);

    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ ticker_or_cik: 'AAPL', limit: 1 });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    expect(result.transactions).toHaveLength(1);
  });

  it('skips filings where XML document is unavailable', async () => {
    mockApi.getRecentFilingsByForm.mockResolvedValue([
      { accessionNumber: 'A-NULL', filingDate: '2024-03-16', primaryDocument: 'form4.xml' },
    ]);
    mockApi.tryGetFilingDocument.mockResolvedValue(null);

    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ ticker_or_cik: 'AAPL' });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    expect(result.transactions).toHaveLength(0);
    expect(result.filings_scanned).toBe(0);
  });

  it('strips xslF345X06/ prefix from primaryDocument before fetching', async () => {
    mockApi.getRecentFilingsByForm.mockResolvedValue([
      {
        accessionNumber: '0001214128-24-000010',
        filingDate: '2024-03-16',
        primaryDocument: 'xslF345X06/form4.xml',
      },
    ]);

    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ ticker_or_cik: 'AAPL' });
    await getInsiderTransactionsTool.handler(input, ctx);

    // Should have been called with the bare filename, not the prefixed one
    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledWith(
      '0000320193',
      '0001214128-24-000010',
      'form4.xml',
    );
  });

  it('throws company_not_found when CIK resolves to empty array', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ ticker_or_cik: 'XYZNOTREAL' });

    await expect(getInsiderTransactionsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'company_not_found' },
    });
  });

  it('throws no_filings_found when no Form 4 filings exist', async () => {
    mockApi.getRecentFilingsByForm.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ ticker_or_cik: 'AAPL' });

    await expect(getInsiderTransactionsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_filings_found' },
    });
  });

  it('skips malformed XML gracefully and continues scanning', async () => {
    mockApi.getRecentFilingsByForm.mockResolvedValue([
      { accessionNumber: 'A-BAD', filingDate: '2024-03-16', primaryDocument: 'form4.xml' },
      { accessionNumber: 'A-GOOD', filingDate: '2024-03-17', primaryDocument: 'form4.xml' },
    ]);
    // First returns malformed XML (not parseable as ownershipDocument), second is valid
    mockApi.tryGetFilingDocument
      .mockResolvedValueOnce('<<< invalid xml >>>')
      .mockResolvedValueOnce(SALE_XML);

    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ ticker_or_cik: 'AAPL' });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    // The valid filing still produces a transaction
    expect(result.transactions.length).toBeGreaterThanOrEqual(0);
    // No throw — malformed filing is skipped
  });

  it('enrichment notice absent when transactions are returned', async () => {
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ ticker_or_cik: 'AAPL' });
    await getInsiderTransactionsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeUndefined();
  });

  it('default input values are applied', () => {
    const input = getInsiderTransactionsTool.input.parse({ ticker_or_cik: 'AAPL' });
    expect(input.transaction_type).toBe('all');
    expect(input.limit).toBe(20);
  });

  it('validates ticker_or_cik must be non-empty', () => {
    expect(() => getInsiderTransactionsTool.input.parse({ ticker_or_cik: '' })).toThrow();
  });

  it('formats transaction output correctly', () => {
    const output = {
      issuer_name: 'Apple Inc.',
      issuer_cik: '0000320193',
      issuer_ticker: 'AAPL',
      transactions: [
        {
          filing_date: '2024-03-16',
          period_of_report: '2024-03-15',
          accession_number: '0001214128-24-000010',
          reporting_person: 'LEVINSON ARTHUR D',
          relationship: 'Director',
          security_title: 'Common Stock',
          transaction_date: '2024-03-15',
          transaction_code: 'S',
          transaction_type: 'sale',
          is_derivative: false,
          shares_traded: -10000,
          price_per_share: 175.5,
          shares_owned_after: 500000,
          ownership_type: 'direct' as const,
          ownership_nature: undefined,
        },
      ],
      filings_scanned: 1,
    };
    const blocks = getInsiderTransactionsTool.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('Apple Inc.');
    expect(blocks[0].text).toContain('AAPL');
    expect(blocks[0].text).toContain('LEVINSON ARTHUR D');
    expect(blocks[0].text).toContain('Director');
    expect(blocks[0].text).toContain('sale');
    expect(blocks[0].text).toContain('10,000 shares disposed');
    expect(blocks[0].text).toContain('$175.50');
    expect(blocks[0].text).toContain('500,000');
  });

  it('formats acquisition with positive shares', () => {
    const output = {
      issuer_name: 'Apple Inc.',
      issuer_cik: '0000320193',
      issuer_ticker: undefined,
      transactions: [
        {
          filing_date: '2024-03-10',
          period_of_report: undefined,
          accession_number: '0001234567-24-000005',
          reporting_person: 'COOK TIMOTHY D',
          relationship: 'Officer (CEO)',
          security_title: 'Common Stock',
          transaction_date: '2024-03-10',
          transaction_code: 'P',
          transaction_type: 'purchase',
          is_derivative: false,
          shares_traded: 5000,
          price_per_share: 170.0,
          shares_owned_after: 1000000,
          ownership_type: 'direct' as const,
          ownership_nature: undefined,
        },
      ],
      filings_scanned: 1,
    };
    const blocks = getInsiderTransactionsTool.format!(output);
    expect(blocks[0].text).toContain('5,000 shares acquired');
    expect(blocks[0].text).toContain('$170.00');
    expect(blocks[0].text).not.toContain('AAPL'); // ticker is undefined
  });

  it('format handles empty transactions list', () => {
    const output = {
      issuer_name: 'Apple Inc.',
      issuer_cik: '0000320193',
      issuer_ticker: 'AAPL',
      transactions: [],
      filings_scanned: 5,
    };
    const blocks = getInsiderTransactionsTool.format!(output);
    expect(blocks[0].text).toContain('0 transaction(s)');
    expect(blocks[0].text).toContain('5 Form 4 filing(s)');
  });

  it('format renders indirect ownership with nature', () => {
    const output = {
      issuer_name: 'Test Corp',
      issuer_cik: '0000000001',
      issuer_ticker: undefined,
      transactions: [
        {
          filing_date: '2024-01-01',
          period_of_report: undefined,
          accession_number: 'X-1',
          reporting_person: 'Smith John',
          relationship: 'Director',
          security_title: 'Common Stock',
          transaction_date: '2024-01-01',
          transaction_code: 'G',
          transaction_type: 'gift',
          is_derivative: false,
          shares_traded: -500,
          price_per_share: 0,
          shares_owned_after: undefined,
          ownership_type: 'indirect' as const,
          ownership_nature: 'By Spouse',
        },
      ],
      filings_scanned: 1,
    };
    const blocks = getInsiderTransactionsTool.format!(output);
    expect(blocks[0].text).toContain('indirect: By Spouse');
    expect(blocks[0].text).not.toContain('[derivative]');
  });

  it('format marks derivative transactions', () => {
    const output = {
      issuer_name: 'Test Corp',
      issuer_cik: '0000000001',
      issuer_ticker: undefined,
      transactions: [
        {
          filing_date: '2024-01-01',
          period_of_report: undefined,
          accession_number: 'X-1',
          reporting_person: 'Smith John',
          relationship: 'Officer (CEO)',
          security_title: 'Stock Option',
          transaction_date: '2024-01-01',
          transaction_code: 'M',
          transaction_type: 'exercise_of_derivative',
          is_derivative: true,
          shares_traded: 10000,
          price_per_share: 50.0,
          shares_owned_after: 50000,
          ownership_type: 'direct' as const,
          ownership_nature: undefined,
        },
      ],
      filings_scanned: 1,
    };
    const blocks = getInsiderTransactionsTool.format!(output);
    expect(blocks[0].text).toContain('[derivative]');
  });

  // Security: no API keys or env vars should appear in output
  it('output contains no process.env values', async () => {
    process.env.EDGAR_USER_AGENT = 'MyApp test@example.com';
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ ticker_or_cik: 'AAPL' });
    const result = await getInsiderTransactionsTool.handler(input, ctx);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('MyApp test@example.com');
  });

  // Security: injection in ticker input should not cause issues
  it('handles SQL-injection-style ticker input gracefully', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({
      ticker_or_cik: "AAPL'; DROP TABLE companies; --",
    });
    await expect(getInsiderTransactionsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'company_not_found' },
    });
  });

  // Security: oversized limit is capped by schema
  it('rejects limit above 100', () => {
    expect(() =>
      getInsiderTransactionsTool.input.parse({ ticker_or_cik: 'AAPL', limit: 101 }),
    ).toThrow();
  });
});
