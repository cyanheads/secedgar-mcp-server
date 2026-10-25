/**
 * @fileoverview Server-specific configuration for SEC EDGAR API access.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { normalizeEnv, parseEnvConfig } from '@cyanheads/mcp-ts-core/config';
import { runtimeCaps } from '@cyanheads/mcp-ts-core/utils';

/** Whether a UTF-16 code unit is a control RFC 9110 bars from a field value: C0 other than tab, or DEL. */
const isFieldValueControl = (unit: number) => (unit < 0x20 && unit !== 0x09) || unit === 0x7f;

/**
 * Whether this runtime's `fetch` sends `value` as a User-Agent rather than throwing
 * before any request goes out (#173). Both runtimes refuse what the Fetch
 * standard's `Headers` refuses — NUL, CR, or LF inside the value and anything past
 * U+00FF — so constructing one decides that part exactly, Latin-1 included. Node's
 * undici also refuses, at dispatch, the other controls RFC 9110 bars from the
 * value `Headers` normalized; Bun 1.4 sends those, so they pass there.
 */
function fetchSendsUserAgent(value: string): boolean {
  let normalized: string | null;
  try {
    normalized = new Headers({ 'User-Agent': value }).get('User-Agent');
  } catch {
    return false;
  }
  if (runtimeCaps.isBun || normalized === null) return true;
  for (let i = 0; i < normalized.length; i++) {
    if (isFieldValueControl(normalized.charCodeAt(i))) return false;
  }
  return true;
}

/**
 * Why a User-Agent `fetch` cannot send was refused, naming the first character
 * outside Latin-1 when there is one — an em dash or curly quote pasted into the
 * value is the usual cause.
 */
function unsendableUserAgentMessage(value: string): string {
  const characters = [...value];
  const position = characters.findIndex((ch) => (ch.codePointAt(0) ?? 0) > 0xff);
  const format = 'keep the "AppName contact@email.com" format';
  if (position < 0) {
    return `Cannot be sent as an HTTP header: it holds a line break or another control character. Remove it and ${format}.`;
  }
  const codePoint = (characters[position]?.codePointAt(0) ?? 0).toString(16).toUpperCase();
  return `Cannot be sent as an HTTP header: character ${position + 1} is U+${codePoint.padStart(4, '0')}, outside the Latin-1 range a header can carry. Replace it with an ASCII equivalent (a hyphen for a dash, a straight quote for a curly one) and ${format}.`;
}

const ServerConfigSchema = z.object({
  userAgent: z
    .string()
    .superRefine((value, ctx) => {
      if (!fetchSendsUserAgent(value)) {
        ctx.addIssue({ code: 'custom', message: unsendableUserAgentMessage(value) });
      }
    })
    .describe('User-Agent header for SEC compliance. Format: "AppName contact@email.com"'),
  rateLimitRps: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(10)
    .describe('Max requests/second to SEC APIs'),
  rateLimitCooldownSeconds: z.coerce
    .number()
    .int()
    .min(1)
    .default(600)
    .describe(
      'Seconds to stop sending to SEC after a 429. SEC blocks an IP until its request rate has stayed under the limit for ten minutes, and every request sent meanwhile restarts that clock, so calls are refused locally for this long and the first one after it goes out alone as a probe.',
    ),
  tickerCacheTtl: z.coerce
    .number()
    .int()
    .min(60)
    .default(3600)
    .describe(
      'Seconds to cache the ticker index (company_tickers.json + company_tickers_mf.json). A failed fund-file load is retried after 60 seconds, or the rate-limit cool-down, instead of standing for this long.',
    ),
  datasetTtlSeconds: z.coerce
    .number()
    .int()
    .min(60)
    .default(86400)
    .describe(
      'Per-table TTL for canvas-registered dataframes, in seconds. Bridge-side bookkeeping in ctx.state (backstop for cyanheads/mcp-ts-core#140 until the framework exposes RegisterTableOptions.ttlMs).',
    ),
  dataframeDropEnabled: z
    .stringbool()
    .default(false)
    .describe(
      'Set to "true" to expose secedgar_dataframe_drop. Off by default — the canvas already drops tables on the per-table TTL, and a write surface against the shared canvas is the only destructive tool on this server.',
    ),
  mirrorEnabled: z
    .stringbool()
    .default(false)
    .describe(
      'Set to "true" to enable the local SQLite mirror of company_tickers + XBRL company-facts. Off by default — when off, every CIK resolution and financials lookup hits the live SEC API. Node/Bun only; ignored on Cloudflare Workers (no SQLite/filesystem).',
    ),
  mirrorPath: z
    .string()
    .default('./data/edgar-mirror')
    .describe(
      'Directory holding the mirror SQLite databases (tickers.sqlite + companyfacts.sqlite). Created if absent.',
    ),
  mirrorRefreshCron: z
    .string()
    .optional()
    .describe(
      'Cron expression for the in-process nightly refresh (HTTP transport only). Omit to disable scheduled refresh and run `bun run mirror:refresh` out-of-band instead. Recommended "0 9 * * *" (≈04:00–05:00 ET, after SEC rebuilds the bulk files ~03:00 ET).',
    ),
  mirrorFallbackLive: z
    .stringbool()
    .default(true)
    .describe(
      'When the mirror is enabled but a lookup misses (company/concept not yet synced, or a filing newer than the last refresh), fall back to the live SEC API. Default true. Set "false" for strict mirror-only reads.',
    ),
  clampOversizedLimits: z
    .stringbool()
    .default(true)
    .describe(
      'Serve a count or size input above the cap its tool applies (a limit, content_limit, periods, preview, or row_limit) at that cap, up to each field\'s rejection bound, instead of rejecting it. Default true. Set "false" to advertise each cap as the maximum and reject anything larger.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

const ENV_VARS = {
  userAgent: 'EDGAR_USER_AGENT',
  rateLimitRps: 'EDGAR_RATE_LIMIT_RPS',
  rateLimitCooldownSeconds: 'EDGAR_RATE_LIMIT_COOLDOWN_SECONDS',
  tickerCacheTtl: 'EDGAR_TICKER_CACHE_TTL',
  datasetTtlSeconds: 'EDGAR_DATASET_TTL_SECONDS',
  dataframeDropEnabled: 'EDGAR_DATAFRAME_DROP_ENABLED',
  mirrorEnabled: 'EDGAR_MIRROR_ENABLED',
  mirrorPath: 'EDGAR_MIRROR_PATH',
  mirrorRefreshCron: 'EDGAR_MIRROR_REFRESH_CRON',
  mirrorFallbackLive: 'EDGAR_MIRROR_FALLBACK_LIVE',
  clampOversizedLimits: 'EDGAR_CLAMP_OVERSIZED_LIMITS',
} as const satisfies Record<keyof ServerConfig, string>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, ENV_VARS);
  return _config;
}

const ToolGatesSchema = ServerConfigSchema.pick({
  dataframeDropEnabled: true,
  clampOversizedLimits: true,
});

/**
 * The switches that shape the tool list, read before `createApp()` by parsing
 * only their own variables (blank or unset takes the default). Every other
 * server variable is left to `getServerConfig()` in `setup()`, so an invalid one
 * fails startup through the framework's configuration banner rather than as an
 * uncaught throw here. An invalid value of a switch itself reads as its default
 * here and fails there the same way.
 */
export function readToolGates(): z.infer<typeof ToolGatesSchema> {
  const parsed = ToolGatesSchema.safeParse(
    normalizeEnv({
      dataframeDropEnabled: process.env[ENV_VARS.dataframeDropEnabled],
      clampOversizedLimits: process.env[ENV_VARS.clampOversizedLimits],
    }),
  );
  return parsed.success ? parsed.data : ToolGatesSchema.parse({});
}
