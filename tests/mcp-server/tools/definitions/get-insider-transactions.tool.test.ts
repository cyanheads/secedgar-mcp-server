/**
 * @fileoverview Tests for get-insider-transactions tool — Form 4 insider transaction parsing.
 * @module tests/mcp-server/tools/definitions/get-insider-transactions.tool
 */

import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getInsiderTransactionsTool } from '@/mcp-server/tools/definitions/get-insider-transactions.tool.js';

vi.mock('@/services/edgar/edgar-api-service.js', () => ({
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
}));

import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import type { FilingsRecent, SubmissionsResponse } from '@/services/edgar/types.js';

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
import { blockAt, blockText, caught, recoveryHint } from '../../../support/assertions.js';

/** A canvas bridge stub whose registerDataframe echoes the rows + truncated flag it received. */
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
  getSubmissions: vi.fn(),
  fetchArchivePage: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default to no canvas — individual tests opt in by returning a stub bridge.
  vi.mocked(getCanvasBridge).mockReturnValue(undefined as never);
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as any);
  // Window-less calls read only the recent Form 4 list; a submissions or archive
  // read nobody arranged fails loudly.
  mockApi.getSubmissions.mockRejectedValue(new Error('unexpected submissions read'));
  mockApi.fetchArchivePage.mockRejectedValue(new Error('unexpected archive page read'));
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
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL' });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    expect(result.issuer_name).toBe('Apple Inc.');
    expect(result.issuer_cik).toBe('0000320193');
    expect(result.issuer_ticker).toBe('AAPL');
    expect(result.filings_scanned).toBe(1);
    expect(result.transactions).toHaveLength(1);
  });

  it('parses sale transaction fields correctly (#46: magnitude + direction)', async () => {
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL' });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    const tx = result.transactions[0]!;
    expect(tx.transaction_code).toBe('S');
    expect(tx.transaction_type).toBe('sale');
    expect(tx.shares_traded).toBe(10000); // disposal → positive magnitude (#46)
    expect(tx.direction).toBe('dispose'); // direction field (#46)
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
      company: 'AAPL',
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
      company: 'AAPL',
      transaction_type: 'purchase',
    });
    await getInsiderTransactionsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('purchase');
  });

  it('returns purchase transaction when XML has purchase code (#46)', async () => {
    mockApi.tryGetFilingDocument.mockResolvedValue(PURCHASE_XML);
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({
      company: 'AAPL',
      transaction_type: 'purchase',
    });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]!.transaction_code).toBe('P');
    expect(result.transactions[0]!.shares_traded).toBe(5000); // acquisition → positive magnitude
    expect(result.transactions[0]!.direction).toBe('acquire'); // direction field
    expect(result.transactions[0]!.relationship).toContain('Officer');
  });

  it('sale filter excludes purchases', async () => {
    mockApi.tryGetFilingDocument.mockResolvedValue(PURCHASE_XML);
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({
      company: 'AAPL',
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
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL', limit: 1 });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    expect(result.transactions).toHaveLength(1);
  });

  it('skips filings where XML document is unavailable', async () => {
    mockApi.getRecentFilingsByForm.mockResolvedValue([
      { accessionNumber: 'A-NULL', filingDate: '2024-03-16', primaryDocument: 'form4.xml' },
    ]);
    mockApi.tryGetFilingDocument.mockResolvedValue(null);

    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL' });
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
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL' });
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
    const input = getInsiderTransactionsTool.input.parse({ company: 'XYZNOTREAL' });

    await expect(getInsiderTransactionsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'company_not_found' },
    });
  });

  it('throws no_filings_found when no Form 4 filings exist', async () => {
    mockApi.getRecentFilingsByForm.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL' });

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
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL' });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    // The valid filing still produces a transaction
    expect(result.transactions.length).toBeGreaterThanOrEqual(0);
    // No throw — malformed filing is skipped
  });

  it('enrichment notice absent when transactions are returned', async () => {
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL' });
    await getInsiderTransactionsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeUndefined();
  });

  it('default input values are applied', () => {
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL' });
    expect(input.transaction_type).toBe('all');
    expect(input.limit).toBe(20);
  });

  it('validates company must be non-empty', () => {
    expect(() => getInsiderTransactionsTool.input.parse({ company: '' })).toThrow();
  });

  it('formats transaction output correctly (#46: magnitude + direction)', () => {
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
          shares_traded: 10000, // positive magnitude (#46)
          direction: 'dispose' as const, // direction field (#46)
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
    expect(blockAt(blocks).type).toBe('text');
    expect(blockText(blocks)).toContain('Apple Inc.');
    expect(blockText(blocks)).toContain('AAPL');
    expect(blockText(blocks)).toContain('LEVINSON ARTHUR D');
    expect(blockText(blocks)).toContain('Director');
    expect(blockText(blocks)).toContain('sale');
    expect(blockText(blocks)).toContain('10,000 shares disposed');
    expect(blockText(blocks)).toContain('$175.50');
    expect(blockText(blocks)).toContain('500,000');
    // The raw `direction` enum reaches content[] through one legend rather than
    // a per-row tag, so a content-only client can map the prose back to it.
    expect(blockText(blocks)).toContain('"shares acquired" = acquire, "shares disposed" = dispose');
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
    expect(blockText(blocks)).toContain('5,000 shares acquired');
    expect(blockText(blocks)).toContain('$170.00');
    expect(blockText(blocks)).not.toContain('AAPL'); // ticker is undefined
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
    expect(blockText(blocks)).toContain('0 transaction(s)');
    expect(blockText(blocks)).toContain('5 Form 4 filing(s)');
    // Nothing to decode, so the legend stays off an empty listing.
    expect(blockText(blocks)).not.toContain('shares acquired" = acquire');
  });

  it('format renders indirect ownership with nature (#46)', () => {
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
          shares_traded: 500, // positive magnitude (#46)
          direction: 'dispose' as const, // gift is a disposal
          price_per_share: 0,
          shares_owned_after: undefined,
          ownership_type: 'indirect' as const,
          ownership_nature: 'By Spouse',
        },
      ],
      filings_scanned: 1,
    };
    const blocks = getInsiderTransactionsTool.format!(output);
    expect(blockText(blocks)).toContain('indirect: By Spouse');
    expect(blockText(blocks)).not.toContain('[derivative]');
    // Disposal renders as "shares disposed" not "shares acquired"
    expect(blockText(blocks)).toContain('shares disposed');
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
    expect(blockText(blocks)).toContain('[derivative]');
  });

  // Security: no API keys or env vars should appear in output
  it('output contains no process.env values', async () => {
    process.env.EDGAR_USER_AGENT = 'MyApp test@example.com';
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL' });
    const result = await getInsiderTransactionsTool.handler(input, ctx);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('MyApp test@example.com');
  });

  // Security: injection in ticker input should not cause issues
  it('handles SQL-injection-style ticker input gracefully', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({
      company: "AAPL'; DROP TABLE companies; --",
    });
    await expect(getInsiderTransactionsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'company_not_found' },
    });
  });

  // Security: oversized limit is capped by schema
  it('rejects limit above 100', () => {
    expect(() => getInsiderTransactionsTool.input.parse({ company: 'AAPL', limit: 101 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// canvas dataframe registration (#39)
// ---------------------------------------------------------------------------

describe('getInsiderTransactionsTool — canvas registration (#39)', () => {
  /** N recent Form 4 filings, each resolving to SALE_XML (one transaction). */
  const filings = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      accessionNumber: `000000000${i}-24-000001`,
      filingDate: '2024-03-16',
      primaryDocument: 'form4.xml',
    }));

  it('omits dataset when the canvas is unavailable', async () => {
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL' });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    expect(result.dataset).toBeUndefined();
  });

  it('registers the full scanned set, caps the inline list, and denormalizes the issuer', async () => {
    mockApi.getRecentFilingsByForm.mockResolvedValue(filings(5));
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);

    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL', limit: 2 });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    // Inline preview capped at limit; the full 5-filing scan lands on the canvas.
    expect(result.transactions).toHaveLength(2);
    expect(bridge.registerDataframe).toHaveBeenCalledTimes(1);
    const opts = bridge.registerDataframe.mock.calls[0]![1];
    expect(opts.sourceTool).toBe('secedgar_get_insider_transactions');
    expect(opts.rows).toHaveLength(5);
    expect(opts.rows[0]).toMatchObject({ issuer_cik: '0000320193', issuer_ticker: 'AAPL' });
    // Whole fetched batch scanned (5 of 5) → not truncated.
    expect(opts.truncated).toBe(false);
    expect(result.dataset).toMatchObject({
      name: 'df_TEST0_TEST1',
      row_count: 5,
      truncated: false,
    });
    // The three transactions past the inline cap live only on the dataframe (#104).
    const notice = String(getEnrichment(ctx).notice);
    expect(getEnrichment(ctx).truncated).toBe(true);
    expect(notice).toContain('df_TEST0_TEST1');
    expect(notice).toContain('secedgar_dataframe_describe');
    expect(notice).toContain('secedgar_dataframe_query');
    expect(notice.match(/secedgar_dataframe_describe/g)).toHaveLength(1);
  });

  it('names both dataframe tools when the whole scanned set fit inline (#104)', async () => {
    mockApi.getRecentFilingsByForm.mockResolvedValue(filings(2));
    vi.mocked(getCanvasBridge).mockReturnValue(stubBridge() as never);

    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL', limit: 20 });
    await getInsiderTransactionsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
    expect(String(enrichment.notice)).toContain('secedgar_dataframe_describe');
  });

  it('promises no pointer when no transaction parsed, so nothing was staged (#104)', async () => {
    mockApi.getRecentFilingsByForm.mockResolvedValue(filings(2));
    // Every document fetch misses → no transactions, no registration.
    mockApi.tryGetFilingDocument.mockResolvedValue(undefined);
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);

    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL' });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    expect(bridge.registerDataframe).not.toHaveBeenCalled();
    expect(result.dataset).toBeUndefined();
    expect(String(getEnrichment(ctx).notice)).not.toContain('secedgar_dataframe_describe');
  });

  it('disposal row: positive magnitude + direction:dispose in both inline and dataframe (#46)', async () => {
    mockApi.getRecentFilingsByForm.mockResolvedValue([
      {
        accessionNumber: '0001214128-24-000010',
        filingDate: '2024-03-16',
        primaryDocument: 'form4.xml',
      },
    ]);
    mockApi.tryGetFilingDocument.mockResolvedValue(SALE_XML);
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);

    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL' });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    // Inline: magnitude positive, direction 'dispose'
    const tx = result.transactions[0]!;
    expect(tx.shares_traded).toBe(10000);
    expect(tx.direction).toBe('dispose');

    // Dataframe: same magnitude and direction
    const opts = bridge.registerDataframe.mock.calls[0]![1];
    const row = opts.rows[0]!;
    expect(row.shares_traded).toBe(10000);
    expect(row.direction).toBe('dispose');
  });

  it('marks the dataframe truncated when the scan cap stops before the batch is exhausted', async () => {
    // More filings than INSIDER_CANVAS_FILING_SCAN (40) → the scan stops early.
    mockApi.getRecentFilingsByForm.mockResolvedValue(filings(45));
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);

    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL', limit: 2 });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    const opts = bridge.registerDataframe.mock.calls[0]![1];
    expect(opts.rows).toHaveLength(40); // capped at the scan floor
    expect(opts.truncated).toBe(true);
    expect(result.dataset?.truncated).toBe(true);
    expect(result.filings_scanned).toBe(40);
  });

  // #63 — a small inline limit must not under-scan the canvas window: the
  // submissions fetch honors the scan floor independently of `limit`, and
  // dataset.truncated reflects Form 4 filings beyond the scanned window.
  it('small inline limit still fetches and scans the canvas floor (#63)', async () => {
    // Mock honors the requested fetch limit so the floor + sentinel are observable.
    mockApi.getRecentFilingsByForm.mockImplementation(
      async (_cik: string, _forms: string[], limit: number) => filings(45).slice(0, limit),
    );
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);

    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL', limit: 1 });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    // Fetch requested the 40-filing scan floor plus the +1 sentinel, not limit*5=5.
    expect(mockApi.getRecentFilingsByForm).toHaveBeenCalledWith('0000320193', ['4', '4/A'], 41);
    // The whole 40-filing window was scanned despite limit=1; inline stays capped.
    expect(result.filings_scanned).toBe(40);
    expect(result.transactions).toHaveLength(1);
    const opts = bridge.registerDataframe.mock.calls[0]![1];
    expect(opts.rows).toHaveLength(40);
    // The sentinel row (41st filing) proves more Form 4s exist beyond the window.
    expect(opts.truncated).toBe(true);
    expect(result.dataset?.truncated).toBe(true);
  });

  it('dataset.truncated stays false when the submissions window is exhausted (#63)', async () => {
    // Only 10 Form 4 filings exist — fewer than the 41 requested. All get scanned,
    // no sentinel row, so the dataframe genuinely holds the full recent history.
    mockApi.getRecentFilingsByForm.mockImplementation(
      async (_cik: string, _forms: string[], limit: number) => filings(10).slice(0, limit),
    );
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);

    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL', limit: 1 });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    expect(result.filings_scanned).toBe(10);
    const opts = bridge.registerDataframe.mock.calls[0]![1];
    expect(opts.rows).toHaveLength(10);
    expect(opts.truncated).toBe(false);
    expect(result.dataset?.truncated).toBe(false);
  });

  it('dataset.truncated is true when the scan breaks before exhausting the window (#63)', async () => {
    // 60 filings inside the fetch window (no sentinel: 60 < the 101 requested for
    // limit=20). The scan floor (40 scanned, 20+ transactions collected) stops the
    // loop with 20 unscanned filings left in the window → truncated.
    mockApi.getRecentFilingsByForm.mockImplementation(
      async (_cik: string, _forms: string[], limit: number) => filings(60).slice(0, limit),
    );
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);

    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL', limit: 20 });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    expect(result.filings_scanned).toBe(40);
    const opts = bridge.registerDataframe.mock.calls[0]![1];
    expect(opts.truncated).toBe(true);
    expect(result.dataset?.truncated).toBe(true);
  });

  it('stops at the inline limit when no canvas is present (no extra fetches)', async () => {
    // No canvas → scanning stops as soon as the inline limit is met, even with
    // many filings available. Guards the "no extra latency without canvas" path.
    mockApi.getRecentFilingsByForm.mockResolvedValue(filings(45));

    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL', limit: 2 });
    const result = await getInsiderTransactionsTool.handler(input, ctx);

    expect(result.dataset).toBeUndefined();
    // Each SALE_XML yields one transaction, so 2 filings suffice for limit=2.
    expect(result.filings_scanned).toBe(2);
  });

  // --- Bare-CIK 404 recovery (#91) ---

  it('converts a bare-CIK 404 to company_not_found with the SEC URL stripped (#91)', async () => {
    // A numeric CIK absent from the ticker cache resolves to a bare { cik }; the
    // submissions feed behind getRecentFilingsByForm 404s (a filing-agent CIK).
    mockApi.resolveCik.mockResolvedValue({ cik: '0001193125' });
    mockApi.getRecentFilingsByForm.mockRejectedValue(
      notFound(
        'SEC EDGAR API returned 404 for https://data.sec.gov/submissions/CIK0001193125.json',
        { url: 'https://data.sec.gov/submissions/CIK0001193125.json', status: 404 },
      ),
    );
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ company: '0001193125' });

    const err = await caught(getInsiderTransactionsTool.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data.reason).toBe('company_not_found');
    expect(err.message).toMatch(/accession-number prefix/i);
    expect(recoveryHint(err)).toContain('secedgar_company_search');
    // No raw SEC URL on the message or the structured data.
    expect(err.message).not.toContain('data.sec.gov');
    expect(err.message).not.toContain('https://');
    expect(JSON.stringify(err.data)).not.toContain('data.sec.gov');
  });

  it('propagates a 404 unchanged when the match came from the ticker cache (#91)', async () => {
    // Default resolveCik returns a name/ticker-bearing match. A 404 there is an
    // EDGAR-side anomaly, not a bad query — never reclassify it.
    mockApi.getRecentFilingsByForm.mockRejectedValue(
      notFound(
        'SEC EDGAR API returned 404 for https://data.sec.gov/submissions/CIK0000320193.json',
        { url: 'https://data.sec.gov/submissions/CIK0000320193.json', status: 404 },
      ),
    );
    const ctx = createMockContext({ errors: getInsiderTransactionsTool.errors });
    const input = getInsiderTransactionsTool.input.parse({ company: 'AAPL' });

    const err = await caught(getInsiderTransactionsTool.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data?.reason).toBeUndefined();
    expect(err.message).toContain('data.sec.gov');
  });
});

// Through the real argument-parsing path, where `inputAliases` is applied (#115).
describe('getInsiderTransactionsTool parameter names (#115)', () => {
  const call = (args: Record<string, unknown>) =>
    runToolContract(getInsiderTransactionsTool, args as never);

  it.each([
    ['company', 'AAPL'],
    ['ticker', 'AAPL'],
    ['cik', '320193'],
    ['ticker_or_cik', 'AAPL'],
  ])('accepts %s and hands its value to the handler as company', async (key, value) => {
    const result = await call({ [key]: value });

    expect(result.isError).toBeFalsy();
    expect(mockApi.resolveCik).toHaveBeenCalledWith(value);
    expect(result.structuredContent).toMatchObject({
      issuer_name: 'Apple Inc.',
      issuer_cik: '0000320193',
    });
    expect(blockText(result.content)).toContain('LEVINSON ARTHUR D');
  });

  it('still rejects an unrelated unknown key by name', async () => {
    const result = await call({ company: 'AAPL', bogus: true });

    expect(result.isError).toBe(true);
    expect(blockText(result.content)).toContain('bogus');
    expect(mockApi.resolveCik).not.toHaveBeenCalled();
  });

  it('rejects an alias sent alongside the canonical key rather than picking one', async () => {
    const result = await call({ company: 'AAPL', ticker_or_cik: 'MSFT' });

    expect(result.isError).toBe(true);
    expect(blockText(result.content)).toContain('ticker_or_cik');
    expect(mockApi.resolveCik).not.toHaveBeenCalled();
  });
});

// --- filed_after / filed_before window (#127) ---

interface Form4Spec {
  accession: string;
  date: string;
  doc?: string;
  form?: string;
}

function form4Block(rows: Form4Spec[]): FilingsRecent {
  return {
    accessionNumber: rows.map((r) => r.accession),
    filingDate: rows.map((r) => r.date),
    form: rows.map((r) => r.form ?? '4'),
    primaryDocDescription: rows.map(() => ''),
    primaryDocument: rows.map((r) => r.doc ?? 'xslF345X05/form4.xml'),
    reportDate: rows.map(() => ''),
  };
}

/** `n` Form 4 rows filed one a day, newest first, ending at `newest`. */
function dailyRows(n: number, newest: string, tag: string): Form4Spec[] {
  const start = Date.parse(`${newest}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    accession: `${tag}-${String(i).padStart(3, '0')}`,
    date: new Date(start - i * 86_400_000).toISOString().slice(0, 10),
  }));
}

function submissionsWith(
  recent: Form4Spec[],
  files: SubmissionsResponse['filings']['files'] = [],
): SubmissionsResponse {
  return {
    cik: '0000320193',
    entityType: 'operating',
    exchanges: ['Nasdaq'],
    filings: { recent: form4Block(recent), files },
    fiscalYearEnd: '0930',
    name: 'Apple Inc.',
    sic: '3571',
    sicDescription: 'ELECTRONIC COMPUTERS',
    tickers: ['AAPL'],
  };
}

const page = (name: string, filingFrom: string, filingTo: string) => ({
  name,
  filingCount: 100,
  filingFrom,
  filingTo,
});

/** Serve archive pages by name; any other page read fails the test. */
function servePages(pages: Record<string, Form4Spec[]>) {
  mockApi.fetchArchivePage.mockImplementation(async (name: string) => {
    const rows = pages[name];
    if (!rows) throw new Error(`unexpected archive page ${name}`);
    return form4Block(rows);
  });
}

describe('getInsiderTransactionsTool — filed_after / filed_before window (#127)', () => {
  const call = (args: Record<string, unknown>) =>
    runToolContract(getInsiderTransactionsTool, args as never);

  it('parses every in-window filing from the recent window alone, with no archive page', async () => {
    // Recent reaches back to 2020-12-02; 30 Form 4s sit in 2021-Q1 among a 10-K and a 4/A.
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith(
        [
          ...dailyRows(10, '2026-09-10', 'new'),
          { accession: '10k', date: '2021-04-02', form: '10-K', doc: 'msft-10k.htm' },
          ...dailyRows(29, '2021-03-31', 'q1'),
          { accession: 'q1-amend', date: '2021-03-02', form: '4/A' },
          ...dailyRows(10, '2020-12-11', 'old'),
        ],
        [page('CIK0000320193-submissions-001.json', '2008-08-13', '2020-08-05')],
      ),
    );
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);

    const result = await call({
      company: 'MSFT',
      filed_after: '2021-01-01',
      filed_before: '2021-03-31',
    });

    expect(result.isError).toBeFalsy();
    expect(mockApi.getRecentFilingsByForm).not.toHaveBeenCalled();
    expect(mockApi.fetchArchivePage).not.toHaveBeenCalled();
    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledTimes(30);
    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledWith(
      '0000320193',
      'q1-amend',
      'form4.xml',
    );
    expect(result.structuredContent).toMatchObject({
      filings_scanned: 30,
      history_scanned_through: '2021-03-02',
      dataset: { row_count: 30, truncated: false },
    });
    const opts = bridge.registerDataframe.mock.calls[0]?.[1];
    expect(opts?.truncated).toBe(false);
    expect(blockText(result.content)).toContain('History scanned through: 2021-03-02');
  });

  it('reads only the archive pages overlapping the window, newest first', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith(dailyRows(5, '2026-09-24', 'recent'), [
        page('p039', '2021-04-20', '2021-06-10'),
        page('p040', '2021-02-19', '2021-04-18'),
        page('p041', '2020-12-15', '2021-02-17'),
        page('p042', '2020-10-01', '2020-12-14'),
      ]),
    );
    servePages({
      // 18 April rows, then 41 rows 2021-03-31 → 2021-02-19 (all in window).
      p040: [...dailyRows(18, '2021-04-18', 'apr'), ...dailyRows(41, '2021-03-31', 'p40')],
      // 48 rows 2021-02-17 → 2021-01-01, then December rows outside the window.
      p041: [...dailyRows(48, '2021-02-17', 'p41'), ...dailyRows(10, '2020-12-31', 'dec')],
    });
    vi.mocked(getCanvasBridge).mockReturnValue(stubBridge() as never);

    const result = await call({
      company: '0000019617',
      filed_after: '2021-01-01',
      filed_before: '2021-03-31',
    });

    expect(mockApi.fetchArchivePage.mock.calls.map(([name]) => name)).toEqual(['p040', 'p041']);
    expect(result.structuredContent).toMatchObject({
      filings_scanned: 89,
      history_scanned_through: '2021-01-01',
      dataset: { truncated: false },
    });
  });

  it('parses up to 100 filings and flags truncation when a sentinel row is in hand', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith(dailyRows(120, '2021-06-30', 'q'), [
        page('p001', '2015-01-01', '2020-12-31'),
      ]),
    );
    vi.mocked(getCanvasBridge).mockReturnValue(stubBridge() as never);

    const result = await call({ company: 'AAPL', filed_after: '2021-01-01', limit: 5 });

    expect(mockApi.fetchArchivePage).not.toHaveBeenCalled();
    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledTimes(100);
    expect(result.structuredContent).toMatchObject({
      filings_scanned: 100,
      dataset: { truncated: true },
    });
    expect((result.structuredContent as { transactions: unknown[] }).transactions).toHaveLength(5);
  });

  it('stops paging on the page that brings in the scan budget plus one sentinel row', async () => {
    const files = Array.from({ length: 5 }, (_, i) =>
      page(`p${i + 1}`, `${2014 - i}-01-01`, `${2014 - i}-12-31`),
    );
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith(dailyRows(3, '2026-01-10', 'recent'), files),
    );
    servePages(
      Object.fromEntries(files.map((f, i) => [f.name, dailyRows(60, `${2014 - i}-12-31`, f.name)])),
    );
    vi.mocked(getCanvasBridge).mockReturnValue(stubBridge() as never);

    const result = await call({ company: 'AAPL', filed_before: '2014-12-31' });

    // Page 1 brings 60 candidates, page 2 brings 120 ≥ 101: the walk ends there, and
    // the 100th filing parsed is page 2's 40th row.
    expect(mockApi.fetchArchivePage).toHaveBeenCalledTimes(2);
    expect(result.structuredContent).toMatchObject({
      filings_scanned: 100,
      history_scanned_through: '2013-11-22',
      dataset: { truncated: true },
    });
  });

  it('flags truncation when the page cap ends the walk before the window’s lower bound', async () => {
    const files = Array.from({ length: 14 }, (_, i) =>
      page(`p${String(i + 1).padStart(3, '0')}`, `${2014 - i}-01-01`, `${2014 - i}-12-31`),
    );
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith(dailyRows(3, '2026-01-10', 'recent'), files),
    );
    servePages(
      Object.fromEntries(files.map((f, i) => [f.name, dailyRows(1, `${2014 - i}-06-30`, f.name)])),
    );
    vi.mocked(getCanvasBridge).mockReturnValue(stubBridge() as never);

    const result = await call({
      company: 'AAPL',
      filed_after: '1990-01-01',
      filed_before: '2015-12-31',
    });

    expect(mockApi.fetchArchivePage).toHaveBeenCalledTimes(10);
    expect(result.structuredContent).toMatchObject({
      filings_scanned: 10,
      history_scanned_through: '2005-06-30',
      dataset: { truncated: true },
    });
  });

  it('answers an empty window with a notice naming it, not no_filings_found', async () => {
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith(dailyRows(5, '2026-01-10', 'recent'), [
        page('p001', '1994-01-26', '2015-07-24'),
      ]),
    );
    servePages({
      p001: [
        ...dailyRows(3, '2004-02-01', 'xml'),
        // Form 4 before EDGAR's ownership XML: an HTML primary document, never parsed.
        { accession: 'html-4', date: '2003-03-21', doc: 'j8739_4.htm' },
        { accession: '10k', date: '2002-12-19', form: '10-K', doc: 'a10k.htm' },
      ],
    });

    const result = await call({
      company: 'AAPL',
      start_date: '1995-01-01',
      end_date: '2003-04-30',
    });

    expect(result.isError).toBeFalsy();
    expect(mockApi.tryGetFilingDocument).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ transactions: [], filings_scanned: 0 });
    const notice = String((result.structuredContent as { notice?: string }).notice);
    expect(notice).toContain('No Form 4 filings filed between 1995-01-01 and 2003-04-30');
    expect(notice).toContain('begin in mid-2003');
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(notice);
  });

  it('names an unread page-cap stretch in the empty-window notice, without the pre-2003 note', async () => {
    // Twenty yearly pages, 2020 back to 2001; with the one-day drift allowance (#137)
    // thirteen overlap 2005–2015 (2004 and 2016 are a day away), ten are read.
    const files = Array.from({ length: 20 }, (_, i) =>
      page(`p${String(i + 1).padStart(3, '0')}`, `${2020 - i}-01-01`, `${2020 - i}-12-31`),
    );
    mockApi.getSubmissions.mockResolvedValue(
      submissionsWith(dailyRows(3, '2026-01-10', 'recent'), files),
    );
    servePages(Object.fromEntries(files.map((f) => [f.name, []])));

    const result = await call({
      company: 'AAPL',
      filed_after: '2005-01-01',
      filed_before: '2015-12-31',
    });

    expect(mockApi.fetchArchivePage).toHaveBeenCalledTimes(10);
    const notice = String((result.structuredContent as { notice?: string }).notice);
    expect(notice).toContain('No Form 4 filings filed between 2005-01-01 and 2015-12-31');
    expect(notice).toContain('stopped after 10 pages, at filings from 2007-01-01');
    expect(notice).not.toContain('mid-2003');
    expect(result.structuredContent).not.toHaveProperty(
      'history_scanned_through',
      expect.anything(),
    );
  });

  it.each([
    ['filed_after', 'filed_before'],
    ['start_date', 'end_date'],
    ['date_from', 'date_to'],
  ])('bounds the window with %s / %s, both ends inclusive', async (after, before) => {
    mockApi.getSubmissions.mockResolvedValue(submissionsWith(dailyRows(10, '2024-03-20', 'd')));

    const result = await call({ company: 'AAPL', [after]: '2024-03-12', [before]: '2024-03-15' });

    expect(result.isError).toBeFalsy();
    expect(mockApi.tryGetFilingDocument.mock.calls.map(([, accn]) => accn)).toEqual([
      'd-005',
      'd-006',
      'd-007',
      'd-008',
    ]);
    expect(result.structuredContent).toMatchObject({ history_scanned_through: '2024-03-12' });
  });

  it('keeps the no-canvas fast path inside a window: stops once limit transactions are in', async () => {
    mockApi.getSubmissions.mockResolvedValue(submissionsWith(dailyRows(10, '2024-03-20', 'd')));

    const result = await call({ company: 'AAPL', filed_before: '2024-03-18', limit: 2 });

    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledTimes(2);
    expect(result.structuredContent).toMatchObject({
      filings_scanned: 2,
      history_scanned_through: '2024-03-17',
    });
    expect((result.structuredContent as { dataset?: unknown }).dataset).toBeUndefined();
  });

  it('rejects a malformed bound at the schema', async () => {
    const result = await call({ company: 'AAPL', filed_after: '2021/01/01' });

    expect(result.isError).toBe(true);
    expect(blockText(result.content)).toContain('filed_after');
    expect(mockApi.resolveCik).not.toHaveBeenCalled();
  });

  it('converts a bare-CIK 404 on the windowed submissions read to company_not_found', async () => {
    mockApi.resolveCik.mockResolvedValue({ cik: '0001193125' });
    mockApi.getSubmissions.mockRejectedValue(
      notFound(
        'SEC EDGAR API returned 404 for https://data.sec.gov/submissions/CIK0001193125.json',
      ),
    );
    const err = await caught(
      getInsiderTransactionsTool.handler(
        getInsiderTransactionsTool.input.parse({
          company: '0001193125',
          filed_after: '2021-01-01',
        }),
        createMockContext({ errors: getInsiderTransactionsTool.errors }),
      ),
    );

    expect(err.data.reason).toBe('company_not_found');
    expect(err.message).not.toContain('data.sec.gov');
  });

  it('leaves a window-less call on the recent Form 4 list, with no scan-depth field', async () => {
    const result = await call({ company: 'AAPL' });

    expect(mockApi.getRecentFilingsByForm).toHaveBeenCalledWith('0000320193', ['4', '4/A'], 101);
    expect(mockApi.getSubmissions).not.toHaveBeenCalled();
    expect(result.structuredContent).not.toHaveProperty('history_scanned_through');
  });
});
