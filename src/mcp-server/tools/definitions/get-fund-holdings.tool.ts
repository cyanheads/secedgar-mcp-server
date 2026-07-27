/**
 * @fileoverview Portfolio holdings of one registered fund, parsed from the NPORT-P report
 * it files each quarter. This is the inverse of the ownership tools: those answer who owns
 * a company, this answers what a fund owns. Routing is the substance of the tool — an
 * NPORT-P covers exactly one fund series, a registrant trust holds many series and files
 * one report per series per period, and the report's series identity appears only inside
 * the document. Series-scoped browse resolves that in one call; a bounded read of each
 * candidate's header is the fallback when it cannot.
 * @module mcp-server/tools/definitions/get-fund-holdings
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';
import { getEdgarApiService, rawDocumentName } from '@/services/edgar/edgar-api-service.js';
import {
  type NportHeader,
  parseNportHeader,
  parseNportXml,
} from '@/services/edgar/nport-parser.js';
import type { FilingsRecent } from '@/services/edgar/types.js';

/** SEC fund series identifier — the letter S followed by nine digits. */
const SERIES_ID_PATTERN = /^S\d{9}$/i;

/** Public quarterly portfolio report, plus its amendment. */
const NPORT_FORMS = ['NPORT-P', 'NPORT-P/A'];

/**
 * Filings requested from the series-scoped browse. EDGAR's company browse serves fixed page
 * sizes (10, 20, 40, 80, 100) and rounds a request down to one of them, so anything between
 * 10 and 39 is served as ten. Forty is one request either way and reaches roughly a decade of
 * quarterly reports, which is what report_date can address.
 */
const SERIES_FEED_COUNT = 40;

/**
 * Ceiling on how many candidate reports the header scan reads. The scan is the fallback
 * routing path, so the bound trades completeness for a call that returns: it comfortably
 * covers a mid-size trust's per-period batch, and a trust large enough to exceed it lists
 * its series in the fund ticker file, which routes without any scan at all.
 */
const SERIES_SCAN_LIMIT = 20;

/**
 * Ceiling on the bytes read from a candidate report before giving up on its header. It binds
 * only on a document that arrives in more than one chunk, because the check runs between
 * reads and the runtime picks the chunk boundary: Bun hands back SEC archive documents in
 * 262,144-byte reads, and `</genInfo>` closes 1,565 bytes into a real report, so a candidate
 * costs one 256 KB read of a document that runs to megabytes. The ceiling is what stops a
 * report carrying no identity block at all from being read to the end.
 */
const HEADER_MAX_BYTES = 65_536;

/** Closing tag of the NPORT-P identity block — everything after it is the report body. */
const HEADER_STOP_AT = '</genInfo>';

/** Registrant series named in a `series_required` error, capped so the message stays readable. */
const SERIES_HINT_LIMIT = 12;

/** One NPORT-P filing considered for the requested series. */
interface NportCandidate {
  accessionNumber: string;
  /** Raw XML document name inside the archive directory. */
  document: string;
  filingDate: string;
  form: string;
  /** Last day of the period the report covers, from the submissions feed. Absent for filings older than that window. */
  reportDate: string | undefined;
}

/** Every NPORT-P row in a submissions recent-filings window, in submission order. */
function nportRows(recent: FilingsRecent): NportCandidate[] {
  const rows: NportCandidate[] = [];
  for (let i = 0; i < recent.form.length; i++) {
    if (!NPORT_FORMS.includes(recent.form[i] ?? '')) continue;
    rows.push({
      accessionNumber: recent.accessionNumber[i] ?? '',
      filingDate: recent.filingDate[i] ?? '',
      form: recent.form[i] ?? '',
      reportDate: recent.reportDate[i] || undefined,
      document: rawDocumentName(recent.primaryDocument[i]),
    });
  }
  return rows;
}

/**
 * Order candidates by the period they report, newest first, with the newest-filed winning a
 * tie. Filing order alone is wrong here: an amendment restating an old period is filed after
 * every report of the periods that followed it, so it would otherwise present a year-old
 * portfolio as the current one.
 */
function byReportPeriod(a: NportCandidate, b: NportCandidate): number {
  return (
    (b.reportDate ?? '').localeCompare(a.reportDate ?? '') ||
    b.filingDate.localeCompare(a.filingDate)
  );
}

/**
 * Read the identity block of up to `limit` candidates, stopping early once `stopWhen` is
 * satisfied. Each read cancels the response body after the header, so a candidate costs one
 * read chunk of a report that runs to megabytes rather than the whole file.
 */
async function scanHeaders(
  api: ReturnType<typeof getEdgarApiService>,
  cik: string,
  candidates: NportCandidate[],
  limit: number,
  stopWhen?: (header: NportHeader) => boolean,
): Promise<{
  scanned: Array<{ candidate: NportCandidate; header: NportHeader }>;
  complete: boolean;
}> {
  const scanned: Array<{ candidate: NportCandidate; header: NportHeader }> = [];
  const budget = candidates.slice(0, limit);
  for (const candidate of budget) {
    const head = await api.tryGetFilingDocumentHead(
      cik,
      candidate.accessionNumber,
      candidate.document,
      { maxBytes: HEADER_MAX_BYTES, stopAt: HEADER_STOP_AT },
    );
    if (!head) continue;
    const header = parseNportHeader(head);
    scanned.push({ candidate, header });
    if (stopWhen?.(header)) return { scanned, complete: true };
  }
  return { scanned, complete: budget.length === candidates.length };
}

/**
 * Fill in the reporting period of candidates the submissions feed could not date, reading it
 * from each report's own identity block until `wanted` turns up.
 *
 * The feed dates only the filings inside the registrant's recent window, and a trust filing
 * thousands of reports a year outruns that window in months — so a series feed reaching back
 * three years routinely carries reports the window cannot date. Those reports exist and are
 * fetchable, so targeting one must not read as absent.
 */
async function datePeriods(
  api: ReturnType<typeof getEdgarApiService>,
  cik: string,
  candidates: NportCandidate[],
  wanted: string,
): Promise<void> {
  const undated = candidates.filter((c) => !c.reportDate);
  if (undated.length === 0) return;
  const { scanned } = await scanHeaders(
    api,
    cik,
    undated,
    SERIES_SCAN_LIMIT,
    (header) => header.report_period_date === wanted,
  );
  for (const { candidate, header } of scanned) {
    candidate.reportDate = header.report_period_date;
  }
}

/**
 * Turn series-browse rows into candidates. The browse feed carries no reporting period, so
 * each row is dated from the registrant's submissions window where that window still reaches
 * it, and left undated where it does not.
 */
async function datedCandidates(
  api: ReturnType<typeof getEdgarApiService>,
  filings: Array<{ accessionNumber: string; filingDate: string; form: string }>,
  registrantCik: string,
): Promise<NportCandidate[]> {
  const byAccession = new Map(
    nportRows((await api.getSubmissions(registrantCik)).filings.recent).map((row) => [
      row.accessionNumber,
      row,
    ]),
  );
  return filings.map((f) => {
    const known = byAccession.get(f.accessionNumber);
    return {
      accessionNumber: f.accessionNumber,
      filingDate: f.filingDate,
      form: f.form,
      reportDate: known?.reportDate,
      document: rawDocumentName(known?.document),
    };
  });
}

/** Distinct series seen across scanned headers, in first-seen order. */
function distinctSeries(
  scanned: Array<{ header: NportHeader }>,
): Array<{ id: string; name: string | undefined }> {
  const seen = new Map<string, string | undefined>();
  for (const { header } of scanned) {
    if (header.series_id && !seen.has(header.series_id)) {
      seen.set(header.series_id, header.series_name);
    }
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}

/** Render a USD amount with a scaled T/B/M/K suffix — fund portfolios span $1M to $2T. */
function formatUsd(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

/** Whole days between two YYYY-MM-DD dates. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

export const getFundHoldingsTool = tool('secedgar_get_fund_holdings', {
  title: 'Get Fund Holdings',
  description:
    "List what an ETF or mutual fund holds, parsed from the NPORT-P portfolio report it files with the SEC every quarter. The input is the fund — a ticker like VOO, a fund series ID, or the registrant trust — which is the opposite direction from the ownership tools: secedgar_get_institutional_holdings and secedgar_find_holders answer who owns a company, this answers what a fund owns. Each position carries the security name, CUSIP/ISIN/LEI where the filer reports them, share balance, market value in USD, and percent of the fund's net assets, alongside fund-level net assets and total assets. Positions are returned largest-first by percent of net assets, one page of limit rows starting at offset; the full report registers as df_<id> when a canvas is available, which is how a fund running to thousands of positions is aggregated or joined against the 13F and insider dataframes. An NPORT-P covers exactly one fund series and a registrant trust files one report per series, so a trust with several funds needs the specific fund named — pass its ticker or series_id. Reports publish roughly two months after the period they cover, so every result is dated: the holdings are the portfolio as of report_period_date, not as of today.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'fund_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The fund input resolves to neither an EDGAR company nor a known fund series',
      recovery: 'Use secedgar_company_search with the fund ticker to get its CIK and series ID.',
    },
    {
      reason: 'ambiguous_fund',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The fund name matches several EDGAR companies',
      recovery: 'Retry with the fund ticker or the 10-digit CIK from the matches list.',
    },
    {
      reason: 'series_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The input resolves to a registrant trust that files reports for more than one fund series',
      recovery: 'Retry with series_id set to one of the listed series, or pass a fund ticker.',
    },
    {
      reason: 'no_filings_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No NPORT-P report exists for this fund, or none for the requested report_date',
      recovery:
        'Drop report_date to take the newest report, or use secedgar_search_filings with forms ["NPORT-P"] to see what the registrant has filed.',
    },
  ],

  input: z.object({
    fund: z
      .string()
      .trim()
      .min(1, 'Fund cannot be blank')
      .describe(
        'The fund whose portfolio you want — a fund ticker ("VOO", "SCHD"), an SEC fund series ID ("S000002839"), or a 10-digit CIK. A ticker names one share class of one series and routes directly; a CIK names the registrant, which files a separate report per series and needs series_id when it runs more than one fund. Fund trusts are indexed by ticker and series, not by name, so a trust name only resolves for a fund that trades under its own name ("SPDR S&P 500 ETF Trust") — pass the CIK otherwise.',
      ),
    series_id: z
      .string()
      .trim()
      .regex(SERIES_ID_PATTERN, 'Series ID must be the letter S followed by nine digits')
      .optional()
      .describe(
        'SEC fund series identifier ("S000002839"), naming which fund of the registrant to report. Takes precedence over any series the fund input implies. Series IDs come back on fund results from secedgar_company_search and in the series list of a series_required error.',
      ),
    report_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Report date must be YYYY-MM-DD')
      .optional()
      .describe(
        'Target a specific reporting period by its last day (YYYY-MM-DD), e.g. "2025-12-31". Omit for the most recent report. Period ends follow the fund\'s own fiscal quarters, which are not always calendar quarters — Direxion funds report to February, May, August, and November. available_report_periods in the response lists the ones this call identified; a period missing from that list is still worth requesting directly, since a report the submissions window no longer dates is dated by reading it.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe(
        'Number of positions to return inline, largest first by percent of net assets. Default 20. A broad index fund reports thousands of positions, so the inline list is a preview — read the whole portfolio from the dataframe, or page it with offset.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Position to start the page at, 0-based, over the full ordered holdings list. Pass the returned next_offset to read the next page — the report is parsed whole and sliced, so paging is stable and gap-free.',
      ),
  }),

  output: z.object({
    fund: z.string().describe('The fund input, echoed.'),
    series_id: z
      .string()
      .optional()
      .describe(
        'SEC series ID of the fund this report covers. Absent when the registrant files as a single fund with no series structure, which is how some older exchange-traded trusts are organized.',
      ),
    series_name: z
      .string()
      .optional()
      .describe(
        'Fund name as the filer states it on the report. A closed-end fund organized as a single registrant names itself here with no series_id alongside; absent only when the filer leaves the field blank or writes "N/A".',
      ),
    class_ids: z
      .array(z.string())
      .describe(
        'SEC class IDs of the share classes covered. One report covers every class of the series, so a fund with both an ETF and an admiral-share class reports them together.',
      ),
    registrant_cik: z.string().describe('CIK of the registrant trust, zero-padded to 10 digits.'),
    registrant_name: z.string().describe('EDGAR-conformed name of the registrant trust.'),
    report_period_date: z
      .string()
      .optional()
      .describe(
        "Last day of the period this portfolio is reported as of (YYYY-MM-DD). Holdings are the fund's positions on this date, not today's. Absent only when the filer omits it.",
      ),
    report_period_end: z
      .string()
      .optional()
      .describe(
        "Last day of the fiscal year the reporting period falls in (YYYY-MM-DD) — the fund's fiscal year end, not the portfolio date.",
      ),
    filing_date: z.string().describe('Date the report was submitted to EDGAR (YYYY-MM-DD).'),
    publication_lag_days: z
      .number()
      .optional()
      .describe(
        'Days between the portfolio date and the filing date. Absent when the report omits its period date.',
      ),
    form: z.string().describe('EDGAR form name — "NPORT-P", or "NPORT-P/A" for an amended report.'),
    accession_number: z
      .string()
      .describe('Accession number — pass to secedgar_get_filing for the full document.'),
    is_final_filing: z
      .boolean()
      .optional()
      .describe(
        'True when the fund reports this as its last filing on the series, which marks a liquidation or merger. Absent when the filing does not answer.',
      ),
    net_assets_usd: z
      .number()
      .optional()
      .describe(
        'Fund net assets in USD at the report date — the denominator of percent_of_net_assets.',
      ),
    total_assets_usd: z
      .number()
      .optional()
      .describe('Fund total assets in USD at the report date.'),
    total_liabilities_usd: z
      .number()
      .optional()
      .describe('Fund total liabilities in USD at the report date.'),
    total_holdings: z
      .number()
      .describe(
        'Positions in the report, before offset and limit — the size of the full portfolio.',
      ),
    offset: z.number().describe('Position the returned page starts at, 0-based.'),
    next_offset: z
      .number()
      .optional()
      .describe(
        'Offset to pass on the next call to continue through the portfolio. Absent on the last page.',
      ),
    available_report_periods: z
      .array(z.string())
      .describe(
        "Period end dates of this fund's reports, newest first — the horizon report_date can address, not the fund's full history. It reaches back roughly a decade of quarterly reports, and a period older than that is refused rather than served. A period inside the horizon can still be missing from the list: the dates come from the registrant's recent submissions window, which a trust filing thousands of reports a year outruns in months, and a report the window no longer reaches is dated by reading it only when report_date asks for it.",
      ),
    holdings: z
      .array(
        z
          .object({
            name: z
              .string()
              .describe(
                'Issuer name as the fund reports it. A derivative position routinely reports the literal "N/A" here and names the instrument in title instead, so group and label positions by title when asset_category marks a derivative.',
              ),
            title: z
              .string()
              .optional()
              .describe(
                "The filer's own title for the security, often an abbreviated trading name.",
              ),
            cusip: z
              .string()
              .optional()
              .describe('9-character CUSIP. Absent when the filer omits it.'),
            isin: z
              .string()
              .optional()
              .describe('ISIN. Absent when the filer reports another identifier.'),
            lei: z
              .string()
              .optional()
              .describe('Legal Entity Identifier of the issuer, when reported.'),
            balance: z
              .number()
              .optional()
              .describe(
                'Units held, counted in whatever `units` names — shares, principal, or contracts.',
              ),
            units: z
              .string()
              .optional()
              .describe(
                'What balance counts — NS number of shares, PA principal amount, NC number of contracts, OU other.',
              ),
            currency: z
              .string()
              .optional()
              .describe('ISO 4217 currency the position is denominated in.'),
            value_usd: z
              .number()
              .optional()
              .describe('Market value of the position in USD at the report date.'),
            percent_of_net_assets: z
              .number()
              .optional()
              .describe(
                "Percent of the fund's net assets, as the filer computes it. Negative on a short position — a leveraged fund's swap or futures leg regularly reports several percent below zero — so this is not bounded at 0.",
              ),
            payoff_profile: z
              .string()
              .optional()
              .describe('"Long", "Short", or "N/A" for instruments with no direction.'),
            asset_category: z
              .string()
              .optional()
              .describe(
                'SEC asset-type code — EC equity-common, EP equity-preferred, DBT debt, RA repurchase agreement, STIV short-term investment vehicle, DE derivative. A filer that classifies a position as Other reports its own label here instead of a code ("Right"), because the code in that case is just "OTHER".',
              ),
            issuer_category: z
              .string()
              .optional()
              .describe(
                'SEC issuer-type code — CORP corporate, MUN municipal, USGSE US government-sponsored, RF registered fund. A filer that classifies an issuer as Other reports its own label here instead of a code ("Future", "Warrant").',
              ),
            country: z.string().optional().describe('ISO 3166 country of investment.'),
          })
          .describe('One position from the fund portfolio.'),
      )
      .describe(
        'One page of positions, `limit` rows starting at `offset`, largest first by percent of net assets.',
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
        'Canvas dataframe holding every position in the report (the inline holdings[] is a preview capped at limit). Each row carries the fund keys — series_id, registrant_cik, report_period_date, accession_number — alongside the position fields, so it joins against the 13F and insider dataframes on cusip. Absent when canvas is unavailable or the report had no positions.',
      ),
  }),

  enrichment: {
    as_of: z
      .string()
      .describe(
        'The portfolio date these holdings are reported as of, and the publication lag behind it.',
      ),
    notice: z
      .string()
      .optional()
      .describe('Guidance when the report carried no positions or the page fell past the end.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the inline holdings list was capped by limit.'),
    shown: z.number().optional().describe('Number of positions shown inline.'),
    cap: z.number().optional().describe('The limit cap applied.'),
  },

  async handler(input, ctx) {
    const api = getEdgarApiService();

    // Phase 1 — registrant and series identity, from local indexes only.
    const fundIsSeries = SERIES_ID_PATTERN.test(input.fund);
    let targetSeries = (input.series_id ?? (fundIsSeries ? input.fund : undefined))?.toUpperCase();
    let registrantCik: string | undefined;

    if (fundIsSeries) {
      registrantCik = (await api.resolveFundSeries(input.fund))?.cik;
    } else {
      const resolved = await api.resolveCik(input.fund);
      const candidates = Array.isArray(resolved) ? resolved : [resolved];
      if (candidates.length > 1) {
        const shown = candidates.slice(0, 10);
        const list = shown.map((c) => `${c.ticker ?? c.cik} (${c.name ?? 'Unknown'})`).join(', ');
        throw ctx.fail(
          'ambiguous_fund',
          `'${input.fund}' matches multiple EDGAR companies: ${list}.`,
          {
            ...ctx.recoveryFor('ambiguous_fund'),
            matches: shown.map((c) => ({ cik: c.cik, name: c.name, ticker: c.ticker })),
          },
        );
      }
      const match = candidates[0];
      if (!match) {
        throw ctx.fail('fund_not_found', `Fund '${input.fund}' not found in EDGAR.`, {
          ...ctx.recoveryFor('fund_not_found'),
        });
      }
      registrantCik = match.cik;
      targetSeries ??= match.seriesId?.toUpperCase();
    }

    // A registrant naming no series is only answerable when it runs exactly one fund. The
    // fund ticker file settles that without a request; a trust whose series carry no listed
    // ticker returns nothing here and falls through to the header scan below.
    if (!targetSeries && registrantCik) {
      const listed = await api.listFundSeries(registrantCik);
      if (listed.length === 1 && listed[0]) targetSeries = listed[0].seriesId;
      else if (listed.length > 1) {
        const shown = listed.slice(0, SERIES_HINT_LIMIT);
        const list = shown
          .map((s) => `${s.seriesId}${s.ticker ? ` (${s.ticker})` : ''}`)
          .join(', ');
        const more =
          listed.length > shown.length ? ` and ${listed.length - shown.length} more` : '';
        throw ctx.fail(
          'series_required',
          `'${input.fund}' is a registrant with ${listed.length} fund series, each filing its own NPORT-P report. Name one: ${list}${more}.`,
          {
            ...ctx.recoveryFor('series_required'),
            registrant_cik: registrantCik,
            series: shown.map((s) => ({ series_id: s.seriesId, ticker: s.ticker })),
          },
        );
      }
    }

    // Phase 2 — candidate reports for the fund. Series-scoped browse answers in one call;
    // reading candidate headers is the fallback for a series it does not index.
    let candidates: NportCandidate[] = [];
    if (targetSeries) {
      const feed = await api.getFundSeriesFilings(targetSeries, 'NPORT-P', SERIES_FEED_COUNT);
      // The browse feed is keyed on the series, so the registrant it names is the trust that
      // files for this series. It outranks the one the fund input implied, which is a
      // different trust whenever series_id overrides that input.
      registrantCik = feed.registrantCik ?? registrantCik;
      if (feed.filings.length > 0 && registrantCik) {
        candidates = await datedCandidates(api, feed.filings, registrantCik);
      }
    }

    if (!registrantCik) {
      throw ctx.fail(
        'fund_not_found',
        `No EDGAR registrant found for fund series ${targetSeries ?? input.fund}.`,
        { ...ctx.recoveryFor('fund_not_found') },
      );
    }

    const submissions = await api.getSubmissions(registrantCik);

    if (candidates.length === 0) {
      const rows = nportRows(submissions.filings.recent);
      if (rows.length === 0) {
        throw ctx.fail(
          'no_filings_found',
          `${submissions.name} (CIK ${registrantCik}) has no NPORT-P portfolio reports in its recent submissions window. Money-market funds report their portfolios on N-MFP instead, and an issuer that is not a registered investment company files neither.`,
          { ...ctx.recoveryFor('no_filings_found') },
        );
      }
      const ordered = [...rows].sort(byReportPeriod);
      if (targetSeries) {
        // Series-scoped browse returned nothing for a series the registrant plainly files
        // for — read headers until the series turns up.
        const { scanned, complete } = await scanHeaders(
          api,
          registrantCik,
          ordered,
          SERIES_SCAN_LIMIT,
          (header) => header.series_id?.toUpperCase() === targetSeries,
        );
        const hit = scanned.find((s) => s.header.series_id?.toUpperCase() === targetSeries);
        if (!hit) {
          const bound = complete
            ? `across all ${ordered.length} of its NPORT-P reports`
            : `in the ${scanned.length} most recent of its ${ordered.length} NPORT-P reports (the scan stops there)`;
          throw ctx.fail(
            'no_filings_found',
            `No NPORT-P report for series ${targetSeries} found under ${submissions.name} (CIK ${registrantCik}) ${bound}. A fund launched since the registrant's last reporting period has not filed one yet; otherwise the series may belong to a different registrant.`,
            { ...ctx.recoveryFor('no_filings_found'), registrant_cik: registrantCik },
          );
        }
        candidates = [hit.candidate];
      } else {
        // No series to route on, so read the newest period's reports to learn whose they are.
        // The batch has to be read even when it holds one report: a registrant's NPORT-P
        // history interleaves its series, and series fiscal quarters are staggered, so one
        // report for the newest period does not mean one fund — it means one fund whose
        // quarter ends latest. Several distinct series mean the ticker file lists none of
        // them, so name them rather than picking one silently.
        const newestPeriod = ordered[0]?.reportDate;
        const newestBatch = ordered.filter((row) => row.reportDate === newestPeriod);
        const { scanned, complete } = await scanHeaders(
          api,
          registrantCik,
          newestBatch,
          SERIES_SCAN_LIMIT,
        );
        const series = distinctSeries(scanned);
        if (series.length > 1) {
          const list = series
            .slice(0, SERIES_HINT_LIMIT)
            .map((s) => `${s.id}${s.name ? ` (${s.name})` : ''}`)
            .join(', ');
          const bound = complete ? '' : ` — read from the ${scanned.length} newest reports only`;
          throw ctx.fail(
            'series_required',
            `${submissions.name} (CIK ${registrantCik}) files ${newestBatch.length} NPORT-P reports for period ${newestPeriod}, one per fund series. Name one: ${list}${bound}.`,
            {
              ...ctx.recoveryFor('series_required'),
              registrant_cik: registrantCik,
              series: series.map((s) => ({ series_id: s.id, series_name: s.name })),
            },
          );
        }
        // The report names a series, so route on it: the registrant's own filing list mixes
        // every series it runs, and a report_date drawn from that mixture would answer with
        // whichever fund happens to close its quarter on that date.
        const only = series[0];
        if (only) {
          targetSeries = only.id.toUpperCase();
          const feed = await api.getFundSeriesFilings(targetSeries, 'NPORT-P', SERIES_FEED_COUNT);
          if (feed.filings.length > 0) {
            candidates = await datedCandidates(api, feed.filings, registrantCik);
          }
        }
        // A registrant that files as a single fund carries no series in the document at all,
        // so its whole NPORT-P history is that one fund's.
        if (candidates.length === 0) candidates = ordered;
      }
    }

    // Phase 3 — pick the report. Ordering is by period reported, so an amendment restating
    // an older period never displaces the current portfolio.
    if (input.report_date && !candidates.some((c) => c.reportDate === input.report_date)) {
      await datePeriods(api, registrantCik, candidates, input.report_date);
    }
    const ordered = [...candidates].sort(byReportPeriod);
    const availablePeriods = [
      ...new Set(ordered.map((c) => c.reportDate).filter((d): d is string => Boolean(d))),
    ];
    const matching = input.report_date
      ? ordered.filter((c) => c.reportDate === input.report_date)
      : ordered;
    const target = matching[0];
    if (!target) {
      const undatedNote = ordered.some((c) => !c.reportDate)
        ? ` ${ordered.filter((c) => !c.reportDate).length} of its ${ordered.length} reports could not be dated and are not listed.`
        : '';
      throw ctx.fail(
        'no_filings_found',
        `No NPORT-P report for period ${input.report_date} under ${submissions.name}. Reported periods: ${availablePeriods.join(', ') || 'none identified'}.${undatedNote}`,
        {
          ...ctx.recoveryFor('no_filings_found'),
          available_report_periods: availablePeriods,
        },
      );
    }

    // Phase 4 — read the report itself.
    const xml = await api.tryGetFilingDocument(
      registrantCik,
      target.accessionNumber,
      target.document,
    );
    if (!xml) {
      throw ctx.fail(
        'no_filings_found',
        `NPORT-P document '${target.document}' for filing ${target.accessionNumber} could not be fetched.`,
        { ...ctx.recoveryFor('no_filings_found') },
      );
    }
    const report = parseNportXml(xml);

    // Largest position first, so a small limit returns the positions that carry the fund.
    const positions = [...report.holdings].sort(
      (a, b) =>
        (b.percent_of_net_assets ?? -1) - (a.percent_of_net_assets ?? -1) ||
        (b.value_usd ?? -1) - (a.value_usd ?? -1),
    );

    let dataset: { name: string; row_count: number; expires_at: string } | undefined;
    const bridge = getCanvasBridge();
    if (bridge && positions.length > 0) {
      const registered = await bridge.registerDataframe(ctx, {
        rows: positions.map((p) => ({
          registrant_cik: registrantCik,
          registrant_name: submissions.name,
          series_id: report.series_id ?? null,
          series_name: report.series_name ?? null,
          report_period_date: report.report_period_date ?? null,
          filing_date: target.filingDate,
          accession_number: target.accessionNumber,
          name: p.name,
          title: p.title ?? null,
          cusip: p.cusip ?? null,
          isin: p.isin ?? null,
          lei: p.lei ?? null,
          balance: p.balance ?? null,
          units: p.units ?? null,
          currency: p.currency ?? null,
          value_usd: p.value_usd ?? null,
          percent_of_net_assets: p.percent_of_net_assets ?? null,
          payoff_profile: p.payoff_profile ?? null,
          asset_category: p.asset_category ?? null,
          issuer_category: p.issuer_category ?? null,
          country: p.country ?? null,
        })),
        sourceTool: 'secedgar_get_fund_holdings',
        queryParams: {
          fund: input.fund,
          series_id: report.series_id,
          registrant_cik: registrantCik,
          report_date: report.report_period_date,
          accession_number: target.accessionNumber,
        },
      });
      if (registered) dataset = toDatasetField(registered);
    }

    const pageEnd = input.offset + input.limit;
    const holdings = positions.slice(input.offset, pageEnd);
    const nextOffset = pageEnd < positions.length ? pageEnd : undefined;
    if (nextOffset !== undefined) {
      ctx.enrich.truncated({ shown: holdings.length, cap: input.limit });
    }

    const lagDays = report.report_period_date
      ? daysBetween(report.report_period_date, target.filingDate)
      : undefined;
    ctx.enrich({
      as_of: report.report_period_date
        ? `Portfolio as of ${report.report_period_date}, filed ${target.filingDate} — ${lagDays} days later. NPORT-P publishes on a lag, so these are not current-day positions.`
        : `This report states no portfolio date; it was filed ${target.filingDate}. NPORT-P publishes on a lag, so these are not current-day positions.`,
    });

    if (holdings.length === 0 && input.offset > 0) {
      ctx.enrich.notice(
        `Offset (${input.offset}) is at or past the ${positions.length} positions in this report. Lower the offset to page back into the portfolio.`,
      );
    } else if (holdings.length === 0) {
      ctx.enrich.notice(
        `Report ${target.accessionNumber} lists no portfolio positions. A fund that had liquidated by the period end files an empty report — is_final_filing says whether this is one — and secedgar_get_filing on this accession shows the document as filed.`,
      );
    }

    ctx.log.info('Fund holdings retrieved', {
      registrantCik,
      seriesId: report.series_id,
      accessionNumber: target.accessionNumber,
      reportPeriod: report.report_period_date,
      totalHoldings: positions.length,
      returned: holdings.length,
      datasetName: dataset?.name,
    });

    return {
      fund: input.fund,
      series_id: report.series_id,
      series_name: report.series_name,
      class_ids: report.class_ids,
      registrant_cik: registrantCik,
      registrant_name: submissions.name,
      report_period_date: report.report_period_date,
      report_period_end: report.report_period_end,
      filing_date: target.filingDate,
      publication_lag_days: lagDays,
      form: target.form,
      accession_number: target.accessionNumber,
      is_final_filing: report.is_final_filing,
      net_assets_usd: report.net_assets_usd,
      total_assets_usd: report.total_assets_usd,
      total_liabilities_usd: report.total_liabilities_usd,
      total_holdings: positions.length,
      offset: input.offset,
      next_offset: nextOffset,
      available_report_periods: availablePeriods,
      holdings,
      dataset,
    };
  },

  format: (result) => {
    const label = result.series_name ?? result.registrant_name;
    const lines: string[] = [
      `**${label} portfolio** — input "${result.fund}"`,
      `Portfolio as of ${result.report_period_date ?? 'an unstated date'}, filed ${result.filing_date}${
        result.publication_lag_days !== undefined
          ? ` (${result.publication_lag_days} days later)`
          : ''
      } | ${result.form} ${result.accession_number}`,
      `Registrant: ${result.registrant_name} (CIK ${result.registrant_cik})${
        result.series_id ? ` | series ${result.series_id}` : ''
      }${result.class_ids.length > 0 ? ` | classes ${result.class_ids.join(', ')}` : ''}`,
    ];
    if (result.report_period_end) lines.push(`Fiscal year end: ${result.report_period_end}`);
    if (result.is_final_filing !== undefined) {
      lines.push(`Final filing on this series: ${result.is_final_filing ? 'yes' : 'no'}`);
    }

    const money = (label: string, value: number) =>
      `${label} ${formatUsd(value)} ($${value.toLocaleString('en-US')})`;
    const assets: string[] = [];
    if (result.net_assets_usd !== undefined)
      assets.push(money('net assets', result.net_assets_usd));
    if (result.total_assets_usd !== undefined)
      assets.push(money('total assets', result.total_assets_usd));
    if (result.total_liabilities_usd !== undefined)
      assets.push(money('total liabilities', result.total_liabilities_usd));
    if (assets.length > 0) lines.push(assets.join(' | '));

    lines.push(
      `Showing ${result.holdings.length} of ${result.total_holdings} positions from offset ${result.offset}.`,
    );
    if (result.next_offset !== undefined) {
      lines.push(`Next offset: ${result.next_offset} — pass as offset to read the next page.`);
    }
    if (result.available_report_periods.length > 0) {
      lines.push(`Reported periods available: ${result.available_report_periods.join(', ')}`);
    }

    for (const h of result.holdings) {
      lines.push('');
      const ids = [
        h.cusip && `CUSIP ${h.cusip}`,
        h.isin && `ISIN ${h.isin}`,
        h.lei && `LEI ${h.lei}`,
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(
        `**${h.name}**${h.title && h.title !== h.name ? ` (${h.title})` : ''}${ids ? ` — ${ids}` : ''}`,
      );
      const value =
        h.value_usd !== undefined
          ? `${formatUsd(h.value_usd)} ($${h.value_usd.toLocaleString('en-US')})`
          : 'value N/A';
      const pct =
        h.percent_of_net_assets !== undefined
          ? `${h.percent_of_net_assets.toFixed(4)}% of net assets`
          : 'percent N/A';
      const balance =
        h.balance !== undefined
          ? `${h.balance.toLocaleString()} ${h.units ?? 'units'}`
          : 'balance N/A';
      lines.push(
        `${balance} | ${value}${h.currency && h.currency !== 'USD' ? ` (${h.currency})` : ''} | ${pct}`,
      );
      const tags = [h.asset_category, h.issuer_category, h.country, h.payoff_profile].filter(
        Boolean,
      );
      if (tags.length > 0) lines.push(tags.join(' | '));
    }

    if (result.dataset) {
      const note =
        result.dataset.row_count > result.holdings.length
          ? ` — showing ${result.holdings.length} of ${result.dataset.row_count} positions inline; full portfolio on the dataframe`
          : '';
      lines.push(
        `\nDataset: ${result.dataset.name} (${result.dataset.row_count} rows, expires ${result.dataset.expires_at})${note} — query with secedgar_dataframe_query.`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
