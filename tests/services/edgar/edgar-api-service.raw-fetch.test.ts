/**
 * @fileoverview `EdgarApiService`'s private `rawFetch` retry/error loop, exercised
 * through a public fetch method with `globalThis.fetch` stubbed. Pins which statuses
 * retry, how many attempts each makes, and what the thrown error carries — in
 * particular that a 429 fails fast with the ten-minute cool-down hint and without
 * SEC's HTML block page (#112). No request ever reaches sec.gov: a real 429 would
 * block this IP for ten minutes.
 * @module tests/services/edgar/edgar-api-service.raw-fetch
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { config } = vi.hoisted(() => ({
  config: {
    userAgent: 'test test@example.com',
    rateLimitRps: 10,
    tickerCacheTtl: 3600,
    mirrorFallbackLive: true,
  },
}));

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));
vi.mock('@/services/edgar/mirror/index.js', () => ({ getEdgarMirror: () => undefined }));

import { getEdgarApiService, initEdgarApiService } from '@/services/edgar/edgar-api-service.js';

const DOCUMENT_URL = 'https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/a.htm';

/** The shape SEC serves on a rate-limit block: a full HTML page, not a JSON body. */
const SEC_BLOCK_PAGE = `<!DOCTYPE html><html><head><title>SEC.gov | Request Rate Threshold Exceeded</title></head><body><h1>Your Request Originates from an Undeclared Automated Tool</h1><p>To allow for equitable access to all users, SEC reserves the right to limit requests originating from undeclared automated tools.</p></body></html>`;

/** Serve `status` on every call, with a fresh body each time. */
function stubStatus(status: number, body = 'upstream error') {
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * Drive a call that is expected to reject while advancing the fake clock past the
 * throttle delay and every retry backoff, and return the rejection.
 */
async function rejectionWithTimers(promise: Promise<unknown>): Promise<McpError> {
  const settled = promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(30_000);
  return (await settled) as McpError;
}

describe('EdgarApiService.rawFetch — retry and error classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    initEdgarApiService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // --- 429: fail fast, hint, no block page (#112) ---

  it('makes exactly one request on a 429 instead of retrying into the block (#112)', async () => {
    const fetchMock = stubStatus(429, SEC_BLOCK_PAGE);

    const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));

    expect(error).toBeInstanceOf(McpError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('classifies a 429 as RateLimited with a ten-minute cool-down hint (#112)', async () => {
    stubStatus(429, SEC_BLOCK_PAGE);

    const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));

    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    const hint = (error.data as { recovery?: { hint?: string } }).recovery?.hint;
    expect(hint).toContain('10 minutes');
    expect((error.data as { url?: string }).url).toBe(DOCUMENT_URL);
  });

  it('keeps SEC’s HTML block page out of the error payload (#112)', async () => {
    stubStatus(429, SEC_BLOCK_PAGE);

    const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));

    const wire = JSON.stringify({ message: error.message, data: error.data });
    expect(wire).not.toContain('<!DOCTYPE');
    expect(wire).not.toContain('<html');
    expect(wire).not.toContain('<title>');
    expect((error.data as { body?: unknown }).body).toBeUndefined();
    expect((error.data as { responseBody?: unknown }).responseBody).toBeUndefined();
  });

  // --- 5xx: still retried (#112 regression) ---

  it.each([500, 502, 503, 504])(
    'still retries a %i up to MAX_RETRIES before failing (#112)',
    async (status) => {
      const fetchMock = stubStatus(status);

      const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(error).toBeInstanceOf(McpError);
    },
  );

  // --- 403: hint unchanged (#112 regression) ---

  it('keeps the 403 recovery hint byte-identical (#112)', async () => {
    stubStatus(403, 'forbidden');

    const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));

    expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
    expect((error.data as { recovery?: { hint?: string } }).recovery?.hint).toBe(
      'www.sec.gov may be blocking requests. Check EDGAR_USER_AGENT format ("AppName contact@email.com") or retry later.',
    );
  });

  it('does not retry a 403', async () => {
    const fetchMock = stubStatus(403, 'forbidden');

    await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // --- Success and 404 paths stay unaffected ---

  it('returns the body on a 200 without retrying', async () => {
    const fetchMock = vi.fn(async () => new Response('filing text', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const text = getEdgarApiService().fetchText(DOCUMENT_URL);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(text).resolves.toBe('filing text');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws NotFound on a 404 without retrying', async () => {
    const fetchMock = stubStatus(404, 'not found');

    const error = await rejectionWithTimers(getEdgarApiService().fetchText(DOCUMENT_URL));

    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
