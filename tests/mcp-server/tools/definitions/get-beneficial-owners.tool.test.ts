/**
 * @fileoverview Tests for get-beneficial-owners — filing selection off the issuer's own
 * submissions feed, the form_kind and amendment filters, the December 2024 coverage
 * boundary the legacy form names sit behind, per-person canvas rows, and the free-text
 * clipping that keeps one filing's Item 4 from crowding out every other filing.
 * @module tests/mcp-server/tools/definitions/get-beneficial-owners.tool
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBeneficialOwnersTool } from '@/mcp-server/tools/definitions/get-beneficial-owners.tool.js';
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
  form: string;
  primaryDocument?: string;
}

function recent(rows: FilingRow[]): FilingsRecent {
  return {
    form: rows.map((r) => r.form),
    accessionNumber: rows.map((r) => r.accessionNumber),
    filingDate: rows.map((r) => r.filingDate),
    reportDate: rows.map(() => ''),
    primaryDocument: rows.map((r) => r.primaryDocument ?? 'xslSCHEDULE_13G_X01/primary_doc.xml'),
    primaryDocDescription: rows.map(() => ''),
  };
}

function thirteenG(name: string, percent: number, opts: { comment?: string } = {}): string {
  return `<?xml version="1.0"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/schedule13g">
  <headerData><submissionType>SCHEDULE 13G</submissionType></headerData>
  <formData>
    <coverPageHeader>
      <issuerInfo><issuerCik>0000320193</issuerCik><issuerName>Apple Inc.</issuerName></issuerInfo>
      <issuerCusip>037833100</issuerCusip>
      <securitiesClassTitle>Common Stock</securitiesClassTitle>
      <eventDateRequiresFilingThisStatement>03/31/2026</eventDateRequiresFilingThisStatement>
    </coverPageHeader>
    <coverPageHeaderReportingPersonDetails>
      <reportingPersonName>${name}</reportingPersonName>
      <citizenshipOrOrganization>PA</citizenshipOrOrganization>
      <reportingPersonBeneficiallyOwnedNumberOfShares>
        <soleVotingPower>1</soleVotingPower><sharedVotingPower>2</sharedVotingPower>
        <soleDispositivePower>3</soleDispositivePower><sharedDispositivePower>4</sharedDispositivePower>
      </reportingPersonBeneficiallyOwnedNumberOfShares>
      <reportingPersonBeneficiallyOwnedAggregateNumberOfShares>10</reportingPersonBeneficiallyOwnedAggregateNumberOfShares>
      <classPercent>${percent}</classPercent>
      <typeOfReportingPerson>IA</typeOfReportingPerson>
      ${opts.comment ? `<comments>${opts.comment}</comments>` : ''}
    </coverPageHeaderReportingPersonDetails>
  </formData>
</edgarSubmission>`;
}

function thirteenD(purpose: string): string {
  return `<?xml version="1.0"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/schedule13D">
  <headerData><submissionType>SCHEDULE 13D</submissionType></headerData>
  <formData>
    <coverPageHeader>
      <issuerInfo><issuerCIK>0000320193</issuerCIK><issuerName>Apple Inc.</issuerName></issuerInfo>
      <issuerCusips><issuerCusipNumber>037833100</issuerCusipNumber></issuerCusips>
      <dateOfEvent>03/13/2026</dateOfEvent>
    </coverPageHeader>
    <reportingPersons>
      <reportingPersonInfo>
        <reportingPersonCIK>0001111111</reportingPersonCIK>
        <reportingPersonName>Activist LP</reportingPersonName>
        <percentOfClass>6.2</percentOfClass>
        <typeOfReportingPerson>PN</typeOfReportingPerson>
      </reportingPersonInfo>
      <reportingPersonInfo>
        <reportingPersonCIK>0002222222</reportingPersonCIK>
        <reportingPersonName>Activist GP</reportingPersonName>
        <percentOfClass>6.2</percentOfClass>
        <typeOfReportingPerson>OO</typeOfReportingPerson>
      </reportingPersonInfo>
    </reportingPersons>
    <items1To7><item4><transactionPurpose>${purpose}</transactionPurpose></item4></items1To7>
  </formData>
</edgarSubmission>`;
}

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
  getSubmissions: vi.fn(),
  tryGetFilingDocument: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCanvasBridge).mockReturnValue(undefined as never);
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as never);
  mockApi.resolveCik.mockResolvedValue({ cik: '0000320193', name: 'Apple Inc.', ticker: 'AAPL' });
  mockApi.getSubmissions.mockResolvedValue({
    name: 'Apple Inc.',
    filings: {
      recent: recent([
        { form: 'SCHEDULE 13G', accessionNumber: '0000000001-26-000001', filingDate: '2026-04-29' },
        {
          form: 'SCHEDULE 13G/A',
          accessionNumber: '0000000002-26-000002',
          filingDate: '2026-03-26',
        },
        { form: 'SC 13G/A', accessionNumber: '0000000003-24-000003', filingDate: '2024-02-13' },
        { form: '10-K', accessionNumber: '0000000004-26-000004', filingDate: '2026-01-30' },
      ]),
    },
  });
  mockApi.tryGetFilingDocument.mockResolvedValue(thirteenG('The Vanguard Group', 7.48));
});

describe('getBeneficialOwnersTool', () => {
  it('selects the structured schedules out of the issuer submissions feed', async () => {
    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    const input = getBeneficialOwnersTool.input.parse({ issuer: 'AAPL' });
    const result = await getBeneficialOwnersTool.handler(input, ctx);

    expect(result.total_structured_filings).toBe(2);
    expect(result.filings_parsed).toBe(2);
    expect(result.filings.map((f) => f.accession_number)).toEqual([
      '0000000001-26-000001',
      '0000000002-26-000002',
    ]);
  });

  it('counts the pre-2024 legacy filings it cannot parse instead of hiding them', async () => {
    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    const input = getBeneficialOwnersTool.input.parse({ issuer: 'AAPL' });
    const result = await getBeneficialOwnersTool.handler(input, ctx);

    expect(result.legacy_filings_before_coverage).toBe(1);
    expect(result.structured_coverage_from).toBe('2024-12-18');
  });

  it('fetches the raw XML, not the human-readable rendering the feed points at', async () => {
    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    const input = getBeneficialOwnersTool.input.parse({ issuer: 'AAPL', limit: 1 });
    await getBeneficialOwnersTool.handler(input, ctx);

    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledWith(
      '0000320193',
      '0000000001-26-000001',
      'primary_doc.xml',
    );
  });

  it('excludes amendments when asked, and marks the ones it keeps', async () => {
    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    const input = getBeneficialOwnersTool.input.parse({
      issuer: 'AAPL',
      include_amendments: false,
    });
    const result = await getBeneficialOwnersTool.handler(input, ctx);

    expect(result.total_structured_filings).toBe(1);
    expect(result.filings[0]?.is_amendment).toBe(false);
  });

  it('filters to one schedule kind when form_kind names it', async () => {
    mockApi.getSubmissions.mockResolvedValue({
      name: 'Apple Inc.',
      filings: {
        recent: recent([
          {
            form: 'SCHEDULE 13D',
            accessionNumber: '0000000005-26-000005',
            filingDate: '2026-05-01',
          },
          {
            form: 'SCHEDULE 13G',
            accessionNumber: '0000000001-26-000001',
            filingDate: '2026-04-29',
          },
        ]),
      },
    });
    mockApi.tryGetFilingDocument.mockResolvedValue(thirteenD('Board representation.'));

    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    const input = getBeneficialOwnersTool.input.parse({ issuer: 'AAPL', form_kind: '13D' });
    const result = await getBeneficialOwnersTool.handler(input, ctx);

    expect(result.total_structured_filings).toBe(1);
    expect(result.filings[0]?.schedule).toBe('13D');
    expect(result.filings[0]?.purpose_of_transaction).toBe('Board representation.');
  });

  it('lists every reporting person of a joint filing separately', async () => {
    mockApi.getSubmissions.mockResolvedValue({
      name: 'Apple Inc.',
      filings: {
        recent: recent([
          {
            form: 'SCHEDULE 13D',
            accessionNumber: '0000000005-26-000005',
            filingDate: '2026-05-01',
          },
        ]),
      },
    });
    mockApi.tryGetFilingDocument.mockResolvedValue(thirteenD('Board representation.'));

    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    const input = getBeneficialOwnersTool.input.parse({ issuer: 'AAPL' });
    const result = await getBeneficialOwnersTool.handler(input, ctx);

    const persons = result.filings[0]?.reporting_persons ?? [];
    expect(persons.map((p) => p.name)).toEqual(['Activist LP', 'Activist GP']);
    // Both report the same underlying block, so the percentages repeat rather than sum.
    expect(persons.map((p) => p.percent_of_class)).toEqual([6.2, 6.2]);
  });

  it('clips a multi-page purpose and says it clipped it', async () => {
    mockApi.getSubmissions.mockResolvedValue({
      name: 'Apple Inc.',
      filings: {
        recent: recent([
          {
            form: 'SCHEDULE 13D',
            accessionNumber: '0000000005-26-000005',
            filingDate: '2026-05-01',
          },
        ]),
      },
    });
    mockApi.tryGetFilingDocument.mockResolvedValue(thirteenD('x'.repeat(4000)));

    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    const input = getBeneficialOwnersTool.input.parse({ issuer: 'AAPL' });
    const result = await getBeneficialOwnersTool.handler(input, ctx);

    expect(result.filings[0]?.purpose_truncated).toBe(true);
    expect(result.filings[0]?.purpose_of_transaction?.length).toBeLessThan(1300);
  });

  it('collapses filer whitespace in a clipped cover-page note', async () => {
    mockApi.tryGetFilingDocument.mockResolvedValue(
      thirteenG('The Vanguard Group', 7.48, { comment: 'line one\n\n   line two' }),
    );
    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    const input = getBeneficialOwnersTool.input.parse({ issuer: 'AAPL', limit: 1 });
    const result = await getBeneficialOwnersTool.handler(input, ctx);

    expect(result.filings[0]?.reporting_persons[0]?.notes).toBe('line one line two');
  });

  it('drops a filing whose document does not parse rather than failing the call', async () => {
    mockApi.tryGetFilingDocument
      .mockResolvedValueOnce('<ownershipDocument/>')
      .mockResolvedValueOnce(thirteenG('The Vanguard Group', 7.48));

    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    const input = getBeneficialOwnersTool.input.parse({ issuer: 'AAPL' });
    const result = await getBeneficialOwnersTool.handler(input, ctx);

    expect(result.total_structured_filings).toBe(2);
    expect(result.filings_parsed).toBe(1);
  });

  it('registers one canvas row per reporting person, keyed on the issuer', async () => {
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);
    mockApi.getSubmissions.mockResolvedValue({
      name: 'Apple Inc.',
      filings: {
        recent: recent([
          {
            form: 'SCHEDULE 13D',
            accessionNumber: '0000000005-26-000005',
            filingDate: '2026-05-01',
          },
        ]),
      },
    });
    mockApi.tryGetFilingDocument.mockResolvedValue(thirteenD('Board representation.'));

    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    const input = getBeneficialOwnersTool.input.parse({ issuer: 'AAPL' });
    const result = await getBeneficialOwnersTool.handler(input, ctx);

    expect(result.dataset?.row_count).toBe(2);
    const rows = bridge.registerDataframe.mock.calls[0]?.[1].rows;
    expect(rows?.[0]).toMatchObject({
      issuer_cik: '0000320193',
      schedule: '13D',
      reporting_person: 'Activist LP',
      person_types: 'PN',
      has_stated_purpose: true,
    });
  });

  it('reports the dataframe as truncated when filings remain beyond limit', async () => {
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);
    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    const input = getBeneficialOwnersTool.input.parse({ issuer: 'AAPL', limit: 1 });
    const result = await getBeneficialOwnersTool.handler(input, ctx);

    expect(result.dataset?.truncated).toBe(true);
    expect(getEnrichment(ctx).truncated).toBe(true);
    expect(getEnrichment(ctx).cap).toBe(1);
  });

  it('routes a zero-hit issuer to the legacy filings it does have', async () => {
    mockApi.getSubmissions.mockResolvedValue({
      name: 'Coca-Cola Co',
      filings: {
        recent: recent([
          { form: 'SC 13G/A', accessionNumber: '0000000003-24-000003', filingDate: '2024-02-13' },
          { form: 'SC 13D', accessionNumber: '0000000006-20-000006', filingDate: '2020-02-13' },
        ]),
      },
    });
    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    const input = getBeneficialOwnersTool.input.parse({ issuer: 'KO' });

    await expect(getBeneficialOwnersTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_filings_found', legacy_filings_before_coverage: 2 },
    });
  });

  it('notices when every fetched filing failed to parse', async () => {
    mockApi.tryGetFilingDocument.mockResolvedValue(null);
    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    const input = getBeneficialOwnersTool.input.parse({ issuer: 'AAPL' });
    const result = await getBeneficialOwnersTool.handler(input, ctx);

    expect(result.filings_parsed).toBe(0);
    expect(getEnrichment(ctx).notice).toContain('none of the 2 fetched parsed');
  });

  it('fails on an ambiguous issuer name rather than picking one', async () => {
    mockApi.resolveCik.mockResolvedValue([
      { cik: '0001560385', name: 'Liberty Media Corp', ticker: 'FWONA' },
      { cik: '0001611983', name: 'Liberty Broadband Corp', ticker: 'LBRDA' },
    ]);
    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    const input = getBeneficialOwnersTool.input.parse({ issuer: 'Liberty' });

    await expect(getBeneficialOwnersTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'ambiguous_issuer' },
    });
    expect(mockApi.getSubmissions).not.toHaveBeenCalled();
  });

  it('fails when the issuer resolves to nothing', async () => {
    mockApi.resolveCik.mockResolvedValue([]);
    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    const input = getBeneficialOwnersTool.input.parse({ issuer: 'Nope Industries' });

    await expect(getBeneficialOwnersTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'issuer_not_found' },
    });
  });

  it('rejects a blank issuer and an out-of-range limit at the schema', () => {
    expect(() => getBeneficialOwnersTool.input.parse({ issuer: '   ' })).toThrow();
    expect(() => getBeneficialOwnersTool.input.parse({ issuer: 'AAPL', limit: 21 })).toThrow();
    expect(() => getBeneficialOwnersTool.input.parse({ issuer: 'AAPL', limit: 0 })).toThrow();
    expect(() =>
      getBeneficialOwnersTool.input.parse({ issuer: 'AAPL', form_kind: 'SC 13D' }),
    ).toThrow();
  });

  it('states that 13G has no purpose item rather than leaving the section blank', () => {
    const text = getBeneficialOwnersTool.format?.({
      issuer: 'AAPL',
      issuer_cik: '0000320193',
      issuer_name: 'Apple Inc.',
      form_kind: 'all',
      total_structured_filings: 1,
      filings_parsed: 1,
      structured_coverage_from: '2024-12-18',
      legacy_filings_before_coverage: 23,
      filings: [
        {
          form: 'SCHEDULE 13G',
          schedule: '13G',
          is_amendment: false,
          accession_number: '0000000001-26-000001',
          filing_date: '2026-04-29',
          cusips: ['037833100'],
          purpose_truncated: false,
          reporting_persons: [
            { name: 'The Vanguard Group', person_types: ['IA'], percent_of_class: 7.48 },
          ],
        },
      ],
    })?.[0];

    const rendered = text?.type === 'text' ? text.text : '';
    expect(rendered).toContain('13G is the passive form and has no purpose item');
    expect(rendered).toContain('7.48% of class');
    expect(rendered).toContain('23 legacy SC 13D/SC 13G filings');
  });
});
