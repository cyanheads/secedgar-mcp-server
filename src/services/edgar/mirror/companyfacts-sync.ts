/**
 * @fileoverview Ingester for the XBRL company-facts layer. Streams SEC's
 * `companyfacts.zip` (~1.3 GB) through fflate, parsing each `CIK*.json` entry
 * into one row per (cik, taxonomy, tag) with the concept's `units` map stored as
 * a JSON blob. Bounded memory: one entry is buffered at a time and rows drain to
 * the framework in batched pages. Upsert-only — a company dropped from the bulk
 * archive lingers (low-harm; re-upserted whenever it reappears).
 * @module services/edgar/mirror/companyfacts-sync
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type {
  MirrorLogger,
  MirrorRow,
  SyncContext,
  SyncGenerator,
  SyncPage,
} from '@cyanheads/mcp-ts-core/mirror';
import { Unzip, UnzipInflate } from 'fflate';
import { COMPANY_FACTS_ZIP_URL, lastModifiedToIso } from './types.js';

/** Rows drained to the framework per page (one transaction each). */
const BATCH_ROWS = 2000;

const EMPTY = new Uint8Array(0);

/** Shape of one `CIK*.json` entry inside companyfacts.zip. */
export interface CompanyFactsFile {
  cik?: number;
  entityName?: string;
  facts?: Record<
    string,
    Record<string, { label?: string; description?: string; units?: Record<string, unknown[]> }>
  >;
}

/** Expand one company's `facts` into per-(taxonomy, tag) rows. Exported for tests. */
export function fileToRows(json: CompanyFactsFile): MirrorRow[] {
  const rows: MirrorRow[] = [];
  if (typeof json.cik !== 'number' || !json.facts) return rows;
  const cik = String(json.cik).padStart(10, '0');
  const entityName = json.entityName ?? '';
  for (const [taxonomy, tags] of Object.entries(json.facts)) {
    for (const [tag, concept] of Object.entries(tags)) {
      if (!concept?.units) continue;
      rows.push({
        id: `${cik}|${taxonomy}|${tag}`,
        cik,
        taxonomy,
        tag,
        entity_name: entityName,
        label: concept.label ?? tag,
        description: concept.description ?? null,
        units_json: JSON.stringify(concept.units),
      });
    }
  }
  return rows;
}

/** HEAD the bulk archive for its `Last-Modified`, normalized to ISO. Best-effort. */
async function headLastModifiedIso(
  userAgent: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const res = await fetch(COMPANY_FACTS_ZIP_URL, {
      method: 'HEAD',
      headers: { 'User-Agent': userAgent },
      signal,
    });
    const lm = res.headers.get('last-modified');
    return lm ? lastModifiedToIso(lm) : undefined;
  } catch {
    return;
  }
}

/**
 * Build the company-facts ingester. On `refresh`, a HEAD check short-circuits
 * when the archive has not been rebuilt since the stored checkpoint. The bulk
 * archive is a full nightly snapshot, so a sync re-streams it whole and relies
 * on idempotent upserts; the framework persists each page transactionally, so an
 * interrupted run is crash-safe (a resume re-applies harmlessly).
 */
export function makeCompanyFactsSync(opts: {
  userAgent: string;
  log?: MirrorLogger;
}): SyncGenerator {
  return async function* companyFactsSync(ctx: SyncContext): AsyncGenerator<SyncPage> {
    const lastModified = await headLastModifiedIso(opts.userAgent, ctx.signal);
    if (
      ctx.mode === 'refresh' &&
      ctx.checkpoint &&
      lastModified &&
      lastModified <= ctx.checkpoint
    ) {
      opts.log?.info?.('companyfacts.zip unchanged since last sync; skipping', {
        checkpoint: ctx.checkpoint,
      });
      return;
    }

    const response = await fetch(COMPANY_FACTS_ZIP_URL, {
      headers: { 'User-Agent': opts.userAgent },
      signal: ctx.signal,
    });
    if (!response.ok || !response.body) {
      throw serviceUnavailable(`SEC companyfacts.zip download failed (HTTP ${response.status})`, {
        url: COMPANY_FACTS_ZIP_URL,
        status: response.status,
      });
    }
    const checkpoint = lastModifiedToIso(response.headers.get('last-modified')) || lastModified;

    const pending: MirrorRow[] = [];
    let completedFiles = 0;
    let skipped = 0;
    let streamError: unknown;

    const unzip = new Unzip();
    unzip.register(UnzipInflate);
    unzip.onfile = (file) => {
      const isCik = /CIK\d+\.json$/i.test(file.name);
      const chunks: Uint8Array[] = [];
      file.ondata = (err, chunk, final) => {
        if (err) {
          streamError ??= err;
          return;
        }
        if (!isCik) return;
        if (chunk?.length) chunks.push(chunk);
        if (!final) return;
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CompanyFactsFile;
          const rows = fileToRows(json);
          if (rows.length) pending.push(...rows);
        } catch {
          skipped += 1;
          opts.log?.warning?.('Skipping unparseable companyfacts entry', { name: file.name });
        }
        completedFiles += 1;
        chunks.length = 0;
      };
      file.start();
    };

    const reader = response.body.getReader();
    try {
      for (;;) {
        if (ctx.signal.aborted) {
          throw ctx.signal.reason instanceof Error
            ? ctx.signal.reason
            : new Error('companyfacts sync aborted');
        }
        const { done, value } = await reader.read();
        if (done) break;
        unzip.push(value, false);
        if (streamError) throw streamError;
        while (pending.length >= BATCH_ROWS) {
          yield {
            records: pending.splice(0, BATCH_ROWS),
            cursor: String(completedFiles),
            checkpoint,
          };
        }
      }
      unzip.push(EMPTY, true);
      if (streamError) throw streamError;
    } finally {
      reader.releaseLock();
    }

    if (skipped > 0)
      opts.log?.notice?.('companyfacts sync complete with skips', { completedFiles, skipped });
    while (pending.length) {
      yield { records: pending.splice(0, BATCH_ROWS), cursor: String(completedFiles), checkpoint };
    }
  };
}
