/**
 * @fileoverview Server-specific configuration for SEC EDGAR API access.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  userAgent: z
    .string()
    .describe('User-Agent header for SEC compliance. Format: "AppName contact@email.com"'),
  rateLimitRps: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(10)
    .describe('Max requests/second to SEC APIs'),
  tickerCacheTtl: z.coerce
    .number()
    .int()
    .min(60)
    .default(3600)
    .describe('Seconds to cache company_tickers.json'),
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
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    userAgent: 'EDGAR_USER_AGENT',
    rateLimitRps: 'EDGAR_RATE_LIMIT_RPS',
    tickerCacheTtl: 'EDGAR_TICKER_CACHE_TTL',
    datasetTtlSeconds: 'EDGAR_DATASET_TTL_SECONDS',
    dataframeDropEnabled: 'EDGAR_DATAFRAME_DROP_ENABLED',
    mirrorEnabled: 'EDGAR_MIRROR_ENABLED',
    mirrorPath: 'EDGAR_MIRROR_PATH',
    mirrorRefreshCron: 'EDGAR_MIRROR_REFRESH_CRON',
    mirrorFallbackLive: 'EDGAR_MIRROR_FALLBACK_LIVE',
  });
  return _config;
}
