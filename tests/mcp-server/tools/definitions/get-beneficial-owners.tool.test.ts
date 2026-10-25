/**
 * @fileoverview Tests for get-beneficial-owners — filing selection off the issuer's own
 * submissions feed, the form_kind and amendment filters, the December 2024 coverage
 * boundary the legacy form names sit behind, per-person canvas rows, and the free-text
 * clipping that keeps one filing's Item 4 from crowding out every other filing, and the
 * company-identifier aliases on `issuer` (#152).
 * @module tests/mcp-server/tools/definitions/get-beneficial-owners.tool
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGetBeneficialOwnersTool,
  getBeneficialOwnersTool,
} from '@/mcp-server/tools/definitions/get-beneficial-owners.tool.js';
import { CallScope } from '@/services/edgar/call-scope.js';
import type { FilingsRecent } from '@/services/edgar/types.js';
import { bag, blockText, wireError } from '../../../support/assertions.js';
import { readCommonMark } from '../../../support/commonmark.js';

vi.mock('@/services/edgar/edgar-api-service.js', async (importActual) => {
  const actual = await importActual<typeof import('@/services/edgar/edgar-api-service.js')>();
  return { ...actual, getEdgarApiService: vi.fn(), initEdgarApiService: vi.fn() };
});

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
  mockApi.tryGetFilingDocument.mockReset();
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
  it('backfills beyond another issuer and failed documents until limit matching successes', async () => {
    mockApi.getSubmissions.mockResolvedValue({
      name: 'Apple Inc.',
      filings: {
        recent: recent(
          ['other', 'missing', 'bad', 'own', 'older'].map((accessionNumber) => ({
            accessionNumber,
            form: 'SCHEDULE 13G',
            filingDate: '2026-04-29',
          })),
        ),
      },
    });
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);
    mockApi.tryGetFilingDocument
      .mockResolvedValueOnce(thirteenG('Wrong Owner', 8).replace('0000320193', '0000920760'))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('<not-a-schedule/>')
      .mockResolvedValueOnce(thirteenG('Correct Owner', 7).replace('0000320193', '320193'));
    const result = await runToolContract(getBeneficialOwnersTool, { issuer: 'AAPL', limit: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      total_structured_filings: 5,
      filings_examined: 4,
      filings_not_examined: 1,
      filings_parsed: 1,
      filings_excluded_other_issuer: 1,
      partial: true,
      truncated: true,
      filings_failed: [
        { accession_number: 'missing', reason: 'document_not_found' },
        { accession_number: 'bad', reason: 'unparseable' },
      ],
      filings: [{ accession_number: 'own' }],
      dataset: { truncated: true, row_count: 1 },
    });
    expect(mockApi.tryGetFilingDocument.mock.calls.map((call) => call[1])).toEqual([
      'other',
      'missing',
      'bad',
      'own',
    ]);
    expect(bridge.registerDataframe.mock.calls[0]?.[1].rows).toEqual([
      expect.objectContaining({ issuer_cik: '0000320193', reporting_person: 'Correct Owner' }),
    ]);
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).not.toContain('Wrong Owner');
    for (const value of [
      'missing',
      'document_not_found',
      'bad',
      'unparseable',
      '4 examined',
      '1 excluded',
      '1 not examined',
      'partial',
      'Raise limit',
      'secedgar_get_filing',
      'df_TEST0_TEST1',
    ]) {
      expect(text).toContain(value);
    }
  });

  it.each([
    ['document_not_found', null],
    ['unparseable', '<not-a-schedule/>'],
    [
      'unparseable',
      thirteenG('Unknown Issuer', 7).replace('<issuerCik>0000320193</issuerCik>', ''),
    ],
  ])('discloses all failed documents as %s without false limit recovery', async (reason, xml) => {
    mockApi.tryGetFilingDocument.mockResolvedValue(xml);
    const result = await runToolContract(getBeneficialOwnersTool, { issuer: 'AAPL' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      filings_parsed: 0,
      filings_examined: 2,
      filings_not_examined: 0,
      filings_excluded_other_issuer: 0,
      partial: true,
      filings_failed: [
        { accession_number: '0000000001-26-000001', reason },
        { accession_number: '0000000002-26-000002', reason },
      ],
    });
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain(String(reason));
    expect(text).toContain('secedgar_get_filing');
    expect(text).not.toContain('Raise limit');
    expect(bag(result.structuredContent).truncated).not.toBe(true);
  });

  it('returns an accurately empty result when every schedule names another issuer', async () => {
    mockApi.tryGetFilingDocument.mockResolvedValue(
      thirteenG('Wrong Owner', 7).replace('0000320193', '920760'),
    );
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);
    const result = await runToolContract(getBeneficialOwnersTool, { issuer: 'AAPL' });
    expect(result.structuredContent).toMatchObject({
      filings_parsed: 0,
      filings_examined: 2,
      filings_excluded_other_issuer: 2,
      filings_not_examined: 0,
      filings_failed: [],
      partial: false,
      filings: [],
    });
    expect(bridge.registerDataframe).not.toHaveBeenCalled();
    expect(
      result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
    ).toContain('2 examined filings name another issuer');
    expect(blockText(result.content)).not.toContain('none of');
  });

  it.each([50, 51])('examines at most 50 of %i indexed schedules', async (total) => {
    mockApi.getSubmissions.mockResolvedValue({
      name: 'Apple Inc.',
      filings: {
        recent: recent(
          Array.from({ length: total }, (_, i) => ({
            accessionNumber: `other-${i}`,
            form: 'SCHEDULE 13G',
            filingDate: '2026-04-29',
          })),
        ),
      },
    });
    mockApi.tryGetFilingDocument.mockResolvedValue(
      thirteenG('Other', 7).replace('0000320193', '920760'),
    );
    const result = await runToolContract(getBeneficialOwnersTool, { issuer: 'AAPL', limit: 1 });
    expect(result.structuredContent).toMatchObject({
      total_structured_filings: total,
      filings_examined: 50,
      filings_not_examined: total - 50,
      filings_excluded_other_issuer: 50,
      filings_parsed: 0,
      partial: false,
      filings_failed: [],
    });
    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledTimes(50);
    expect(bag(result.structuredContent).truncated === true).toBe(total === 51);
    if (total === 51) {
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain('50-document scan ceiling');
      expect(text).not.toContain('Raise limit');
    }
  });

  it('names the scan ceiling when the fiftieth document also fills the result limit', async () => {
    mockApi.getSubmissions.mockResolvedValue({
      name: 'Apple Inc.',
      filings: {
        recent: recent(
          Array.from({ length: 51 }, (_, i) => ({
            accessionNumber: `filing-${i}`,
            form: 'SCHEDULE 13G',
            filingDate: '2026-04-29',
          })),
        ),
      },
    });
    mockApi.tryGetFilingDocument.mockImplementation(async (_cik, accession) =>
      thirteenG('Owner', 7).replace('0000320193', accession === 'filing-49' ? '320193' : '920760'),
    );
    const result = await runToolContract(getBeneficialOwnersTool, { issuer: 'AAPL', limit: 1 });
    expect(result.structuredContent).toMatchObject({
      filings_examined: 50,
      filings_parsed: 1,
      filings_excluded_other_issuer: 49,
      filings_not_examined: 1,
      truncated: true,
      cap: 50,
      filings: [{ accession_number: 'filing-49' }],
    });
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('50-document scan ceiling');
    expect(text).not.toContain('Raise limit');
  });

  it('does not recommend raising an already maximal result limit', async () => {
    mockApi.getSubmissions.mockResolvedValue({
      name: 'Apple Inc.',
      filings: {
        recent: recent(
          Array.from({ length: 21 }, (_, i) => ({
            accessionNumber: `filing-${i}`,
            form: 'SCHEDULE 13G',
            filingDate: '2026-04-29',
          })),
        ),
      },
    });
    const result = await runToolContract(getBeneficialOwnersTool, { issuer: 'AAPL', limit: 20 });
    expect(result.structuredContent).toMatchObject({
      filings_parsed: 20,
      filings_examined: 20,
      filings_not_examined: 1,
      truncated: true,
      cap: 20,
    });
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('form_kind');
    expect(text).not.toContain('Raise limit');
  });

  it('preserves a document service failure instead of returning an incomplete success', async () => {
    const failure = new Error('SEC document service unavailable');
    mockApi.tryGetFilingDocument.mockRejectedValueOnce(failure);
    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    await expect(
      getBeneficialOwnersTool.handler(getBeneficialOwnersTool.input.parse({ issuer: 'AAPL' }), ctx),
    ).rejects.toBe(failure);
    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledTimes(1);
  });

  it('stops between documents with the caller cancellation reason intact', async () => {
    const controller = new AbortController();
    const reason = new Error('Caller stopped ownership scan');
    mockApi.tryGetFilingDocument.mockImplementationOnce(async () => {
      controller.abort(reason);
      return thirteenG('Other', 7).replace('0000320193', '920760');
    });
    const ctx = createMockContext({
      errors: getBeneficialOwnersTool.errors,
      signal: controller.signal,
    });
    await expect(
      getBeneficialOwnersTool.handler(getBeneficialOwnersTool.input.parse({ issuer: 'AAPL' }), ctx),
    ).rejects.toBe(reason);
    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledTimes(1);
  });

  it('keeps a matching filing despite one missing document, without truncating the dataset', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(stubBridge() as never);
    mockApi.tryGetFilingDocument.mockResolvedValueOnce(null);
    const result = await runToolContract(getBeneficialOwnersTool, { issuer: 'AAPL', limit: 2 });
    expect(result.structuredContent).toMatchObject({
      filings_examined: 2,
      filings_parsed: 1,
      filings_not_examined: 0,
      filings_excluded_other_issuer: 0,
      partial: true,
      filings_failed: [{ accession_number: '0000000001-26-000001', reason: 'document_not_found' }],
      dataset: { truncated: false, row_count: 1 },
    });
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('document_not_found');
    expect(text).toContain('df_TEST0_TEST1');
    expect(text).not.toContain('Raise limit');
    expect(bag(result.structuredContent).truncated).not.toBe(true);
  });

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
      expect.any(CallScope),
    );
    // The scope carries the caller's own signal, so a cancel reaches SEC (#179).
    expect(mockApi.tryGetFilingDocument.mock.calls[0]?.[3].signal).toBe(ctx.signal);
    // A newest matching schedule still costs exactly one document request.
    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledTimes(1);
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

    // Both halves of the guidance survive in ONE notice — the limit boundary and
    // the describe-then-query pointer. `notice` is last-wins across notice and
    // truncated, so a second enrich call here would clobber the first (#104).
    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('Raise limit to reach further back');
    expect(notice).toContain('df_TEST0_TEST1');
    expect(notice).toContain('secedgar_dataframe_describe');
    expect(notice).toContain('secedgar_dataframe_query');
    expect(notice.match(/secedgar_dataframe_describe/g)).toHaveLength(1);
    expect(notice.match(/df_TEST0_TEST1/g)).toHaveLength(1);
  });

  it('names both dataframe tools when every structured filing was parsed (#104)', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(stubBridge() as never);
    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    const input = getBeneficialOwnersTool.input.parse({ issuer: 'AAPL', limit: 20 });
    const result = await getBeneficialOwnersTool.handler(input, ctx);

    expect(result.dataset?.truncated).toBe(false);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
    expect(String(enrichment.notice)).toContain('secedgar_dataframe_describe');
  });

  it('promises no pointer when the canvas is unavailable (#104)', async () => {
    vi.mocked(getCanvasBridge).mockReturnValue(undefined as never);
    const ctx = createMockContext({ errors: getBeneficialOwnersTool.errors });
    const input = getBeneficialOwnersTool.input.parse({ issuer: 'AAPL', limit: 1 });
    const result = await getBeneficialOwnersTool.handler(input, ctx);

    expect(result.dataset).toBeUndefined();
    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('Raise limit to reach further back');
    expect(notice).not.toContain('secedgar_dataframe_describe');
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
    expect(getEnrichment(ctx).notice).toContain('2 documents failed; this is a partial result');
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
    expect(() => getBeneficialOwnersTool.input.parse({ issuer: 'AAPL', limit: 1001 })).toThrow();
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
      filings_examined: 1,
      filings_excluded_other_issuer: 0,
      filings_not_examined: 0,
      filings_failed: [],
      partial: false,
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

// Through the real argument-parsing path, where `inputAliases` is applied (#152).
describe('getBeneficialOwnersTool parameter names (#152)', () => {
  const call = (args: Record<string, unknown>) =>
    runToolContract(getBeneficialOwnersTool, args as never);

  it.each(['issuer', 'company', 'ticker', 'cik', 'ticker_or_cik'])(
    'resolves the issuer from %s',
    async (key) => {
      const result = await call({ [key]: 'AAPL' });

      expect(result.isError).toBeFalsy();
      expect(mockApi.resolveCik).toHaveBeenCalledWith('AAPL', expect.any(CallScope));
      expect(result.structuredContent).toMatchObject({
        issuer: 'AAPL',
        issuer_cik: '0000320193',
        issuer_name: 'Apple Inc.',
      });
      expect(blockText(result.content)).toContain(
        '**5%+ beneficial owners of Apple Inc.** (CIK 0000320193) — input "AAPL"',
      );
    },
  );

  it('rejects an alias sent beside issuer by name rather than picking one', async () => {
    const result = await call({ issuer: 'AAPL', company: 'MSFT' });

    expect(wireError(result).data.reason).toBe('invalid_arguments');
    expect(blockText(result.content)).toContain('"company"');
    expect(mockApi.resolveCik).not.toHaveBeenCalled();
  });
});

// A limit above the 20-filing result cap is served at 20 while EDGAR_CLAMP_OVERSIZED_LIMITS
// is on; the mechanism itself is tabled in tests/mcp-server/tools/limit-clamp.test.ts (#197).
describe('getBeneficialOwnersTool — limit above the 20 cap (#197)', () => {
  beforeEach(() => {
    mockApi.getSubmissions.mockResolvedValue({
      name: 'Apple Inc.',
      filings: {
        recent: recent(
          Array.from({ length: 25 }, (_, i) => ({
            accessionNumber: `filing-${i}`,
            form: 'SCHEDULE 13G',
            filingDate: '2026-04-29',
          })),
        ),
      },
    });
  });

  const args = { issuer: 'AAPL' };

  it('answers limit 21 exactly as limit 20, the applied cap included', async () => {
    const at20 = await runToolContract(getBeneficialOwnersTool, { ...args, limit: 20 });
    const at21 = await runToolContract(getBeneficialOwnersTool, { ...args, limit: 21 });

    expect(at21).toEqual(at20);
    expect(at21.structuredContent).toMatchObject({
      filings_parsed: 20,
      filings_examined: 20,
      filings_not_examined: 5,
      cap: 20,
      shown: 20,
    });
    const text = at21.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    expect(readCommonMark(text)).toContain(
      '5 indexed schedules remain unexamined after the 20-filing result limit',
    );
    // 20 documents read per call: the 21st filing is never fetched.
    expect(mockApi.tryGetFilingDocument).toHaveBeenCalledTimes(40);
  });

  it('answers limit 21 exactly as limit 20 when the owners are staged as a dataframe', async () => {
    const bridge = stubBridge();
    vi.mocked(getCanvasBridge).mockReturnValue(bridge as never);

    const at20 = await runToolContract(getBeneficialOwnersTool, { ...args, limit: 20 });
    const at21 = await runToolContract(getBeneficialOwnersTool, { ...args, limit: 21 });

    expect(bridge.registerDataframe).toHaveBeenCalledTimes(2);
    expect(bridge.registerDataframe.mock.calls[1]?.[1]).toEqual(
      bridge.registerDataframe.mock.calls[0]?.[1],
    );
    expect(bridge.registerDataframe.mock.calls[1]?.[1]).toMatchObject({
      queryParams: { limit: 20 },
    });
    expect(at21).toEqual(at20);
  });

  it('accepts up to 1000 with the switch on; off, advertises 20 and rejects 21', async () => {
    const maximum = (clampOversizedLimits: boolean) =>
      (
        z.toJSONSchema(createGetBeneficialOwnersTool({ clampOversizedLimits }).input, {
          io: 'input',
        }) as any
      ).properties.limit.maximum;
    expect(maximum(true)).toBe(1000);
    expect(maximum(false)).toBe(20);
    expect(getBeneficialOwnersTool.input.safeParse({ ...args, limit: 1000 }).success).toBe(true);

    const off = createGetBeneficialOwnersTool({ clampOversizedLimits: false });
    const rejected = await runToolContract(off, { ...args, limit: 21 });
    expect(rejected.isError).toBe(true);
    expect(wireError(rejected).code).toBe(JsonRpcErrorCode.InvalidParams);
  });
});
