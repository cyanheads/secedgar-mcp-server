/**
 * @fileoverview Blockholder ownership for one issuer, parsed from the structured
 * SCHEDULE 13D / SCHEDULE 13G XML that SEC has required since 2024-12-18. Completes the
 * ownership triangle alongside secedgar_get_insider_transactions (Form 4 officers and
 * directors) and secedgar_get_institutional_holdings (13F portfolios): this tool covers the
 * 5%-and-over stakes, activist and passive. Discovery runs off the issuer's own submissions
 * feed — SEC cross-lists a 13D/G under every CIK party to it, so the issuer's history
 * already carries the filings made about it and the archive document is reachable on the
 * issuer's own path.
 * @module mcp-server/tools/definitions/get-beneficial-owners
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';
import {
  type BeneficialOwner,
  type BeneficialOwnershipForm,
  formNameToSchedule,
  parseBeneficialOwnershipXml,
} from '@/services/edgar/beneficial-ownership-parser.js';
import { getEdgarApiService, rawDocumentName } from '@/services/edgar/edgar-api-service.js';

/**
 * First filing date on which every beneficial-ownership filing arrived in the structured
 * format. The legacy `SC 13D` / `SC 13G` names stop dead here: EDGAR full-text search counts
 * 37 legacy filings on 2024-12-17 and zero on 2024-12-18, against 44 structured ones the
 * same day. Filings before it are text or HTML documents with no XML to parse.
 */
const STRUCTURED_FROM = '2024-12-18';

/** Legacy form names that carry the same disclosure with no parseable XML. */
const LEGACY_FORMS = ['SC 13D', 'SC 13D/A', 'SC 13G', 'SC 13G/A'];

/**
 * Character ceiling on the Item 4 purpose-of-transaction prose. It is free text and runs to
 * several pages on a control filing, which would put one filing's narrative ahead of every
 * other filing's ownership data in the caller's context. The full text stays one
 * secedgar_get_filing call away on the accession number each row carries.
 */
const PURPOSE_MAX_CHARS = 1200;

/** Character ceiling on a reporting person's cover-page footnote — same reasoning, per person. */
const NOTES_MAX_CHARS = 240;

/** Trim free text to a ceiling, reporting whether anything was cut. */
function clip(text: string | undefined, max: number): { text: string | undefined; cut: boolean } {
  if (text === undefined) return { text: undefined, cut: false };
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return { text: collapsed, cut: false };
  return { text: `${collapsed.slice(0, max)}…`, cut: true };
}

/** One blockholder filing selected from the issuer's submissions feed. */
interface FilingRef {
  accessionNumber: string;
  document: string;
  filingDate: string;
  form: string;
  schedule: BeneficialOwnershipForm;
}

export const getBeneficialOwnersTool = tool('secedgar_get_beneficial_owners', {
  title: 'Get Beneficial Owners',
  description:
    "List the 5%-and-over beneficial owners of a public company, parsed from the structured SCHEDULE 13D and SCHEDULE 13G filings made about it. The input is the ISSUER — the company being held — which is the opposite direction from secedgar_get_institutional_holdings, where the input is the manager. 13D is the activist form and carries the filer's stated purpose of the transaction; 13G is the passive form and has no purpose field at all, which is the substantive difference between a stake that intends to influence control and one that does not. Every filing is returned with each reporting person listed separately, because voting power, dispositive power, and percent of class are reported per person even on a joint filing where several funds and their controlling principal report overlapping shares — summing those percentages double-counts the same position. Coverage starts at 2024-12-18, when SEC replaced the legacy SC 13D / SC 13G text filings with this XML format; earlier stakes are readable but not parseable, and the response reports how many of them the issuer has. The full parsed set is materialized as df_<id> when a canvas is available, one row per reporting person, so it joins against the insider and 13F dataframes on issuer CIK.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'issuer_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The issuer input does not resolve to a known EDGAR company',
      recovery: 'Use secedgar_company_search to find the issuer ticker or 10-digit CIK.',
    },
    {
      reason: 'ambiguous_issuer',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The issuer name matches several EDGAR companies',
      recovery:
        'Retry with the ticker or the 10-digit CIK of the intended issuer from the matches list.',
    },
    {
      reason: 'no_filings_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The issuer has no structured SCHEDULE 13D/13G filings matching the requested form kind',
      recovery:
        'Use secedgar_search_filings with forms ["SC 13D","SC 13G"] to reach the pre-2024-12-18 text filings, then read them with secedgar_get_filing.',
    },
  ],

  input: z.object({
    issuer: z
      .string()
      .trim()
      .min(1, 'Issuer cannot be blank')
      .describe(
        'The company whose blockholders you want — a ticker ("AAPL"), a 10-digit CIK ("0000320193"), or a company name. This is the subject company of the schedule, not the investor filing it; passing an investment manager here returns the schedules filed about that manager, which is almost always empty.',
      ),
    form_kind: z
      .enum(['all', '13D', '13G'])
      .default('all')
      .describe(
        'Which schedule to return. "13D" is the activist form, filed by a holder that may seek to influence control and carrying a stated purpose of transaction. "13G" is the passive form, available to institutions and holders under 20% that certify no control intent. "all" (default) returns both, newest first.',
      ),
    include_amendments: z
      .boolean()
      .default(true)
      .describe(
        'Whether to include amendments (SCHEDULE 13D/A, SCHEDULE 13G/A). Amendments carry the current position and are how an ongoing stake is tracked, so they are included by default. Set false to see only filings that opened a new position.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(10)
      .describe(
        'Number of filings to fetch and parse, newest first. Each filing is a separate document fetch, so this is the cost of the call as well as its depth. Default 10; a widely-held company can have dozens of blockholder filings a year.',
      ),
  }),

  output: z.object({
    issuer: z.string().describe('The issuer input, echoed.'),
    issuer_cik: z.string().describe('CIK of the resolved issuer, zero-padded to 10 digits.'),
    issuer_name: z.string().describe('EDGAR-conformed name of the resolved issuer.'),
    form_kind: z
      .enum(['all', '13D', '13G'])
      .describe('The schedule filter applied — the requested value, or the default "all".'),
    total_structured_filings: z
      .number()
      .describe(
        "Structured SCHEDULE 13D/13G filings matching the form filter in the issuer's recent submissions window, before the limit. The population the returned filings are the newest slice of.",
      ),
    filings_parsed: z
      .number()
      .describe('Filings actually fetched and parsed — total_structured_filings capped by limit.'),
    structured_coverage_from: z
      .string()
      .describe(
        'First filing date on which SEC required this XML format (YYYY-MM-DD). Blockholder filings before it exist but are not parseable into this schema.',
      ),
    legacy_filings_before_coverage: z
      .number()
      .describe(
        "Legacy SC 13D / SC 13G filings in the issuer's recent submissions window — pre-2024-12-18 stakes this tool cannot parse. Reach them with secedgar_search_filings and read them with secedgar_get_filing. A floor, not a lifetime count: the submissions window holds roughly the last thousand filings of every type.",
      ),
    filings: z
      .array(
        z
          .object({
            form: z.string().describe('EDGAR form name, e.g. "SCHEDULE 13D" or "SCHEDULE 13G/A".'),
            schedule: z
              .enum(['13D', '13G'])
              .describe('Which schedule this is — 13D activist, 13G passive.'),
            is_amendment: z.boolean().describe('True when the form name carries the /A suffix.'),
            amendment_number: z
              .string()
              .optional()
              .describe('Amendment sequence from the cover page. Absent on an original filing.'),
            accession_number: z
              .string()
              .describe('Accession number — pass to secedgar_get_filing for the full document.'),
            filing_date: z.string().describe('Date the schedule was submitted (YYYY-MM-DD).'),
            event_date: z
              .string()
              .optional()
              .describe(
                'Date of the event that required the filing (YYYY-MM-DD) — when the position actually crossed or changed, which precedes filing_date. Absent when the cover page omits it.',
              ),
            security_class: z
              .string()
              .optional()
              .describe(
                'Title of the class of securities the schedule covers. A multi-class issuer has a separate schedule per class, so percentages are of this class only.',
              ),
            cusips: z
              .array(z.string())
              .describe('CUSIPs of the subject class from the cover page. Empty when none listed.'),
            purpose_of_transaction: z
              .string()
              .optional()
              .describe(
                'Item 4 purpose-of-transaction prose — what the holder says it intends. Present on 13D filings only; 13G has no such field, which is what makes it the passive form. Absent on an amendment that restates no purpose.',
              ),
            purpose_truncated: z
              .boolean()
              .describe(
                'True when purpose_of_transaction was clipped to fit — read the full item with secedgar_get_filing on this accession number.',
              ),
            reporting_persons: z
              .array(
                z
                  .object({
                    name: z.string().describe('Reporting person as named on the cover page.'),
                    cik: z
                      .string()
                      .optional()
                      .describe(
                        'Reporting person CIK, when the schedule carries one. SCHEDULE 13G never does — its cover page has no CIK field — so this is populated on 13D filings only.',
                      ),
                    citizenship: z
                      .string()
                      .optional()
                      .describe(
                        'SEC citizenship or place-of-organization code — a US state ("DE"), or an SEC country code ("X1" United States, "E9" Cayman Islands).',
                      ),
                    percent_of_class: z
                      .number()
                      .optional()
                      .describe(
                        'Percent of the class this person beneficially owns (0-100), as this person reports it. Per person, not per filing: joint filers report overlapping shares, so these do not sum to a group total.',
                      ),
                    aggregate_amount_owned: z
                      .number()
                      .optional()
                      .describe(
                        'Shares beneficially owned by this person. Absent when the person reports no amount, which happens on an exit amendment reporting a zero position.',
                      ),
                    sole_voting_power: z
                      .number()
                      .optional()
                      .describe('Shares this person alone may vote.'),
                    shared_voting_power: z
                      .number()
                      .optional()
                      .describe('Shares this person votes jointly with another party.'),
                    sole_dispositive_power: z
                      .number()
                      .optional()
                      .describe('Shares this person alone may sell or transfer.'),
                    shared_dispositive_power: z
                      .number()
                      .optional()
                      .describe(
                        'Shares this person may sell or transfer jointly with another party.',
                      ),
                    person_types: z
                      .array(z.string())
                      .describe(
                        'SEC type-of-reporting-person codes — IN individual, CO corporation, PN partnership, IA investment adviser, HC holding company, OO other. One person can carry several.',
                      ),
                    excludes_certain_shares: z
                      .boolean()
                      .optional()
                      .describe(
                        'True when the reported aggregate deliberately excludes shares this person disclaims beneficial ownership of. Absent when the filing does not answer.',
                      ),
                    notes: z
                      .string()
                      .optional()
                      .describe(
                        "The filer's own cover-page footnote, usually the share count the percentage was computed against. Clipped when long — the full text is in the filing.",
                      ),
                  })
                  .describe('One reporting person from the schedule cover page.'),
              )
              .describe(
                'Every reporting person on this filing. A joint filing lists a fund, its adviser, and its controlling principal separately, each reporting the same underlying shares.',
              ),
          })
          .describe('One SCHEDULE 13D or 13G filing made about this issuer.'),
      )
      .describe('Blockholder filings, newest first, capped at limit.'),
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
            'True when the issuer has more structured filings than limit fetched — the dataframe holds the parsed filings only, not the whole history.',
          ),
      })
      .optional()
      .describe(
        "Canvas dataframe holding one row per reporting person across every parsed filing, each row carrying the issuer, form, accession, and dates alongside the person's powers. Joins against the insider and 13F dataframes on issuer_cik. Absent when canvas is unavailable or nothing parsed.",
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when no filings matched — names the coverage boundary and the fallback.'),
    truncated: z.boolean().optional().describe('True when filings were capped by limit.'),
    shown: z.number().optional().describe('Number of filings returned.'),
    cap: z.number().optional().describe('The limit cap applied.'),
  },

  async handler(input, ctx) {
    const api = getEdgarApiService();

    const resolved = await api.resolveCik(input.issuer);
    const candidates = Array.isArray(resolved) ? resolved : [resolved];
    if (candidates.length > 1) {
      const shown = candidates.slice(0, 10);
      const list = shown.map((c) => `${c.ticker ?? c.cik} (${c.name ?? 'Unknown'})`).join(', ');
      throw ctx.fail(
        'ambiguous_issuer',
        `'${input.issuer}' matches multiple EDGAR companies: ${list}.`,
        {
          ...ctx.recoveryFor('ambiguous_issuer'),
          matches: shown.map((c) => ({ cik: c.cik, name: c.name, ticker: c.ticker })),
        },
      );
    }
    const match = candidates[0];
    if (!match) {
      throw ctx.fail('issuer_not_found', `Issuer '${input.issuer}' not found in EDGAR.`, {
        ...ctx.recoveryFor('issuer_not_found'),
      });
    }

    const submissions = await api.getSubmissions(match.cik);
    const recent = submissions.filings.recent;

    // SEC indexes a 13D/G under every CIK party to it, so the issuer's own feed already
    // carries the schedules filed about it — no entity-scoped search needed.
    const selected: FilingRef[] = [];
    let totalMatching = 0;
    let legacyCount = 0;
    for (let i = 0; i < recent.form.length; i++) {
      const form = recent.form[i] ?? '';
      if (LEGACY_FORMS.includes(form)) {
        legacyCount++;
        continue;
      }
      const schedule = formNameToSchedule(form);
      if (!schedule) continue;
      if (input.form_kind !== 'all' && schedule !== input.form_kind) continue;
      if (!input.include_amendments && form.endsWith('/A')) continue;
      totalMatching++;
      if (selected.length < input.limit) {
        selected.push({
          form,
          schedule,
          accessionNumber: recent.accessionNumber[i] ?? '',
          filingDate: recent.filingDate[i] ?? '',
          document: rawDocumentName(recent.primaryDocument[i]),
        });
      }
    }

    if (totalMatching === 0) {
      const kindLabel =
        input.form_kind === 'all' ? 'SCHEDULE 13D/13G' : `SCHEDULE ${input.form_kind}`;
      const legacyHint =
        legacyCount > 0
          ? `Its submissions window does hold ${legacyCount} legacy SC 13D/SC 13G filings from before ${STRUCTURED_FROM}; those are text filings with no XML to parse — read them with secedgar_get_filing.`
          : `Blockholder filings from before ${STRUCTURED_FROM} use the legacy SC 13D / SC 13G names and are not parseable into this schema — search for them with secedgar_search_filings.`;
      throw ctx.fail(
        'no_filings_found',
        `No structured ${kindLabel} filings found for ${submissions.name} (CIK ${match.cik}). ${legacyHint}`,
        {
          ...ctx.recoveryFor('no_filings_found'),
          issuer_cik: match.cik,
          issuer_name: submissions.name,
          legacy_filings_before_coverage: legacyCount,
        },
      );
    }

    // Fetch and parse each selected filing. A document that 404s or does not parse as a
    // schedule is dropped rather than failing the call — one malformed filing must not
    // hide every other blockholder in the list.
    const filings: Array<{
      form: string;
      schedule: BeneficialOwnershipForm;
      is_amendment: boolean;
      amendment_number: string | undefined;
      accession_number: string;
      filing_date: string;
      event_date: string | undefined;
      security_class: string | undefined;
      cusips: string[];
      purpose_of_transaction: string | undefined;
      purpose_truncated: boolean;
      reporting_persons: BeneficialOwner[];
    }> = [];

    for (const ref of selected) {
      const xml = await api.tryGetFilingDocument(match.cik, ref.accessionNumber, ref.document);
      const parsed = xml ? parseBeneficialOwnershipXml(xml) : undefined;
      if (!parsed) {
        ctx.log.debug('Skipping unparseable beneficial-ownership filing', {
          accessionNumber: ref.accessionNumber,
          document: ref.document,
        });
        continue;
      }
      const purpose = clip(parsed.purpose_of_transaction, PURPOSE_MAX_CHARS);
      filings.push({
        form: ref.form,
        schedule: ref.schedule,
        is_amendment: ref.form.endsWith('/A'),
        amendment_number: parsed.amendment_number,
        accession_number: ref.accessionNumber,
        filing_date: ref.filingDate,
        event_date: parsed.event_date,
        security_class: parsed.security_class,
        cusips: parsed.issuer_cusips,
        purpose_of_transaction: purpose.text,
        purpose_truncated: purpose.cut,
        reporting_persons: parsed.owners.map((o) => ({
          name: o.name,
          cik: o.cik,
          citizenship: o.citizenship,
          percent_of_class: o.percent_of_class,
          aggregate_amount_owned: o.aggregate_amount_owned,
          sole_voting_power: o.sole_voting_power,
          shared_voting_power: o.shared_voting_power,
          sole_dispositive_power: o.sole_dispositive_power,
          shared_dispositive_power: o.shared_dispositive_power,
          person_types: o.person_types,
          excludes_certain_shares: o.excludes_certain_shares,
          notes: clip(o.notes, NOTES_MAX_CHARS).text,
        })),
      });
    }

    const truncated = totalMatching > filings.length;

    // One row per reporting person — the grain the ownership question is asked at, and the
    // grain that joins to the insider and 13F dataframes on issuer_cik.
    let dataset:
      | { name: string; row_count: number; expires_at: string; truncated: boolean }
      | undefined;
    const bridge = getCanvasBridge();
    const rows = filings.flatMap((f) =>
      f.reporting_persons.map((p) => ({
        issuer_cik: match.cik,
        issuer_name: submissions.name,
        form: f.form,
        schedule: f.schedule,
        is_amendment: f.is_amendment,
        accession_number: f.accession_number,
        filing_date: f.filing_date,
        event_date: f.event_date ?? null,
        security_class: f.security_class ?? null,
        cusip: f.cusips[0] ?? null,
        reporting_person: p.name,
        reporting_person_cik: p.cik ?? null,
        citizenship: p.citizenship ?? null,
        percent_of_class: p.percent_of_class ?? null,
        aggregate_amount_owned: p.aggregate_amount_owned ?? null,
        sole_voting_power: p.sole_voting_power ?? null,
        shared_voting_power: p.shared_voting_power ?? null,
        sole_dispositive_power: p.sole_dispositive_power ?? null,
        shared_dispositive_power: p.shared_dispositive_power ?? null,
        person_types: p.person_types.join(',') || null,
        has_stated_purpose: f.purpose_of_transaction !== undefined,
      })),
    );
    if (bridge && rows.length > 0) {
      const registered = await bridge.registerDataframe(ctx, {
        rows,
        sourceTool: 'secedgar_get_beneficial_owners',
        queryParams: {
          issuer: input.issuer,
          issuer_cik: match.cik,
          form_kind: input.form_kind,
          include_amendments: input.include_amendments,
          limit: input.limit,
        },
        truncated,
      });
      if (registered) dataset = { ...toDatasetField(registered), truncated };
    }

    if (filings.length === 0) {
      ctx.enrich.notice(
        `${totalMatching} structured filings are indexed for ${submissions.name}, but none of the ${selected.length} fetched parsed as a SCHEDULE 13D or 13G document. Read one directly with secedgar_get_filing on an accession number from secedgar_search_filings.`,
      );
    } else if (truncated) {
      ctx.enrich.truncated({
        shown: filings.length,
        cap: input.limit,
        guidance: `${totalMatching} structured blockholder filings are indexed for this issuer. Raise limit to reach further back, or narrow with form_kind or include_amendments=false.`,
      });
    }

    ctx.log.info('Beneficial owners retrieved', {
      cik: match.cik,
      formKind: input.form_kind,
      totalMatching,
      parsed: filings.length,
      owners: rows.length,
      datasetName: dataset?.name,
    });

    return {
      issuer: input.issuer,
      issuer_cik: match.cik,
      issuer_name: submissions.name,
      form_kind: input.form_kind,
      total_structured_filings: totalMatching,
      filings_parsed: filings.length,
      structured_coverage_from: STRUCTURED_FROM,
      legacy_filings_before_coverage: legacyCount,
      filings,
      dataset,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**5%+ beneficial owners of ${result.issuer_name}** (CIK ${result.issuer_cik}) — input "${result.issuer}"`,
      `Schedule filter: ${result.form_kind} | ${result.filings_parsed} of ${result.total_structured_filings} structured filings parsed`,
      `Structured coverage starts ${result.structured_coverage_from}; ${result.legacy_filings_before_coverage} legacy SC 13D/SC 13G filings sit before it in the submissions window (read those with secedgar_get_filing).`,
    ];

    for (const f of result.filings) {
      lines.push('');
      const amendment = f.is_amendment
        ? ` (amendment${f.amendment_number ? ` no. ${f.amendment_number}` : ''})`
        : '';
      lines.push(`## ${f.form}${amendment} — filed ${f.filing_date} [${f.accession_number}]`);
      const bits = [`Schedule ${f.schedule}`];
      if (f.event_date) bits.push(`event ${f.event_date}`);
      if (f.security_class) bits.push(f.security_class);
      if (f.cusips.length > 0) bits.push(`CUSIP ${f.cusips.join(', ')}`);
      lines.push(bits.join(' | '));

      for (const p of f.reporting_persons) {
        const pct =
          p.percent_of_class !== undefined ? `${p.percent_of_class}% of class` : 'percent N/A';
        const owned =
          p.aggregate_amount_owned !== undefined
            ? `${p.aggregate_amount_owned.toLocaleString()} shares`
            : 'amount N/A';
        const idBits: string[] = [];
        if (p.cik) idBits.push(`CIK ${p.cik}`);
        if (p.citizenship) idBits.push(p.citizenship);
        if (p.person_types.length > 0) idBits.push(p.person_types.join('/'));
        lines.push(`- **${p.name}**${idBits.length > 0 ? ` (${idBits.join(', ')})` : ''}`);
        lines.push(`  ${owned} | ${pct}`);
        lines.push(
          `  voting sole/shared: ${p.sole_voting_power ?? 'N/A'} / ${p.shared_voting_power ?? 'N/A'} | dispositive sole/shared: ${p.sole_dispositive_power ?? 'N/A'} / ${p.shared_dispositive_power ?? 'N/A'}`,
        );
        if (p.excludes_certain_shares !== undefined) {
          lines.push(`  Excludes disclaimed shares: ${p.excludes_certain_shares ? 'yes' : 'no'}`);
        }
        if (p.notes) lines.push(`  Note: ${p.notes}`);
      }

      if (f.purpose_of_transaction) {
        lines.push(
          `**Purpose of transaction:** ${f.purpose_of_transaction}${f.purpose_truncated ? ' (clipped — read the full Item 4 with secedgar_get_filing)' : ''}`,
        );
      } else {
        lines.push(
          f.schedule === '13G'
            ? '**Purpose of transaction:** not applicable — 13G is the passive form and has no purpose item.'
            : '**Purpose of transaction:** not stated in this filing.',
        );
      }
    }

    if (result.dataset) {
      const note = result.dataset.truncated
        ? ' (truncated — more structured filings exist beyond limit)'
        : '';
      lines.push(
        `\nDataset: ${result.dataset.name} (${result.dataset.row_count} reporting-person rows, expires ${result.dataset.expires_at})${note} — query with secedgar_dataframe_query.`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
