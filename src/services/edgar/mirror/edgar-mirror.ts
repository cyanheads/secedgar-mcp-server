/**
 * @fileoverview `EdgarMirror` — owns the two framework `Mirror` instances (the
 * ticker/CIK layer and the XBRL company-facts layer) and the read helpers that
 * reconstruct the live API's `companyconcept` and `frames` response shapes off
 * the local SQLite stores. The service routes through these when the mirror is
 * ready; callers gate on `tickersReady()` / `companyFactsReady()`.
 * @module services/edgar/mirror/edgar-mirror
 */

import { join } from 'node:path';
import {
  defineMirror,
  type Mirror,
  type MirrorLogger,
  type SyncMode,
  type SyncProgress,
  type SyncResult,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import type {
  CompanyConceptResponse,
  CompanyConceptUnit,
  FrameEntry,
  FramesResponse,
} from '../types.js';
import { makeCompanyFactsSync } from './companyfacts-sync.js';
import { makeTickersSync } from './tickers-sync.js';
import {
  COMPANY_CONCEPTS_TABLE,
  COMPANY_FACTS_DB_FILE,
  TICKERS_DB_FILE,
  TICKERS_TABLE,
  type TickerRow,
} from './types.js';

export interface EdgarMirrorOptions {
  /** Directory holding the SQLite databases (`EDGAR_MIRROR_PATH`). */
  dir: string;
  /** Logger for ingester warnings (per-file skips, refresh no-ops). */
  log?: MirrorLogger;
  /** SEC User-Agent for the bulk downloads. */
  userAgent: string;
}

type MirrorLayer = 'tickers' | 'companyfacts';

export interface MirrorRunArgs {
  onProgress?: (layer: MirrorLayer, info: Parameters<SyncProgress>[0]) => void;
  signal: AbortSignal;
}

/** A subset of `company_concepts` columns selected for the frames scan. */
interface FrameScanRow {
  cik: string;
  description: string | null;
  entity_name: string;
  label: string;
  units_json: string;
}

export class EdgarMirror {
  readonly tickers: Mirror;
  readonly companyFacts: Mirror;
  private _tickersReady = false;
  private _companyFactsReady = false;

  constructor(opts: EdgarMirrorOptions) {
    this.tickers = defineMirror({
      name: 'edgar-tickers',
      store: sqliteMirrorStore({
        path: join(opts.dir, TICKERS_DB_FILE),
        table: TICKERS_TABLE,
        primaryKey: 'ticker',
        columns: { ticker: 'TEXT', cik: 'TEXT', name: 'TEXT' },
        indexes: [{ columns: ['cik'] }],
      }),
      sync: makeTickersSync({ userAgent: opts.userAgent }),
      ...(opts.log ? { logger: opts.log } : {}),
    });
    this.companyFacts = defineMirror({
      name: 'edgar-companyfacts',
      store: sqliteMirrorStore({
        path: join(opts.dir, COMPANY_FACTS_DB_FILE),
        table: COMPANY_CONCEPTS_TABLE,
        primaryKey: 'id',
        columns: {
          id: 'TEXT',
          cik: 'TEXT',
          taxonomy: 'TEXT',
          tag: 'TEXT',
          entity_name: 'TEXT',
          label: 'TEXT',
          description: 'TEXT',
          units_json: 'TEXT',
        },
        indexes: [{ columns: ['taxonomy', 'tag'] }],
      }),
      sync: makeCompanyFactsSync({
        userAgent: opts.userAgent,
        ...(opts.log ? { log: opts.log } : {}),
      }),
      ...(opts.log ? { logger: opts.log } : {}),
    });
  }

  /** Memoized readiness — the durable completion marker only flips false→true. */
  async tickersReady(): Promise<boolean> {
    if (!this._tickersReady) this._tickersReady = await this.tickers.ready();
    return this._tickersReady;
  }

  async companyFactsReady(): Promise<boolean> {
    if (!this._companyFactsReady) this._companyFactsReady = await this.companyFacts.ready();
    return this._companyFactsReady;
  }

  /**
   * Stricter readiness for the cross-company frames AGGREGATION. `getFrames`
   * scans every row for a (taxonomy, tag), so a partial or mid-sync store yields
   * a plausible-but-incomplete frame with no detectable "miss" to trigger a live
   * fallback — unlike a point lookup, where a missing key falls through cleanly.
   * Keys off `status === 'complete'` (read fresh, never memoized): false while a
   * sync is in progress or after a failed one, so frames fall back to live until
   * the layer is fully synced again. Contrast `companyFactsReady()` — the durable
   * "ever completed" marker that stays true through a refresh for point reads. (#29)
   */
  async companyFactsComplete(): Promise<boolean> {
    return (await this.companyFacts.status()).status === 'complete';
  }

  /** All ticker rows, for rebuilding the in-memory CIK index. Assumes the layer is ready. */
  async getTickerRows(): Promise<TickerRow[]> {
    const handle = await this.tickers.raw();
    return handle.prepare<TickerRow>(`SELECT ticker, cik, name FROM ${TICKERS_TABLE}`).all();
  }

  /**
   * One company's full concept series in `companyconcept` API shape, or null when
   * the mirror has no row for this (cik, taxonomy, tag). Assumes the layer is ready.
   */
  async getCompanyConcept(
    cik: string,
    taxonomy: string,
    tag: string,
  ): Promise<CompanyConceptResponse | null> {
    const id = `${cik.padStart(10, '0')}|${taxonomy}|${tag}`;
    const [row] = await this.companyFacts.getByIds([id]);
    if (!row) return null;
    const description = row.description == null ? undefined : String(row.description);
    return {
      cik: Number(row.cik),
      entityName: String(row.entity_name ?? ''),
      taxonomy: String(row.taxonomy ?? taxonomy),
      tag: String(row.tag ?? tag),
      label: String(row.label ?? tag),
      units: JSON.parse(String(row.units_json ?? '{}')) as Record<string, CompanyConceptUnit[]>,
      ...(description !== undefined ? { description } : {}),
    };
  }

  /**
   * Cross-company frame in `frames` API shape, assembled by scanning every company
   * reporting (taxonomy, tag) and extracting the period's frame-aligned value.
   * Returns null when no company reports the combination. Assumes the layer is ready.
   *
   * `unit` arrives in the dashed wire form the tool uses (`USD-per-shares`); the
   * `units` map is keyed by the slashed form (`USD/shares`). `loc` (business
   * location) is absent — companyfacts carries no location; the live frames API
   * adds it. The tool treats an empty `loc` as absent.
   */
  async getFrames(
    taxonomy: string,
    tag: string,
    unit: string,
    period: string,
  ): Promise<FramesResponse | null> {
    const unitKey = unit.replace('-per-', '/');
    const handle = await this.companyFacts.raw();
    const rows = handle
      .prepare<FrameScanRow>(
        `SELECT cik, entity_name, label, description, units_json FROM ${COMPANY_CONCEPTS_TABLE} WHERE taxonomy = ? AND tag = ?`,
      )
      .all(taxonomy, tag);
    if (rows.length === 0) return null;

    const data: FrameEntry[] = [];
    let label = tag;
    let description: string | undefined;
    for (const row of rows) {
      const units = JSON.parse(row.units_json) as Record<string, CompanyConceptUnit[]>;
      const series = units[unitKey];
      if (!series) continue;
      // The frame members are the datapoints whose `frame` equals the period; if a
      // value was re-filed, the latest filing wins (matches get_financials dedup).
      let best: CompanyConceptUnit | undefined;
      for (const u of series) {
        if (u.frame !== period) continue;
        if (!best || u.filed > best.filed) best = u;
      }
      if (!best) continue;
      if (label === tag && row.label) {
        label = row.label;
        description = row.description ?? undefined;
      }
      data.push({
        accn: best.accn,
        cik: Number(row.cik),
        end: best.end,
        entityName: row.entity_name,
        loc: '',
        ...(best.start !== undefined ? { start: best.start } : {}),
        val: best.val,
      });
    }
    if (data.length === 0) return null;
    return {
      ccp: period,
      data,
      label,
      pts: data.length,
      tag,
      taxonomy,
      uom: unit,
      ...(description !== undefined ? { description } : {}),
    };
  }

  /** Full init (bootstrap) of both layers — tickers first (fast), then company-facts. */
  runInit(args: MirrorRunArgs): Promise<{ tickers: SyncResult; companyFacts: SyncResult }> {
    return this.runBothLayers('init', args);
  }

  /** Incremental refresh of both layers. */
  runRefresh(args: MirrorRunArgs): Promise<{ tickers: SyncResult; companyFacts: SyncResult }> {
    return this.runBothLayers('refresh', args);
  }

  private async runBothLayers(
    mode: SyncMode,
    args: MirrorRunArgs,
  ): Promise<{ tickers: SyncResult; companyFacts: SyncResult }> {
    const tickers = await this.tickers.runSync({
      mode,
      signal: args.signal,
      ...(args.onProgress ? { onProgress: (i) => args.onProgress?.('tickers', i) } : {}),
    });
    const companyFacts = await this.companyFacts.runSync({
      mode,
      signal: args.signal,
      ...(args.onProgress ? { onProgress: (i) => args.onProgress?.('companyfacts', i) } : {}),
    });
    return { tickers, companyFacts };
  }

  /** Combined status of both layers, for the verify script and operability checks. */
  async status() {
    return {
      tickers: await this.tickers.status(),
      companyFacts: await this.companyFacts.status(),
    };
  }

  async close(): Promise<void> {
    await this.tickers.close();
    await this.companyFacts.close();
  }
}
