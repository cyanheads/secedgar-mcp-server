/**
 * @fileoverview Operability check for the EDGAR local mirror. Prints the sync
 * status of both layers and runs a couple of sample reads so an operator can
 * confirm the mirror is populated and queryable after an init or refresh.
 *
 * Usage:
 *   bun run mirror:verify
 *
 * @module scripts/edgar-mirror-verify
 */

import { getServerConfig } from '@/config/server-config.js';
import { EdgarMirror } from '@/services/edgar/mirror/index.js';

async function main(): Promise<void> {
  const cfg = getServerConfig();
  const mirror = new EdgarMirror({ dir: cfg.mirrorPath, userAgent: cfg.userAgent });

  try {
    const status = await mirror.status();
    console.log(`Mirror directory: ${cfg.mirrorPath}`);
    console.log(JSON.stringify(status, null, 2));

    if (await mirror.tickersReady()) {
      const rows = await mirror.getTickerRows();
      console.log(`tickers: ${rows.length} rows`);
    } else {
      console.log('tickers: not ready (run `bun run mirror:init`)');
    }

    if (await mirror.companyFactsReady()) {
      // Apple Inc. (CIK 0000320193) — a stable probe for the company-facts layer.
      const concept = await mirror.getCompanyConcept('320193', 'us-gaap', 'Revenues');
      console.log(
        `company-facts probe (AAPL us-gaap/Revenues): ${
          concept ? `${Object.keys(concept.units).length} unit(s)` : 'absent'
        }`,
      );
    } else {
      console.log('company-facts: not ready (run `bun run mirror:init`)');
    }

    await mirror.close();
  } catch (err) {
    console.error('Verify failed:', err instanceof Error ? err.message : err);
    await mirror.close().catch(() => {});
    process.exit(1);
  }
}

void main();
