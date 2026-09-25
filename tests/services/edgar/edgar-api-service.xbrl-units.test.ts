/**
 * @fileoverview SEC's companyconcept endpoint serves some filers' units as an
 * empty object where an array belongs (`"units":{"USD":{}}` for Visa's and
 * Coca-Cola's NetIncomeLoss). These tests run the real `EdgarApiService` over a
 * mocked `fetch`, so the edge validation and the tools reading through it are
 * both exercised: the service drops a unit that is not an array, and
 * `secedgar_get_financials` answers from companyfacts when a tag is left with
 * no values (#141).
 * @module tests/services/edgar/edgar-api-service.xbrl-units
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { config, mirrorRef } = vi.hoisted(() => ({
  config: {
    userAgent: 'test test@example.com',
    rateLimitRps: 10,
    rateLimitCooldownSeconds: 600,
    tickerCacheTtl: 3600,
    mirrorFallbackLive: true,
  },
  mirrorRef: { current: undefined as Record<string, ReturnType<typeof vi.fn>> | undefined },
}));

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));
vi.mock('@/services/edgar/mirror/index.js', () => ({ getEdgarMirror: () => mirrorRef.current }));

import { getFinancialsTool } from '@/mcp-server/tools/definitions/get-financials.tool.js';
import { getSnapshotTool } from '@/mcp-server/tools/definitions/get-snapshot.tool.js';
import { getEdgarApiService, initEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { blockText, caught } from '../../support/assertions.js';

const VISA_CIK = '0001403161';

const tenK = {
  start: '2024-10-01',
  end: '2025-09-30',
  accn: '0001403161-25-000080',
  filed: '2025-11-06',
  form: '10-K',
  fp: 'FY',
  frame: 'CY2025',
  fy: 2025,
  val: 20_058_000_000,
};

/** Visa's live NetIncomeLoss companyconcept payload, as SEC serves it. */
const malformedConcept = {
  cik: 1403161,
  taxonomy: 'us-gaap',
  tag: 'NetIncomeLoss',
  label: 'Net Income (Loss) Attributable to Parent',
  description: 'Net income attributable to the parent.',
  entityName: 'Visa Inc.',
  units: { USD: {} },
};

/** Visa's companyfacts: well-formed for NetIncomeLoss, one malformed tag beside it. */
const companyFacts = {
  cik: 1403161,
  entityName: 'Visa Inc.',
  facts: {
    'us-gaap': {
      NetIncomeLoss: {
        label: 'Net Income (Loss) Attributable to Parent',
        description: 'Net income attributable to the parent.',
        units: { USD: [tenK] },
      },
      Assets: { label: 'Assets', units: { USD: {} } },
    },
  },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Route each SEC URL this suite touches; `facts` null answers companyfacts with a 404. */
function stubSec(facts: unknown = companyFacts) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('company_tickers_mf.json')) return json({ fields: ['cik'], data: [] });
    if (url.includes('company_tickers.json')) {
      return json({ '0': { cik_str: 1403161, ticker: 'V', title: 'Visa Inc.' } });
    }
    if (url.includes('/companyconcept/') && url.endsWith('/NetIncomeLoss.json')) {
      return json(malformedConcept);
    }
    if (url.includes('/companyfacts/')) return facts ? json(facts) : json({}, 404);
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  mirrorRef.current = undefined;
  initEdgarApiService();
});

afterEach(() => vi.unstubAllGlobals());

describe('XBRL unit validation at the service edge (#141)', () => {
  it('drops a companyconcept unit served as an object, keeping the payload', async () => {
    stubSec();
    const concept = await getEdgarApiService().tryGetCompanyConcept(
      VISA_CIK,
      'us-gaap',
      'NetIncomeLoss',
    );
    expect(concept?.tag).toBe('NetIncomeLoss');
    expect(concept?.units).toEqual({});
  });

  it('drops the same shape from a companyfacts payload, leaving well-formed tags intact', async () => {
    stubSec();
    const facts = await getEdgarApiService().tryGetCompanyFacts(VISA_CIK);
    expect(facts?.facts['us-gaap']?.Assets?.units).toEqual({});
    expect(facts?.facts['us-gaap']?.NetIncomeLoss?.units.USD).toEqual([tenK]);
  });

  it('applies to mirror-served payloads too', async () => {
    mirrorRef.current = {
      companyFactsReady: vi.fn().mockResolvedValue(true),
      getCompanyConcept: vi.fn().mockResolvedValue({
        ...malformedConcept,
        units: { USD: {}, EUR: [tenK] },
      }),
    };
    stubSec();
    const concept = await getEdgarApiService().tryGetCompanyConcept(
      VISA_CIK,
      'us-gaap',
      'NetIncomeLoss',
    );
    expect(concept?.units).toEqual({ EUR: [tenK] });
  });
});

describe('tools reading through the edge (#141)', () => {
  it('get_financials answers Visa net income from companyfacts instead of failing', async () => {
    const fetchMock = stubSec();
    const result = await runToolContract(getFinancialsTool, {
      company: 'V',
      concept: 'net_income',
      limit: 3,
    });

    expect(result.isError).toBeFalsy();
    const text = blockText(result.content);
    expect(text).not.toContain('is not iterable');
    expect(text).toContain('CY2025: $20058.0M (raw 20058000000)');
    expect(getFinancialsTool.output.parse(result.structuredContent).data).toEqual([
      expect.objectContaining({ period: 'CY2025', value: 20_058_000_000, form: '10-K' }),
    ]);
    const companyFactsReads = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes('/companyfacts/'),
    );
    expect(companyFactsReads).toHaveLength(1);
  });

  it('get_financials fails as no_concept_data when companyfacts has nothing either', async () => {
    stubSec(null);
    const ctx = createMockContext({ errors: getFinancialsTool.errors });
    const err = await caught(
      getFinancialsTool.handler(
        getFinancialsTool.input.parse({ company: 'V', concept: 'net_income' }),
        ctx,
      ),
    );
    expect(err.data.reason).toBe('no_concept_data');
    expect(err.message).not.toContain('is not iterable');
  });

  it('get_snapshot tolerates the shape inside companyfacts and matches get_financials', async () => {
    stubSec();
    const ctx = createMockContext({ errors: getSnapshotTool.errors });
    const result = await getSnapshotTool.handler(
      getSnapshotTool.input.parse({ company: 'V' }),
      ctx,
    );
    expect(result.lines.find((l) => l.concept === 'net_income')?.annual).toMatchObject({
      period: 'CY2025',
      value: 20_058_000_000,
    });
    expect(result.gaps.map((g) => g.concept)).toContain('assets');
  });
});
