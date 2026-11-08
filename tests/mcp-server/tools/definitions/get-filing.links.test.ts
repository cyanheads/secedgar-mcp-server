/**
 * @fileoverview Tests for get_filing's `section` landing on a table-of-contents row
 * that links to its section (#239): the row's forward link carries the page to the
 * section, a back-link and every other landing stay where they are, and a cache
 * hit lands where the miss did without reading the document again.
 * @module tests/mcp-server/tools/definitions/get-filing.links
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFilingTool } from '@/mcp-server/tools/definitions/get-filing.tool.js';
import type { CachedExtract, InDocumentLink } from '@/services/edgar/filing-to-text.js';

// Only the service singleton is mocked; `filingArchiveUrl` stays real.
vi.mock('@/services/edgar/edgar-api-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/edgar/edgar-api-service.js')>()),
  getEdgarApiService: vi.fn(),
}));

// The conversion, heading detection, and windowing are spies wired to the real
// functions below, so a call counts them; the extract cache is a stub each test
// fills. Everything else — `linkedSectionStart` and the comparisons the section
// matcher performs — is the real module (#239).
vi.mock('@/services/edgar/filing-to-text.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/edgar/filing-to-text.js')>();
  return {
    ...actual,
    filingToExtract: vi.fn(),
    detectHeadings: vi.fn(),
    windowText: vi.fn(),
    getExtractCache: vi.fn(),
    setExtractCache: vi.fn(),
  };
});

import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import {
  detectHeadings,
  filingToExtract,
  getExtractCache,
  setExtractCache,
  windowText,
} from '@/services/edgar/filing-to-text.js';
import { allText, at, bag, wireError } from '../../../support/assertions.js';

const ACCN = '0001628280-26-068676';
const CIK = '0001994000';
const DOCUMENT = 'prospectus.htm';

/** Long enough that a 1,000-character page from the Risk Factors section is cut. */
const RISK_PROSE = 'Investing in our Class A common stock involves a high degree of risk. '.repeat(
  30,
);

/**
 * The shape of Anthropic, PBC's S-1/A (0001628280-26-068676): an all-caps table of
 * contents whose rows link each section, then each section's mixed-case heading —
 * a line heading detection does not list — after an empty target `div`, a page
 * number, and the running `Table of Contents` link. The Prospectus Summary row
 * links back to the cover instead; a body heading and a mixed-case line each link
 * forward to the notes.
 */
const PROSPECTUS = [
  '<html><body>',
  '<div id="top">EXAMPLE PBC</div>',
  '<div><a href="#rf">RISK FACTORS</a></div><div>12</div>',
  '<div><a href="#top">PROSPECTUS SUMMARY</a></div><div>1</div>',
  '<div><a href="#uop">USE OF PROCEEDS</a></div><div>81</div>',
  '<div>We are offering shares of our Class A common stock. Cover prose follows here.</div>',
  '<div>Prospectus Summary</div><p>This summary highlights information found elsewhere.</p>',
  '<div id="rf"></div><div>28</div><div><a href="#top">Table of Contents</a></div>',
  `<div>Risk Factors</div><p>${RISK_PROSE}</p>`,
  '<div id="uop"></div><div>81</div><div>Use of Proceeds</div>',
  '<p>We intend to use the net proceeds for general corporate purposes.</p>',
  '<div><a href="#notes">DESCRIPTION OF CAPITAL STOCK</a></div><p>Our authorized capital stock consists of common stock.</p>',
  '<div><a href="#notes">Capitalization</a></div><p>The following table sets forth our capitalization.</p>',
  '<div id="notes">Notes to the Financial Statements</div><p>Note prose.</p>',
  '</body></html>',
].join('\n');

const mockApi = {
  findFilingCiks: vi.fn(),
  tryGetFilingIndex: vi.fn(),
  tryGetFilingDocument: vi.fn(),
  tryGetFilingHeaders: vi.fn(),
  tryGetFilingPartyCiks: vi.fn(),
  tryGetSubmissionHeader: vi.fn(),
  getSubmissions: vi.fn(),
};

/** The real extraction of the fixture, to read each expected landing off. */
let TEXT: string;

beforeEach(async () => {
  vi.clearAllMocks();
  const actual = await vi.importActual<typeof import('@/services/edgar/filing-to-text.js')>(
    '@/services/edgar/filing-to-text.js',
  );
  TEXT = actual.filingToExtract(PROSPECTUS);
  vi.mocked(filingToExtract).mockImplementation(actual.filingToExtract);
  vi.mocked(detectHeadings).mockImplementation(actual.detectHeadings);
  vi.mocked(windowText).mockImplementation(actual.windowText);
  vi.mocked(getExtractCache).mockReturnValue(undefined);
  vi.mocked(setExtractCache).mockImplementation(() => {});

  vi.mocked(getEdgarApiService).mockReturnValue(mockApi as never);
  mockApi.findFilingCiks.mockResolvedValue([CIK]);
  mockApi.tryGetFilingIndex.mockResolvedValue({
    directory: {
      name: ACCN.replace(/-/g, ''),
      item: [{ name: DOCUMENT, type: 'text/html', size: '', 'last-modified': '2026-10-28' }],
    },
  });
  mockApi.tryGetFilingDocument.mockResolvedValue(PROSPECTUS);
  mockApi.tryGetFilingHeaders.mockResolvedValue(null);
  mockApi.tryGetFilingPartyCiks.mockResolvedValue(null);
  mockApi.tryGetSubmissionHeader.mockRejectedValue(new Error('unexpected .hdr.sgml read'));
  mockApi.getSubmissions.mockResolvedValue({
    cik: CIK,
    name: 'EXAMPLE PBC',
    tickers: [],
    exchanges: [],
    filings: {
      recent: {
        accessionNumber: [ACCN],
        filingDate: ['2026-10-28'],
        form: ['S-1/A'],
        primaryDocument: [DOCUMENT],
        primaryDocDescription: [''],
        reportDate: [''],
      },
      files: [],
    },
  });
});

/** One `section` page and where it starts in the extraction, from both surfaces. */
async function landing(section: string) {
  const result = await runToolContract(getFilingTool, {
    accession_number: ACCN,
    cik: '1994000',
    section,
    content_limit: 1000,
  });
  expect(result.isError).toBeFalsy();
  const sc = bag(result.structuredContent);
  const content = sc.content as string;
  const offset = TEXT.indexOf(content);
  expect(TEXT.indexOf(content, offset + 1), 'the page occurs once in the text').toBe(-1);
  return { content, notice: sc.notice as string | undefined, offset, result, sc };
}

describe('get_filing section — a table-of-contents row that links to its section (#239)', () => {
  it('lands a row’s value on the line holding its linked section, on both surfaces', async () => {
    const section = TEXT.indexOf('28\nTable of Contents\nRisk Factors');
    const row = TEXT.indexOf('RISK FACTORS');
    expect(row).toBeLessThan(section);

    const { content, notice, offset, result, sc } = await landing('risk factors');

    expect(offset).toBe(section);
    expect(content.startsWith('28\nTable of Contents\nRisk Factors\n\nInvesting')).toBe(true);
    expect(sc.next_offset).toBe(section + content.length);
    expect(notice).toBe(
      `Showing ${content.length} of ${TEXT.length} characters. Pass next_offset (${section + content.length}) as offset without section to read the next page — section takes precedence over offset.`,
    );
    expect(allText(result)).toContain('28\nTable of Contents\nRisk Factors\n\nInvesting');
    expect(allText(result)).toContain(notice);
  });

  it('lands each row on its own linked section', async () => {
    const { offset } = await landing('use of proceeds');

    expect(offset).toBe(TEXT.indexOf('81\nUse of Proceeds'));
  });

  it('keeps a row whose link points back to the cover on the row', async () => {
    const { offset, content } = await landing('prospectus summary');

    expect(offset).toBe(TEXT.indexOf('PROSPECTUS SUMMARY'));
    expect(content.startsWith('PROSPECTUS SUMMARY\n1\n')).toBe(true);
  });

  it('keeps a body heading that links forward where it is', async () => {
    const { offset } = await landing('description of capital stock');

    expect(offset).toBe(TEXT.indexOf('DESCRIPTION OF CAPITAL STOCK'));
  });

  it('keeps a line landing that links forward on its line, with the line notice', async () => {
    const { offset, notice, result } = await landing('capitalization');

    expect(offset).toBe(TEXT.indexOf('Capitalization\n'));
    const lineNotice =
      "No detected heading matches section 'capitalization', so this page starts at the first document line that does.";
    expect(notice).toBe(lineNotice);
    expect(allText(result)).toContain(lineNotice);
  });

  it('still misses a value nothing in the linked document matches', async () => {
    const result = await runToolContract(getFilingTool, {
      accession_number: ACCN,
      cik: '1994000',
      section: 'executive compensation',
    });

    expect(wireError(result).data.reason).toBe('section_not_found');
  });

  it('caches the links with the extract, and a cache hit lands where the miss did with no document read', async () => {
    const miss = await landing('risk factors');
    const [key, entry] = at(vi.mocked(setExtractCache).mock.calls);
    const cached = entry as CachedExtract & { links: InDocumentLink[] };
    expect(cached.text).toBe(TEXT);
    expect(cached.links.map((link) => TEXT.slice(link.offset, link.offset + 12))).toContain(
      'RISK FACTORS',
    );
    vi.mocked(getExtractCache).mockImplementation((k) => (k === key ? entry : undefined));
    mockApi.tryGetFilingDocument.mockClear();
    vi.mocked(filingToExtract).mockClear();

    const hit = await landing('risk factors');

    expect(mockApi.tryGetFilingDocument).not.toHaveBeenCalled();
    expect(filingToExtract).not.toHaveBeenCalled();
    expect(hit.offset).toBe(miss.offset);
    expect(hit.offset).toBe(TEXT.indexOf('28\nTable of Contents\nRisk Factors'));
    expect(hit.sc.next_offset).toBe(miss.sc.next_offset);
    expect(allText(hit.result)).toBe(allText(miss.result));
  });
});
