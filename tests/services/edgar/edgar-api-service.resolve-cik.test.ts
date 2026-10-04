/**
 * @fileoverview `EdgarApiService.resolveCik` exercised against the real service with
 * `globalThis.fetch` stubbed, rather than mocked away at a tool-test call site. Covers
 * the name passes (exact → prefix → substring, including corporate-suffix normalization,
 * #107), resolution within the best tier — a suffix-dropped exact match, and former names
 * that tie current ones but never outrank them (#155) — and the catch-all ticker fallback
 * (including the dotted share-class retry, #110). The registry fixture mirrors live
 * `company_tickers.json` rows verbatim, and the former names are the committed asset —
 * the suffix and share-class shapes these behaviors turn on only exist in real titles.
 * @module tests/services/edgar/edgar-api-service.resolve-cik
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { config } = vi.hoisted(() => ({
  config: {
    userAgent: 'test test@example.com',
    rateLimitRps: 1000,
    rateLimitCooldownSeconds: 600,
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
  // Name tiers (#155): each group holds an exact or sole-prefix hit beside weaker ones.
  { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  { cik_str: 1418121, ticker: 'APLE', title: 'Apple Hospitality REIT, Inc.' },
  { cik_str: 63330, ticker: 'MLP', title: 'MAUI LAND & PINEAPPLE CO INC' },
  { cik_str: 1134982, ticker: 'AAPI', title: 'Apple iSports Group, Inc.' },
  { cik_str: 1938109, ticker: 'PAPL', title: 'Pineapple Financial Inc.' },
  { cik_str: 1710495, ticker: 'PNXP', title: 'PINEAPPLE EXPRESS CANNABIS Co' },
  { cik_str: 780571, ticker: 'ITRI', title: 'ITRON, INC.' },
  { cik_str: 91668, ticker: 'SODI', title: 'SOLITRON DEVICES INC' },
  { cik_str: 844985, ticker: 'POSC', title: 'POSITRON CORP' },
  { cik_str: 942126, ticker: 'TAIT', title: 'TAITRON COMPONENTS INC' },
  { cik_str: 1866633, ticker: 'CCSI', title: 'Consensus Cloud Solutions, Inc.' },
  { cik_str: 1494891, ticker: 'SRTS', title: 'Sensus Healthcare, Inc.' },
  { cik_str: 1001838, ticker: 'SCCO', title: 'SOUTHERN COPPER CORP/' },
  { cik_str: 92122, ticker: 'SO', title: 'SOUTHERN CO' },
  { cik_str: 702165, ticker: 'NSC', title: 'NORFOLK SOUTHERN CORP' },
  { cik_str: 92122, ticker: 'SOJC', title: 'SOUTHERN CO' },
  { cik_str: 1747777, ticker: 'OTF', title: 'Blue Owl Technology Finance Corp.' },
  { cik_str: 86312, ticker: 'TRV', title: 'TRAVELERS COMPANIES, INC.' },
  { cik_str: 1326801, ticker: 'META', title: 'Meta Platforms, Inc.' },
  // Suffixes outside the four buckets (#107): dropped for a bare query, never merged.
  { cik_str: 312069, ticker: 'BCS', title: 'BARCLAYS PLC' },
  { cik_str: 312070, ticker: 'ATMP', title: 'BARCLAYS BANK PLC' },
  { cik_str: 1552275, ticker: 'SUN', title: 'Sunoco LP' },
  { cik_str: 2089661, ticker: 'SUNC', title: 'SunocoCorp LLC' },
  { cik_str: 887028, ticker: 'RTNTF', title: 'RIO TINTO LTD' },
  { cik_str: 863064, ticker: 'RIO', title: 'RIO TINTO PLC' },
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

  it('resolves an exact hit alone, without the prefix hits behind it (#155)', async () => {
    // 'toro co' matches TORO CO exactly, and TORO CORP. plus the committed former
    // name 'toro combineco, inc.' only by prefix — a weaker tier, so not ambiguity.
    expect(await resolveCiks('Toro Co')).toEqual(['0000737758']);
  });

  // --- Best-tier resolution (#155) ---

  it.each([
    // Exact once the registry's terminal suffix (and a comma before it) is dropped.
    ['Apple', '0000320193', 'Apple Inc.'],
    ['Itron', '0000780571', 'ITRON, INC.'],
    ['Southern', '0000092122', 'SOUTHERN CO'],
    // The only prefix hit; Consensus Cloud Solutions merely contains the query.
    ['Sensus', '0001494891', 'Sensus Healthcare, Inc.'],
  ])(
    'resolves %s within its best tier rather than listing weaker hits',
    async (query, cik, name) => {
      const match = await resolveOne(query);
      expect(match.cik).toBe(cik);
      expect(match.name).toBe(name);
    },
  );

  it('lists the CIKs sharing the winning tier, without the tiers below it (#155)', async () => {
    // Two current prefix hits, plus the former names 'pineapple energy inc.' and
    // 'pineapple holdings, inc.' (CIK 22701) at the same tier; MAUI LAND & PINEAPPLE
    // only contains the query and stays out.
    expect(await resolveCiks('Pineapple')).toEqual(['0001938109', '0001710495', '0000022701']);
  });

  it('keeps two suffix variants that both drop to the query ambiguous (#155)', async () => {
    // Dropping a suffix compares the registry name with the query as typed, so the
    // two registrants tie rather than one bucket winning.
    expect(await resolveCiks('Blue Owl Capital')).toEqual(['0001823945', '0001655888']);
    expect(await resolveCiks('Fluent')).toEqual(['0001460329', '0001758124']);
  });

  it('lets a former name tie a current one but never outrank it (#155)', async () => {
    // 'travelers inc' (a former name of CIK 831001) is exact once its suffix drops;
    // TRAVELERS COMPANIES, INC. is only a prefix hit. The current holder still wins
    // the tier choice, the former name joins as a tie, and current names list first.
    expect(await resolveCiks('Travelers')).toEqual(['0000086312', '0000831001']);
  });

  it('resolves a name only a former name matches (#155)', async () => {
    const match = await resolveOne('Facebook Inc');
    expect(match.cik).toBe('0001326801');
    expect(match.ticker).toBeUndefined();
  });

  it('drops plc and lp for a bare query, like the four buckets (#155)', async () => {
    // BARCLAYS PLC and Sunoco LP are exact once their suffix drops; BARCLAYS BANK PLC
    // and SunocoCorp LLC stay prefix hits.
    expect(await resolveCiks('Barclays')).toEqual(['0000312069']);
    expect(await resolveCiks('Sunoco')).toEqual(['0001552275']);
  });

  it('ties registrants whose suffixes fall in different sets (#155)', async () => {
    // `ltd` and `plc` both drop for a bare query, so neither registrant wins silently.
    expect(await resolveCiks('Rio Tinto')).toEqual(['0000887028', '0000863064']);
  });

  it('never drops the query suffix or merges plc into a bucket (#155)', async () => {
    expect(await resolveCiks('Rio Tinto plc')).toEqual(['0000863064']);
    expect(await resolveCiks('Rio Tinto Limited')).toEqual(['0000887028']);
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
