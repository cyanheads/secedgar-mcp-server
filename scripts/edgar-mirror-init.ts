/**
 * @fileoverview One-shot bootstrap of the EDGAR local mirror. Downloads
 * `company_tickers.json` and the `companyfacts.zip` bulk archive into the local
 * SQLite stores. Idempotent and resumable — the framework persists state per
 * page, so re-running after an interrupt continues without re-applying lost work.
 *
 * Usage:
 *   bun run mirror:init
 *
 * Env vars (see CLAUDE.md Config table):
 *   EDGAR_USER_AGENT   required — "AppName contact@email.com"
 *   EDGAR_MIRROR_PATH  mirror directory (default ./data/edgar-mirror)
 *
 * @module scripts/edgar-mirror-init
 */

import { getServerConfig } from '@/config/server-config.js';
import { EdgarMirror } from '@/services/edgar/mirror/index.js';
import { makeScriptContext } from './_mirror-context.js';

async function main(): Promise<void> {
  const cfg = getServerConfig();
  const ctx = makeScriptContext('mirror:init');
  const mirror = new EdgarMirror({ dir: cfg.mirrorPath, userAgent: cfg.userAgent, log: ctx.log });

  const start = Date.now();
  let lastReport = start;
  ctx.log.notice('Starting EDGAR mirror init (tickers + company-facts)', { dir: cfg.mirrorPath });

  try {
    const result = await mirror.runInit({
      signal: ctx.signal,
      onProgress: (layer, info) => {
        const now = Date.now();
        if (now - lastReport < 10_000) return;
        lastReport = now;
        const elapsedMin = ((now - start) / 60_000).toFixed(1);
        console.log(
          `  [${layer}] pages=${info.pages} records=${info.records} elapsed=${elapsedMin}m`,
        );
      },
    });
    const elapsedMin = ((Date.now() - start) / 60_000).toFixed(1);
    console.log(
      `\nInit complete in ${elapsedMin}m — tickers: ${result.tickers.total} rows, company-facts: ${result.companyFacts.total} rows`,
    );
    await mirror.close();
  } catch (err) {
    console.error('\nInit failed:', err instanceof Error ? err.message : err);
    await mirror.close().catch(() => {});
    process.exit(1);
  }
}

void main();
