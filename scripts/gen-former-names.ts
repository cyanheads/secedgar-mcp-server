/**
 * @fileoverview Offline generator for the former-names.json asset.
 * Reads company_tickers.json, fetches each CIK's submission record, collects
 * formerNames[].name, and emits src/services/edgar/data/former-names.json as
 * a JSON array of [lowercasedName, zeroPaddedCIK] tuples.
 *
 * Runtime: ~17 min (≈10k CIKs at SEC's 10 req/s fair-access rate).
 * This is an offline tool — do NOT run as part of the build step.
 *
 * Usage:
 *   bun run gen:former-names
 *
 * Env vars:
 *   EDGAR_USER_AGENT   required — "AppName contact@email.com"
 *
 * @module scripts/gen-former-names
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = join(ROOT_DIR, 'src/services/edgar/data/former-names.json');

const USER_AGENT = process.env.EDGAR_USER_AGENT;
if (!USER_AGENT) {
  console.error('EDGAR_USER_AGENT env var is required. Format: "AppName contact@email.com"');
  process.exit(1);
}

/** SEC fair-access rate limit: 10 req/s per IP → 100 ms per request. */
const INTERVAL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fetch with SEC fair-access throttling (simple sequential queue). */
let lastFetch = 0;
async function secFetch(url: string): Promise<Response> {
  const elapsed = Date.now() - lastFetch;
  if (elapsed < INTERVAL_MS) await sleep(INTERVAL_MS - elapsed);
  lastFetch = Date.now();
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT as string, Accept: 'application/json' },
  });
}

interface RawTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

interface SubmissionFormerName {
  from?: string;
  name: string;
  to?: string;
}

interface SubmissionRecord {
  cik?: string;
  formerNames?: SubmissionFormerName[];
}

async function main(): Promise<void> {
  console.log('gen:former-names — fetching company_tickers.json...');
  const tickersResp = await secFetch('https://www.sec.gov/files/company_tickers.json');
  if (!tickersResp.ok) {
    console.error(`Failed to fetch company_tickers.json: HTTP ${tickersResp.status}`);
    process.exit(1);
  }
  const raw = (await tickersResp.json()) as Record<string, RawTickerEntry>;
  const entries = Object.values(raw);

  // Dedup CIKs — one fetch per registrant.
  const ciks = [...new Set(entries.map((e) => String(e.cik_str).padStart(10, '0')))];
  console.log(`  ${ciks.length} unique CIKs to scan`);

  const collected = new Map<string, string>(); // lowercasedFormerName → zeroPaddedCIK
  let done = 0;
  let skipped = 0;

  for (const cik of ciks) {
    done++;
    const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
    try {
      const resp = await secFetch(url);
      if (!resp.ok) {
        skipped++;
        continue;
      }
      const sub = (await resp.json()) as SubmissionRecord;
      if (Array.isArray(sub.formerNames)) {
        for (const fn of sub.formerNames) {
          if (fn.name && typeof fn.name === 'string') {
            const key = fn.name.toLowerCase().trim();
            if (!collected.has(key)) {
              collected.set(key, cik);
            }
          }
        }
      }
    } catch {
      skipped++;
    }

    if (done % 500 === 0) {
      console.log(
        `  progress: ${done}/${ciks.length} CIKs processed, ${collected.size} former-name tuples collected, ${skipped} skipped`,
      );
    }
  }

  // Emit as sorted array of [name, cik] tuples for deterministic diffs.
  const tuples = [...collected.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  writeFileSync(OUT_FILE, `${JSON.stringify(tuples, null, 2)}\n`, 'utf-8');

  console.log(`\nDone. ${tuples.length} former-name tuples written to ${OUT_FILE}`);
  if (skipped > 0) console.log(`  (${skipped} CIKs skipped due to fetch errors)`);
}

main().catch((err) => {
  console.error('gen:former-names failed:', err);
  process.exit(1);
});
