/**
 * @fileoverview Server-specific configuration for SEC EDGAR API access.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';

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
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= ServerConfigSchema.parse({
    userAgent: process.env.EDGAR_USER_AGENT,
    rateLimitRps: process.env.EDGAR_RATE_LIMIT_RPS,
    tickerCacheTtl: process.env.EDGAR_TICKER_CACHE_TTL,
  });
  return _config;
}
