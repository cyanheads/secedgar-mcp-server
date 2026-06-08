/**
 * @fileoverview Fetch Form 4 insider transactions (purchases, sales, awards, exercises)
 * for a company by parsing ownership XML from SEC EDGAR.
 * @module mcp-server/tools/definitions/get-insider-transactions
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import {
  type InsiderTransaction,
  parseForm4Xml,
  type ReportingOwner,
} from '@/services/edgar/ownership-parser.js';

/** Transaction type filter → SEC transaction codes. */
const PURCHASE_CODES = new Set(['P']);
const SALE_CODES = new Set(['S']);

/**
 * When a canvas is available, scan up to this many recent Form 4 filings (one
 * rate-limited fetch each) so the dataframe holds a useful window for aggregation
 * beyond the inline `limit`. Without a canvas, scanning stops as soon as the
 * inline limit is met — no extra latency.
 */
const INSIDER_CANVAS_FILING_SCAN = 40;

function matchesFilter(tx: InsiderTransaction, filter: 'purchase' | 'sale' | 'all'): boolean {
  if (filter === 'all') return true;
  if (filter === 'purchase') return PURCHASE_CODES.has(tx.transaction_code);
  if (filter === 'sale') return SALE_CODES.has(tx.transaction_code);
  return true;
}

/** Build a human-readable relationship string from reporting owner flags. */
function ownerRelationship(owner: ReportingOwner): string {
  const parts: string[] = [];
  if (owner.is_director) parts.push('Director');
  if (owner.is_officer) {
    parts.push(owner.officer_title ? `Officer (${owner.officer_title})` : 'Officer');
  }
  if (owner.is_ten_percent_owner) parts.push('10% Owner');
  if (owner.is_other) parts.push('Other');
  return parts.join(', ') || 'Unknown';
}

export const getInsiderTransactionsTool = tool('secedgar_get_insider_transactions', {
  title: 'Get Insider Transactions',
  description:
    'Fetch Form 4 insider transactions (purchases, sales, grants, exercises) for a company by parsing SEC EDGAR ownership XML. Returns the reporting person, their relationship to the issuer, transaction date, type, shares traded, price per share, and shares owned after the transaction. Covers nonDerivative transactions (open-market buys/sells, gifts) and derivative transactions (option exercises, RSU vests). When a canvas is available, the full set of transactions parsed from the scanned recent filings is materialized as df_<id> (the inline list is a preview capped at limit) — query it with secedgar_dataframe_query to aggregate net buy/sell by insider. Use secedgar_search_filings with forms=["4"] for broader date-range queries or to search across all companies.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'company_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The ticker or CIK does not resolve to a known company',
      recovery: 'Use secedgar_company_search to find the correct ticker or CIK.',
    },
    {
      reason: 'no_filings_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No Form 4 filings exist for this company in the recent submissions window',
      recovery: 'Use secedgar_search_filings with forms=["4"] for broader historical coverage.',
    },
  ],

  input: z.object({
    ticker_or_cik: z
      .string()
      .min(1)
      .describe(
        'Company ticker symbol (e.g., "AAPL") or 10-digit CIK number (e.g., "0000320193"). The issuer, not the reporting person.',
      ),
    transaction_type: z
      .enum(['purchase', 'sale', 'all'])
      .default('all')
      .describe(
        'Filter by direction. "purchase" = open-market buys (code P). "sale" = open-market sells (code S). "all" includes grants, awards, exercises, gifts, and other coded transaction types as well.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe(
        'Maximum number of transactions to return across all Form 4 filings fetched. Filings are scanned newest-first. Default 20.',
      ),
  }),

  output: z.object({
    issuer_name: z.string().describe('Issuer entity name (SEC-conformed).'),
    issuer_cik: z.string().describe('Issuer CIK, zero-padded to 10 digits.'),
    issuer_ticker: z.string().optional().describe('Issuer ticker symbol when available.'),
    transactions: z
      .array(
        z
          .object({
            filing_date: z.string().describe('Date the Form 4 was filed (YYYY-MM-DD).'),
            period_of_report: z
              .string()
              .optional()
              .describe('Transaction date per the filing period (YYYY-MM-DD).'),
            accession_number: z
              .string()
              .describe('Form 4 accession number — pass to secedgar_get_filing for the raw XML.'),
            reporting_person: z.string().describe('Name of the insider who filed the Form 4.'),
            relationship: z
              .string()
              .describe('Relationship to issuer (e.g., "Director", "Officer (CEO)", "10% Owner").'),
            security_title: z.string().describe('Security type (e.g., "Common Stock").'),
            transaction_date: z
              .string()
              .optional()
              .describe('Date the transaction occurred (YYYY-MM-DD). Absent on some filings.'),
            transaction_code: z
              .string()
              .describe(
                'Single-letter SEC transaction code: P = purchase, S = sale, M = exercise, A = award, G = gift, F = tax withholding, C = conversion, others exist.',
              ),
            transaction_type: z
              .string()
              .describe(
                'Human-readable description of the transaction code (e.g., "purchase", "sale", "conversion_of_derivative").',
              ),
            is_derivative: z
              .boolean()
              .describe(
                'True for derivative security transactions (options, RSUs, convertible notes). False for direct equity transactions.',
              ),
            shares_traded: z
              .number()
              .optional()
              .describe(
                'Shares involved. Negative = disposal (sale, return, gift), positive = acquisition. Absent when the filing omits this field.',
              ),
            price_per_share: z
              .number()
              .optional()
              .describe(
                'Price per share in USD. 0 for gifts and RSU awards (no cash consideration). Absent when not reported.',
              ),
            shares_owned_after: z
              .number()
              .optional()
              .describe(
                'Total shares owned after this transaction, as reported. Absent when omitted by the filer.',
              ),
            ownership_type: z
              .enum(['direct', 'indirect'])
              .optional()
              .describe(
                'D = direct ownership, I = indirect (through a trust, family member, etc.). Absent when not reported.',
              ),
            ownership_nature: z
              .string()
              .optional()
              .describe(
                'Nature of indirect ownership (e.g., "By Trust", "By Spouse"). Only present when ownership_type is indirect.',
              ),
          })
          .describe('One insider transaction parsed from a Form 4 filing.'),
      )
      .describe(
        'Insider transactions, newest filing first. Preview capped at `limit` — the full scanned set lives on the canvas dataframe (see `dataset`).',
      ),
    filings_scanned: z.number().describe('Number of Form 4 filings scanned to produce the result.'),
    dataset: z
      .object({
        name: z
          .string()
          .describe('Dataframe handle (df_XXXXX_XXXXX) — pass to secedgar_dataframe_query.'),
        row_count: z.number().describe('Rows materialized in the dataframe.'),
        expires_at: z.string().describe('ISO 8601 expiry timestamp.'),
        truncated: z
          .boolean()
          .describe(
            'True when more recent Form 4 filings exist beyond the scanned window — the dataframe is a recent sample, not the issuer\'s full Form 4 history. Use secedgar_search_filings with forms=["4"] for exhaustive coverage.',
          ),
      })
      .optional()
      .describe(
        'Canvas dataframe holding the full parsed transaction set from the scanned filings (the inline transactions[] is a preview capped at limit). Each row carries the issuer (issuer_cik, issuer_ticker) plus the transaction fields, so it aggregates net buy/sell by insider and joins across issuers. Query with secedgar_dataframe_query. Absent when canvas is unavailable or no transactions were parsed.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when results are empty after filtering — explains the filter applied and suggests alternatives.',
      ),
  },

  async handler(input, ctx) {
    const api = getEdgarApiService();

    // Resolve company to CIK
    const resolved = await api.resolveCik(input.ticker_or_cik);
    const match = Array.isArray(resolved) ? resolved[0] : resolved;
    if (!match || (Array.isArray(resolved) && resolved.length === 0)) {
      throw ctx.fail('company_not_found', `Company '${input.ticker_or_cik}' not found.`, {
        ...ctx.recoveryFor('company_not_found'),
      });
    }

    // Fetch recent Form 4 filing metadata from submissions API
    // We over-fetch by 5x to account for multi-transaction filings and filter losses.
    const filingBatch = await api.getRecentFilingsByForm(
      match.cik,
      ['4', '4/A'],
      Math.min(input.limit * 5, 100),
    );

    if (filingBatch.length === 0) {
      throw ctx.fail('no_filings_found', `No Form 4 filings found for '${input.ticker_or_cik}'.`, {
        ...ctx.recoveryFor('no_filings_found'),
      });
    }

    const transactions: Array<{
      filing_date: string;
      period_of_report: string | undefined;
      accession_number: string;
      reporting_person: string;
      relationship: string;
      security_title: string;
      transaction_date: string | undefined;
      transaction_code: string;
      transaction_type: string;
      is_derivative: boolean;
      shares_traded: number | undefined;
      price_per_share: number | undefined;
      shares_owned_after: number | undefined;
      ownership_type: 'direct' | 'indirect' | undefined;
      ownership_nature: string | undefined;
    }> = [];

    let filingsScanned = 0;

    // With a canvas available, scan deeper than the inline `limit` so the dataframe
    // holds a useful window for aggregation; without one, stop as soon as the inline
    // limit is met (preserves the fast, low-fetch path).
    const bridge = getCanvasBridge();
    const scanFloor = bridge ? INSIDER_CANVAS_FILING_SCAN : 0;

    for (const filing of filingBatch) {
      if (transactions.length >= input.limit && filingsScanned >= scanFloor) break;

      // primaryDocument may be prefixed with xslF345X06/ — strip to get the bare filename
      const docName = filing.primaryDocument.replace(/^xsl[^/]+\//, '');
      const xmlText = await api.tryGetFilingDocument(match.cik, filing.accessionNumber, docName);
      if (!xmlText) continue;

      filingsScanned++;

      let parsed: ReturnType<typeof parseForm4Xml>;
      try {
        parsed = parseForm4Xml(xmlText);
      } catch {
        // Malformed XML in edge cases — skip and continue
        ctx.log.warning('Failed to parse Form 4 XML', {
          accessionNumber: filing.accessionNumber,
        });
        continue;
      }

      // Build a single primary owner label from the first reporting owner
      const primaryOwner = parsed.reporting_owners[0];
      const personName = primaryOwner?.name ?? 'Unknown';
      const relationship = primaryOwner ? ownerRelationship(primaryOwner) : 'Unknown';

      // Collect every matching transaction — the full set backs the canvas; the
      // inline response is sliced to `limit` after the scan completes.
      for (const tx of parsed.transactions) {
        if (!matchesFilter(tx, input.transaction_type)) continue;

        transactions.push({
          filing_date: filing.filingDate,
          period_of_report: parsed.period_of_report,
          accession_number: filing.accessionNumber,
          reporting_person: personName,
          relationship,
          security_title: tx.security_title,
          transaction_date: tx.transaction_date,
          transaction_code: tx.transaction_code,
          transaction_type: tx.transaction_type,
          is_derivative: tx.is_derivative,
          shares_traded: tx.shares_traded,
          price_per_share: tx.price_per_share,
          shares_owned_after: tx.shares_owned_after,
          ownership_type: tx.ownership_type,
          ownership_nature: tx.ownership_nature,
        });
      }
    }

    if (transactions.length === 0) {
      const filterNote =
        input.transaction_type !== 'all'
          ? ` with transaction_type="${input.transaction_type}"`
          : '';
      ctx.enrich.notice(
        `No insider transactions found for '${input.ticker_or_cik}'${filterNote} in the ${filingsScanned} most recent Form 4 filings. ` +
          `Try transaction_type="all" or use secedgar_search_filings with forms=["4"] for broader coverage.`,
      );
    }

    // Use issuer data from the resolved entity (the submissions API may not always
    // surface ticker in the same place).
    const issuerTicker = match.ticker ?? undefined;

    // Register the full scanned transaction set to the canvas; the inline response
    // is a preview sliced to `limit`. Denormalize the issuer onto every row so the
    // dataframe is self-contained for SQL aggregation and cross-issuer joins.
    let dataset:
      | { name: string; row_count: number; expires_at: string; truncated: boolean }
      | undefined;
    if (bridge && transactions.length > 0) {
      // The scanned window is a recent sample — more Form 4 filings exist when we
      // stopped before exhausting the fetched batch.
      const truncated = filingsScanned < filingBatch.length;
      const registered = await bridge.registerDataframe(ctx, {
        rows: transactions.map((t) => ({
          issuer_cik: match.cik,
          issuer_ticker: issuerTicker ?? null,
          reporting_person: t.reporting_person,
          relationship: t.relationship,
          security_title: t.security_title,
          transaction_date: t.transaction_date ?? null,
          filing_date: t.filing_date,
          period_of_report: t.period_of_report ?? null,
          transaction_code: t.transaction_code,
          transaction_type: t.transaction_type,
          is_derivative: t.is_derivative,
          shares_traded: t.shares_traded ?? null,
          price_per_share: t.price_per_share ?? null,
          shares_owned_after: t.shares_owned_after ?? null,
          ownership_type: t.ownership_type ?? null,
          ownership_nature: t.ownership_nature ?? null,
          accession_number: t.accession_number,
        })),
        sourceTool: 'secedgar_get_insider_transactions',
        queryParams: {
          ticker_or_cik: input.ticker_or_cik,
          cik: match.cik,
          transaction_type: input.transaction_type,
        },
        truncated,
      });
      if (registered) dataset = { ...toDatasetField(registered), truncated };
    }

    const inlineTransactions = transactions.slice(0, input.limit);

    ctx.log.info('Insider transactions retrieved', {
      cik: match.cik,
      filingsScanned,
      transactionCount: transactions.length,
      returned: inlineTransactions.length,
      filter: input.transaction_type,
      datasetName: dataset?.name,
    });

    return {
      issuer_name: match.name ?? input.ticker_or_cik,
      issuer_cik: match.cik,
      issuer_ticker: issuerTicker,
      transactions: inlineTransactions,
      filings_scanned: filingsScanned,
      dataset,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**Insider Transactions** — ${result.issuer_name} (CIK ${result.issuer_cik}${result.issuer_ticker ? `, ${result.issuer_ticker}` : ''})`,
      `${result.transactions.length} transaction(s) from ${result.filings_scanned} Form 4 filing(s) scanned`,
    ];

    for (const tx of result.transactions) {
      lines.push('');
      const sharesStr =
        tx.shares_traded !== undefined
          ? tx.shares_traded < 0
            ? `${Math.abs(tx.shares_traded).toLocaleString()} shares disposed`
            : `${tx.shares_traded.toLocaleString()} shares acquired`
          : 'shares not reported';
      const priceStr =
        tx.price_per_share !== undefined ? `@ $${tx.price_per_share.toFixed(2)}` : '';
      const ownedStr =
        tx.shares_owned_after !== undefined
          ? ` | owns ${tx.shares_owned_after.toLocaleString()} after`
          : '';
      const derivStr = tx.is_derivative ? ' [derivative]' : '';
      const ownershipStr = tx.ownership_nature
        ? ` (${tx.ownership_type ?? 'indirect'}: ${tx.ownership_nature})`
        : tx.ownership_type
          ? ` (${tx.ownership_type})`
          : '';

      lines.push(
        `**${tx.reporting_person}** (${tx.relationship}) — ${tx.transaction_type}${derivStr}`,
      );
      const txDate = tx.transaction_date ?? tx.filing_date;
      const periodStr = tx.period_of_report ? ` | report period: ${tx.period_of_report}` : '';
      lines.push(
        `${txDate} | ${tx.security_title} | ${sharesStr} ${priceStr}${ownedStr}${ownershipStr}${periodStr}`,
      );
      lines.push(
        `Code: ${tx.transaction_code} | Filed: ${tx.filing_date} [${tx.accession_number}]`,
      );
    }

    if (result.dataset) {
      const truncatedNote = result.dataset.truncated
        ? ' (truncated — more recent Form 4 filings exist beyond the scanned window)'
        : '';
      lines.push(
        `\nDataset: ${result.dataset.name} (${result.dataset.row_count} rows, expires ${result.dataset.expires_at})${truncatedNote} — query with secedgar_dataframe_query.`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
