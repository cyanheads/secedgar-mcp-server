/**
 * @fileoverview `trigramScorer` — the Dice trigram scorer behind
 * near-match suggestions — and the two scoring passes that use it: `findUnknownConcept`'s
 * nearest catalog names, and `suggestCompanies` over the ticker index (the registry served
 * by a stubbed `fetch`, beside the committed former-names asset). A seeded differential
 * holds the scorer and both passes to a reference copy of the two-argument Dice computation
 * (same scores, same suggestions in the same order), and a thread-CPU suite holds both
 * passes linear in the length of the caller's string.
 * @module tests/services/edgar/trigram-similarity
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
import { findUnknownConcept, getAllConcepts } from '@/services/edgar/concept-map.js';
import {
  disposeEdgarApiService,
  getEdgarApiService,
  initEdgarApiService,
  suggestCompanies,
} from '@/services/edgar/edgar-api-service.js';
import { trigramScorer } from '@/services/edgar/trigram-similarity.js';
import type { CikMatch } from '@/services/edgar/types.js';

/** Each string's padded trigram set, kept so the reference rankings rebuild none per query. */
const referenceGrams = new Map<string, Set<string>>();

/**
 * The two-argument Dice coefficient over padded trigram sets: the reference every scorer
 * result and every suggestion list here is held to.
 */
function referenceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const grams = (s: string) => {
    const known = referenceGrams.get(s);
    if (known) return known;
    const padded = `  ${s}  `;
    const set = new Set<string>();
    for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
    referenceGrams.set(s, set);
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 && gb.size === 0) return 1;
  if (ga.size === 0 || gb.size === 0) return 0;
  let intersection = 0;
  for (const g of ga) {
    if (gb.has(g)) intersection++;
  }
  return (2 * intersection) / (ga.size + gb.size);
}

/** mulberry32: a seeded generator, so every run draws the same inputs. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error('pick from an empty list');
  return item;
}

/** `source` after one to three random edits: a deletion, insertion, substitution, or swap. */
function mutate(rand: () => number, source: string, alphabet: readonly string[]): string {
  let s = source;
  const edits = 1 + Math.floor(rand() * 3);
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(rand() * (s.length + 1));
    const ch = pick(rand, alphabet);
    const kind = Math.floor(rand() * 4);
    if (kind === 0) s = s.slice(0, at) + s.slice(at + 1);
    else if (kind === 1) s = s.slice(0, at) + ch + s.slice(at);
    else if (kind === 2) s = s.slice(0, at) + ch + s.slice(at + 1);
    else s = s.slice(0, at) + s.slice(at + 1, at + 2) + s.slice(at, at + 1) + s.slice(at + 2);
  }
  return s;
}

/** Letters in both cases, digits, separators, NBSP, line breaks, and an astral character. */
const MIXED_ALPHABET = [...'abcxyzAB019 _-.,&§ \r\n𝔸'];
const KEY_ALPHABET = [...'abcdefghijklmnopqrstuvwxyz_'];

function randomString(rand: () => number, maxLength: number): string {
  const length = Math.floor(rand() * (maxLength + 1));
  return Array.from({ length }, () => pick(rand, MIXED_ALPHABET)).join('');
}

const scope = () => new CallScope(new AbortController().signal);

/** Rows copied from `company_tickers.json`: one CIK listed twice, two suffix variants. */
const REGISTRY: Array<{ cik_str: number; ticker: string; title: string }> = [
  { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  { cik_str: 789019, ticker: 'MSFT', title: 'MICROSOFT CORP' },
  { cik_str: 1067983, ticker: 'BRK-B', title: 'BERKSHIRE HATHAWAY INC' },
  { cik_str: 1067983, ticker: 'BRK-A', title: 'BERKSHIRE HATHAWAY INC' },
  { cik_str: 1326801, ticker: 'META', title: 'Meta Platforms, Inc.' },
  { cik_str: 737758, ticker: 'TTC', title: 'TORO CO' },
  { cik_str: 1941131, ticker: 'TORO', title: 'TORO CORP.' },
  { cik_str: 1460329, ticker: 'FLNT', title: 'Fluent, Inc.' },
  { cik_str: 1758124, ticker: 'CNTMF', title: 'Fluent Corp.' },
  { cik_str: 86312, ticker: 'TRV', title: 'TRAVELERS COMPANIES, INC.' },
];

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** The ticker index's entries, built by the service from the stubbed registry and the asset. */
let entries: CikMatch[] = [];

beforeAll(async () => {
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
  initEdgarApiService();
  entries = await getEdgarApiService().getAllEntries(scope());
});

afterAll(() => {
  disposeEdgarApiService();
  vi.unstubAllGlobals();
});

describe('trigramScorer', () => {
  it.each([
    ['ab', 'abc', 4 / 9],
    ['abc', 'ab', 4 / 9],
    ['microsoft corp', 'microsoft corp', 1],
    ['', '', 1],
    ['', 'a', 0],
    ['xyz', 'abc', 0],
  ])('scores %j against %j as %d', (a, b, want) => {
    expect(trigramScorer(a)(b)).toBe(want);
  });

  it('scores every seeded pair exactly as the reference, one scorer reused across many strings', () => {
    const rand = seeded(0x7a1);
    const mismatches: Array<{ a: string; b: string; got: number; want: number }> = [];
    let compared = 0;
    let partial = 0;
    for (let i = 0; i < 300; i++) {
      const a = randomString(rand, 40);
      const score = trigramScorer(a);
      const others = [
        a,
        '',
        a.toUpperCase(),
        ...Array.from({ length: 13 }, () => mutate(rand, a, MIXED_ALPHABET)),
        ...Array.from({ length: 4 }, () => randomString(rand, 40)),
      ];
      for (const b of others) {
        const want = referenceSimilarity(a, b);
        const got = score(b);
        if (!Object.is(got, want)) mismatches.push({ a, b, got, want });
        compared++;
        if (want > 0 && want < 1) partial++;
      }
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBe(6_000);
    expect(partial).toBeGreaterThan(3_000);
  });
});

describe('findUnknownConcept suggestions', () => {
  /** The reference ranking: name and label scored, the higher kept, ≥ 0.3, ties by name, top three. */
  function referenceNearest(key: string): string[] {
    const words = key.replace(/_/g, ' ');
    return Object.entries(getAllConcepts())
      .map(([name, mapping]) => ({
        name,
        score: Math.max(
          referenceSimilarity(key, name),
          referenceSimilarity(words, mapping.label.toLowerCase()),
        ),
      }))
      .filter((candidate) => candidate.score >= 0.3)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 3)
      .map((candidate) => candidate.name);
  }

  it('suggests the reference’s names in its order for seeded near-misses of names and labels', () => {
    const rand = seeded(0xc0de);
    const sources = Object.entries(getAllConcepts()).flatMap(([name, mapping]) => [
      name,
      mapping.label.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    ]);
    const mismatches: Array<{ input: string; got: string[]; want: string[] }> = [];
    let compared = 0;
    let several = 0;
    for (let i = 0; i < 400; i++) {
      // A lowercase key of letters and underscores is its own catalog key, split or not.
      const input = mutate(rand, pick(rand, sources), KEY_ALPHABET);
      if (!/^[a-z][a-z0-9_]*$/.test(input)) continue;
      const unknown = findUnknownConcept(input);
      if (!unknown || unknown.derivation) continue;
      const want = referenceNearest(input);
      compared++;
      if (want.length > 1) several++;
      if (unknown.suggestions.join('|') !== want.join('|')) {
        mismatches.push({ input, got: unknown.suggestions, want });
      }
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBeGreaterThan(300);
    expect(several).toBeGreaterThan(150);
  });
});

describe('suggestCompanies over the ticker index', () => {
  /** The reference ranking: name and ticker scored, the higher kept, ≥ 0.3, stable sort, top three, one per CIK. */
  function referenceSuggestions(query: string, list: readonly CikMatch[]) {
    const q = query.toLowerCase();
    const top = list
      .map((entry) => ({
        entry,
        score: Math.max(
          entry.name ? referenceSimilarity(q, entry.name.toLowerCase()) : 0,
          entry.ticker ? referenceSimilarity(q, entry.ticker.toLowerCase()) : 0,
        ),
      }))
      .filter((scored) => scored.score >= 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    const seen = new Set<string>();
    return top.flatMap(({ entry }) => {
      if (seen.has(entry.cik)) return [];
      seen.add(entry.cik);
      return [
        {
          cik: entry.cik,
          ...(entry.name !== undefined ? { name: entry.name } : {}),
          ...(entry.ticker !== undefined ? { ticker: entry.ticker } : {}),
        },
      ];
    });
  }

  it('reads registry rows and former names into the index it scores', () => {
    expect(entries.some((entry) => entry.ticker === 'BRK-A')).toBe(true);
    expect(entries.some((entry) => entry.ticker === undefined && entry.name)).toBe(true);
    expect(entries.length).toBeGreaterThan(6_000);
  });

  it('suggests the reference’s companies in its order for seeded near-misses of names and tickers', () => {
    const rand = seeded(0xb1d);
    // Every registry row and every third former name, in index order, so ties rank as they do.
    const index = entries.filter((entry, i) => entry.ticker !== undefined || i % 3 === 0);
    const sources = index.flatMap((entry) => [entry.name, entry.ticker]).filter(Boolean);
    const mismatches: Array<{ query: string; got: unknown; want: unknown }> = [];
    let several = 0;
    for (let i = 0; i < 100; i++) {
      const source = pick(rand, sources as string[]);
      const query = mutate(rand, rand() < 0.5 ? source : source.toUpperCase(), MIXED_ALPHABET);
      const got = suggestCompanies(query, index);
      const want = referenceSuggestions(query, index);
      if (want.length > 1) several++;
      if (JSON.stringify(got) !== JSON.stringify(want)) mismatches.push({ query, got, want });
    }
    expect(mismatches).toEqual([]);
    expect(several).toBeGreaterThan(50);
  });
});

describe('both scoring passes — linear in the length of the caller’s string', () => {
  const fill = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length));

  /**
   * Thread CPU milliseconds one call takes, least of five rounds: wall clock is noise under a
   * parallel suite. A round runs calls until it holds the work near 320k characters or has
   * spent 25 ms, so a call too short to time alone is timed over a batch, and a long one is
   * not repeated past what one measurement needs.
   */
  function perCallCpuMs(run: (text: string) => unknown, text: string): number {
    const batch = Math.max(1, Math.round(320_000 / text.length));
    let least = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 5; round++) {
      const start = process.threadCpuUsage();
      let calls = 0;
      let usedMs = 0;
      do {
        run(text);
        calls++;
        const used = process.threadCpuUsage(start);
        usedMs = (used.user + used.system) / 1000;
      } while (calls < batch && usedMs < 25);
      least = Math.min(least, usedMs / calls);
    }
    return least;
  }

  /**
   * Doubles n from 5,000 to 320,000, checking the CPU bound at each size before building the
   * next, so a regression fails at the first size it breaks instead of running every size,
   * then holds the 64× span's ratio under 256, where a quadratic scan reaches 4,096.
   */
  function expectLinear(
    run: (text: string) => unknown,
    build: (n: number) => string,
    boundMs: number,
  ): void {
    const small = build(5_000);
    run(small); // warm the JIT
    const t5k = Math.max(perCallCpuMs(run, small), 0.001);
    expect(t5k, '5000 characters').toBeLessThan(boundMs);
    let last = t5k;
    for (let n = 10_000; n <= 320_000; n *= 2) {
      last = perCallCpuMs(run, build(n));
      expect(last, `${n} characters`).toBeLessThan(boundMs);
    }
    expect(last / t5k).toBeLessThan(256);
  }

  // Each bound sits at two to four times the slowest call measured at 320k on either runtime.

  // Each concept shape opens lowercase, so the camelCase split runs too, and survives the trim.
  it.each([
    ['a long digit run', (n: number) => `a${fill('1', n)}`],
    ['one long line ending in a break', (n: number) => `a${fill('§1 x', n)}\ny`],
    ['breaks throughout', (n: number) => `a${fill('  \r\n', n)}B`],
  ])('findUnknownConcept: %s (5k → 320k)', (_label, build) => {
    expectLinear(findUnknownConcept, build, 120);
  });

  it.each([
    ['a long digit run', (n: number) => fill('1', n)],
    ['one long line ending in a break', (n: number) => `${fill('§1 x', n)}\ny`],
    ['breaks throughout', (n: number) => fill('  \r\n', n)],
  ])('suggestCompanies over the ticker index: %s (5k → 320k)', (_label, build) => {
    expectLinear((text) => suggestCompanies(text, entries), build, 100);
  });
});
