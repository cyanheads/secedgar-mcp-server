/**
 * @fileoverview `EdgarApiService.resolveCik` exercised against the real service with
 * `globalThis.fetch` stubbed, rather than mocked away at a tool-test call site. Covers
 * the name passes (exact → prefix → substring, including corporate-suffix normalization,
 * #107) and the catch-all ticker fallback (including the dotted share-class retry, #110).
 * The registry fixture mirrors live `company_tickers.json` rows verbatim — the suffix and
 * share-class shapes these behaviors turn on only exist in real registrant titles.
 * @module tests/services/edgar/edgar-api-service.resolve-cik
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { config } = vi.hoisted(() => ({
  config: {
    userAgent: 'test test@example.com',
    rateLimitRps: 1000,
    tickerCacheTtl: 3600,
    mirrorFallbackLive: true,
  },
}));

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));
vi.mock('@/services/edgar/mirror/index.js', () => ({ getEdgarMirror: () => undefined }));

import { getEdgarApiService, initEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import type { CikMatch } from '@/services/edgar/types.js';

/**
 * Rows copied verbatim from `https://www.sec.gov/files/company_tickers.json`.
 * The suffix pairs (`TORO CO` / `TORO CORP.`, the two Blue Owls, the two Fluents)
 * are real distinct registrants that differ only in suffix form — the exact case
 * suffix normalization must not conflate.
 */
const REGISTRY: Array<{ cik_str: number; ticker: string; title: string }> = [
  { cik_str: 1108134, ticker: 'BBT', title: 'Beacon Financial Corp' },
  { cik_str: 737758, ticker: 'TTC', title: 'TORO CO' },
  { cik_str: 1941131, ticker: 'TORO', title: 'TORO CORP.' },
  { cik_str: 1823945, ticker: 'OWL', title: 'BLUE OWL CAPITAL INC.' },
  { cik_str: 1655888, ticker: 'OBDC', title: 'Blue Owl Capital Corp' },
  { cik_str: 1460329, ticker: 'FLNT', title: 'Fluent, Inc.' },
  { cik_str: 1758124, ticker: 'CNTMF', title: 'Fluent Corp.' },
  { cik_str: 1817511, ticker: 'SOPAQ', title: 'SOCIETY PASS INCORPORATED.' },
  { cik_str: 1410636, ticker: 'AWK', title: 'American Water Works Company, Inc.' },
  { cik_str: 867840, ticker: 'POCI', title: 'PRECISION OPTICS CORPORATION, INC.' },
  { cik_str: 1584273, ticker: 'SNROY', title: 'Sanrio Company, Ltd./ADR' },
  { cik_str: 1067983, ticker: 'BRK-B', title: 'BERKSHIRE HATHAWAY INC' },
  { cik_str: 1067983, ticker: 'BRK-A', title: 'BERKSHIRE HATHAWAY INC' },
  { cik_str: 14693, ticker: 'BF-B', title: 'BROWN FORMAN CORP' },
  { cik_str: 789019, ticker: 'MSFT', title: 'MICROSOFT CORP' },
];

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** Serve the registry fixture for company_tickers.json and an empty MF file. */
function stubRegistryFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('company_tickers_mf.json')) {
        return jsonResponse({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [] });
      }
      if (url.includes('company_tickers.json')) {
        return jsonResponse(Object.fromEntries(REGISTRY.map((row, i) => [String(i), row])));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

/** Resolve and assert a single match, returning it. */
async function resolveOne(query: string): Promise<CikMatch> {
  const resolved = await getEdgarApiService().resolveCik(query);
  expect(Array.isArray(resolved), `expected a single match for '${query}'`).toBe(false);
  return resolved as CikMatch;
}

/** Resolve and return the CIKs, whatever the arity. */
async function resolveCiks(query: string): Promise<string[]> {
  const resolved = await getEdgarApiService().resolveCik(query);
  return (Array.isArray(resolved) ? resolved : [resolved]).map((m) => m.cik);
}

describe('EdgarApiService.resolveCik', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubRegistryFetch();
    initEdgarApiService();
  });

  afterEach(() => vi.unstubAllGlobals());

  // --- Characterization: the passes that already work ---

  it('resolves a ticker through the short-alphabetic fast path', async () => {
    expect((await resolveOne('MSFT')).cik).toBe('0000789019');
  });

  it('resolves a name that matches a registry title verbatim', async () => {
    expect((await resolveOne('Beacon Financial Corp')).cik).toBe('0001108134');
  });

  it('resolves a numeric query as a CIK', async () => {
    expect((await resolveOne('789019')).cik).toBe('0000789019');
  });

  it('returns an empty array when nothing matches', async () => {
    expect(await getEdgarApiService().resolveCik('zzzzzzzz not a company')).toEqual([]);
  });

  it('keeps a name prefix hit ranked behind the exact hit', async () => {
    // 'toro co' matches TORO CO exactly, and TORO CORP. plus the committed former
    // name 'toro combineco, inc.' by prefix — a pre-existing multi-match this
    // change does not alter. Exact stays first.
    const ciks = await resolveCiks('Toro Co');
    expect(ciks[0]).toBe('0000737758');
    expect(ciks.length).toBeGreaterThan(1);
  });

  // --- Corporate-suffix normalization (#107) ---

  it('resolves a spelled-out suffix to the abbreviated registry title (#107)', async () => {
    const match = await resolveOne('Beacon Financial Corporation');
    expect(match.cik).toBe('0001108134');
    expect(match.ticker).toBe('BBT');
  });

  it('leaves the already-matching suffix form resolving exactly as before (#107)', async () => {
    expect(await resolveCiks('Beacon Financial Corp')).toEqual(['0001108134']);
  });

  it('keeps the co/company and corp/corporation buckets distinct (#107)', async () => {
    expect(await resolveCiks('Toro Company')).toEqual(['0000737758']);
    expect(await resolveCiks('Toro Corporation')).toEqual(['0001941131']);
  });

  it('keeps the inc/incorporated and corp/corporation buckets distinct (#107)', async () => {
    expect(await resolveCiks('Blue Owl Capital Inc')).toEqual(['0001823945']);
    expect(await resolveCiks('Blue Owl Capital Corp')).toEqual(['0001655888']);
    // The Fluent pair shares a base name across the same two buckets.
    expect(await resolveCiks('Fluent Corp')).toEqual(['0001758124']);
  });

  it('strips a trailing period from the registry suffix token (#107)', async () => {
    expect(await resolveCiks('Society Pass Inc')).toEqual(['0001817511']);
  });

  it('does not rewrite a long-form suffix word sitting mid-name (#107)', async () => {
    // Both titles carry Company/Corporation mid-name and end in `Inc.`; a query
    // ending in the mid-name word must not exact-match them through it.
    expect(await resolveCiks('American Water Works Corporation')).toEqual([]);
    expect(await resolveCiks('Precision Optics Company')).toEqual([]);
    // The actual terminal suffix still resolves.
    expect(await resolveCiks('American Water Works Company, Incorporated')).toEqual(['0001410636']);
  });

  it('leaves a name whose terminal token is not a suffix untouched (#107)', async () => {
    // 'ltd./adr' is not a recognized suffix token — the /ADR marker stays in place.
    expect(await resolveCiks('Sanrio Company, Limited')).toEqual([]);
    expect(await resolveCiks('Sanrio Company, Ltd./ADR')).toEqual(['0001584273']);
  });

  // --- Dotted share-class tickers (#110) ---

  it('resolves a dotted share-class ticker via the hyphenated registry form (#110)', async () => {
    expect((await resolveOne('BRK.B')).cik).toBe('0001067983');
    expect((await resolveOne('BF.B')).cik).toBe('0000014693');
  });

  it('leaves the hyphenated form resolving on the exact lookup (#110)', async () => {
    expect((await resolveOne('BRK-B')).cik).toBe('0001067983');
  });

  it('keeps a dotted ticker that resolves in neither form a no-match (#110)', async () => {
    expect(await getEdgarApiService().resolveCik('ZZZZ.Q')).toEqual([]);
  });

  it('keeps the name passes ahead of the dotted ticker fallback (#110)', async () => {
    // A name containing a literal '.' still resolves by name, not by substitution.
    expect(await resolveCiks('Fluent, Inc.')).toEqual(['0001460329']);
  });
});
