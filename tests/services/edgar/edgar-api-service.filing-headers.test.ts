/**
 * @fileoverview `EdgarApiService`'s two SEC-header reads, driven with `globalThis.fetch`
 * stubbed: `tryGetFilingHeaders` (the index-headers page, parsed into documents and the
 * submission fields) and `tryGetSubmissionHeader` (the bare `.hdr.sgml`, the fallback
 * when that page is missing) — which URL each requests and that a 404 answers `null`
 * (#126).
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

import { getEdgarApiService, initEdgarApiService } from '@/services/edgar/edgar-api-service.js';

const BASE = 'https://www.sec.gov/Archives/edgar/data/0000320193/000110465905058421';
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
      getEdgarApiService().tryGetFilingHeaders('320193', '0001104659-05-058421'),
    ).resolves.toBeNull();
  });

  it('reads the bare .hdr.sgml header from the filing directory', async () => {
    const fetchMock = serve({ [`${BASE}/0001104659-05-058421.hdr.sgml`]: HDR_SGML });

    const header = await getEdgarApiService().tryGetSubmissionHeader(
      '320193',
      '0001104659-05-058421',
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
      getEdgarApiService().tryGetSubmissionHeader('320193', '0001104659-05-058421'),
    ).resolves.toBeNull();
  });
});
