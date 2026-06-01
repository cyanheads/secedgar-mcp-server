/**
 * @fileoverview Tests for the company-facts ingester: the pure `fileToRows`
 * expansion (including sparse SEC payloads) and the fflate streaming path that
 * turns a zip of `CIK*.json` entries into mirror rows, plus the refresh
 * short-circuit when the bulk archive is unchanged.
 * @module tests/services/edgar/mirror/companyfacts-sync
 */

import type { MirrorRow, SyncContext, SyncPage } from '@cyanheads/mcp-ts-core/mirror';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CompanyFactsFile,
  fileToRows,
  makeCompanyFactsSync,
} from '@/services/edgar/mirror/companyfacts-sync.js';

const LM = 'Sat, 31 May 2026 03:00:00 GMT';
const LM_ISO = new Date(LM).toISOString();

describe('fileToRows', () => {
  it('expands one company into per-(taxonomy, tag) rows with a units blob', () => {
    const rows = fileToRows({
      cik: 320193,
      entityName: 'Apple Inc.',
      facts: {
        'us-gaap': {
          Revenues: {
            label: 'Revenues',
            description: 'Total revenue',
            units: {
              USD: [{ end: '2023-09-30', val: 383285000000, frame: 'CY2023', accn: 'a' }],
            },
          },
        },
      },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0] as MirrorRow;
    expect(row.id).toBe('0000320193|us-gaap|Revenues');
    expect(row.cik).toBe('0000320193');
    expect(row.entity_name).toBe('Apple Inc.');
    expect(row.label).toBe('Revenues');
    expect(row.description).toBe('Total revenue');
    expect((JSON.parse(String(row.units_json)) as Record<string, unknown[]>).USD).toHaveLength(1);
  });

  it('falls back to the tag for a missing label and null for a missing description', () => {
    const rows = fileToRows({
      cik: 1,
      entityName: 'X',
      facts: { 'us-gaap': { Assets: { units: { USD: [] } } } },
    });
    expect(rows[0]?.label).toBe('Assets');
    expect(rows[0]?.description).toBeNull();
  });

  it('skips concepts without units, and companies without facts or a numeric cik', () => {
    expect(fileToRows({ cik: 1, facts: { 'us-gaap': { NoUnits: {} } } })).toHaveLength(0);
    expect(fileToRows({ entityName: 'no cik' })).toHaveLength(0);
    expect(fileToRows({ cik: 'x' as unknown as number, facts: {} })).toHaveLength(0);
  });

  it('emits one row per tag across taxonomies', () => {
    const rows = fileToRows({
      cik: 5,
      entityName: 'Multi',
      facts: {
        'us-gaap': { Revenues: { units: { USD: [] } }, Assets: { units: { USD: [] } } },
        dei: { EntityCommonStockSharesOutstanding: { units: { shares: [] } } },
      },
    });
    expect(rows.map((r) => r.id).sort()).toEqual([
      '0000000005|dei|EntityCommonStockSharesOutstanding',
      '0000000005|us-gaap|Assets',
      '0000000005|us-gaap|Revenues',
    ]);
  });
});

describe('makeCompanyFactsSync', () => {
  afterEach(() => vi.unstubAllGlobals());

  function chunkedResponse(bytes: Uint8Array, chunkSize: number): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(bytes.slice(i, i + chunkSize));
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: { 'last-modified': LM } });
  }

  it('streams a zip of CIK*.json entries into mirror rows (ignoring other entries)', async () => {
    const apple: CompanyFactsFile = {
      cik: 320193,
      entityName: 'Apple Inc.',
      facts: { 'us-gaap': { Revenues: { units: { USD: [{ end: '2023-09-30', val: 1 }] } } } },
    };
    const msft: CompanyFactsFile = {
      cik: 789019,
      entityName: 'Microsoft',
      facts: { 'us-gaap': { Revenues: { units: { USD: [] } }, Assets: { units: { USD: [] } } } },
    };
    const zip = zipSync({
      'CIK0000320193.json': strToU8(JSON.stringify(apple)),
      'CIK0000789019.json': strToU8(JSON.stringify(msft)),
      'README.txt': strToU8('ignored'),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'HEAD'
          ? new Response(null, { status: 200, headers: { 'last-modified': LM } })
          : chunkedResponse(zip, 48),
      ),
    );

    const sync = makeCompanyFactsSync({ userAgent: 'test test@example.com' });
    const ctx: SyncContext = { mode: 'init', signal: new AbortController().signal };
    const pages: SyncPage[] = [];
    for await (const page of sync(ctx)) pages.push(page);
    const records = pages.flatMap((p) => p.records);

    expect(records.map((r) => r.id).sort()).toEqual([
      '0000320193|us-gaap|Revenues',
      '0000789019|us-gaap|Assets',
      '0000789019|us-gaap|Revenues',
    ]);
    // #33: the checkpoint marks completion, so it is emitted only on a terminal
    // (zero-record) page after the whole archive drained — never on a data page.
    // An interrupted ingest therefore persists no checkpoint, and the next refresh
    // re-streams instead of skipping a partial store as already-synced.
    for (const page of pages) {
      if (page.records.length > 0) expect(page.checkpoint).toBeUndefined();
    }
    expect(pages.filter((p) => p.checkpoint !== undefined)).toHaveLength(1);
    const last = pages.at(-1);
    expect(last?.records).toHaveLength(0);
    expect(last?.checkpoint).toBe(LM_ISO);
  });

  it('short-circuits a refresh (HEAD only, no GET) when the archive is unchanged', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('HEAD');
      return new Response(null, { status: 200, headers: { 'last-modified': LM } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const sync = makeCompanyFactsSync({ userAgent: 'test test@example.com' });
    const ctx: SyncContext = {
      mode: 'refresh',
      checkpoint: LM_ISO,
      signal: new AbortController().signal,
    };
    const pages = [];
    for await (const page of sync(ctx)) pages.push(page);

    expect(pages).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
