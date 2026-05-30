/**
 * @fileoverview Fetch Form 4 insider transactions (purchases, sales, awards, exercises)
 * for a company by parsing ownership XML from SEC EDGAR.
 * @module mcp-server/tools/definitions/get-insider-transactions
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import {
  type InsiderTransaction,
  parseForm4Xml,
  type ReportingOwner,
} from '@/services/edgar/ownership-parser.js';

/** Transaction type filter → SEC transaction codes. */
const PURCHASE_CODES = new Set(['P']);
const SALE_CODES = new Set(['S']);

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
    'Fetch Form 4 insider transactions (purchases, sales, grants, exercises) for a company by parsing SEC EDGAR ownership XML. Returns the reporting person, their relationship to the issuer, transaction date, type, shares traded, price per share, and shares owned after the transaction. Covers nonDerivative transactions (open-market buys/sells, gifts) and derivative transactions (option exercises, RSU vests). Use secedgar_search_filings with forms=["4"] for broader date-range queries or to search across all companies.',
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
      .describe('Insider transactions, newest filing first.'),
    filings_scanned: z.number().describe('Number of Form 4 filings scanned to produce the result.'),
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

    for (const filing of filingBatch) {
      if (transactions.length >= input.limit) break;

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

      for (const tx of parsed.transactions) {
        if (!matchesFilter(tx, input.transaction_type)) continue;
        if (transactions.length >= input.limit) break;

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

    ctx.log.info('Insider transactions retrieved', {
      cik: match.cik,
      filingsScanned,
      transactionCount: transactions.length,
      filter: input.transaction_type,
    });

    // Use issuer data from the first successfully parsed filing when available
    // (the submissions API may not always surface ticker in the same place)
    const issuerTicker = match.ticker ?? undefined;

    return {
      issuer_name: match.name ?? input.ticker_or_cik,
      issuer_cik: match.cik,
      issuer_ticker: issuerTicker,
      transactions,
      filings_scanned: filingsScanned,
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

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
