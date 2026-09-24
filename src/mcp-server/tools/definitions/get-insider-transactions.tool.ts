/**
 * @fileoverview Fetch Form 4 insider transactions (purchases, sales, awards, exercises)
 * for a company by parsing ownership XML from SEC EDGAR.
 * @module mcp-server/tools/definitions/get-insider-transactions
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  dataframeGuidance,
  getCanvasBridge,
  toDatasetField,
} from '@/services/canvas-bridge/canvas-bridge.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import {
  type InsiderTransaction,
  parseForm4Xml,
  type ReportingOwner,
} from '@/services/edgar/ownership-parser.js';
import { SubmissionsArchiveWalk } from '@/services/edgar/submissions-archive.js';
import type { FilingsRecent } from '@/services/edgar/types.js';

/** Transaction type filter → SEC transaction codes. */
const PURCHASE_CODES = new Set(['P']);
const SALE_CODES = new Set(['S']);

/**
 * When a canvas is available, scan at least this many recent Form 4 filings —
 * as many as the submissions window offers (one rate-limited fetch each) — so
 * the dataframe holds a useful aggregation window even when the inline `limit`
 * is small (#63). Without a canvas, scanning stops as soon as the inline limit
 * is met — no extra latency.
 */
const INSIDER_CANVAS_FILING_SCAN = 40;

/** Most Form 4 filings one call parses — one rate-limited document request each. */
const INSIDER_FILING_SCAN_CAP = 100;

/** Structured Form 4 XML became mandatory for filings on and after this date. */
const STRUCTURED_FORM4_START = '2003-06-30';

/** Form 4 metadata the scan needs, from the recent Form 4 list or a submissions block. */
interface Form4Filing {
  accessionNumber: string;
  filingDate: string;
  primaryDocument: string;
}

/**
 * The Form 4 / 4-A rows of a submissions block filed inside the window, in block order
 * (newest first). Only rows whose primary document is ownership XML — EDGAR's
 * structured Form 4 began in mid-2003, and an earlier HTML or text filing has nothing
 * this tool can parse, so fetching it would spend a request on an empty result.
 */
function windowForm4Rows(block: FilingsRecent, inWindow: (date: string) => boolean): Form4Filing[] {
  const rows: Form4Filing[] = [];
  for (let i = 0; i < block.form.length; i++) {
    const form = block.form[i];
    const filingDate = block.filingDate[i] ?? '';
    const primaryDocument = block.primaryDocument[i] ?? '';
    if ((form !== '4' && form !== '4/A') || !inWindow(filingDate)) continue;
    if (!/\.xml$/i.test(primaryDocument)) continue;
    rows.push({ accessionNumber: block.accessionNumber[i] ?? '', filingDate, primaryDocument });
  }
  return rows;
}

/** "between A and B" / "on or after A" / "on or before B" for notices. */
function describeWindow(filedAfter: string | undefined, filedBefore: string | undefined): string {
  if (filedAfter && filedBefore) return `between ${filedAfter} and ${filedBefore}`;
  return filedAfter ? `on or after ${filedAfter}` : `on or before ${filedBefore}`;
}

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
    'Fetch Form 4 insider transactions (purchases, sales, grants, exercises) for a company by parsing SEC EDGAR ownership XML. Returns the reporting person, their relationship to the issuer, transaction date, type, shares traded (absolute magnitude), direction (acquire/dispose), price per share, and shares owned after the transaction. Covers nonDerivative transactions (open-market buys/sells, gifts) and derivative transactions (option exercises, RSU vests). Without a date window it reads the newest Form 4 filings; filed_after / filed_before read any period since mid-2003, reaching past the recent submissions window into the archive (e.g. insider trades in the quarter before an earnings miss). When a canvas is available, the full set of transactions parsed from the scanned filings is materialized as df_<id> (the inline list is a preview capped at limit) — inspect it with secedgar_dataframe_describe, then query it with secedgar_dataframe_query to aggregate net buy/sell by insider: SUM(CASE WHEN direction=\'dispose\' THEN -shares_traded ELSE shares_traded END). Use secedgar_search_filings with forms=["4"] to search Form 4 filings across all companies.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'company_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The company input does not resolve to a known company',
      recovery: 'Use secedgar_company_search to find the correct ticker or CIK.',
    },
    {
      reason: 'no_filings_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'A call without a date window finds no Form 4 filings in the recent submissions window',
      recovery:
        'Pass filed_after / filed_before to read an older period, or use secedgar_search_filings with forms=["4"] to find the filings.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "SEC is rate-limiting this server's IP — SEC answered 429, or the call was refused without being sent while the cool-down after one runs",
      recovery:
        'Wait the retryAfter seconds the error carries, then retry — SEC lifts the block only once requests stop for ten minutes.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  input: z.object({
    company: z
      .string()
      .min(1)
      .describe(
        'The issuer whose Form 4 filings to read — the company, not the reporting person. A ticker symbol (e.g., "AAPL"), a CIK with or without zero-padding (e.g., "320193" or "0000320193"), or a company name (current or former). A name matching several companies resolves to the top-ranked one — exact name first, then prefix, then substring — so pass a ticker or CIK when the issuer must be exact.',
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
    filed_after: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
          .describe('YYYY-MM-DD'),
      ])
      .optional()
      .describe(
        'Only read Form 4 filings filed on or after this date (YYYY-MM-DD). A date window reaches filings older than the recent submissions window by paging into the archive, and with a canvas every Form 4 filed inside it is parsed, up to 100. Structured Form 4 XML begins in mid-2003, so an earlier window finds nothing.',
      ),
    filed_before: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
          .describe('YYYY-MM-DD'),
      ])
      .optional()
      .describe(
        'Only read Form 4 filings filed on or before this date (YYYY-MM-DD). Use alone or with filed_after. Without either bound the tool reads the newest Form 4 filings.',
      ),
  }),
  // Other tools' spellings of the company and filing-date parameters, and this tool's
  // former company name (#115).
  inputAliases: {
    ticker: 'company',
    cik: 'company',
    ticker_or_cik: 'company',
    start_date: 'filed_after',
    date_from: 'filed_after',
    end_date: 'filed_before',
    date_to: 'filed_before',
  },

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
                'Absolute number of shares involved (always positive). Absent when the filing omits this field. Use `direction` to distinguish acquisitions from disposals.',
              ),
            direction: z
              .enum(['acquire', 'dispose'])
              .optional()
              .describe(
                'Whether shares were acquired or disposed. "acquire" = buy, award, exercise; "dispose" = sale, gift, return. Absent when shares_traded is absent.',
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
    history_scanned_through: z
      .string()
      .optional()
      .describe(
        'Filing date of the oldest Form 4 parsed (YYYY-MM-DD). Present only when a date window was given; absent when the window held no Form 4 filing.',
      ),
    dataset: z
      .object({
        name: z
          .string()
          .describe(
            'Dataframe handle (df_XXXXX_XXXXX) — inspect its columns with secedgar_dataframe_describe, then query it with secedgar_dataframe_query.',
          ),
        row_count: z.number().describe('Rows materialized in the dataframe.'),
        expires_at: z.string().describe('ISO 8601 expiry timestamp.'),
        truncated: z
          .boolean()
          .describe(
            'True when Form 4 filings exist beyond those parsed — past the newest-filings sample, or, with a date window, inside the window beyond the 100-filing cap or past the 10 archive pages read. Narrow the window to reach the rest.',
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
    truncated: z
      .boolean()
      .optional()
      .describe('True when the inline transactions[] was capped by limit.'),
    shown: z.number().optional().describe('Number of transactions shown inline.'),
    cap: z.number().optional().describe('The limit cap applied.'),
  },

  async handler(input, ctx) {
    const api = getEdgarApiService();

    // Resolve company to CIK
    const resolved = await api.resolveCik(input.company);
    const match = Array.isArray(resolved) ? resolved[0] : resolved;
    if (!match || (Array.isArray(resolved) && resolved.length === 0)) {
      throw ctx.fail('company_not_found', `Company '${input.company}' not found.`, {
        ...ctx.recoveryFor('company_not_found'),
      });
    }

    const filedAfter = input.filed_after || undefined;
    const filedBefore = input.filed_before || undefined;
    const dateWindow = filedAfter || filedBefore ? { filedAfter, filedBefore } : undefined;

    // With a canvas available, scan deeper than the inline `limit` so the dataframe
    // holds a useful window for aggregation; without one, stop as soon as the inline
    // limit is met (preserves the fast, low-fetch path). A date window already bounds
    // the set, so with a canvas every filing inside it is parsed, up to the cap (#127).
    const bridge = getCanvasBridge();
    const scanFloor = bridge
      ? dateWindow
        ? INSIDER_FILING_SCAN_CAP
        : INSIDER_CANVAS_FILING_SCAN
      : 0;

    // Over-fetch Form 4 metadata by 5x to account for multi-transaction filings and
    // filter losses; with a canvas, also fetch at least the scan floor so a small inline
    // `limit` doesn't under-scan the dataframe window (#63). Capped at 100; the +1
    // sentinel row (metadata only) detects Form 4 filings beyond the scan window so
    // `dataset.truncated` is truthful.
    const scanCap = Math.min(
      bridge ? Math.max(input.limit * 5, scanFloor) : input.limit * 5,
      INSIDER_FILING_SCAN_CAP,
    );

    // Bare-CIK fallback: a numeric CIK absent from the ticker cache resolves to { cik }
    // with no name/ticker. The submissions feed 404s for such a CIK — it's a
    // filer/transmitter (e.g. an accession-number prefix), not a registrant. Convert
    // that to the declared contract error instead of leaking the raw SEC URL (#91).
    // A cache-hit or ticker-resolved match that 404s signals an EDGAR-side problem,
    // not a bad query — propagate unchanged, same reasoning as #55 and #76.
    const isBareCikFallback = !match.name && !match.ticker;
    const readSubmissionsFeed = async <T>(read: Promise<T>): Promise<T> => {
      try {
        return await read;
      } catch (err) {
        if (
          isBareCikFallback &&
          err instanceof McpError &&
          err.code === JsonRpcErrorCode.NotFound
        ) {
          ctx.log.debug('CIK has no submissions feed', { cik: match.cik });
          throw ctx.fail(
            'company_not_found',
            `No issuer found for CIK ${match.cik}. If this looks like an accession-number prefix, it's the filing agent, not the issuer — use secedgar_company_search to find the company.`,
            { ...ctx.recoveryFor('company_not_found') },
          );
        }
        throw err;
      }
    };

    let filingBatch: Form4Filing[];
    let walk: SubmissionsArchiveWalk | undefined;
    if (dateWindow) {
      // In-window Form 4 rows, newest first: the recent window, then the archive pages
      // overlapping the window, read until the scan budget plus one sentinel row is in
      // hand or the shared page cap ends the walk.
      const submissions = await readSubmissionsFeed(api.getSubmissions(match.cik));
      const inWindow = (date: string) =>
        (!filedAfter || date >= filedAfter) && (!filedBefore || date <= filedBefore);
      filingBatch = windowForm4Rows(submissions.filings.recent, inWindow);
      walk = new SubmissionsArchiveWalk(api, submissions, {
        filedAfter,
        filedBefore,
        order: 'newest-first',
      });
      if (filingBatch.length <= scanCap) {
        for await (const { block } of walk) {
          filingBatch.push(...windowForm4Rows(block, inWindow));
          if (filingBatch.length > scanCap) break;
        }
      }
    } else {
      filingBatch = await readSubmissionsFeed(
        api.getRecentFilingsByForm(match.cik, ['4', '4/A'], scanCap + 1),
      );
    }
    // Form 4 filings exist past the scan: the sentinel row turned up, or — in a date
    // window — archive pages overlapping it went unread.
    const moreBeyondWindow = filingBatch.length > scanCap || Boolean(walk?.truncated);
    const filingsToScan = filingBatch.slice(0, scanCap);

    if (filingBatch.length === 0 && !dateWindow) {
      throw ctx.fail('no_filings_found', `No Form 4 filings found for '${input.company}'.`, {
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
      /** Absolute magnitude — always positive when present. Use `direction` for sign. */
      shares_traded: number | undefined;
      direction: 'acquire' | 'dispose' | undefined;
      price_per_share: number | undefined;
      shares_owned_after: number | undefined;
      ownership_type: 'direct' | 'indirect' | undefined;
      ownership_nature: string | undefined;
    }> = [];

    let filingsScanned = 0;
    /** Filing date of the last filing parsed — the oldest, since filings run newest first. */
    let oldestParsed: string | undefined;
    let scannedWholeWindow = true;

    for (const filing of filingsToScan) {
      if (transactions.length >= input.limit && filingsScanned >= scanFloor) {
        scannedWholeWindow = false;
        break;
      }

      // primaryDocument may be prefixed with xslF345X06/ — strip to get the bare filename
      const docName = filing.primaryDocument.replace(/^xsl[^/]+\//, '');
      const xmlText = await api.tryGetFilingDocument(match.cik, filing.accessionNumber, docName);
      if (!xmlText) continue;

      filingsScanned++;
      oldestParsed = filing.filingDate;

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

        // Derive direction from the raw signed shares_traded, then store magnitude (#46).
        const rawShares = tx.shares_traded;
        const direction: 'acquire' | 'dispose' | undefined =
          rawShares !== undefined ? (rawShares < 0 ? 'dispose' : 'acquire') : undefined;
        const sharesMagnitude = rawShares !== undefined ? Math.abs(rawShares) : undefined;

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
          shares_traded: sharesMagnitude,
          direction,
          price_per_share: tx.price_per_share,
          shares_owned_after: tx.shares_owned_after,
          ownership_type: tx.ownership_type,
          ownership_nature: tx.ownership_nature,
        });
      }
    }

    const windowText = dateWindow && describeWindow(filedAfter, filedBefore);
    if (windowText && filingBatch.length === 0) {
      const walkNote = walk?.truncated
        ? ` The archive scan stopped after ${walk.pagesRead} pages, at filings from ${walk.scannedThrough}; narrow the window to reach older ones.`
        : '';
      const eraNote =
        filedBefore && filedBefore < STRUCTURED_FORM4_START
          ? ' Structured Form 4 filings begin in mid-2003, so an earlier window finds none.'
          : '';
      ctx.enrich.notice(
        `No Form 4 filings filed ${windowText} for '${input.company}'.${walkNote}${eraNote}`,
      );
    } else if (transactions.length === 0) {
      const filterNote =
        input.transaction_type !== 'all'
          ? ` with transaction_type="${input.transaction_type}"`
          : '';
      const scope = windowText
        ? `the ${filingsScanned} Form 4 filings filed ${windowText}`
        : `the ${filingsScanned} most recent Form 4 filings`;
      ctx.enrich.notice(
        `No insider transactions found for '${input.company}'${filterNote} in ${scope}. ` +
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
      // The scanned window is a recent sample — more Form 4 filings exist when the
      // scan broke before exhausting its window, or the submissions window held
      // more filings than the scan cap (the +1 sentinel fetch above) (#63).
      const truncated = !scannedWholeWindow || moreBeyondWindow;
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
          direction: t.direction ?? null,
          price_per_share: t.price_per_share ?? null,
          shares_owned_after: t.shares_owned_after ?? null,
          ownership_type: t.ownership_type ?? null,
          ownership_nature: t.ownership_nature ?? null,
          accession_number: t.accession_number,
        })),
        sourceTool: 'secedgar_get_insider_transactions',
        queryParams: {
          company: input.company,
          cik: match.cik,
          transaction_type: input.transaction_type,
          filed_after: filedAfter,
          filed_before: filedBefore,
        },
        truncated,
      });
      if (registered) dataset = { ...toDatasetField(registered), truncated };
    }

    const inlineTransactions = transactions.slice(0, input.limit);
    if (transactions.length > input.limit) {
      ctx.enrich.truncated({
        shown: inlineTransactions.length,
        cap: input.limit,
        ...(dataset && { guidance: dataframeGuidance(dataset) }),
      });
    } else if (dataset) {
      ctx.enrich.notice(dataframeGuidance(dataset));
    }

    ctx.log.info('Insider transactions retrieved', {
      cik: match.cik,
      filingsScanned,
      transactionCount: transactions.length,
      returned: inlineTransactions.length,
      filter: input.transaction_type,
      datasetName: dataset?.name,
    });

    return {
      issuer_name: match.name ?? input.company,
      issuer_cik: match.cik,
      issuer_ticker: issuerTicker,
      transactions: inlineTransactions,
      filings_scanned: filingsScanned,
      ...(dateWindow && { history_scanned_through: oldestParsed }),
      dataset,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**Insider Transactions** — ${result.issuer_name} (CIK ${result.issuer_cik}${result.issuer_ticker ? `, ${result.issuer_ticker}` : ''})`,
      `${result.transactions.length} transaction(s) from ${result.filings_scanned} Form 4 filing(s) scanned`,
    ];

    // One legend rather than a per-row tag: every row spells the direction out
    // as "shares acquired" / "shares disposed", and repeating the raw enum on
    // each line would grow the rendered text without adding information.
    if (result.transactions.length > 0) {
      lines.push('Direction: "shares acquired" = acquire, "shares disposed" = dispose.');
    }

    for (const tx of result.transactions) {
      lines.push('');
      const sharesStr =
        tx.shares_traded !== undefined
          ? tx.direction === 'dispose'
            ? `${tx.shares_traded.toLocaleString()} shares disposed`
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

    if (result.history_scanned_through) {
      lines.push(`\nHistory scanned through: ${result.history_scanned_through}`);
    }

    if (result.dataset) {
      const truncatedNote = result.dataset.truncated
        ? ' (truncated — more Form 4 filings exist beyond those scanned)'
        : '';
      lines.push(
        `\nDataset: ${result.dataset.name} (${result.dataset.row_count} rows, expires ${result.dataset.expires_at})${truncatedNote} — query with secedgar_dataframe_query.`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
