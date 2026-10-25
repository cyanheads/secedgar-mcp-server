/**
 * @fileoverview Fetch 13F-HR quarterly institutional holdings by parsing the SEC EDGAR
 * information table XML, composed with the quarter's 13F-HR/A amendments (#198).
 * Institution lookup only — `company` is the 13F filer.
 * The reverse direction (which institutions hold an issuer) is secedgar_find_holders,
 * which searches the information tables by CUSIP and returns filer CIKs to feed back
 * into this tool (#81).
 * @module mcp-server/tools/definitions/get-institutional-holdings
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  type LimitClampOptions,
  limitClamp,
  withLimitClamps,
} from '@/mcp-server/tools/limit-clamp.js';
import {
  dataframeGuidance,
  getCanvasBridge,
  toDatasetField,
} from '@/services/canvas-bridge/canvas-bridge.js';
import { CallScope } from '@/services/edgar/call-scope.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import {
  type HoldingRow,
  parseInfoTableXml,
  parseThirteenFCoverPage,
} from '@/services/edgar/ownership-parser.js';
import {
  ARCHIVE_PAGE_SCAN_CAP,
  SubmissionsArchiveWalk,
} from '@/services/edgar/submissions-archive.js';
import type { FilingsRecent } from '@/services/edgar/types.js';

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
  /** Accessions the row came from, in application order — several once consolidated. */
  source_accession_numbers: string[];
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
 * attribute with no meaning once managers/accounts are rolled up — and unions the source
 * accessions, so a position merged across an original and its amendment names both. Sorted
 * by value descending, so a small `limit` returns the largest distinct holdings.
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
      for (const accession of r.source_accession_numbers) {
        if (!existing.source_accession_numbers.includes(accession)) {
          existing.source_accession_numbers.push(accession);
        }
      }
    } else {
      byPosition.set(key, {
        ...r,
        investment_discretion: undefined,
        source_accession_numbers: [...r.source_accession_numbers],
      });
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

/** Outcome of reading one filing's information table: the parsed rows, or the step that failed. */
type InfoTableRead =
  | { kind: 'ok'; holdings: HoldingRow[] }
  | { kind: 'no_index' }
  | { kind: 'no_document'; documents: string[] }
  | { kind: 'no_table'; document: string }
  | { kind: 'unparseable' };

/**
 * Read a 13F filing's information table: the index, the table document it names, and the
 * parse. Two requests. SEC failures other than a 404 throw from the service.
 */
async function readInfoTable(
  api: ReturnType<typeof getEdgarApiService>,
  cik: string,
  accession: string,
  scope: CallScope,
): Promise<InfoTableRead> {
  const index = await api.tryGetFilingIndex(cik, accession, scope);
  if (!index) return { kind: 'no_index' };
  const document = findInfoTableDocument(index.directory.item);
  if (!document) return { kind: 'no_document', documents: index.directory.item.map((i) => i.name) };
  const xml = await api.tryGetFilingDocument(cik, accession, document, scope);
  if (!xml) return { kind: 'no_table', document };
  try {
    return { kind: 'ok', holdings: parseInfoTableXml(xml).holdings };
  } catch {
    return { kind: 'unparseable' };
  }
}

/**
 * Normalize one accession's parsed rows to whole USD and tag them with their source. SEC's
 * 2022 Form 13F amendments (effective 2023-01-03) switched Information Table Column 4 from
 * thousands of dollars to whole dollars, and an amendment filed after that date reports whole
 * dollars even for a pre-2023 quarter, so the unit follows each accession's own filing date —
 * the literal compliance boundary, and always present (unlike the cover-page period).
 */
function toHoldingRows(
  holdings: HoldingRow[],
  accession: string,
  filingDate: string,
): HoldingOut[] {
  const scale = filingDate < '2023-01-03' ? 1000 : 1;
  return holdings.map((h) => ({
    issuer_name: h.issuer_name,
    title_of_class: h.title_of_class,
    cusip: h.cusip,
    market_value_usd: h.value_reported === undefined ? undefined : h.value_reported * scale,
    shares_or_principal_amount: h.shares_or_principal_amount,
    shares_or_principal_type: h.shares_or_principal_type,
    put_call: h.put_call,
    investment_discretion: h.investment_discretion,
    source_accession_numbers: [accession],
  }));
}

/**
 * Identity of a raw row for the NEW HOLDINGS containment test. Value is left out: its unit
 * changed at 2023-01-03, so a resubmitted row filed across that date differs only in scale.
 */
const rowIdentity = (r: HoldingOut) =>
  `${r.cusip ?? r.issuer_name}|${r.title_of_class ?? ''}|${r.put_call ?? ''}|${r.investment_discretion ?? ''}|${r.shares_or_principal_amount ?? ''}|${r.shares_or_principal_type ?? ''}`;

/**
 * True when `table` repeats every row of `composed`, counting duplicates. A NEW HOLDINGS
 * amendment should list only the added securities, but some filers resubmit the whole table
 * under that type (First Eagle's 2026-Q2 amendment repeats all 614 original rows plus 2);
 * appending it would double the portfolio, so it is applied as the restatement it is.
 */
function repeatsEveryRow(table: HoldingOut[], composed: HoldingOut[]): boolean {
  if (composed.length === 0) return false;
  const counts = new Map<string, number>();
  for (const r of table) counts.set(rowIdentity(r), (counts.get(rowIdentity(r)) ?? 0) + 1);
  for (const r of composed) {
    const left = counts.get(rowIdentity(r)) ?? 0;
    if (left === 0) return false;
    counts.set(rowIdentity(r), left - 1);
  }
  return true;
}

/** How a same-period amendment entered the composed holdings. */
type AppliedAs = z.infer<typeof amendmentIdentity>['applied_as'];

/** One filing in composition order: the original 13F-HR, or a same-period 13F-HR/A. */
interface CompositionStep {
  accession: string;
  /** `undefined` when the amendment's cover-page type could not be read. */
  kind: 'original' | 'RESTATEMENT' | 'NEW HOLDINGS' | undefined;
  row: ThirteenFRow;
  status: AppliedAs;
}

/**
 * Compose a quarter's holdings from its original 13F-HR and same-period amendments, in
 * acceptance order. A RESTATEMENT replaces everything composed before it (earlier NEW
 * HOLDINGS included), and the original counts as one: the base is the last restatement whose
 * table reads, walking back to the original, and nothing before it is read (`superseded`).
 * Each NEW HOLDINGS after the base is read and appended — or applied as a restatement when
 * its table repeats every composed row. An amendment whose type or table cannot be read is
 * `not_applied`; `readTable` returns undefined for it.
 */
async function composeHoldings(
  steps: CompositionStep[],
  originalRows: HoldingOut[],
  readTable: (step: CompositionStep) => Promise<HoldingOut[] | undefined>,
): Promise<{ accessions: string[]; rows: HoldingOut[] }> {
  let base = 0;
  let rows = originalRows;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i] as CompositionStep;
    if (step.kind === 'original') {
      base = i;
      break;
    }
    if (step.kind !== 'RESTATEMENT') continue;
    const table = await readTable(step);
    if (table) {
      base = i;
      rows = table;
      step.status = 'restatement';
      break;
    }
    step.status = 'not_applied';
  }
  for (const step of steps.slice(0, base)) if (!step.kind) step.status = 'not_applied';
  let applied = [steps[base] as CompositionStep];
  for (const step of steps.slice(base + 1)) {
    // A restatement past the base was tried in the backward pass and did not read.
    if (step.kind !== 'NEW HOLDINGS') {
      step.status = 'not_applied';
      continue;
    }
    const table = await readTable(step);
    if (!table) step.status = 'not_applied';
    else if (repeatsEveryRow(table, rows)) {
      for (const earlier of applied) if (earlier.kind !== 'original') earlier.status = 'superseded';
      applied = [step];
      rows = table;
      step.status = 'restatement';
    } else {
      applied.push(step);
      rows = [...rows, ...table];
      step.status = 'new_holdings';
    }
  }
  return { accessions: applied.map((s) => s.accession), rows };
}

/**
 * Periodic-report forms that mark an operating company (not an institutional manager).
 * A filer with any of these and no 13F-HR is misrouted here — the caller wants
 * secedgar_get_financials / secedgar_search_filings, not a 13F (#86).
 */
const OPERATING_COMPANY_FORMS = ['10-K', '10-K/A', '10-Q', '10-Q/A', '8-K', '8-K/A'];

/** The holdings report, and the notice a manager files instead when others report its holdings. */
const HOLDINGS_REPORT_FORM = '13F-HR';
const NOTICE_FORMS = new Set(['13F-NT', '13F-NT/A']);

/** One 13F-HR, 13F-HR/A or 13F-NT notice row from a submissions block. */
interface ThirteenFRow {
  /** EDGAR acceptance timestamp; empty when the block omits it. Orders same-day amendments. */
  acceptanceDateTime: string;
  accessionNumber: string;
  filingDate: string;
  form: string;
  reportDate: string;
}

/**
 * Composition order: acceptance time, which separates two amendments filed the same day
 * (Advisors Asset Management's 2020-Q2 restatement and new-holdings amendment, 2026-08-27,
 * a minute apart), then filing date when a block lacks it, then accession. `amendmentNo`
 * is not a key — filers skip numbers.
 */
function compositionOrder(a: ThirteenFRow, b: ThirteenFRow): number {
  return (
    (a.acceptanceDateTime || a.filingDate).localeCompare(b.acceptanceDateTime || b.filingDate) ||
    a.filingDate.localeCompare(b.filingDate) ||
    a.accessionNumber.localeCompare(b.accessionNumber)
  );
}

/**
 * Zip a submissions block (the recent window or an archive page) into its 13F-HR,
 * 13F-HR/A and 13F-NT notice rows, newest filed first. Read off the submissions fetch the
 * tool already holds, which also feeds the 404 handling (#76) and the operating-company
 * classification (#86).
 */
function thirteenFRows(block: FilingsRecent): ThirteenFRow[] {
  const out: ThirteenFRow[] = [];
  for (let i = 0; i < block.form.length; i++) {
    const form = block.form[i] ?? '';
    if (form !== HOLDINGS_REPORT_FORM && form !== '13F-HR/A' && !NOTICE_FORMS.has(form)) continue;
    out.push({
      acceptanceDateTime: block.acceptanceDateTime?.[i] ?? '',
      accessionNumber: block.accessionNumber[i] ?? '',
      filingDate: block.filingDate[i] ?? '',
      form,
      reportDate: block.reportDate[i] ?? '',
    });
  }
  return out;
}

/** The newest-filed 13F-HR and 13F-NT for one period among `rows`. */
function forPeriod(rows: ThirteenFRow[], periodEnd: string) {
  const inPeriod = rows.filter((r) => r.reportDate === periodEnd);
  return {
    report: inPeriod.find((r) => r.form === HOLDINGS_REPORT_FORM),
    notice: inPeriod.find((r) => NOTICE_FORMS.has(r.form)),
  };
}

/** SEC lookup failures that can leave optional disclosure unavailable. */
function optionalLookupFailure(err: unknown): err is McpError {
  return (
    err instanceof McpError &&
    [
      JsonRpcErrorCode.ServiceUnavailable,
      JsonRpcErrorCode.Timeout,
      JsonRpcErrorCode.Forbidden,
      JsonRpcErrorCode.RateLimited,
      JsonRpcErrorCode.NotFound,
    ].includes(err.code)
  );
}

const amendmentIdentity = z.object({
  accession_number: z.string().describe('Accession for secedgar_get_filing.'),
  filing_date: z.string().describe('Filing date (YYYY-MM-DD).'),
  applied_as: z
    .enum(['restatement', 'new_holdings', 'superseded', 'not_applied'])
    .describe('Composition role.'),
});
const amendmentSchema = z.discriminatedUnion('amendment_type', [
  amendmentIdentity
    .extend({
      amendment_type: z.enum(['RESTATEMENT', 'NEW HOLDINGS']).describe('Cover-page type.'),
    })
    .describe('Typed amendment.'),
  amendmentIdentity
    .extend({
      amendment_type: z.literal('UNAVAILABLE').describe('Type could not be read.'),
      unavailable_reason: z
        .enum(['missing_header', 'unreadable_header', 'lookup_failed', 'lookup_stopped'])
        .describe('Why the type is unavailable; inspect with secedgar_get_filing.'),
    })
    .describe('Untyped amendment.'),
]);
type UnavailableReason = Extract<
  z.infer<typeof amendmentSchema>,
  { amendment_type: 'UNAVAILABLE' }
>['unavailable_reason'];

/** `limit`: a page holds at most 500 holdings rows (#197). */
const holdingsLimit = limitClamp({
  tool: 'secedgar_get_institutional_holdings',
  field: 'limit',
  min: 1,
  cap: 500,
  bound: 1000,
  shape: (n) => n.default(20),
  description:
    'Maximum number of holdings rows to return. 13F filings from large institutions can contain thousands of positions. Default 20.',
});

export const getInstitutionalHoldingsTool = tool('secedgar_get_institutional_holdings', {
  title: 'Get Institutional Holdings',
  description:
    'Read an institutional manager\'s 13F-HR information table for a quarter. company is the filer: a 10-digit CIK, ticker, or name; names outside the ticker file use EDGAR entity search, and ambiguous names return candidates. For managers holding an issuer, use secedgar_find_holders and pass its filer_cik here. Positions carry issuer, CUSIP, shares, whole-USD market value, option designation, and the accessions they came from. Same-period 13F-HR/A amendments are composed in acceptance order: a RESTATEMENT replaces the rows, a NEW HOLDINGS amendment adds its rows, and each amendment reports how it was applied. By default, sub-lines consolidate into positions sorted by value; consolidate=false preserves raw filing order, each filing\'s rows after the last. Page with limit, offset and returned next_offset. When canvas is available, the full composed positions are staged as df_<id>: inspect with secedgar_dataframe_describe, then aggregate or join on cusip + reporting_period with secedgar_dataframe_query. Managers below $100M in 13(f) securities may not file. Use secedgar_search_filings with forms=["13F-HR"] for broader search.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'company_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The company input does not resolve to a known company or institution',
      recovery: 'Use secedgar_company_search to find the correct CIK or full entity name.',
    },
    {
      reason: 'ambiguous_entity',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The name resolves to multiple EDGAR entities (e.g. several filers sharing a legal name)',
      recovery: 'Retry with the exact 10-digit CIK of the intended filer from the matches list.',
    },
    {
      reason: 'no_filings_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No 13F-HR matches — the entity files none, none exists for the requested quarter in the recent submissions window or the archive pages searched, or the manager filed a 13F-NT notice instead (for the requested quarter, or as its only recent 13F filing when no quarter is given)',
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
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "SEC is rate-limiting this server's IP — SEC answered 429, or the call was refused without being sent while the cool-down after one runs",
      recovery:
        'Wait the retryAfter seconds the error carries, then retry — SEC lifts the block only once requests stop for ten minutes.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'sec_unreachable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "SEC EDGAR gave no complete, readable response — on the last attempt made (the third, or an earlier one once this call's 40-second budget for SEC failures ran out) the connection failed, no response headers arrived within 15 seconds, or the body broke off or stalled for 15 seconds, each wait capped at what was left of that budget; a 200 body was not the JSON SEC serves; or earlier SEC failures had spent that budget, so the request was never sent",
      recovery:
        'Retry the same call in a minute — SEC EDGAR did not deliver a complete, readable response, and nothing in the request needs to change.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  input: z.object({
    company: z
      .string()
      .min(1)
      .describe(
        'The institutional filer whose 13F to fetch — a 10-digit CIK (e.g. "0000102909" for VANGUARD GROUP INC, the most reliable form), a ticker, or an entity name. A name is matched against the registrants in EDGAR\'s ticker file first (current and former names) and, when none match, resolved through EDGAR entity search, which covers institutional managers absent from that file; a name matching several filers (some legal names are shared across entities) returns those candidates so you can retry with the exact CIK. This is NOT the portfolio company — passing an issuer ticker like "AAPL" finds that operating company\'s own filings (it files no 13F), not who holds it; use secedgar_find_holders for that direction.',
      ),
    quarter: z
      .string()
      .optional()
      .describe(
        'Reporting quarter to target, in "YYYY-QN" format (e.g., "2025-Q4"), matched exactly against each 13F-HR\'s period of report. When omitted, returns the most recent 13F-HR in the submissions feed\'s recent window (the last year or 1,000 filings, whichever holds more). Quarters map to the filing window: Q4 2025 = filings submitted roughly Jan–Mar 2026. A quarter older than the recent window is looked up in the archive, reading forward from the quarter end up to 10 archive pages. A quarter the manager covered with a 13F-NT notice (holdings reported by other managers) fails naming that notice.',
      ),
    limit: holdingsLimit.schema(true),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Row to start the page at, 0-based, over the ordered position list. Pass the next_offset from the previous response to read the next page — the filing is parsed whole and sliced, so paging is stable and gap-free. An offset at or past the position count returns an empty page.',
      ),
    consolidate: z
      .boolean()
      .default(true)
      .describe(
        'When true (default), info-table sub-lines for the same security (CUSIP + class + put/call) are summed into one position and results are sorted by market value descending, so `limit` returns the largest distinct holdings. Set false to return raw information-table rows in filing order (one per investment-discretion/manager sub-line), preserving investment_discretion.',
      ),
  }),
  // Other tools' spellings of the company parameter, and this tool's former one (#115).
  inputAliases: { ticker: 'company', cik: 'company', ticker_or_cik: 'company' },

  output: z.object({
    filer_name: z.string().describe('Institutional filer name (the 13F submitter).'),
    filer_cik: z.string().describe('CIK of the 13F filer, zero-padded to 10 digits.'),
    reporting_period: z
      .string()
      .optional()
      .describe('Cover-page quarter end (YYYY-MM-DD). Absent if omitted.'),
    filing_date: z.string().describe('Original 13F-HR filing date (YYYY-MM-DD).'),
    accession_number: z.string().describe('Original 13F-HR accession for secedgar_get_filing.'),
    amendments: z
      .array(amendmentSchema.describe('Same-period 13F-HR/A.'))
      .optional()
      .describe('Known amendments, newest filed first. Absent if none.'),
    amendment_search_complete: z
      .boolean()
      .optional()
      .describe('False if archive discovery was bounded or unavailable.'),
    composed_accessions: z
      .array(z.string())
      .describe('Accessions whose rows form holdings, in application order.'),
    total_holdings_in_filing: z.number().describe('Original 13F-HR raw row count.'),
    total_holdings_composed: z
      .number()
      .describe('Composed raw row count before consolidation or paging.'),
    total_positions: z
      .number()
      .optional()
      .describe('Distinct positions before paging. Only with consolidate=true.'),
    offset: z.number().describe('Row the returned page starts at, 0-based.'),
    next_offset: z
      .number()
      .optional()
      .describe('Offset for the next page. Absent on the last page.'),
    holdings: z
      .array(
        z
          .object({
            issuer_name: z.string().describe('Name of the issuer whose securities are held.'),
            title_of_class: z
              .string()
              .optional()
              .describe('Security class (COM, CL A, ETF). Absent if unreported.'),
            cusip: z.string().optional().describe('CUSIP. Absent if unreported.'),
            market_value_usd: z
              .number()
              .optional()
              .describe(
                'Whole USD at report date; values filed before 2023-01-03 scaled from thousands. Absent if unreported.',
              ),
            shares_or_principal_amount: z
              .number()
              .optional()
              .describe('Shares or debt principal. Absent if unreported.'),
            shares_or_principal_type: z
              .enum(['SH', 'PRN'])
              .optional()
              .describe('SH shares; PRN debt principal. Absent if unreported.'),
            put_call: z
              .enum(['Put', 'Call'])
              .optional()
              .describe('Present only on a put or call option position.'),
            investment_discretion: z
              .enum(['SOLE', 'DFND', 'OTR'])
              .optional()
              .describe(
                'SOLE sole, DFND shared/advised, OTR other. Absent if unreported or consolidated.',
              ),
            source_accession_numbers: z
              .array(z.string())
              .describe('Accessions the row came from, in application order.'),
          })
          .describe('One row from the 13F information table.'),
      )
      .describe(
        '`limit` rows from `offset`: positions by value when consolidate=true, else raw rows in application order.',
      ),
    dataset: z
      .object({
        name: z
          .string()
          .describe(
            'Dataframe handle (df_XXXXX_XXXXX) for secedgar_dataframe_describe, then secedgar_dataframe_query.',
          ),
        row_count: z.number().describe('Rows materialized in the dataframe.'),
        expires_at: z.string().describe('ISO 8601 expiry timestamp.'),
      })
      .optional()
      .describe(
        'Composed positions, shaped by consolidate; join on cusip + reporting_period. Absent without canvas or holdings.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Amendment composition, discovery, paging, and dataframe guidance.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the inline holdings[] was capped by limit.'),
    shown: z.number().optional().describe('Number of holdings shown inline.'),
    cap: z.number().optional().describe('The limit cap applied.'),
  },

  async handler(input, ctx) {
    const limit = holdingsLimit.apply(input.limit, ctx);
    const api = getEdgarApiService();
    const callScope = new CallScope(ctx.signal);

    // Resolve entity to CIK. Ticker/CIK/name go through the ticker cache first; on a
    // name miss, fall back to EFTS entity-autocomplete, which resolves any EDGAR filer —
    // institutional managers, trusts, individuals — that company_tickers.json can never
    // contain (#73). Both paths normalize to a candidate list so ambiguity is handled
    // uniformly and index 0 is never taken silently.
    const resolved = await api.resolveCik(input.company, callScope);
    const candidates: Array<{ cik: string; name: string | undefined; ticker: string | undefined }> =
      Array.isArray(resolved)
        ? resolved.length === 0
          ? (await api.resolveEntityByName(input.company, callScope)).map((m) => ({
              cik: m.cik,
              name: m.name,
              ticker: undefined,
            }))
          : resolved.map((m) => ({ cik: m.cik, name: m.name, ticker: m.ticker }))
        : [{ cik: resolved.cik, name: resolved.name, ticker: resolved.ticker }];

    // Several filers match this name (the ticker cache returned multiple, or EFTS
    // returned distinct entities sharing a legal name) — list them for disambiguation
    // by CIK, never auto-resolve to the top hit (#73).
    if (candidates.length > 1) {
      const shown = candidates.slice(0, 10);
      const list = shown.map((c) => `${c.cik}${c.name ? ` (${c.name})` : ''}`).join(', ');
      throw ctx.fail(
        'ambiguous_entity',
        `'${input.company}' matches multiple EDGAR entities: ${list}. Retry with the exact 10-digit CIK.`,
        { matches: shown.map((c) => ({ cik: c.cik, name: c.name, ticker: c.ticker })) },
      );
    }
    const [match] = candidates;
    if (!match) {
      throw ctx.fail('company_not_found', `Entity '${input.company}' not found.`);
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

    // Bare-CIK fallback: a numeric CIK absent from the ticker cache resolves to { cik }
    // with no name/ticker. getSubmissions 404s for a CIK with no submissions feed — a
    // filer/transmitter CIK (e.g. an accession-number prefix), not a registrant.
    const isBareCikFallback = !match.name && !match.ticker;

    // Fetch submissions directly (not getRecentFilingsByForm) so the same response feeds
    // both the bare-CIK 404 recovery (#76) and operating-company classification (#86).
    let submissions: Awaited<ReturnType<typeof api.getSubmissions>>;
    try {
      submissions = await api.getSubmissions(match.cik, callScope);
    } catch (err) {
      if (isBareCikFallback && err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        ctx.log.debug('CIK has no submissions feed', { cik: match.cik });
        throw ctx.fail(
          'company_not_found',
          `No 13F filer found for CIK ${match.cik}. If this looks like an accession-number prefix, it's the filer/agent, not the issuer — use secedgar_company_search to find the institution.`,
        );
      }
      // A cache-hit or name-resolved match that 404s signals an EDGAR-side problem, not
      // a bad query — propagate unchanged, same reasoning as #55.
      throw err;
    }

    // Each 13F-HR carries a reportDate (the period-end), so a requested quarter is
    // matched exactly. No quarter → most-recent; with a quarter, a miss is reported,
    // never silently the latest filing.
    const recentRows = thirteenFRows(submissions.filings.recent);
    const discoveredRows = [...recentRows];
    // A 13F-HR or a notice either one marks a 13F manager; only an entity whose rows
    // read hold neither gets the #86 classification below.
    let filesThirteenF = recentRows.length > 0;
    let filingMeta: ThirteenFRow | undefined;
    let notice: ThirteenFRow | undefined;
    let walk: SubmissionsArchiveWalk | undefined;

    if (!periodEnd) {
      filingMeta = recentRows.find((r) => r.form === HOLDINGS_REPORT_FORM);
      // A manager whose recent filings are notices only: name its newest notice rather
      // than calling it a non-filer (#133).
      if (!filingMeta) notice = recentRows.find((r) => NOTICE_FORMS.has(r.form));
    } else {
      ({ report: filingMeta, notice } = forPeriod(recentRows, periodEnd));
      // A quarter the recent window does not reach: a 13F-HR is filed after its period
      // ends, so read the archive forward in time from the page covering the quarter
      // end and stop on the first page holding a report or notice for it (#117, #133).
      // A quarter ending on or after the window's oldest filing selects no page.
      if (!filingMeta && !notice) {
        walk = new SubmissionsArchiveWalk(
          api,
          submissions,
          { filedAfter: periodEnd, order: 'oldest-first' },
          callScope,
        );
        for await (const { block } of walk) {
          const rows = thirteenFRows(block);
          discoveredRows.push(...rows);
          filesThirteenF ||= rows.length > 0;
          ({ report: filingMeta, notice } = forPeriod(rows, periodEnd));
          if (filingMeta || notice) break;
        }
      }
    }

    if (!filingMeta) {
      if (notice) {
        // The manager filed a notice for this quarter — or, asked for no quarter, files
        // only notices: another manager's 13F-HR carries its holdings, so there is no
        // information table here to read (#133).
        const scope = input.quarter
          ? `for quarter "${input.quarter}"`
          : 'in its recent submissions window';
        throw ctx.fail(
          'no_filings_found',
          `No 13F-HR filed by '${input.company}' (${submissions.name}) ${scope} — it filed a ${notice.form} notice (accession ${notice.accessionNumber}, period ${notice.reportDate}, filed ${notice.filingDate}) instead: its holdings for that quarter are reported by other managers in their own 13F-HR filings.`,
          {
            recovery: {
              hint: `Read notice ${notice.accessionNumber} with secedgar_get_filing — its cover page lists the managers reporting these holdings — then call this tool with one of those managers' CIKs.`,
            },
            notice_accession_number: notice.accessionNumber,
            notice_form: notice.form,
            notice_period: notice.reportDate,
          },
        );
      }
      if (!filesThirteenF) {
        // Entity files no 13F-HR or notice at all. Classify from the recent-form list (#86): an
        // entity filing 10-K/10-Q/8-K is an operating company, not an institutional
        // manager — route the caller to the tools that fit. Use the submissions identity
        // so it works for CIKs absent from the ticker cache too.
        const recentForms = new Set(submissions.filings.recent.form);
        const operatingForms = OPERATING_COMPANY_FORMS.filter((f) => recentForms.has(f));
        if (operatingForms.length > 0) {
          const tickerSuffix = submissions.tickers[0] ? ` (${submissions.tickers[0]})` : '';
          throw ctx.fail(
            'no_filings_found',
            `No 13F-HR filings found for '${input.company}' — resolves to ${submissions.name}${tickerSuffix}, an operating company (files ${operatingForms.join(', ')}), not an institutional investment manager. To find which managers hold it, use secedgar_find_holders; for financials use secedgar_get_financials.`,
            {
              recovery: {
                hint: `${submissions.name} is an operating company, not a 13F filer. Use secedgar_find_holders with issuer "${input.company}" to list its institutional holders.`,
              },
              resolved_cik: match.cik,
              resolved_name: submissions.name,
              suggestions: [
                {
                  tool: 'secedgar_find_holders',
                  description: `Institutional managers reporting a position in ${submissions.name}`,
                },
                {
                  tool: 'secedgar_get_financials',
                  description: `Historical XBRL financials for ${submissions.name}`,
                },
                {
                  tool: 'secedgar_search_filings',
                  description: `Full-text search ${submissions.name}'s SEC filings`,
                },
              ],
            },
          );
        }
        // No operating-company signal (e.g. a filing agent or an unusual filer) — a true
        // unknown, so keep the generic recovery.
        throw ctx.fail(
          'no_filings_found',
          `No 13F-HR filings found for '${input.company}' (resolves to ${submissions.name}). This entity is not a 13F institutional filer.`,
        );
      }
      // 13F filings exist, but none for the requested quarter (#31) — a real 13F filer.
      const searched =
        walk && walk.pagesRead > 0
          ? ` Searched the recent submissions window and ${walk.pagesRead} archive page${walk.pagesRead === 1 ? '' : 's'} filed from ${walk.scannedThrough} forward${walk.truncated ? `; the ${ARCHIVE_PAGE_SCAN_CAP}-page cap stopped the search before later pages` : ''}.`
          : '';
      throw ctx.fail(
        'no_filings_found',
        `No 13F-HR filings found for '${input.company}' for quarter "${input.quarter}".${searched}`,
      );
    }

    // The original's information table is required: a failure here fails the call.
    const originalTable = await readInfoTable(
      api,
      match.cik,
      filingMeta.accessionNumber,
      callScope,
    );
    switch (originalTable.kind) {
      case 'ok':
        break;
      case 'no_index':
        throw ctx.fail(
          'no_info_table',
          `Filing ${filingMeta.accessionNumber} index could not be fetched.`,
        );
      case 'no_document':
        throw ctx.fail(
          'no_info_table',
          `No information table XML found in filing ${filingMeta.accessionNumber}.`,
          {
            accession_number: filingMeta.accessionNumber,
            available_documents: originalTable.documents,
          },
        );
      case 'no_table':
        throw ctx.fail(
          'no_info_table',
          `Information table document '${originalTable.document}' could not be fetched.`,
        );
      case 'unparseable':
        throw ctx.fail(
          'no_info_table',
          `Failed to parse information table XML for filing ${filingMeta.accessionNumber}.`,
        );
    }

    // Pull reporting period and filing-manager name from the primary_doc.xml cover page.
    // The CIK resolver only knows names for ticker-listed entities, but most 13F filers
    // are investment managers that aren't listed — the cover page is the reliable source.
    const primaryXml = await api.tryGetFilingDocument(
      match.cik,
      filingMeta.accessionNumber,
      'primary_doc.xml',
      callScope,
    );
    const { filerName, reportingPeriod } = primaryXml
      ? parseThirteenFCoverPage(primaryXml)
      : { filerName: undefined, reportingPeriod: undefined };

    const originalRows = toHoldingRows(
      originalTable.holdings,
      filingMeta.accessionNumber,
      filingMeta.filingDate,
    );

    /** Discovery is optional enrichment after the original is readable. Resume an
     * archive walk that found the original so later-filed amendments are included.
     * Every request shares the primary operation's failure budget and cancellation.
     */
    const amendmentPeriod = filingMeta.reportDate || reportingPeriod;
    let amendmentSearchComplete = Boolean(amendmentPeriod);
    let disclosureBlocked = false;
    if (amendmentPeriod) {
      walk ??= new SubmissionsArchiveWalk(
        api,
        submissions,
        { filedAfter: amendmentPeriod, order: 'oldest-first' },
        callScope,
      );
      try {
        for await (const { block } of walk) discoveredRows.push(...thirteenFRows(block));
        amendmentSearchComplete = !walk.truncated;
      } catch (err) {
        callScope.signal.throwIfAborted();
        if (!optionalLookupFailure(err)) throw err;
        amendmentSearchComplete = false;
        disclosureBlocked =
          err.code === JsonRpcErrorCode.RateLimited || callScope.remainingMs === 0;
      }
    }
    const samePeriod = [
      ...new Map(
        discoveredRows
          .filter(
            (r) => r.form === '13F-HR/A' && amendmentPeriod && r.reportDate === amendmentPeriod,
          )
          .map((r) => [r.accessionNumber, r]),
      ).values(),
    ].sort((a, b) => b.filingDate.localeCompare(a.filingDate));
    const entries: Array<{
      amendmentType: 'RESTATEMENT' | 'NEW HOLDINGS' | undefined;
      step: CompositionStep;
      unavailableReason: UnavailableReason;
    }> = [];
    for (const amendment of samePeriod) {
      let amendmentType: 'RESTATEMENT' | 'NEW HOLDINGS' | undefined;
      let unavailableReason: UnavailableReason = 'lookup_stopped';
      if (!disclosureBlocked) {
        try {
          const header = await api.tryGetFilingDocument(
            match.cik,
            amendment.accessionNumber,
            'primary_doc.xml',
            callScope,
          );
          if (header) amendmentType = parseThirteenFCoverPage(header).amendmentType;
          unavailableReason = header ? 'unreadable_header' : 'missing_header';
        } catch (err) {
          callScope.signal.throwIfAborted();
          if (!optionalLookupFailure(err)) throw err;
          unavailableReason = 'lookup_failed';
          disclosureBlocked =
            err.code === JsonRpcErrorCode.RateLimited || callScope.remainingMs === 0;
        }
      }
      entries.push({
        amendmentType,
        step: {
          accession: amendment.accessionNumber,
          kind: amendmentType,
          row: amendment,
          status: 'superseded',
        },
        unavailableReason,
      });
    }

    // Compose the quarter. Each amendment table read is two more requests (index and
    // table) on the same CallScope; a 429 or a spent failure budget stops further reads,
    // as it stops the cover reads above, and a caller cancel still fails the call.
    const original: CompositionStep = {
      accession: filingMeta.accessionNumber,
      kind: 'original',
      row: filingMeta,
      status: 'superseded',
    };
    const steps = [original, ...entries.map((e) => e.step)].sort((a, b) =>
      compositionOrder(a.row, b.row),
    );
    const composed = await composeHoldings(steps, originalRows, async (step) => {
      if (disclosureBlocked) return;
      try {
        const read = await readInfoTable(api, match.cik, step.accession, callScope);
        // An amendment exists to change rows: an empty table is unreadable, never a
        // restatement that blanks the quarter.
        if (read.kind !== 'ok' || read.holdings.length === 0) return;
        return toHoldingRows(read.holdings, step.accession, step.row.filingDate);
      } catch (err) {
        callScope.signal.throwIfAborted();
        if (!optionalLookupFailure(err)) throw err;
        disclosureBlocked =
          err.code === JsonRpcErrorCode.RateLimited || callScope.remainingMs === 0;
        return;
      }
    });
    const amendments: Array<z.infer<typeof amendmentSchema>> = entries.map((e) => ({
      accession_number: e.step.accession,
      filing_date: e.step.row.filingDate,
      applied_as: e.step.status,
      ...(e.amendmentType
        ? { amendment_type: e.amendmentType }
        : { amendment_type: 'UNAVAILABLE' as const, unavailable_reason: e.unavailableReason }),
    }));
    const positions = input.consolidate ? consolidatePositions(composed.rows) : composed.rows;
    const notApplied = amendments.filter((a) => a.applied_as === 'not_applied');

    const amendmentNotice = [
      ...(amendments.length > 0
        ? [
            `Holdings and dataframe compose the original 13F-HR with its same-period amendments, applied in acceptance order: a RESTATEMENT replaces the rows, NEW HOLDINGS adds them. Amendments, newest filed first: ${amendments.map((a) => `${a.accession_number} (filed ${a.filing_date}, ${a.amendment_type}${a.amendment_type === 'UNAVAILABLE' ? `: ${a.unavailable_reason}` : ''}, ${a.applied_as})`).join('; ')}. Rows come from ${composed.accessions.join(', ')}, in that order.`,
          ]
        : []),
      ...(notApplied.length > 0
        ? [
            `Not applied, since the type or information table could not be read: ${notApplied.map((a) => a.accession_number).join(', ')} — inspect with secedgar_get_filing.`,
          ]
        : []),
      ...(!amendmentSearchComplete
        ? [
            `Amendment discovery is incomplete: the submissions archive search was bounded at ${ARCHIVE_PAGE_SCAN_CAP} pages or unavailable, or the report period is missing. Additional amendments may exist.`,
          ]
        : []),
    ].join(' ');

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
          source_accession_numbers: p.source_accession_numbers,
        })),
        sourceTool: 'secedgar_get_institutional_holdings',
        queryParams: {
          company: input.company,
          cik: match.cik,
          quarter: input.quarter,
          consolidate: input.consolidate,
          accession_number: filingMeta.accessionNumber,
          composed_accessions: composed.accessions,
        },
      });
      if (registered) dataset = toDatasetField(registered);
    }

    // Offset paging over the whole ordered position list — the retrieval path for
    // rows past `limit` when no canvas is available to hold the full set (#94). The
    // information table is parsed whole, so slicing it is contiguous and stable.
    const pageEnd = input.offset + limit;
    const holdings = positions.slice(input.offset, pageEnd);
    const nextOffset = pageEnd < positions.length ? pageEnd : undefined;

    // One chain, because `notice` is last-wins across notice/truncated: each arm
    // composes the staged-dataframe pointer into its own string rather than
    // emitting a second notice that would clobber the first (#104).
    const notices: string[] = amendmentNotice ? [amendmentNotice] : [];
    if (holdings.length === 0 && input.offset > 0) {
      notices.push(
        `Offset (${input.offset}) is at or past the ${positions.length} positions in this filing. ` +
          `Lower the offset to page back into the holdings.` +
          (dataset ? ` ${dataframeGuidance(dataset)}` : ''),
      );
    } else if (holdings.length === 0) {
      notices.push(
        `The information table for this filing contained no holdings rows. ` +
          `This may be a 13F-NT (notice-only) filing or an amendment. ` +
          `Use secedgar_search_filings with forms=["13F-HR"] to find the correct filing.`,
      );
    } else if (dataset) {
      notices.push(dataframeGuidance(dataset));
    }
    if (holdings.length > 0 && nextOffset !== undefined) {
      ctx.enrich.truncated({
        shown: holdings.length,
        cap: limit,
        ...(notices.length > 0 && { guidance: notices.join(' ') }),
      });
    } else if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('Institutional holdings retrieved', {
      cik: match.cik,
      accessionNumber: filingMeta.accessionNumber,
      totalHoldings: originalRows.length,
      composedRows: composed.rows.length,
      composedAccessions: composed.accessions.length,
      totalPositions: positions.length,
      returned: holdings.length,
      datasetName: dataset?.name,
    });

    return {
      filer_name: filerName ?? match.name ?? input.company,
      filer_cik: match.cik,
      reporting_period: reportingPeriod,
      filing_date: filingMeta.filingDate,
      accession_number: filingMeta.accessionNumber,
      amendments: amendments.length > 0 ? amendments : undefined,
      amendment_search_complete: amendmentSearchComplete,
      composed_accessions: composed.accessions,
      total_holdings_in_filing: originalRows.length,
      total_holdings_composed: composed.rows.length,
      total_positions: input.consolidate ? positions.length : undefined,
      offset: input.offset,
      next_offset: nextOffset,
      holdings,
      dataset,
    };
  },

  format: (result) => {
    const period = result.reporting_period ? ` (period: ${result.reporting_period})` : '';
    const countLine =
      result.total_positions !== undefined
        ? `Showing ${result.holdings.length} of ${result.total_positions} positions (consolidated from ${result.total_holdings_composed} info-table rows)`
        : `Showing ${result.holdings.length} of ${result.total_holdings_composed} info-table rows`;
    const lines: string[] = [
      `**13F-HR Holdings** — ${result.filer_name} (CIK ${result.filer_cik})`,
      `Filed: ${result.filing_date}${period} | Accession: ${result.accession_number}`,
      countLine,
      `Composed from: ${result.composed_accessions.join(', ')} (${result.total_holdings_composed} rows; original 13F-HR: ${result.total_holdings_in_filing})`,
    ];
    lines.push(`Page offset: ${result.offset} (${result.holdings.length} shown)`);
    for (const amendment of result.amendments ?? []) {
      lines.push(
        `Amendment: ${amendment.accession_number}, filed ${amendment.filing_date}, ${amendment.amendment_type}${amendment.amendment_type === 'UNAVAILABLE' ? ` (${amendment.unavailable_reason})` : ''} — applied as ${amendment.applied_as}${amendment.applied_as === 'not_applied' ? '; inspect with secedgar_get_filing' : ''}.`,
      );
    }
    if (result.amendment_search_complete !== undefined)
      lines.push(
        result.amendment_search_complete
          ? 'Amendment discovery complete within submissions coverage.'
          : 'Amendment discovery incomplete; additional amendments may exist.',
      );
    if (result.next_offset !== undefined) {
      lines.push(`Next offset: ${result.next_offset} — pass as offset to read the next page.`);
    }

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
      lines.push(
        `${sharesStr} | ${valueStr}${discStr} | source: ${h.source_accession_numbers.join(', ')}`,
      );
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

/** `secedgar_get_institutional_holdings` as this deployment's `EDGAR_CLAMP_OVERSIZED_LIMITS` builds it. */
export function createGetInstitutionalHoldingsTool(options: LimitClampOptions) {
  return withLimitClamps(getInstitutionalHoldingsTool, [holdingsLimit], options);
}
