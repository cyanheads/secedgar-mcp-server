/**
 * @fileoverview The URL shape of every `EdgarApiService` read, driven with
 * `globalThis.fetch` stubbed to answer only the expected URL. Archive reads under
 * `www.sec.gov/Archives/edgar/data/` carry the unpadded CIK — SEC answers the
 * zero-padded path with a 301, so a padded URL costs a second request — while the
 * `data.sec.gov` APIs keep the 10-digit padded form they require (#156).
 * @module tests/services/edgar/edgar-api-service.archive-urls
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

import {
  filingArchiveUrl,
  getEdgarApiService,
  initEdgarApiService,
} from '@/services/edgar/edgar-api-service.js';

const ACCESSION = '0000320193-25-000079';
const FILING_DIR = 'https://www.sec.gov/Archives/edgar/data/320193/000032019325000079';

/** Answer exactly one URL; any other request fails the call, naming the URL it asked for. */
function serveOnly(url: string, body: string) {
  const fetchMock = vi.fn(async (requested: string) => {
    if (requested !== url) throw new Error(`unexpected fetch: ${requested}`);
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('EdgarApiService — request URL shape (#156)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    initEdgarApiService();
  });

  afterEach(() => {
    getEdgarApiService().dispose();
    vi.unstubAllGlobals();
  });

  // Callers hold the CIK in both forms: resolveCik and the submissions feed pad it,
  // a caller-supplied CIK may not be.
  describe.each([
    ['padded', '0000320193'],
    ['unpadded', '320193'],
  ])('archive reads given a %s CIK request the unpadded path', (_form, cik) => {
    // The one rule every read below uses, exported so a tool's filing_url names the same path.
    it('filingArchiveUrl', () => {
      expect(filingArchiveUrl(cik, ACCESSION, 'aapl-20250927.htm')).toBe(
        `${FILING_DIR}/aapl-20250927.htm`,
      );
    });

    it('tryGetFilingIndex', async () => {
      const fetchMock = serveOnly(`${FILING_DIR}/index.json`, '{"directory":{"item":[]}}');
      await expect(getEdgarApiService().tryGetFilingIndex(cik, ACCESSION)).resolves.toEqual({
        directory: { item: [] },
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('tryGetFilingHeaders', async () => {
      const fetchMock = serveOnly(`${FILING_DIR}/${ACCESSION}-index-headers.html`, '<HTML></HTML>');
      await getEdgarApiService().tryGetFilingHeaders(cik, ACCESSION);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('tryGetSubmissionHeader', async () => {
      const fetchMock = serveOnly(`${FILING_DIR}/${ACCESSION}.hdr.sgml`, '<SEC-HEADER>');
      await getEdgarApiService().tryGetSubmissionHeader(cik, ACCESSION);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('getFilingDocument', async () => {
      const fetchMock = serveOnly(`${FILING_DIR}/aapl-20250927.htm`, '<html>10-K</html>');
      await expect(
        getEdgarApiService().getFilingDocument(cik, ACCESSION, 'aapl-20250927.htm'),
      ).resolves.toBe('<html>10-K</html>');
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('tryGetFilingDocument', async () => {
      const fetchMock = serveOnly(`${FILING_DIR}/primary_doc.xml`, '<ownershipDocument/>');
      await expect(
        getEdgarApiService().tryGetFilingDocument(cik, ACCESSION, 'primary_doc.xml'),
      ).resolves.toBe('<ownershipDocument/>');
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('tryGetFilingDocumentHead', async () => {
      const fetchMock = serveOnly(`${FILING_DIR}/primary_doc.xml`, '<edgarSubmission><seriesId>');
      await expect(
        getEdgarApiService().tryGetFilingDocumentHead(cik, ACCESSION, 'primary_doc.xml', {
          maxBytes: 1_000_000,
          stopAt: '</seriesId>',
        }),
      ).resolves.toBe('<edgarSubmission><seriesId>');
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  // --- Characterization: the data.sec.gov APIs keep the padded CIK ---

  describe.each([
    ['padded', '0000320193'],
    ['unpadded', '320193'],
  ])('data.sec.gov reads given a %s CIK keep the padded path', (_form, cik) => {
    it('getSubmissions', async () => {
      const fetchMock = serveOnly(
        'https://data.sec.gov/submissions/CIK0000320193.json',
        '{"cik":"320193","name":"Apple Inc."}',
      );
      await expect(getEdgarApiService().getSubmissions(cik)).resolves.toMatchObject({
        name: 'Apple Inc.',
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('tryGetCompanyFacts', async () => {
      const fetchMock = serveOnly(
        'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json',
        '{"cik":320193,"entityName":"Apple Inc.","facts":{}}',
      );
      await expect(getEdgarApiService().tryGetCompanyFacts(cik)).resolves.toMatchObject({
        entityName: 'Apple Inc.',
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('tryGetCompanyConcept', async () => {
      const fetchMock = serveOnly(
        'https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/Revenues.json',
        '{"cik":320193,"tag":"Revenues","units":{}}',
      );
      await expect(
        getEdgarApiService().tryGetCompanyConcept(cik, 'us-gaap', 'Revenues'),
      ).resolves.toMatchObject({ tag: 'Revenues' });
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });
});
