/**
 * @fileoverview Fetch 13F-HR quarterly institutional holdings by parsing the SEC EDGAR
 * information table XML. Works for both issuer lookup (which institutions hold a stock)
 * and institution lookup (what a specific institution holds).
 * @module mcp-server/tools/definitions/get-institutional-holdings
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { parseInfoTableXml } from '@/services/edgar/ownership-parser.js';

/**
 * Parse a quarter string like "2025-Q3" into startDate/endDate for EFTS search.
 * Returns undefined when the quarter string is absent or malformed.
 */
function quarterToDateRange(
  quarter: string | undefined,
): { startDate: string; endDate: string } | undefined {
  if (!quarter) return;
  const m = quarter.match(/^(\d{4})-Q([1-4])$/i);
  if (!m) return;
  const year = Number(m[1]);
  const q = Number(m[2]);
  // 13F filing deadlines: 45 days after quarter end.
  // Q1 ends Mar 31 → filed by May 15; Q2 ends Jun 30 → by Aug 15; etc.
  const quarterEndMonth = q * 3; // 3, 6, 9, 12
  const filingWindowStart = new Date(year, quarterEndMonth - 1, 1).toISOString().slice(0, 10);
  // Window: from quarter end month to 3 months after (covers the 45-day lag)
  const filingWindowEndDate = new Date(year, quarterEndMonth + 2, 28);
  const filingWindowEnd = filingWindowEndDate.toISOString().slice(0, 10);
  return { startDate: filingWindowStart, endDate: filingWindowEnd };
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
    'Fetch 13F-HR quarterly institutional holdings by parsing the SEC EDGAR information table XML. Use ticker_or_cik to look up an institution (e.g., "Vanguard Group" or its CIK) and see what it holds — or pass a company ticker/CIK to find which institutions filed 13Fs covering that period. The 13F information table lists each position: issuer name, CUSIP, shares held, market value (in thousands), and put/call designation for options. Institutions with less than $100M in 13(f) securities are exempt and may not file. Use secedgar_search_filings with forms=["13F-HR"] for broader search.',
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
        'Ticker symbol or CIK of the institutional filer (e.g., "0000102909" for Vanguard) or a company name. For institution lookups, CIK or the full legal name resolves most reliably — tickers are typically for operating companies, not fund managers.',
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
      .describe('Total number of infoTable rows in this filing before the limit was applied.'),
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
            value_in_thousands: z
              .number()
              .optional()
              .describe(
                'Market value of the position in thousands of USD at the reporting date. Absent when not reported.',
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
      .describe('Holdings rows from the information table, truncated to limit.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no filings were found or the result set is empty — suggests alternatives.',
      ),
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

    // Use submissions API for recent 13F filings
    let filingMeta:
      | { accessionNumber: string; filingDate: string; primaryDocument: string }
      | undefined;

    if (input.quarter) {
      // With a quarter filter, use EFTS to search for the filing in the right window
      const dateRange = quarterToDateRange(input.quarter);
      if (dateRange) {
        const eftsResp = await api.searchFilings({
          query: `cik:${match.cik}`,
          forms: ['13F-HR'],
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
          from: 0,
          size: 5,
        });
        const hit = eftsResp.hits.hits.find((h) => h._source.ciks?.includes(match.cik));
        if (hit) {
          filingMeta = {
            accessionNumber: hit._source.adsh,
            filingDate: hit._source.file_date,
            primaryDocument: 'primary_doc.xml',
          };
        }
      }
    }

    if (!filingMeta) {
      // Fall back to submissions API most-recent
      const recentFilings = await api.getRecentFilingsByForm(match.cik, ['13F-HR'], 3);
      filingMeta = recentFilings[0];
    }

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

    const totalHoldings = parsed.holdings.length;
    const holdings = parsed.holdings.slice(0, input.limit);

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
      totalHoldings,
      returned: holdings.length,
    });

    return {
      filer_name: filerName ?? match.name ?? input.ticker_or_cik,
      filer_cik: match.cik,
      reporting_period: reportingPeriod,
      filing_date: filingMeta.filingDate,
      accession_number: filingMeta.accessionNumber,
      total_holdings_in_filing: totalHoldings,
      holdings: holdings.map((h) => ({
        issuer_name: h.issuer_name,
        title_of_class: h.title_of_class,
        cusip: h.cusip,
        value_in_thousands: h.value_in_thousands,
        shares_or_principal_amount: h.shares_or_principal_amount,
        shares_or_principal_type: h.shares_or_principal_type,
        put_call: h.put_call,
        investment_discretion: h.investment_discretion,
      })),
    };
  },

  format: (result) => {
    const period = result.reporting_period ? ` (period: ${result.reporting_period})` : '';
    const lines: string[] = [
      `**13F-HR Holdings** — ${result.filer_name} (CIK ${result.filer_cik})`,
      `Filed: ${result.filing_date}${period} | Accession: ${result.accession_number}`,
      `Showing ${result.holdings.length} of ${result.total_holdings_in_filing} total positions`,
    ];

    for (const h of result.holdings) {
      lines.push('');
      const valueStr =
        h.value_in_thousands !== undefined
          ? `$${(h.value_in_thousands / 1000).toFixed(2)}M (${h.value_in_thousands}K)`
          : 'value N/A';
      const sharesStr =
        h.shares_or_principal_amount !== undefined
          ? `${h.shares_or_principal_amount.toLocaleString()} ${h.shares_or_principal_type ?? 'shares'}`
          : 'shares N/A';
      const putCallStr = h.put_call ? ` [${h.put_call}]` : '';
      const cusipStr = h.cusip ? ` CUSIP ${h.cusip}` : '';
      const classStr = h.title_of_class ? ` (${h.title_of_class})` : '';

      lines.push(`**${h.issuer_name}**${classStr}${cusipStr}${putCallStr}`);
      lines.push(`${sharesStr} | ${valueStr} | discretion: ${h.investment_discretion ?? 'N/A'}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
