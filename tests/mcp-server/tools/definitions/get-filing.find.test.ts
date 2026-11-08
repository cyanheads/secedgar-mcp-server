/**
 * @fileoverview Tests for get_filing's `find` input (#238): where a find page
 * opens, `occurrences` and `occurrences_total` on both surfaces, the
 * continuation and paging guidance, `phrase_not_found`, precedence against
 * `section` and `offset`, the extract cache, `section_not_found`'s recovery
 * naming `find`, and CPU time on the paths a long match takes.
 * @module tests/mcp-server/tools/definitions/get-filing.find
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFilingTool } from '@/mcp-server/tools/definitions/get-filing.tool.js';
import type { CachedExtract } from '@/services/edgar/filing-to-text.js';
import type { FilingIndex, SubmissionsResponse } from '@/services/edgar/types.js';

vi.mock('@/config/server-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/server-config.js')>()),
  getServerConfig: () => ({
    userAgent: 'test test@example.com',
    rateLimitRps: 10,
    rateLimitCooldownSeconds: 600,
    tickerCacheTtl: 3600,
    mirrorFallbackLive: true,
  }),
}));

vi.mock('@/services/edgar/edgar-api-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/edgar/edgar-api-service.js')>()),
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
}));

// Only the extraction and its cache are stubbed: `findPhrase`, `windowText`, and
// `detectHeadings` are the scans and the page cut under test, so the real ones run.
vi.mock('@/services/edgar/filing-to-text.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/edgar/filing-to-text.js')>()),
  filingToExtract: vi.fn(),
  getExtractCache: vi.fn(),
  setExtractCache: vi.fn(),
}));

import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { filingToExtract, getExtractCache } from '@/services/edgar/filing-to-text.js';
import { bag, blockText, records, wireError } from '../../../support/assertions.js';
import { readCommonMark } from '../../../support/commonmark.js';

const ACCN = '0000320193-23-000106';
const CIK = '0000320193';
/** U+00A0, which `\s` reads as whitespace. */
const NBSP = String.fromCharCode(0xa0);

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
    ],
  },
};

const mockSubmissions: SubmissionsResponse = {
  cik: CIK,
  entityType: 'operating',
  exchanges: ['Nasdaq'],
  filings: {
    recent: {
      accessionNumber: [ACCN],
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
  tryGetFilingHeaders: vi.fn(),
  tryGetFilingPartyCiks: vi.fn(),
  tryGetSubmissionHeader: vi.fn(),
  getSubmissions: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as never);
  mockApi.findFilingCiks.mockResolvedValue([CIK]);
  mockApi.tryGetFilingIndex.mockResolvedValue(mockIndex);
  mockApi.tryGetFilingDocument.mockResolvedValue('<html><body><p>Filing</p></body></html>');
  mockApi.tryGetFilingHeaders.mockResolvedValue({
    documents: new Map([
      ['aapl-20230930.htm', { type: '10-K', sequence: '1', description: '10-K' }],
    ]),
    submission: {},
  });
  mockApi.getSubmissions.mockResolvedValue(mockSubmissions);
  mockApi.tryGetFilingPartyCiks.mockResolvedValue(null);
  mockApi.tryGetSubmissionHeader.mockRejectedValue(new Error('unexpected .hdr.sgml read'));
  vi.mocked(getExtractCache).mockReturnValue(undefined);
});

/** Serve `text` as the document's extraction. */
function serve(text: string): void {
  vi.mocked(filingToExtract).mockReturnValue(text);
}

/** One get_filing call through the framework's production parse and format(). */
function call(args: Record<string, unknown>) {
  return runToolContract(getFilingTool, { accession_number: ACCN, cik: '320193', ...args });
}

/** A successful call's structuredContent, the caller-visible text a CommonMark parse reads, and the raw text. */
async function page(args: Record<string, unknown>) {
  const result = await call(args);
  expect(result.isError).toBeFalsy();
  const sc = bag(result.structuredContent);
  const raw = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
  return { result, sc, read: readCommonMark(blockText(result.content)), raw };
}

/** Filler of exactly `length` characters, with no line break and no phrase in it. */
const filler = (length: number) => 'word '.repeat(Math.ceil(length / 5)).slice(0, length);

// ── The motivating S-1/A, laid out at its extraction's offsets ───────────────

/**
 * Where "Net Revenue Retention" occurs in 0001628280-26-068676's extracted text,
 * and where each occurrence's line starts, as the corpus copy of that filing
 * measures them; the text below is filler laid out at those offsets.
 */
const PHRASE_OFFSETS = [21404, 21518, 50801, 309173, 618387, 797702, 851983];
const LINE_STARTS = [21403, 21505, 50754, 309113, 618287, 797655, 851927];
/** A body heading between the third and fourth occurrences, for `section`. */
const RISK_FACTORS_AT = 100_000;

const MOTIVATING = (() => {
  const parts: string[] = [];
  let length = 0;
  const put = (s: string) => {
    parts.push(s);
    length += s.length;
  };
  const fillTo = (offset: number) => put(filler(offset - length));
  PHRASE_OFFSETS.forEach((offset, i) => {
    if (i === 3) {
      fillTo(RISK_FACTORS_AT - 2);
      put('\n\nRISK FACTORS\n\n');
    }
    fillTo((LINE_STARTS[i] ?? 0) - 1);
    put('\n');
    fillTo(offset);
    put('Net Revenue Retention');
  });
  fillTo(900_000);
  return parts.join('');
})();

const PHRASE = 'net revenue retention';

describe('find — the motivating filing (#238)', () => {
  beforeEach(() => serve(MOTIVATING));

  it.each([PHRASE, 'NET  revenue\nretention'])(
    'find %j opens at the first occurrence’s line and lists all seven',
    async (find) => {
      const { sc, read } = await page({ find });
      const content = String(sc.content);
      expect(MOTIVATING.startsWith(content, 21403)).toBe(true);
      expect(sc.next_offset).toBe(21403 + content.length);
      expect(records(sc.occurrences).map((o) => o.offset)).toEqual(PHRASE_OFFSETS);
      expect(sc.occurrences_total).toBe(7);
      expect(sc.outline).toBeUndefined();
      expect(read).toContain('Occurrences (7 in the document):\n[21404] ');
      for (const offset of PHRASE_OFFSETS) expect(read).toContain(`\n[${offset}] `);
    },
  );

  it('with offset 21405, opens at 21505 and lists the last six of seven', async () => {
    const { sc } = await page({ find: PHRASE, offset: 21405 });
    expect(MOTIVATING.startsWith(String(sc.content), 21505)).toBe(true);
    expect(records(sc.occurrences).map((o) => o.offset)).toEqual(PHRASE_OFFSETS.slice(1));
    expect(sc.occurrences_total).toBe(7);
  });

  it('with offset 852004, fails phrase_not_found saying all 7 come before it', async () => {
    const result = await call({ find: PHRASE, offset: 852004 });
    const error = wireError(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toBe(
      "Phrase 'net revenue retention' does not occur at or after offset 852004; all 7 occurrences come before it.",
    );
    expect(error.data).toMatchObject({
      reason: 'phrase_not_found',
      find: PHRASE,
      offset: 852004,
      occurrences_before: 7,
    });
    expect(bag(error.data.recovery).hint).toBe(
      'Pass a smaller offset, or leave offset out, to search from the start of the document.',
    );
    expect(readCommonMark(blockText(result.content))).toContain(
      'Recovery: Pass a smaller offset, or leave offset out, to search from the start of the document.',
    );
  });

  it('a phrase the document does not hold fails phrase_not_found with the hint for that rule alone', async () => {
    const error = wireError(await call({ find: 'gross revenue retention' }));
    expect(error.message).toBe("Phrase 'gross revenue retention' does not occur in this document.");
    expect(error.data).toMatchObject({ reason: 'phrase_not_found', occurrences_before: 0 });
    expect(bag(error.data.recovery).hint).toBe(
      'Check the spelling, or pass a shorter part of the phrase: find ignores case, whitespace runs, and quote style, and matches every other character as given.',
    );
  });

  it('section and find together land as section alone', async () => {
    const both = await call({ section: 'risk factors', find: PHRASE });
    const alone = await call({ section: 'risk factors' });
    expect(
      MOTIVATING.startsWith(String(bag(alone.structuredContent).content), RISK_FACTORS_AT),
    ).toBe(true);
    expect(both.structuredContent).toEqual(alone.structuredContent);
    expect(both.content).toEqual(alone.content);
    expect(bag(both.structuredContent).occurrences).toBeUndefined();
  });

  it('a truncated find page says to pass next_offset without find, and that call reads the next page', async () => {
    const first = await page({ find: PHRASE });
    const content = String(first.sc.content);
    const next = Number(first.sc.next_offset);
    const guidance = `Showing ${content.length} of ${MOTIVATING.length} characters. Pass next_offset (${next}) as offset without find to read the next page — with find, offset is where the search starts.`;
    expect(first.sc.notice).toBe(guidance);
    expect(first.raw).toContain(guidance);

    const second = await page({ offset: next });
    expect(MOTIVATING.startsWith(String(second.sc.content), next)).toBe(true);
    // Keeping find searches on from next_offset instead: the page opens at the next occurrence's line.
    const kept = await page({ find: PHRASE, offset: next });
    expect(MOTIVATING.startsWith(String(kept.sc.content), 309113)).toBe(true);
  });

  it('a cache hit lands the find page and lists the occurrences the miss did', async () => {
    const miss = await page({ find: PHRASE, offset: 21405 });
    const entry: CachedExtract & { cik: string } = {
      text: MOTIVATING,
      document: 'aapl-20230930.htm',
      cik: CIK,
      links: [],
    };
    vi.mocked(getExtractCache).mockReturnValue(entry);
    vi.mocked(filingToExtract).mockClear();
    mockApi.tryGetFilingDocument.mockClear();
    const hit = await page({ find: PHRASE, offset: 21405 });
    expect(filingToExtract).not.toHaveBeenCalled();
    expect(mockApi.tryGetFilingDocument).not.toHaveBeenCalled();
    expect(hit.sc).toEqual(miss.sc);
    expect(hit.result.content).toEqual(miss.result.content);
  });
});

// ── Where a find page opens ───────────────────────────────────────────────────

describe('find — where the page opens', () => {
  /** The page's first character's offset in `text`, for one find call. */
  async function pageStart(text: string, args: Record<string, unknown>): Promise<number> {
    serve(text);
    const { sc } = await page(args);
    const content = String(sc.content);
    const start = text.indexOf(content);
    expect(start).not.toBe(-1);
    return start;
  }

  it('opens at the line start when it is exactly 200 characters before the occurrence', async () => {
    const text = `${'x'.repeat(50)}\n${'y'.repeat(199)} needle tail`;
    expect(text.indexOf('needle')).toBe(251);
    expect(await pageStart(text, { find: 'needle' })).toBe(51);
  });

  it('opens at the first word starting within 200 characters when the line starts 201 before', async () => {
    const text = `${'x'.repeat(50)}\na ${'b'.repeat(198)} needle tail`;
    expect(text.indexOf('needle')).toBe(252);
    expect(await pageStart(text, { find: 'needle' })).toBe(53);
  });

  it('opens at a word starting exactly 200 characters before the occurrence', async () => {
    const text = `${'x'.repeat(50)}\n ${'b'.repeat(199)} needle tail`;
    expect(text.indexOf('needle')).toBe(252);
    expect(await pageStart(text, { find: 'needle' })).toBe(52);
  });

  it('opens at the occurrence itself when no word starts within the 200 characters before it', async () => {
    const text = `start ${'b'.repeat(500)}needle tail`;
    expect(await pageStart(text, { find: 'needle' })).toBe(506);
  });

  it('opens at the document start for an occurrence on its first line', async () => {
    expect(await pageStart('Intro text holds the needle here.', { find: 'needle' })).toBe(0);
  });

  it('searches from offset, and may open before it at the occurrence’s line', async () => {
    const text = 'First line.\nThe net revenue figure\nnet revenue again';
    serve(text);
    const { sc } = await page({ find: 'net revenue', offset: 14 });
    expect(String(sc.content)).toBe(text.slice(12));
    expect(records(sc.occurrences).map((o) => o.offset)).toEqual([16, 35]);
  });

  it('reports document offsets past a lowercase form longer than its source (U+0130)', async () => {
    serve('İİİİ needle');
    const { sc } = await page({ find: 'NEEDLE' });
    expect(sc.content).toBe('İİİİ needle');
    expect(sc.occurrences).toEqual([{ offset: 5, context: 'İİİİ needle' }]);
  });

  it('emits no outline on a truncated find page opening at offset 0, where a plain first page does', async () => {
    serve(`needle\n\nRISK FACTORS\n\n${filler(3000)}`);
    const plain = await page({ content_limit: 1000 });
    expect(records(plain.sc.outline).map((h) => h.heading)).toEqual(['RISK FACTORS']);
    const found = await page({ find: 'needle', content_limit: 1000 });
    expect(found.sc.content_truncated).toBe(true);
    expect(String(found.sc.content).startsWith('needle')).toBe(true);
    expect(found.sc.outline).toBeUndefined();
  });
});

// ── Occurrences, their context, and the continuation ─────────────────────────

describe('find — occurrences and their context', () => {
  it('gives each occurrence the match and 40 characters either side, whitespace runs as one space', async () => {
    serve(
      `Over the year our${NBSP}net\nrevenue  retention held at 120% while churn fell to nearly nothing at all.`,
    );
    const { sc } = await page({ find: PHRASE });
    expect(sc.occurrences).toEqual([
      {
        offset: 18,
        context: 'Over the year our net revenue retention held at 120% while churn fell to nearly',
      },
    ]);
  });

  it('renders a context through the Markdown escaper, so content[] reads back the structuredContent value', async () => {
    const text = ' *a* `b` [c](http://e.com) <b>d</b> &amp; | e |\nNEEDLE \\ _f_ # g ---\t  ';
    serve(text);
    const { sc, read } = await page({ find: 'needle' });
    const context = ' [c](http://e.com) <b>d</b> &amp; | e | NEEDLE \\ _f_ # g --- ';
    expect(sc.occurrences).toEqual([{ offset: 48, context }]);
    expect(read).toContain(`Occurrences (1 in the document):\n[48] ${context}\nURL: `);
  });

  // 40 characters either side of the match start inside the first emoji and end inside the last.
  it('keeps both context edges off the middle of a surrogate pair', async () => {
    const text = `😀${'x'.repeat(38)} needle ${'y'.repeat(38)}😀`;
    serve(text);
    const { sc } = await page({ find: 'needle' });
    expect(sc.occurrences).toEqual([
      { offset: 41, context: `${'x'.repeat(38)} needle ${'y'.repeat(38)}` },
    ]);
  });

  describe('more occurrences than one response lists', () => {
    // Occurrence k starts at 12k and ends at 12k + 6.
    const TEXT = 'needle word '.repeat(30);
    const listed = (k: number, count: number) =>
      Array.from({ length: count }, (_, i) => 12 * (k + i));

    it('lists 20, counts 30, and names the call that lists the rest — and that call lists them', async () => {
      serve(TEXT);
      const first = await page({ find: 'needle' });
      expect(records(first.sc.occurrences).map((o) => o.offset)).toEqual(listed(0, 20));
      expect(first.sc.occurrences_total).toBe(30);
      const notice =
        '20 of the 30 occurrences at or after offset 0 are listed; to list the next ones, pass the same find with offset 234.';
      expect(first.sc.notice).toBe(notice);
      expect(first.raw).toContain(notice);

      const rest = await page({ find: 'needle', offset: 234 });
      expect(records(rest.sc.occurrences).map((o) => o.offset)).toEqual(listed(20, 10));
      expect(rest.sc.occurrences_total).toBe(30);
      expect(rest.sc.notice).toBeUndefined();
    });

    it('composes the continuation into the truncation guidance of a cut page', async () => {
      const text = `${TEXT}${filler(2000)}`;
      serve(text);
      const { sc } = await page({ find: 'needle', content_limit: 1000 });
      const content = String(sc.content);
      expect(sc.notice).toBe(
        `20 of the 30 occurrences at or after offset 0 are listed; to list the next ones, pass the same find with offset 234. Showing ${content.length} of ${text.length} characters. Pass next_offset (${sc.next_offset}) as offset without find to read the next page — with find, offset is where the search starts.`,
      );
    });
  });

  it('omits occurrences and occurrences_total without find', async () => {
    serve('needle needle');
    const { sc } = await page({});
    expect(sc.occurrences).toBeUndefined();
    expect(sc.occurrences_total).toBeUndefined();
  });
});

// ── Input bounds ──────────────────────────────────────────────────────────────

describe('find — input', () => {
  it.each([
    ['empty', ''],
    ['whitespace alone', ` \t${NBSP}\n`],
  ])('reads a blank find (%s) as omitted', async (_label, find) => {
    serve(`needle\n\nRISK FACTORS\n\n${filler(3000)}`);
    const blank = await page({ find, content_limit: 1000 });
    const omitted = await page({ content_limit: 1000 });
    expect(blank.sc).toEqual(omitted.sc);
    expect(blank.sc.occurrences).toBeUndefined();
    // A first page without find carries the outline, which a find page never does.
    expect(records(blank.sc.outline)).toHaveLength(1);
  });

  it('accepts a 200-character phrase and rejects a 201-character one before any SEC request', async () => {
    serve(`a ${'x'.repeat(200)} b`);
    const accepted = await page({ find: 'x'.repeat(200) });
    expect(records(accepted.sc.occurrences).map((o) => o.offset)).toEqual([2]);

    mockApi.tryGetFilingIndex.mockClear();
    const rejected = await call({ find: 'x'.repeat(201) });
    expect(wireError(rejected).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(mockApi.tryGetFilingIndex).not.toHaveBeenCalled();
  });

  it('says so when the one occurrence comes before offset', async () => {
    serve('one needle here');
    const error = wireError(await call({ find: 'needle', offset: 5 }));
    expect(error.message).toBe(
      "Phrase 'needle' does not occur at or after offset 5; its one occurrence comes before it.",
    );
    expect(error.data).toMatchObject({ reason: 'phrase_not_found', occurrences_before: 1 });
  });

  it('treats an offset past the end of the text as a search start, not an out-of-range page', async () => {
    serve('one needle here');
    const error = wireError(await call({ find: 'needle', offset: 1000 }));
    expect(error.data).toMatchObject({ reason: 'phrase_not_found', occurrences_before: 1 });
  });
});

// ── section_not_found names find ──────────────────────────────────────────────

describe('section_not_found points a phrase at find', () => {
  it('names find in the contract recovery', () => {
    const entry = getFilingTool.errors?.find((e) => e.reason === 'section_not_found');
    expect(entry?.recovery).toBe(
      'Pick a heading from the outline in the error message or pass a subheading exactly as the document prints it; pass a phrase that is not a heading as find, or page with offset.',
    );
  });

  it('names find in the hint for a document with detected headings', async () => {
    serve(`RISK FACTORS\n\n${filler(2000)}`);
    const error = wireError(await call({ section: 'net revenue retention' }));
    expect(error.data.reason).toBe('section_not_found');
    expect(bag(error.data.recovery).hint).toBe(
      'Pick a heading from the outline above and pass it as section; a subheading the outline omits matches when passed exactly as the document prints it. For a phrase that is not a heading, pass it as find instead.',
    );
  });

  it('names find in the hint for a document with no detected headings', async () => {
    serve(filler(2000));
    const error = wireError(await call({ section: 'net revenue retention' }));
    expect(error.data.reason).toBe('section_not_found');
    expect(bag(error.data.recovery).hint).toBe(
      'No headings were detected in this document — pass a phrase as find to locate it in the text, or use offset paging.',
    );
  });

  it('declares phrase_not_found as NotFound with a recovery', () => {
    const entry = getFilingTool.errors?.find((e) => e.reason === 'phrase_not_found');
    expect(entry).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      recovery:
        'Check the phrase against the document text, or pass a smaller offset to search from earlier in the document.',
    });
  });
});

// ── CPU time on the paths a long match takes ─────────────────────────────────

/**
 * A match can span an arbitrarily long whitespace run, which its context
 * collapses, and can sit at the end of a line hundreds of thousands of characters
 * long, where the page start reads back. Each size doubles the last and is
 * checked before the next runs; small texts are timed per call over a batch, and
 * each size keeps the least of three measurements.
 */
describe('find — CPU time, linear in the text length', () => {
  /** Thread CPU budget per text character, several times what either runtime measures. */
  const BUDGET_NS_PER_CHAR = 2000;

  /** Least thread CPU microseconds per handler call over 3 batches of `reps` calls. */
  async function handlerMicros(text: string, reps: number): Promise<number> {
    serve(text);
    const input = getFilingTool.input.parse({
      accession_number: ACCN,
      cik: '320193',
      find: 'net revenue',
    });
    const run = () =>
      getFilingTool.handler(input, createMockContext({ errors: getFilingTool.errors }));
    expect((await run()).occurrences_total).toBe(1);
    let least = Number.POSITIVE_INFINITY;
    for (let batch = 0; batch < 3; batch++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < reps; i++) await run();
      const spent = process.threadCpuUsage(start);
      least = Math.min(least, (spent.user + spent.system) / reps);
    }
    return least;
  }

  const shapes: Array<[string, (chars: number) => string]> = [
    ['a match across line breaks throughout', (chars) => `net${'  \r\n'.repeat(chars / 4)}revenue`],
    [
      'a match at the end of one long line ending in a line break',
      (chars) => `${'§1 x'.repeat(chars / 4)} net revenue\ny`,
    ],
  ];

  it.each(shapes)('finds %s in time linear in the text length', async (_shape, make) => {
    let smallest = 0;
    for (let chars = 5_000; chars <= 320_000; chars *= 2) {
      const micros = await handlerMicros(make(chars), Math.ceil(64_000 / chars));
      expect(micros, `${chars} characters`).toBeLessThan((chars * BUDGET_NS_PER_CHAR) / 1000);
      if (chars === 5_000) smallest = micros;
      // Linear growth with 4x slack: the full 64x span may cost at most 256x the smallest size.
      expect(micros / smallest, `${chars} characters`).toBeLessThan((4 * chars) / 5_000);
    }
  });
});
