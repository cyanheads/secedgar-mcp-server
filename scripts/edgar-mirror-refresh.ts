/**
 * @fileoverview Incremental refresh of the EDGAR local mirror. Re-downloads
 * `company_tickers.json` and re-ingests `companyfacts.zip` when the bulk archive
 * has been rebuilt since the last sync (a HEAD check short-circuits otherwise).
 * Intended for an external cron under stdio deployments; HTTP deployments can
 * schedule this in-process via `EDGAR_MIRROR_REFRESH_CRON`.
 *
 * Usage:
 *   bun run mirror:refresh
 *
 * @module scripts/edgar-mirror-refresh
 */

import { getServerConfig } from '@/config/server-config.js';
import { EdgarMirror } from '@/services/edgar/mirror/index.js';
import { makeScriptContext } from './_mirror-context.js';

async function main(): Promise<void> {
  const cfg = getServerConfig();
  const ctx = makeScriptContext('mirror:refresh');
  const mirror = new EdgarMirror({ dir: cfg.mirrorPath, userAgent: cfg.userAgent, log: ctx.log });

  const start = Date.now();
  ctx.log.notice('Starting EDGAR mirror refresh', { dir: cfg.mirrorPath });

  try {
    const result = await mirror.runRefresh({ signal: ctx.signal });
    const elapsedMin = ((Date.now() - start) / 60_000).toFixed(1);
    console.log(
      `\nRefresh complete in ${elapsedMin}m — tickers: +${result.tickers.recordsApplied}, company-facts: +${result.companyFacts.recordsApplied}`,
    );
    await mirror.close();
  } catch (err) {
    console.error('\nRefresh failed:', err instanceof Error ? err.message : err);
    await mirror.close().catch(() => {});
    process.exit(1);
  }
}

void main();
