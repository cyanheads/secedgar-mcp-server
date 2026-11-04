/**
 * @fileoverview `EdgarApiService.resolveCik` exercised against the real service with
 * `globalThis.fetch` stubbed, rather than mocked away at a tool-test call site. Covers
 * the name passes (exact → prefix → substring, including corporate-suffix normalization,
 * #107), resolution within the best tier — a suffix-dropped exact match, and former names
 * that tie current ones but never outrank them (#155) — the comma, period, and apostrophe
 * fold (#210), whitespace runs and spaced initials (#219), word boundaries on the prefix and
 * substring tiers (#218), and the catch-all ticker fallback (including the dotted
 * share-class retry, #110). The registry fixture mirrors live
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

import { CallScope } from '@/services/edgar/call-scope.js';
import { getEdgarApiService, initEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import type { CikMatch } from '@/services/edgar/types.js';

const scope = () => new CallScope(new AbortController().signal);

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
  // Commas, periods, and apostrophes a query may leave out (#210), beside the registrants a
  // weaker tier reaches when it does.
  { cik_str: 1236275, ticker: 'QXO', title: 'QXO, Inc.' },
  { cik_str: 36104, ticker: 'USB', title: 'US BANCORP \\DE\\' },
  { cik_str: 1951070, ticker: 'MH', title: 'McGraw Hill, Inc.' },
  { cik_str: 1632790, ticker: 'ENR', title: 'ENERGIZER HOLDINGS, INC.' },
  { cik_str: 2012383, ticker: 'BLK', title: 'BlackRock, Inc.' },
  { cik_str: 832327, ticker: 'BKT', title: 'BLACKROCK INCOME TRUST, INC.' },
  { cik_str: 1512673, ticker: 'XYZ', title: 'Block, Inc.' },
  { cik_str: 12659, ticker: 'HRB', title: 'H&R BLOCK INC' },
  { cik_str: 794367, ticker: 'M', title: "Macy's, Inc." },
  { cik_str: 1449794, ticker: 'EMYB', title: 'Embassy Bancorp, Inc.' },
  { cik_str: 27093, ticker: 'USAU', title: 'U.S. GOLD CORP.' },
  { cik_str: 1947244, ticker: 'USGO', title: 'U.S. GoldMining Inc.' },
  // Later SPACs whose titles extend an earlier one's former name mid-word, and a title holding
  // a delisted symbol mid-word (#218).
  { cik_str: 2099656, ticker: 'HLXC', title: 'Helix Acquisition Corp. III' },
  { cik_str: 2030482, ticker: 'PLMK', title: 'Plum Acquisition Corp. IV' },
  { cik_str: 2128045, ticker: 'BCCQ', title: 'Bleichroeder Acquisition Corp. III' },
  { cik_str: 1724009, ticker: 'PRT', title: 'PermRock Royalty Trust' },
  // Conformed names that space their initials (#219).
  { cik_str: 91419, ticker: 'SJM', title: 'J M SMUCKER Co' },
  { cik_str: 728535, ticker: 'JBHT', title: 'HUNT J B TRANSPORT SERVICES INC' },
  { cik_str: 1025378, ticker: 'WPC', title: 'W. P. Carey Inc.' },
  // Seven titles that start with the word `Core`, in registry order, and no former name that
  // does: one prefix tier holding more candidates than any cut short of all of them (#229).
  { cik_str: 1856525, ticker: 'CNM', title: 'Core & Main, Inc.' },
  { cik_str: 1710366, ticker: 'CNR', title: 'Core Natural Resources, Inc.' },
  { cik_str: 1839341, ticker: 'CORZ', title: 'Core Scientific, Inc./tx' },
  { cik_str: 1958086, ticker: 'CLB', title: 'Core Laboratories Inc. /DE/' },
  { cik_str: 1026655, ticker: 'CMT', title: 'CORE MOLDING TECHNOLOGIES INC' },
  { cik_str: 1853599, ticker: 'CCOOF', title: 'CORE SILVER CORP.' },
  { cik_str: 1649009, ticker: 'CHAI', title: 'Core AI Holdings, Inc.' },
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
  const resolved = await getEdgarApiService().resolveCik(query, scope());
  expect(Array.isArray(resolved), `expected a single match for '${query}'`).toBe(false);
  return resolved as CikMatch;
}

/** Resolve and return the CIKs, whatever the arity. */
async function resolveCiks(query: string): Promise<string[]> {
  const resolved = await getEdgarApiService().resolveCik(query, scope());
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
    expect(await getEdgarApiService().resolveCik('zzzzzzzz not a company', scope())).toEqual([]);
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

  it('returns every candidate of the winning tier, in registry order (#229)', async () => {
    // Seven current prefix hits; the cut that kept the first five is gone, so a consumer's
    // own cut (10) and count see the whole tier.
    expect(await resolveCiks('Core')).toEqual([
      '0001856525',
      '0001710366',
      '0001839341',
      '0001958086',
      '0001026655',
      '0001853599',
      '0001649009',
    ]);
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
    expect(await getEdgarApiService().resolveCik('ZZZZ.Q', scope())).toEqual([]);
  });

  it('keeps the name passes ahead of the dotted ticker fallback (#110)', async () => {
    // A name containing a literal '.' still resolves by name, not by substitution.
    expect(await resolveCiks('Fluent, Inc.')).toEqual(['0001460329']);
  });

  // --- Commas, periods, and apostrophes (#210) ---

  it.each([
    ['QXO Inc', '0001236275'],
    ['U.S. Bancorp', '0000036104'],
    // A former name of 0001885408, `jeffs' brands ltd`: the fold reaches former names too.
    ['Jeffs Brands', '0001885408'],
    ['Jeffs’ Brands', '0001885408'],
    ['Macys', '0000794367'],
    ['Macy’s', '0000794367'],
    ['Fluent Inc', '0001460329'],
  ])(
    'resolves %s once commas, periods, and apostrophes leave both sides (#210)',
    async (query, cik) => {
      expect(await resolveCiks(query)).toEqual([cik]);
    },
  );

  it('resolves a title equal once folded ahead of another registrant matching as written (#210)', async () => {
    // As written, BLACKROCK INCOME TRUST, INC. starts with 'blackrock inc' and H&R BLOCK INC
    // contains 'block inc'; BlackRock, Inc. and Block, Inc. equal each query once folded.
    expect(await resolveCiks('BlackRock Inc')).toEqual(['0002012383']);
    expect(await resolveCiks('Block Inc')).toEqual(['0001512673']);
  });

  it('ranks a match exact as written ahead of one exact only once folded (#210)', async () => {
    // S&P Global's former name 'mcgraw hill inc' (0000064040) equals the title once folded.
    expect(await resolveCiks('McGraw Hill, Inc.')).toEqual(['0001951070']);
  });

  it('lists a current registrant first when it now ties a former name (#210)', async () => {
    // Each query equals a former name as written and the current title once folded; a
    // former name never outranks a current one (#155), so both list, current first.
    expect(await resolveCiks('McGraw Hill Inc')).toEqual(['0001951070', '0000064040']);
    expect(await resolveCiks('energizer holdings inc')).toEqual(['0001632790', '0001096752']);
  });

  it('accepts a spelled-out suffix once folded (#210)', async () => {
    // 'meta platforms inc' and 'qxo inc' read as 'incorporated' once their suffix expands.
    expect(await resolveCiks('Meta Platforms Incorporated')).toEqual(['0001326801']);
    expect(await resolveCiks('QXO Incorporated')).toEqual(['0001236275']);
  });

  it('resolves a folded title minus its suffix ahead of a folded prefix hit (#210)', async () => {
    // 'us gold' is U.S. GOLD CORP. once folded and its suffix drops; U.S. GoldMining Inc.
    // only starts with it.
    expect(await resolveCiks('US Gold')).toEqual(['0000027093']);
  });

  it('keeps the substring tier as written (#210)', async () => {
    // Embassy Bancorp, Inc. contains 'sy bancorp inc' once folded, not 's.y. bancorp inc'; the
    // query reaches Stock Yards' former name 's y bancorp inc' once its initials join (#219).
    expect(await resolveCiks('S.Y. Bancorp Inc')).toEqual(['0000835324']);
  });

  it.each([
    ['QXO, Inc.', '0001236275'],
    ['US BANCORP \\DE\\', '0000036104'],
    ['ENERGIZER HOLDINGS, INC.', '0001632790'],
    ['BLACKROCK INCOME TRUST, INC.', '0000832327'],
    ['H&R BLOCK INC', '0000012659'],
    ['Block, Inc.', '0001512673'],
    ["Macy's, Inc.", '0000794367'],
    ['Embassy Bancorp, Inc.', '0001449794'],
    ['Toro Corp.', '0001941131'],
  ])(
    'resolves %s, typed as the registry lists it, to its own CIK alone (#210)',
    async (query, cik) => {
      expect(await resolveCiks(query)).toEqual([cik]);
    },
  );

  // --- Whitespace runs and spaced initials (#219) ---

  it.each([
    ['JM Smucker', '0000091419'],
    ['J.M. Smucker', '0000091419'],
    ['J. M. Smucker', '0000091419'],
    ['J M Smucker', '0000091419'],
    ['Hunt JB Transport Services', '0000728535'],
    ['WP Carey', '0001025378'],
    ['W.P. Carey', '0001025378'],
  ])('resolves %s to a title that spaces its initials (#219)', async (query, cik) => {
    expect(await resolveCiks(query)).toEqual([cik]);
  });

  it('matches the start of a title once its initials join, ending at a word (#219)', async () => {
    // HUNT J B TRANSPORT SERVICES INC reads 'hunt jb transport services inc' once joined.
    expect(await resolveCiks('Hunt JB Transport')).toEqual(['0000728535']);
  });

  it('resolves a former name with a double space typed single-spaced (#219)', async () => {
    // 'forgent networks  inc', a former name of ASURE SOFTWARE INC.
    expect(await resolveCiks('Forgent Networks Inc')).toEqual(['0000884144']);
    expect(await resolveCiks('forgent networks  inc')).toEqual(['0000884144']);
  });

  it('collapses a whitespace run in the query (#219)', async () => {
    expect(await resolveCiks('Blue Owl  Capital Inc')).toEqual(['0001823945']);
  });

  it('lists the current registrant first for a former name it equals once joined (#219)', async () => {
    // The former name matches as written; U.S. GOLD CORP. matches once its initials join. A
    // former name never outranks a current one (#155), so both list, current first.
    expect(await resolveCiks('u s gold corp')).toEqual(['0000027093', '0000314203']);
  });

  it.each(['.', ',', "'", '..'])(
    'fails %s, a query with no letter or digit, as no match (#219)',
    async (query) => {
      expect(await getEdgarApiService().resolveCik(query, scope())).toEqual([]);
    },
  );

  // --- Word boundaries on the prefix and substring tiers (#218) ---

  it.each([['SY Bancorp, Inc.'], ['SY Bancorp']])(
    'resolves %s to Stock Yards, not to Embassy Bancorp around it (#218)',
    async (query) => {
      // 'embassy bancorp, inc.' contains the query inside 'embassy'; Stock Yards' former name
      // 's y bancorp inc' (0000835324) equals it once its initials join.
      expect(await resolveCiks(query)).toEqual(['0000835324']);
    },
  );

  it.each([
    ['helix acquisition corp ii', '0001869105'],
    ['plum acquisition corp i', '0001840317'],
    ['bleichroeder acquisition corp i', '0002028707'],
  ])(
    'resolves %s to its former holder alone, not a later SPAC extending its last word (#218)',
    async (query, cik) => {
      // 'helix acquisition corp iii' starts with 'helix acquisition corp ii' mid-word.
      expect(await resolveCiks(query)).toEqual([cik]);
    },
  );

  it('keeps a SPAC former name typed with its period beside the title containing it (#218)', async () => {
    // 'helix acquisition corp. iii' contains 'helix acquisition corp. ii' as written, from its
    // first word; the former name equals the query as written and joins the tie (#155).
    expect(await resolveCiks('Helix Acquisition Corp. II')).toEqual(['0002099656', '0001869105']);
  });

  it('no longer reaches a title holding a delisted symbol mid-word (#218)', async () => {
    // MRO has no registry row; 'permrock royalty trust' holds 'mro' inside 'permrock'.
    expect(await getEdgarApiService().resolveCik('MRO', scope())).toEqual([]);
    expect(await resolveCiks('PermRock')).toEqual(['0001724009']);
  });

  it.each([
    ['Berkshire Hath', '0001067983'],
    ['Microso', '0000789019'],
  ])(
    'resolves %s, a query ending mid-word that the title contains as written (#218)',
    async (query, cik) => {
      expect(await resolveCiks(query)).toEqual([cik]);
    },
  );
});
