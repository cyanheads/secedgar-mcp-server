/**
 * @fileoverview Fetch 13F-HR quarterly institutional holdings by parsing the SEC EDGAR
 * information table XML. Institution lookup only — `ticker_or_cik` is the 13F filer.
 * EDGAR has no issuer→13F-holders index, so reverse lookup (which institutions hold a
 * stock) is out of scope (#62); issuer-side questions route to secedgar_search_filings.
 * @module mcp-server/tools/definitions/get-institutional-holdings
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { parseInfoTableXml } from '@/services/edgar/ownership-parser.js';

/**
 * Map a quarter string like "2025-Q4" to its calendar quarter-end date (YYYY-MM-DD) — the
 * filing's reporting-period end (`reportDate`) in the SEC submissions API. Returns undefined
 * when the quarter string is absent or malformed.
 */
function quarterEndDate(quarter: string | undefined): string | undefined {
  if (!quarter) return;
  const m = quarter.match(/^(\d{4})-Q([1-4])$/i);
  if (!m) return;
  // Q1→03-31, Q2→06-30, Q3→09-30, Q4→12-31.
  const day = ['03-31', '06-30', '09-30', '12-31'][Number(m[2]) - 1];
  return `${m[1]}-${day}`;
}

/** One holdings row as returned to the caller (post unit-normalization / consolidation). */
interface HoldingOut {
  cusip: string | undefined;
  investment_discretion: 'SOLE' | 'DFND' | 'OTR' | undefined;
  issuer_name: string;
  market_value_usd: number | undefined;
  put_call: 'Put' | 'Call' | undefined;
  shares_or_principal_amount: number | undefined;
  shares_or_principal_type: 'SH' | 'PRN' | undefined;
  title_of_class: string | undefined;
}

/** Sum two optional numbers; undefined only when both are absent. */
function addMaybe(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Collapse info-table sub-lines into distinct positions, keyed by (CUSIP ?? issuer, class,
 * put/call). Sums market value and shares; drops `investment_discretion` — a per-sub-line
 * attribute with no meaning once managers/accounts are rolled up. Sorted by value descending,
 * so a small `limit` returns the largest distinct holdings.
 */
function consolidatePositions(rows: HoldingOut[]): HoldingOut[] {
  const byPosition = new Map<string, HoldingOut>();
  for (const r of rows) {
    const key = `${r.cusip ?? r.issuer_name}|${r.title_of_class ?? ''}|${r.put_call ?? ''}`;
    const existing = byPosition.get(key);
    if (existing) {
      existing.market_value_usd = addMaybe(existing.market_value_usd, r.market_value_usd);
      existing.shares_or_principal_amount = addMaybe(
        existing.shares_or_principal_amount,
        r.shares_or_principal_amount,
      );
    } else {
      byPosition.set(key, { ...r, investment_discretion: undefined });
    }
  }
  return [...byPosition.values()].sort(
    (a, b) => (b.market_value_usd ?? 0) - (a.market_value_usd ?? 0),
  );
}

/** Render a whole-USD amount with a scaled B/M/K suffix — 13F positions span $100M–$60B+. */
function formatUsd(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

/**
 * Locate the information table XML document in a 13F filing. The holdings table is the
 * one XML document that is neither the cover page (`primary_doc.xml`) nor an index file —
 * its name varies (infotable.xml, form13fInfoTable.xml, or a numeric name like 53405.xml),
 * and the index `type` field carries only a display icon, so selection is name-based.
 */
function findInfoTableDocument(items: Array<{ name: string }>): string | undefined {
  const candidates = items.filter(
    (it) =>
      /\.xml$/i.test(it.name) &&
      it.name.toLowerCase() !== 'primary_doc.xml' &&
      !it.name.toLowerCase().includes('index'),
  );
  return (
    candidates.find((it) => /informationtable|infotable|form13f/i.test(it.name))?.name ??
    candidates[0]?.name
  );
}

export const getInstitutionalHoldingsTool = tool('secedgar_get_institutional_holdings', {
  title: 'Get Institutional Holdings',
  description:
    'Fetch 13F-HR quarterly institutional holdings by parsing the SEC EDGAR information table XML. ticker_or_cik is the institutional filer (e.g., "Vanguard Group" or its CIK 0000102909) — the tool returns what that institution holds. It does not do reverse lookup from a portfolio company to its institutional holders (EDGAR has no issuer-to-13F index); for issuer-side questions, use secedgar_search_filings with forms=["13F-HR"]. The 13F information table lists each position: issuer name, CUSIP, shares held, market value (in whole USD), and put/call designation for options. Sub-lines for the same security are consolidated into distinct positions sorted by value by default (set consolidate=false for raw filing rows). The full parsed holdings set is materialized as df_<id> when a canvas is available — the inline holdings list is a preview capped at limit — so query it with secedgar_dataframe_query to aggregate the whole filing or self-join across quarters on cusip + reporting_period. Institutions with less than $100M in 13(f) securities are exempt and may not file. Use secedgar_search_filings with forms=["13F-HR"] for broader search.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'company_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The ticker or CIK does not resolve to a known company or institution',
      recovery: 'Use secedgar_company_search to find the correct CIK or full entity name.',
    },
    {
      reason: 'no_filings_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No 13F-HR filings found for this entity in the recent submissions window',
      recovery:
        'Use secedgar_search_filings with forms=["13F-HR"] for broader search, or check that the entity is an institutional investment manager.',
    },
    {
      reason: 'no_info_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'The 13F-HR filing was found but the information table XML document could not be located',
      recovery:
        'Use secedgar_get_filing with the accession number to inspect the filing documents directly.',
    },
  ],

  input: z.object({
    ticker_or_cik: z
      .string()
      .min(1)
      .describe(
        'The institutional filer whose 13F to fetch — its CIK (e.g., "0000102909" for Vanguard) or full legal name (e.g., "Vanguard Group"). CIK or the full legal name resolves most reliably; tickers usually belong to operating companies, which do not file 13Fs. This is NOT the portfolio company — passing an issuer ticker like "AAPL" finds that entity\'s own filings, not who holds it.',
      ),
    quarter: z
      .string()
      .optional()
      .describe(
        'Reporting quarter to target, in "YYYY-QN" format (e.g., "2025-Q4"). When omitted, returns the most recent 13F-HR available. Quarters map to the filing window: Q4 2025 = filings submitted roughly Jan–Mar 2026.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(20)
      .describe(
        'Maximum number of holdings rows to return. 13F filings from large institutions can contain thousands of positions. Default 20.',
      ),
    consolidate: z
      .boolean()
      .default(true)
      .describe(
        'When true (default), info-table sub-lines for the same security (CUSIP + class + put/call) are summed into one position and results are sorted by market value descending, so `limit` returns the largest distinct holdings. Set false to return raw information-table rows in filing order (one per investment-discretion/manager sub-line), preserving investment_discretion.',
      ),
  }),

  output: z.object({
    filer_name: z.string().describe('Name of the institutional filer (the 13F submitter).'),
    filer_cik: z.string().describe('CIK of the 13F filer, zero-padded to 10 digits.'),
    reporting_period: z
      .string()
      .optional()
      .describe(
        'The calendar-quarter end date this 13F covers (YYYY-MM-DD), from the filing cover page. Absent if not surfaced in the filing.',
      ),
    filing_date: z.string().describe('Date the 13F was submitted (YYYY-MM-DD).'),
    accession_number: z
      .string()
      .describe(
        'Accession number for this 13F-HR filing — pass to secedgar_get_filing for the full document.',
      ),
    total_holdings_in_filing: z
      .number()
      .describe(
        'Total number of raw information-table rows in this filing, before consolidation and the limit.',
      ),
    total_positions: z
      .number()
      .optional()
      .describe(
        'Number of distinct positions after consolidating info-table sub-lines, before the limit. Present only when consolidate=true.',
      ),
    holdings: z
      .array(
        z
          .object({
            issuer_name: z.string().describe('Name of the issuer whose securities are held.'),
            title_of_class: z
              .string()
              .optional()
              .describe('Security class (e.g., "COM", "CL A", "ETF"). Absent when not reported.'),
            cusip: z
              .string()
              .optional()
              .describe('9-digit CUSIP identifier. Absent when omitted by the filer.'),
            market_value_usd: z
              .number()
              .optional()
              .describe(
                'Market value of the position in whole USD at the reporting date. SEC Form 13F has reported whole dollars since the 2023 amendments; values from filings before 2023-01-03 (originally thousands) are normalized to whole USD. Absent when not reported.',
              ),
            shares_or_principal_amount: z
              .number()
              .optional()
              .describe(
                'Number of shares (for equities) or principal amount (for debt securities). Absent when not reported.',
              ),
            shares_or_principal_type: z
              .enum(['SH', 'PRN'])
              .optional()
              .describe(
                'SH = share position, PRN = principal amount (bonds, notes). Absent when not reported.',
              ),
            put_call: z
              .enum(['Put', 'Call'])
              .optional()
              .describe(
                'Options designation. Present only when the row represents a put or call option position.',
              ),
            investment_discretion: z
              .enum(['SOLE', 'DFND', 'OTR'])
              .optional()
              .describe(
                'SOLE = sole investment discretion, DFND = defined (shared/advised), OTR = other. Absent when not reported.',
              ),
          })
          .describe('One row from the 13F information table.'),
      )
      .describe(
        'Holdings truncated to limit — consolidated positions sorted by market value when consolidate=true, else raw information-table rows in filing order.',
      ),
    dataset: z
      .object({
        name: z
          .string()
          .describe('Dataframe handle (df_XXXXX_XXXXX) — pass to secedgar_dataframe_query.'),
        row_count: z.number().describe('Rows materialized in the dataframe.'),
        expires_at: z.string().describe('ISO 8601 expiry timestamp.'),
      })
      .optional()
      .describe(
        'Canvas dataframe holding every parsed position from this 13F filing (the inline holdings[] is a preview capped at limit). Each row carries the filer metadata (filer_cik, filer_name, reporting_period, filing_date, accession_number) plus the position fields, so it self-joins across quarters/filers on cusip + reporting_period. Reflects the consolidate setting (consolidated positions when true, raw info-table sub-lines with investment_discretion when false). Query with secedgar_dataframe_query. Absent when canvas is unavailable or the filing had no holdings.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no filings were found or the result set is empty — suggests alternatives.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the inline holdings[] was capped by limit.'),
    shown: z.number().optional().describe('Number of holdings shown inline.'),
    cap: z.number().optional().describe('The limit cap applied.'),
  },

  async handler(input, ctx) {
    const api = getEdgarApiService();

    // Resolve entity to CIK
    const resolved = await api.resolveCik(input.ticker_or_cik);
    const match = Array.isArray(resolved) ? resolved[0] : resolved;
    if (!match || (Array.isArray(resolved) && resolved.length === 0)) {
      throw ctx.fail('company_not_found', `Entity '${input.ticker_or_cik}' not found.`, {
        ...ctx.recoveryFor('company_not_found'),
      });
    }

    // Validate the requested quarter's format before any lookup (fail fast on bad input).
    let periodEnd: string | undefined;
    if (input.quarter) {
      periodEnd = quarterEndDate(input.quarter);
      if (!periodEnd) {
        throw validationError(
          `Invalid quarter "${input.quarter}" — use "YYYY-QN" format, e.g. "2025-Q4".`,
        );
      }
    }

    // Pull this entity's recent 13F-HR filings from the submissions API. Each carries a
    // reportDate (the period-end), so a requested quarter is matched exactly — EFTS full-text
    // is unfit here (its `cik:` query is a doc-text phrase, not a CIK filter). No quarter →
    // most-recent; with a quarter, a miss is reported, never silently the latest filing.
    const recentFilings = await api.getRecentFilingsByForm(match.cik, ['13F-HR'], 80);
    const filingMeta = periodEnd
      ? recentFilings.find((f) => f.reportDate === periodEnd)
      : recentFilings[0];

    if (!filingMeta) {
      const quarterNote = input.quarter ? ` for quarter "${input.quarter}"` : '';
      throw ctx.fail(
        'no_filings_found',
        `No 13F-HR filings found for '${input.ticker_or_cik}'${quarterNote}.`,
        { ...ctx.recoveryFor('no_filings_found') },
      );
    }

    // Get the filing index to find the information table document
    const filingIndex = await api.tryGetFilingIndex(match.cik, filingMeta.accessionNumber);
    if (!filingIndex) {
      throw ctx.fail(
        'no_info_table',
        `Filing ${filingMeta.accessionNumber} index could not be fetched.`,
        { ...ctx.recoveryFor('no_info_table') },
      );
    }

    const infoTableDoc = findInfoTableDocument(filingIndex.directory.item);
    if (!infoTableDoc) {
      throw ctx.fail(
        'no_info_table',
        `No information table XML found in filing ${filingMeta.accessionNumber}.`,
        {
          accession_number: filingMeta.accessionNumber,
          available_documents: filingIndex.directory.item.map((i) => i.name),
          ...ctx.recoveryFor('no_info_table'),
        },
      );
    }

    const xmlText = await api.tryGetFilingDocument(
      match.cik,
      filingMeta.accessionNumber,
      infoTableDoc,
    );
    if (!xmlText) {
      throw ctx.fail(
        'no_info_table',
        `Information table document '${infoTableDoc}' could not be fetched.`,
        { ...ctx.recoveryFor('no_info_table') },
      );
    }

    // Pull reporting period and filing-manager name from the primary_doc.xml cover page.
    // The CIK resolver only knows names for ticker-listed entities, but most 13F filers
    // are investment managers that aren't listed — the cover page is the reliable source.
    let reportingPeriod: string | undefined;
    let filerName: string | undefined;
    const primaryXml = await api.tryGetFilingDocument(
      match.cik,
      filingMeta.accessionNumber,
      'primary_doc.xml',
    );
    if (primaryXml) {
      // <periodOfReport>12-31-2025</periodOfReport> or <reportCalendarOrQuarter>12-31-2025</reportCalendarOrQuarter>
      const periodMatch =
        primaryXml.match(/<periodOfReport>(\d{2}-\d{2}-\d{4})<\/periodOfReport>/) ??
        primaryXml.match(/<reportCalendarOrQuarter>(\d{2}-\d{2}-\d{4})<\/reportCalendarOrQuarter>/);
      if (periodMatch?.[1]) {
        // Convert MM-DD-YYYY to YYYY-MM-DD
        const [mm, dd, yyyy] = periodMatch[1].split('-');
        reportingPeriod = `${yyyy}-${mm}-${dd}`;
      }
      const nameMatch = primaryXml.match(
        /<(?:\w+:)?filingManager>[\s\S]*?<(?:\w+:)?name>([^<]+)<\/(?:\w+:)?name>/i,
      );
      if (nameMatch?.[1]) filerName = nameMatch[1].trim();
    }

    let parsed: ReturnType<typeof parseInfoTableXml>;
    try {
      parsed = parseInfoTableXml(xmlText);
    } catch {
      throw ctx.fail(
        'no_info_table',
        `Failed to parse information table XML for filing ${filingMeta.accessionNumber}.`,
        { ...ctx.recoveryFor('no_info_table') },
      );
    }

    // SEC's 2022 Form 13F amendments (effective 2023-01-03) switched Information Table
    // Column 4 from thousands of dollars to whole dollars. Normalize older filings (still
    // reported in thousands) up to whole USD using the filing date — the literal compliance
    // boundary, and always present (unlike the cover-page reporting period).
    const valuesInThousands = filingMeta.filingDate < '2023-01-03';
    const toUsd = (v: number | undefined): number | undefined =>
      v === undefined ? undefined : valuesInThousands ? v * 1000 : v;

    const rows: HoldingOut[] = parsed.holdings.map((h) => ({
      issuer_name: h.issuer_name,
      title_of_class: h.title_of_class,
      cusip: h.cusip,
      market_value_usd: toUsd(h.value_reported),
      shares_or_principal_amount: h.shares_or_principal_amount,
      shares_or_principal_type: h.shares_or_principal_type,
      put_call: h.put_call,
      investment_discretion: h.investment_discretion,
    }));

    const positions = input.consolidate ? consolidatePositions(rows) : rows;

    // Register the full parsed position set to the canvas (the inline holdings list
    // is a preview capped at `limit`). Denormalize the filer/period metadata onto
    // every row so the dataframe self-joins across quarters and filers on cusip +
    // reporting_period without a separate lookup. Best-effort: a canvas failure
    // leaves the inline response intact.
    let dataset: { name: string; row_count: number; expires_at: string } | undefined;
    const bridge = getCanvasBridge();
    if (bridge && positions.length > 0) {
      const registered = await bridge.registerDataframe(ctx, {
        rows: positions.map((p) => ({
          filer_cik: match.cik,
          filer_name: filerName ?? match.name ?? null,
          reporting_period: reportingPeriod ?? null,
          filing_date: filingMeta.filingDate,
          accession_number: filingMeta.accessionNumber,
          issuer_name: p.issuer_name,
          cusip: p.cusip ?? null,
          title_of_class: p.title_of_class ?? null,
          shares_or_principal_amount: p.shares_or_principal_amount ?? null,
          shares_or_principal_type: p.shares_or_principal_type ?? null,
          market_value_usd: p.market_value_usd ?? null,
          put_call: p.put_call ?? null,
          investment_discretion: p.investment_discretion ?? null,
        })),
        sourceTool: 'secedgar_get_institutional_holdings',
        queryParams: {
          ticker_or_cik: input.ticker_or_cik,
          cik: match.cik,
          quarter: input.quarter,
          consolidate: input.consolidate,
          accession_number: filingMeta.accessionNumber,
        },
      });
      if (registered) dataset = toDatasetField(registered);
    }

    const holdings = positions.slice(0, input.limit);
    if (positions.length > input.limit) {
      ctx.enrich.truncated({ shown: holdings.length, cap: input.limit });
    }

    if (holdings.length === 0) {
      ctx.enrich.notice(
        `The information table for this filing contained no holdings rows. ` +
          `This may be a 13F-NT (notice-only) filing or an amendment. ` +
          `Use secedgar_search_filings with forms=["13F-HR"] to find the correct filing.`,
      );
    }

    ctx.log.info('Institutional holdings retrieved', {
      cik: match.cik,
      accessionNumber: filingMeta.accessionNumber,
      totalHoldings: parsed.holdings.length,
      totalPositions: positions.length,
      returned: holdings.length,
      datasetName: dataset?.name,
    });

    return {
      filer_name: filerName ?? match.name ?? input.ticker_or_cik,
      filer_cik: match.cik,
      reporting_period: reportingPeriod,
      filing_date: filingMeta.filingDate,
      accession_number: filingMeta.accessionNumber,
      total_holdings_in_filing: parsed.holdings.length,
      total_positions: input.consolidate ? positions.length : undefined,
      holdings,
      dataset,
    };
  },

  format: (result) => {
    const period = result.reporting_period ? ` (period: ${result.reporting_period})` : '';
    const countLine =
      result.total_positions !== undefined
        ? `Showing ${result.holdings.length} of ${result.total_positions} positions (consolidated from ${result.total_holdings_in_filing} info-table rows)`
        : `Showing ${result.holdings.length} of ${result.total_holdings_in_filing} info-table rows`;
    const lines: string[] = [
      `**13F-HR Holdings** — ${result.filer_name} (CIK ${result.filer_cik})`,
      `Filed: ${result.filing_date}${period} | Accession: ${result.accession_number}`,
      countLine,
    ];

    for (const h of result.holdings) {
      lines.push('');
      const valueStr =
        h.market_value_usd !== undefined
          ? `${formatUsd(h.market_value_usd)} ($${h.market_value_usd.toLocaleString()})`
          : 'value N/A';
      const sharesStr =
        h.shares_or_principal_amount !== undefined
          ? `${h.shares_or_principal_amount.toLocaleString()} ${h.shares_or_principal_type ?? 'shares'}`
          : 'shares N/A';
      const putCallStr = h.put_call ? ` [${h.put_call}]` : '';
      const cusipStr = h.cusip ? ` CUSIP ${h.cusip}` : '';
      const classStr = h.title_of_class ? ` (${h.title_of_class})` : '';
      const discStr = h.investment_discretion ? ` | discretion: ${h.investment_discretion}` : '';

      lines.push(`**${h.issuer_name}**${classStr}${cusipStr}${putCallStr}`);
      lines.push(`${sharesStr} | ${valueStr}${discStr}`);
    }

    if (result.dataset) {
      const note =
        result.dataset.row_count > result.holdings.length
          ? ` — showing ${result.holdings.length} of ${result.dataset.row_count} positions inline; full set on the dataframe`
          : '';
      lines.push(
        `\nDataset: ${result.dataset.name} (${result.dataset.row_count} rows, expires ${result.dataset.expires_at})${note} — query with secedgar_dataframe_query.`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
