/**
 * @fileoverview `EdgarApiService`'s per-filing archive reads, driven with
 * `globalThis.fetch` stubbed: `tryGetFilingHeaders` (the index-headers page, parsed
 * into documents and the submission fields) and `tryGetSubmissionHeader` (the bare
 * `.hdr.sgml`, the fallback when that page is missing) — which URL each requests and
 * that a 404 answers `null` (#126) — plus `tryGetFilingIndex`, which drops the entries
 * SEC lists with no filename, and `tryGetFilingPartyCiks`, which reads the filers an
 * index page names (#203).
 * @module tests/services/edgar/edgar-api-service.filing-headers
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
import {
  filingPartyCiks,
  getEdgarApiService,
  initEdgarApiService,
} from '@/services/edgar/edgar-api-service.js';

const scope = () => new CallScope(new AbortController().signal);

// Archive paths carry the unpadded CIK; SEC 301s the zero-padded form (#156).
const BASE = 'https://www.sec.gov/Archives/edgar/data/320193/000110465905058421';
const HDR_SGML = `<SEC-HEADER>0001104659-05-058421.hdr.sgml : 20051201
<ACCEPTANCE-DATETIME>20051130212248
<TYPE>10-K
<PERIOD>20050924
<FILING-DATE>20051201
</SEC-HEADER>
`;
const INDEX_HEADERS = `<HTML><!--
${HDR_SGML}-->
<PRE>&lt;DOCUMENT&gt;
&lt;TYPE&gt;10-K
&lt;SEQUENCE&gt;1
&lt;FILENAME&gt;d10k.htm
&lt;/DOCUMENT&gt;</PRE></HTML>`;

/** Serve fixed bodies by URL; a URL not listed answers SEC's archive 404. */
function serve(bodies: Record<string, string>) {
  const fetchMock = vi.fn(async (url: string) =>
    url in bodies
      ? new Response(bodies[url])
      : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('EdgarApiService — SEC header reads (#126)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    initEdgarApiService();
  });

  afterEach(() => {
    getEdgarApiService().dispose();
    vi.unstubAllGlobals();
  });

  it('parses the index-headers page into documents and the submission fields', async () => {
    const fetchMock = serve({ [`${BASE}/0001104659-05-058421-index-headers.html`]: INDEX_HEADERS });

    const headers = await getEdgarApiService().tryGetFilingHeaders(
      '320193',
      '0001104659-05-058421',
      scope(),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(headers?.documents.get('d10k.htm')?.type).toBe('10-K');
    expect(headers?.submission).toEqual({
      form: '10-K',
      filingDate: '2005-12-01',
      periodOfReport: '2005-09-24',
    });
  });

  it('answers null when the index-headers page 404s', async () => {
    serve({});
    await expect(
      getEdgarApiService().tryGetFilingHeaders('320193', '0001104659-05-058421', scope()),
    ).resolves.toBeNull();
  });

  it('reads the bare .hdr.sgml header from the filing directory', async () => {
    const fetchMock = serve({ [`${BASE}/0001104659-05-058421.hdr.sgml`]: HDR_SGML });

    const header = await getEdgarApiService().tryGetSubmissionHeader(
      '320193',
      '0001104659-05-058421',
      scope(),
    );

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${BASE}/0001104659-05-058421.hdr.sgml`,
      expect.anything(),
    );
    expect(header).toEqual({
      form: '10-K',
      filingDate: '2005-12-01',
      periodOfReport: '2005-09-24',
    });
  });

  it('answers null when the .hdr.sgml header 404s', async () => {
    serve({});
    await expect(
      getEdgarApiService().tryGetSubmissionHeader('320193', '0001104659-05-058421', scope()),
    ).resolves.toBeNull();
  });
});

// IBM's 1998 10-K, filed through a filing agent (CIK 1047469, the accession prefix).
const IBM_ACCESSION = '0001047469-99-011848';
const AGENT_DIR = 'https://www.sec.gov/Archives/edgar/data/1047469/000104746999011848';
const NAMED_ITEMS = [
  `${IBM_ACCESSION}-index-headers.html`,
  `${IBM_ACCESSION}-index.html`,
  `${IBM_ACCESSION}.txt`,
];
/** The agent directory's `index.json` as SEC serves it: four documents with no filename. */
const AGENT_INDEX_JSON = JSON.stringify({
  directory: {
    item: [
      ...NAMED_ITEMS.map((name) => ({
        'last-modified': '1999-03-29 00:00:00',
        name,
        type: 'text.gif',
        size: '',
      })),
      ...['73605', '231374', '23557', '2280'].map((size) => ({
        'last-modified': '1999-03-29 00:00:00',
        name: '',
        type: '',
        size,
      })),
    ],
    name: '/Archives/edgar/data/1047469/000104746999011848',
    'parent-dir': '/Archives/edgar/data/1047469',
  },
});

/** The agent path's index page, trimmed to its links: navigation, documents, and the filer. */
const IBM_INDEX_PAGE = `<html><body>
<a href="/cgi-bin/browse-edgar?action=getcurrent" class="nav__link">Latest Filings</a>
<table class="tableFile" summary="Document Format Files">
<tr><td scope="row">1</td><td scope="row">10-K</td><td scope="row"><a href="/Archives/edgar/data/51143/"></a></td></tr>
<tr><td scope="row">&nbsp;</td><td scope="row">Complete submission text file</td><td scope="row"><a href="/Archives/edgar/data/51143/0001047469-99-011848.txt">0001047469-99-011848.txt</a></td></tr>
</table>
<div class="companyInfo">
  <span class="companyName">INTERNATIONAL BUSINESS MACHINES CORP (Filer)
 <acronym title="Central Index Key">CIK</acronym>: <a href="/cgi-bin/browse-edgar?CIK=0000051143&amp;action=getcompany">0000051143 (see all company filings)</a></span>
<p class="identInfo">Type: <strong>10-K</strong> | Act: <strong>34</strong> | File No.: <a href="/cgi-bin/browse-edgar?filenum=001-02360&amp;action=getcompany"><strong>001-02360</strong></a> | Film No.: <strong>99575375</strong><br /><acronym title="Standard Industrial Code">SIC</acronym>: <b><a href="/cgi-bin/browse-edgar?action=getcompany&amp;SIC=3570&amp;owner=include">3570</a></b> Computer &amp; office Equipment</p>
</div>
</body></html>`;

/** A 1999 SC 13D's index page under the filing agent's path: the subject, then the filer. */
const SC13D_INDEX_PAGE = `<html><body>
<a href="/cgi-bin/browse-edgar?action=getcurrent" class="nav__link">Latest Filings</a>
<div class="companyInfo">
  <span class="companyName">ACTV INC /DE/ (Subject)
 <acronym title="Central Index Key">CIK</acronym>: <a href="/cgi-bin/browse-edgar?CIK=0000854152&amp;action=getcompany">0000854152 (see all company filings)</a></span>
<p class="identInfo">Type: <strong>SC 13D</strong> | File No.: <a href="/cgi-bin/browse-edgar?filenum=005-41394&amp;action=getcompany"><strong>005-41394</strong></a></p>
</div>
<div class="companyInfo">
  <span class="companyName">LIBERTY MEDIA CORP /DE/ (Filed by)
 <acronym title="Central Index Key">CIK</acronym>: <a href="/cgi-bin/browse-edgar?CIK=0001082114&amp;action=getcompany">0001082114 (see all company filings)</a></span>
</div>
</body></html>`;

describe('EdgarApiService — the filing index and index page (#203)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    initEdgarApiService();
  });

  afterEach(() => {
    getEdgarApiService().dispose();
    vi.unstubAllGlobals();
  });

  it('drops the entries index.json lists with no filename, keeping the named ones in order', async () => {
    const fetchMock = serve({ [`${AGENT_DIR}/index.json`]: AGENT_INDEX_JSON });

    const index = await getEdgarApiService().tryGetFilingIndex('1047469', IBM_ACCESSION, scope());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(index?.directory.item.map((item) => item.name)).toEqual(NAMED_ITEMS);
  });

  it('keeps an index whose entries all carry a filename as SEC serves it', async () => {
    const listing = {
      directory: {
        item: [{ 'last-modified': '2026-04-03', name: 'form4.xml', type: 'text.gif', size: '15' }],
        name: '/Archives/edgar/data/1047469/000104746999011848',
      },
    };
    serve({ [`${AGENT_DIR}/index.json`]: JSON.stringify(listing) });

    await expect(
      getEdgarApiService().tryGetFilingIndex('1047469', IBM_ACCESSION, scope()),
    ).resolves.toEqual(listing);
  });

  it('answers null when index.json 404s', async () => {
    serve({});
    await expect(
      getEdgarApiService().tryGetFilingIndex('1047469', IBM_ACCESSION, scope()),
    ).resolves.toBeNull();
  });

  it('reads the filer the index page names under the filing agent’s path', async () => {
    const fetchMock = serve({ [`${AGENT_DIR}/${IBM_ACCESSION}-index.html`]: IBM_INDEX_PAGE });

    const ciks = await getEdgarApiService().tryGetFilingPartyCiks(
      '0001047469',
      IBM_ACCESSION,
      scope(),
    );

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${AGENT_DIR}/${IBM_ACCESSION}-index.html`,
      expect.anything(),
    );
    // The navigation, file-number, and SIC links carry no CIK parameter.
    expect(ciks).toEqual(['0000051143']);
  });

  it('reads every party in page order: the subject company, then the filer', async () => {
    const accession = '0000950130-99-001766';
    const page = `https://www.sec.gov/Archives/edgar/data/950130/000095013099001766/${accession}-index.html`;
    serve({ [page]: SC13D_INDEX_PAGE });

    await expect(
      getEdgarApiService().tryGetFilingPartyCiks('950130', accession, scope()),
    ).resolves.toEqual(['0000854152', '0001082114']);
  });

  it('answers null when the index page 404s', async () => {
    serve({});
    await expect(
      getEdgarApiService().tryGetFilingPartyCiks('1047469', IBM_ACCESSION, scope()),
    ).resolves.toBeNull();
  });
});

describe('filingPartyCiks — the CIK parameter of each company-browse link (#203)', () => {
  const link = (query: string) => `<a href="/cgi-bin/browse-edgar?${query}">x</a>`;

  it.each([
    ['the first parameter', 'CIK=0000051143&amp;action=getcompany', ['0000051143']],
    [
      'a later parameter after an escaped ampersand',
      'action=getcompany&amp;CIK=0000051143',
      ['0000051143'],
    ],
    [
      'a later parameter after a bare ampersand',
      'action=getcompany&CIK=0000051143',
      ['0000051143'],
    ],
    ['the only parameter', 'CIK=0000051143', ['0000051143']],
    ['a value of nine digits', 'CIK=000005114&amp;action=getcompany', []],
    ['a value of eleven digits', 'CIK=00000511430&amp;action=getcompany', []],
    ['a parameter whose name only ends in CIK', 'XCIK=0000051143', []],
    ['a link with no CIK parameter', 'action=getcompany&amp;SIC=3570&amp;owner=include', []],
  ])('%s', (_label, query, expected) => {
    expect(filingPartyCiks(link(query))).toEqual(expected);
  });

  it('reads a CIK parameter only inside a company-browse link', () => {
    const html = `<a href="/cgi-bin/own-disp?action=getissuer&amp;CIK=0000320193">x</a> CIK=0000789019`;
    expect(filingPartyCiks(html)).toEqual([]);
  });

  it('ends a link’s query at its closing quote, so a later link keeps its own CIK', () => {
    const html = `${link('action=getcurrent')}&amp;CIK=0000000001 ${link('CIK=0000789019')}`;
    expect(filingPartyCiks(html)).toEqual(['0000789019']);
  });

  it('names a party linked twice once, in the order first linked', () => {
    const html = [
      link('CIK=0001082114&amp;action=getcompany'),
      link('CIK=0000854152&amp;action=getcompany'),
      link('CIK=0001082114&amp;action=getcompany'),
    ].join('\n');
    expect(filingPartyCiks(html)).toEqual(['0001082114', '0000854152']);
  });

  it('answers an empty list for a page with no company-browse link', () => {
    expect(filingPartyCiks('<html><body>No filing.</body></html>')).toEqual([]);
  });
});

describe('filingPartyCiks — linear in the page’s length (#203)', () => {
  const fill = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length));

  /**
   * Thread CPU milliseconds one call takes, timed over a batch sized to hold the
   * work near 320k characters per measurement, least of five: wall clock is noise
   * under a parallel suite, and a 5k call alone is too short to time.
   */
  function perCallCpuMs(text: string): number {
    const batch = Math.max(1, Math.round(320_000 / text.length));
    let least = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 5; round++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < batch; i++) filingPartyCiks(text);
      const used = process.threadCpuUsage(start);
      least = Math.min(least, (used.user + used.system) / 1000 / batch);
    }
    return least;
  }

  /**
   * Doubles n from 5,000 to 320,000, checking the CPU bound at each size before
   * building the next, so a quadratic shape fails fast instead of hanging, then
   * holds the 64× span's ratio under 256, where a quadratic scan reaches 4,096.
   */
  function expectLinear(build: (n: number) => string): void {
    const small = build(5_000);
    filingPartyCiks(small); // warm the JIT
    const t5k = Math.max(perCallCpuMs(small), 0.001);
    let last = t5k;
    for (let n = 10_000; n <= 320_000; n *= 2) {
      last = perCallCpuMs(build(n));
      expect(last, `${n} characters`).toBeLessThan(100);
    }
    expect(last / t5k).toBeLessThan(256);
  }

  it.each([
    ['link openers with no closer', (n: number) => fill('browse-edgar?', n)],
    ['one query with no closer', (n: number) => `browse-edgar?${fill('&amp;x=1', n)}`],
    [
      'CIK near-misses inside one query',
      (n: number) => `browse-edgar?${fill('&CIK=000000000x', n)}`,
    ],
    ['overlapping opener prefixes', (n: number) => fill('browse-edgabrowse-edgar', n)],
    ['links each closed at once', (n: number) => fill('browse-edgar?"CIK="', n)],
    [
      'links closed at once, with no CIK parameter anywhere',
      (n: number) => fill('browse-edgar?" ', n),
    ],
    ['one long line ending in a break', (n: number) => `${fill('§1 x', n)}\ny`],
    ['breaks throughout', (n: number) => fill('  \r\n', n)],
    [
      'a query of one long line ending in a break',
      (n: number) => `browse-edgar?${fill('§1 x', n)}\ny`,
    ],
  ])('%s (5k → 320k)', (_label, build) => {
    expectLinear(build);
  });
});
