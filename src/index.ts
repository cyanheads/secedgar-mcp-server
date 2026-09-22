#!/usr/bin/env node
/**
 * @fileoverview secedgar-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import {
  requestContextService,
  runtimeCaps,
  schedulerService,
  withExtra,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { companyAnalysisPrompt } from '@/mcp-server/prompts/definitions/company-analysis.prompt.js';
import { conceptsResource } from '@/mcp-server/resources/definitions/concepts.resource.js';
import { filingTypesResource } from '@/mcp-server/resources/definitions/filing-types.resource.js';
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { disposeEdgarApiService, initEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { closeEdgarMirror, initEdgarMirror } from '@/services/edgar/mirror/index.js';

// DuckDB is the only canvas engine we support and ships as a direct dep, so
// enable the canvas by default. Set CANVAS_PROVIDER_TYPE=none explicitly to
// turn it off (e.g. on Cloudflare Workers, where DuckDB has no V8-isolate
// build and the framework would fail to construct a canvas anyway).
process.env.CANVAS_PROVIDER_TYPE ??= 'duckdb';

// secedgar_dataframe_drop is the only destructive tool on this server and is
// off by default — TTL handles cleanup. Set EDGAR_DATAFRAME_DROP_ENABLED=true
// to expose it. When off it is registered disabled rather than dropped from the
// list: uncallable, but still discoverable with its enable hint (#103).
const dropEnabled = getServerConfig().dataframeDropEnabled;

await createApp({
  name: 'secedgar-mcp-server',
  title: 'secedgar-mcp-server',
  tools: buildToolDefinitions({ dropEnabled }),
  resources: [conceptsResource, filingTypesResource],
  prompts: [companyAnalysisPrompt],
  // No tool calls ctx.requestInput, so no HTTP session state is needed and every
  // request can land on any instance. MCP_SESSION_MODE still overrides this when
  // it carries a meaningful value.
  sessionMode: 'stateless',
  instructions:
    'Resolve a company with secedgar_company_search (ticker, name, or CIK), find its filings with secedgar_search_filings — full text covers 2001 onward, while earlier ranges browse the archives by form and need ticker:/cik: scope for text matching — and read one by accession number with secedgar_get_filing. Financial tools take friendly concept names such as "revenue" or "eps_diluted" (list them with secedgar_search_concepts), and ownership runs both ways: a 13F manager to its portfolio, an issuer to its institutional holders or 5%-and-over blockholders, a fund to its NPORT-P holdings. Data-returning tools also stage their full result as a df_<id> dataframe — inspect it with secedgar_dataframe_describe, then query it with secedgar_dataframe_query.',
  async setup(core) {
    initEdgarApiService();
    initCanvasBridge(core.canvas);

    // Optional local mirror of company_tickers + XBRL company-facts. Needs SQLite
    // and a persistent filesystem, so it is Node/Bun only — skipped on Cloudflare
    // Workers, where the live SEC API stays the only path.
    const cfg = getServerConfig();
    if (cfg.mirrorEnabled && runtimeCaps.isNode && !runtimeCaps.isWorkerLike) {
      const mirror = initEdgarMirror({ dir: cfg.mirrorPath, userAgent: cfg.userAgent });

      // In-process nightly refresh, HTTP transport only. Under stdio, operators run
      // `bun run mirror:refresh` out-of-band; the full init always runs out-of-band.
      const transport = core.config?.mcpTransportType ?? 'stdio';
      if (cfg.mirrorRefreshCron && transport === 'http') {
        const bootCtx = requestContextService.createRequestContext({
          operation: 'edgar-mirror-refresh-init',
        });
        // The framework scheduler lazily imports the optional `node-cron` peer.
        // If scheduling fails for any reason, degrade gracefully: the mirror still
        // answers reads (with live fallback) and can be refreshed out-of-band via
        // `bun run mirror:refresh`. A scheduling fault must not crash the server.
        try {
          core.logger.info(
            'Scheduling EDGAR mirror refresh',
            withExtra(bootCtx, { cron: cfg.mirrorRefreshCron }),
          );
          await schedulerService.schedule(
            'edgar-mirror-refresh',
            cfg.mirrorRefreshCron,
            async (jobCtx) => {
              try {
                const result = await mirror.runRefresh({
                  signal: AbortSignal.timeout(6 * 60 * 60_000),
                });
                core.logger.info('EDGAR mirror refresh complete', withExtra(jobCtx, result));
              } catch (err) {
                core.logger.error(
                  'EDGAR mirror refresh failed',
                  withExtra(jobCtx, {
                    error: err instanceof Error ? err.message : String(err),
                  }),
                );
              }
            },
            'Refresh the EDGAR mirror (company_tickers + XBRL company-facts) from the SEC bulk files.',
          );
          schedulerService.start('edgar-mirror-refresh');
        } catch (err) {
          core.logger.warning(
            'Could not schedule EDGAR mirror refresh; serving with live fallback. Run `bun run mirror:refresh` out-of-band to refresh the mirror.',
            withExtra(bootCtx, {
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    }
  },
  // The SEC request pacer holds a dispatch timer and any queued requests, and
  // the mirror holds two SQLite files open for the process lifetime; nothing
  // else setup() allocates outlives the framework's own disposal. The scheduled
  // refresh needs no stop here — shutdown() runs schedulerService.destroyAll()
  // right after this hook.
  async teardown() {
    disposeEdgarApiService();
    await closeEdgarMirror();
  },
});
