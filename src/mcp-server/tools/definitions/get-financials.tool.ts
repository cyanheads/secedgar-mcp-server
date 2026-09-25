/**
 * @fileoverview Get historical XBRL financial data for a company.
 * Handles friendly concept name resolution, multi-tag lookup, and automatic deduplication.
 * @module mcp-server/tools/definitions/get-financials
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  dataframeGuidance,
  getCanvasBridge,
  toDatasetField,
} from '@/services/canvas-bridge/canvas-bridge.js';
import {
  describeUnknownConcepts,
  findUnknownConcept,
  resolveConceptTarget,
} from '@/services/edgar/concept-map.js';
import {
  describingTag,
  type FramedUnit,
  matchesPeriodType,
  resolveFrameSeries,
  seriesStalenessCaveats,
  type TagPrioritizedUnit,
} from '@/services/edgar/concept-series.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { missingQuarterCaveats } from '@/services/edgar/fiscal-periods.js';
import type { CompanyConceptUnit, CompanyFactsResponse } from '@/services/edgar/types.js';

export const getFinancialsTool = tool('secedgar_get_financials', {
  description:
    'Get historical XBRL financial data for a company. Accepts friendly concept names (e.g., "revenue", "net_income", "assets") or raw XBRL tags. Discover available friendly names with secedgar_search_concepts. Handles historical tag changes and deduplicates data automatically. The full series is also staged as df_<id> when a canvas is available — inspect it with secedgar_dataframe_describe, then analyze it with secedgar_dataframe_query.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  enrichment: {
    // Declared so the staged-dataframe pointer reaches the wire at all: the
    // framework parses the handler result against output.extend(enrichment) and
    // strips any key the block does not declare, including the `notice` that
    // ctx.enrich.truncated writes (#104).
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the inline series was capped, or when the full series is staged as a dataframe.',
      ),
    truncated: z.boolean().optional().describe('True when the inline data[] was capped by limit.'),
    shown: z.number().optional().describe('Number of periods shown inline.'),
    cap: z.number().optional().describe('The limit cap applied.'),
  },

  errors: [
    {
      reason: 'company_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The company input does not resolve to a CIK',
      recovery: 'Use a ticker symbol or 10-digit CIK number for an exact match.',
    },
    {
      reason: 'ambiguous_company',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The company input resolves to multiple entities and the target is ambiguous',
      recovery: 'Use a ticker symbol or 10-digit CIK from the matches list for an exact match.',
    },
    {
      reason: 'unknown_concept',
      code: JsonRpcErrorCode.NotFound,
      when: 'The concept input is neither a supported friendly name nor shaped like an XBRL tag, so no request is sent',
      recovery: 'Use a friendly name from secedgar_search_concepts or a valid raw XBRL tag.',
    },
    {
      reason: 'no_concept_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'The company does not report any XBRL data for the resolved concept and taxonomy',
      recovery: 'Try a raw XBRL tag, switch taxonomy to ifrs-full, or use a related concept.',
    },
    {
      reason: 'no_frame_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Concept exists but has no frame-aligned (standard calendar period) entries',
      recovery: 'Try a related concept that reports against standard calendar periods.',
    },
    {
      reason: 'no_period_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Concept has data but the period_type filter excluded all of it',
      recovery: 'Switch period_type to "quarterly" or "all" for balance sheet items.',
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
      .describe('Ticker symbol (e.g., "AAPL") or CIK number. Ticker is preferred.'),
    concept: z
      .string()
      .min(1)
      .describe(
        'Financial concept — friendly name (e.g., "revenue", "net_income", "assets", "eps_diluted") or raw XBRL tag (e.g., "AccountsPayableCurrent"). Friendly names auto-resolve to the correct XBRL tags and handle historical tag changes.',
      ),
    taxonomy: z
      .enum(['us-gaap', 'ifrs-full', 'dei'])
      .default('us-gaap')
      .describe(
        'XBRL taxonomy. us-gaap for US companies, ifrs-full for foreign filers, dei for entity info (shares outstanding).',
      ),
    period_type: z
      .enum(['annual', 'quarterly', 'all'])
      .optional()
      .describe(
        'Filter to annual (FY) or quarterly (Q1-Q4) data. "all" returns both. When omitted, defaults to "annual"; instant (balance-sheet) concepts automatically fall back to returning the full series on the first call when the annual filter yields nothing (#48).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Cap the inline data[] to the most-recent N periods (the series is newest-first). The full series is always registered to the dataframe, so older periods stay queryable via secedgar_dataframe_query. Omit to return every period inline.',
      ),
  }),
  // Other spellings of the company parameter in use across tools (#115).
  inputAliases: { ticker: 'company', cik: 'company', ticker_or_cik: 'company' },

  output: z.object({
    company: z.string().describe('Resolved entity name (SEC-conformed).'),
    cik: z.string().describe('Resolved CIK, zero-padded to 10 digits.'),
    concept: z
      .string()
      .describe(
        'XBRL tag behind the newest value. A friendly name can walk several tags, so each row names its own.',
      ),
    label: z.string().describe('Human-readable taxonomy label of the concept tag.'),
    description: z
      .string()
      .optional()
      .describe(
        'XBRL taxonomy description of the concept tag. Often absent for company-extension tags or older concepts.',
      ),
    unit: z
      .string()
      .describe('Unit of measure of the newest value (e.g., "USD", "shares", "USD/shares").'),
    data: z
      .array(
        z
          .object({
            period: z.string().describe('Calendar period label (e.g., "CY2023", "CY2023Q3").'),
            value: z.number().describe('Reported value.'),
            start: z
              .string()
              .optional()
              .describe('Period start date (YYYY-MM-DD). Duration items only.'),
            end: z.string().describe('Period end date (YYYY-MM-DD).'),
            fiscal_year: z
              .number()
              .nullable()
              .describe(
                "Fiscal year of the source filing, not the data period — every comparative period restated in the same filing carries that filing's fiscal year, so use end (or period) as the time key. Null when the source filing did not encode a fiscal year.",
              ),
            fiscal_period: z
              .string()
              .nullable()
              .describe(
                'Fiscal period of the source filing (FY, Q1, Q2, Q3, Q4), not the data period. Null when the source filing did not encode a fiscal period.',
              ),
            form: z.string().describe('Source filing type (10-K, 10-Q, etc.).'),
            filed: z.string().describe('Date the source filing was submitted (YYYY-MM-DD).'),
            accession_number: z
              .string()
              .describe('Source filing accession number for secedgar_get_filing.'),
            tag: z
              .string()
              .describe(
                'XBRL tag this value was reported under — differs from concept when an older or successor tag in the friendly name answers this period.',
              ),
          })
          .describe(
            'One reported value with its period, fiscal context, source filing, and source tag.',
          ),
      )
      .describe(
        "Deduplicated time series, newest first — one value per calendar period. Where SEC's period frame sits on a proxy statement's figure (the pay-versus-performance table re-tags net income), the value comes from the filer's own report of the same period; an annual period SEC framed on a 10-Q's trailing-twelve-month figure is left out, since the filer has not closed that year.",
      ),
    tags_tried: z
      .array(z.string())
      .optional()
      .describe(
        'XBRL tags that were attempted (shown when using friendly names that map to multiple tags).',
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
      })
      .optional()
      .describe(
        'Canvas dataframe handle holding the same time series. Use for cross-company JOINs via secedgar_dataframe_query. The source-filing fiscal keys are materialized as source_filing_fy/source_filing_fp — order, group, and window by period_end, not by those columns. Absent when canvas is unavailable.',
      ),
    caveats: z
      .array(z.string())
      .optional()
      .describe(
        "Data-completeness warnings about the returned series. Two kinds. On quarterly results, one entry when one or two calendar quarters are absent from every recent qualifying year — SEC reports a filer's fiscal Q4 as the 10-K residual rather than a discrete quarterly fact, so the calendar quarter fiscal Q4 spans has no frame-tagged value, and a filer whose other fiscal quarters span non-calendar durations loses a second quarter the same way. Applies to calendar-year filers (no discrete Q4) as much as to off-calendar ones. On any result, one entry when the series stops well short of today — either because the concept resolved to an XBRL tag SEC has retired from the taxonomy (the current tags reported nothing), or because a current tag's series ends more than two years plus a filing window back, which is what a filer migrating to a different element or dropping the disclosure looks like. Absent when the series has nothing to flag.",
      ),
  }),

  async handler(input, ctx) {
    /**
     * A name that is neither a catalog entry nor tag-shaped can match nothing
     * SEC holds, so it fails here — before company resolution, and before the
     * tag is interpolated into a request path (#128).
     */
    const unknown = findUnknownConcept(input.concept);
    if (unknown) {
      const { message, hint } = describeUnknownConcepts([unknown]);
      throw ctx.fail('unknown_concept', message, {
        recovery: { hint },
        concept: unknown.concept,
        suggestions: unknown.suggestions,
        ...(unknown.derivation ? { derivation: unknown.derivation } : {}),
      });
    }

    const api = getEdgarApiService();

    // Resolve company to CIK
    const resolved = await api.resolveCik(input.company);
    if (Array.isArray(resolved) && resolved.length === 0) {
      throw ctx.fail('company_not_found', `Company '${input.company}' not found.`, {
        ...ctx.recoveryFor('company_not_found'),
      });
    }
    if (Array.isArray(resolved) && resolved.length > 1) {
      // Render the candidates into the message itself, not just structured data —
      // clients that read only content[] otherwise get a "pick from the matches
      // list" instruction with no list to pick from (#90). Same shape the
      // company_search and get_institutional_holdings ambiguity paths already ship.
      const shown = resolved.slice(0, 10);
      const list = shown
        .map((m) => `${m.cik} ${m.name ?? 'Unknown'}${m.ticker ? ` (${m.ticker})` : ''}`)
        .join(', ');
      throw ctx.fail(
        'ambiguous_company',
        `'${input.company}' matches multiple companies: ${list}. Retry with one of these tickers or 10-digit CIKs.`,
        {
          ...ctx.recoveryFor('ambiguous_company'),
          matches: shown.map((m) => ({
            cik: m.cik,
            name: m.name,
            ticker: m.ticker,
          })),
        },
      );
    }
    const match = Array.isArray(resolved) ? resolved[0] : resolved;
    if (!match) {
      throw ctx.fail('company_not_found', `Company '${input.company}' not found.`, {
        ...ctx.recoveryFor('company_not_found'),
      });
    }

    // Resolve concept to taxonomy + XBRL tag(s). The mapping's own taxonomy wins
    // over the `us-gaap` default (e.g. `dei` for shares_outstanding); ifrs-full
    // uses the confirmed IFRS variants when the mapping has them.
    const { label, tagSelection, tags, taxonomy } = resolveConceptTarget(
      input.concept,
      input.taxonomy,
    );

    // Default to "annual" for unset period_type; post-fetch fallback handles instant concepts (#48).
    const effectivePeriodType = input.period_type ?? 'annual';

    // Try each tag until we get data. `tryGetCompanyConcept` returns null for 404
    // (tag not reported by this company); other errors propagate.
    /** Taxonomy metadata of every tag that carried values, keyed by tag. */
    const responses = new Map<string, { label: string; description: string | undefined }>();
    const tagsTried: string[] = [];
    /**
     * Each value is augmented with its source tag, the tag's array position, and
     * its unit key: the position resolves collisions by tag priority (#44, index
     * 0 = preferred total), the tag and unit key are the value's provenance and
     * scope the proxy-frame swap (#123, #125).
     */
    const allUnits: TagPrioritizedUnit[] = [];
    const collect = (
      tag: string,
      tagIndex: number,
      units: Record<string, CompanyConceptUnit[]>,
      meta: { label: string; description: string | undefined },
    ) => {
      responses.set(tag, meta);
      for (const [unit, values] of Object.entries(units)) {
        for (const value of values) allUnits.push({ ...value, tag, tagIndex, unit });
      }
    };
    /**
     * Tags whose companyconcept payload named the tag but carried no values. SEC
     * serves some filers' units as an object where an array belongs, and the
     * service edge drops those; a well-formed payload always carries a unit, since
     * SEC answers an unreported tag with a 404 (#141).
     */
    const servedEmpty: Array<{ tag: string; tagIndex: number }> = [];

    for (const [tagIndex, tag] of tags.entries()) {
      tagsTried.push(tag);
      const resp = await api.tryGetCompanyConcept(match.cik, taxonomy, tag);
      if (!resp) continue;
      if (Object.keys(resp.units).length === 0) {
        servedEmpty.push({ tag, tagIndex });
        continue;
      }
      collect(tag, tagIndex, resp.units, {
        label: resp.label,
        description: resp.description ?? undefined,
      });
    }

    /**
     * The filer's companyfacts payload, read at most once: it answers every tag
     * companyconcept served empty — the same filer's companyfacts carries those
     * facts well-formed — and backs the no-data probe below. `undefined` until read.
     */
    let facts: CompanyFactsResponse | null | undefined;
    if (servedEmpty.length > 0) {
      facts = await api.tryGetCompanyFacts(match.cik);
      const namespace = facts?.facts[taxonomy];
      for (const { tag, tagIndex } of servedEmpty) {
        const concept = namespace?.[tag];
        if (!concept) continue;
        // An absent label falls back to the concept's own at the return below.
        collect(tag, tagIndex, concept.units, {
          label: concept.label ?? '',
          description: concept.description,
        });
      }
    }

    /**
     * Collapse to one value per standard calendar period — frame-bearing entries
     * only, a proxy-held frame answered by the filer's reporting-form fact,
     * same-frame collisions resolved by tag priority then latest `filed` (#44,
     * #123). An empty map means the concept exists but has no frame-aligned entries.
     */
    const byFrameClean = resolveFrameSeries(allUnits, tagSelection);
    /**
     * The concept is described by the tag behind its newest value: a successor
     * behind an older leader answers the recent frames (#125), and under a
     * `coverage` selection only the winner contributes at all (#101).
     */
    const conceptTag = describingTag([...byFrameClean.values()], allUnits, tagSelection);
    const conceptResponse = conceptTag !== undefined ? responses.get(conceptTag) : undefined;

    if (conceptTag === undefined || !conceptResponse) {
      // Probe companyfacts to discover what namespaces and tags this filer actually reports.
      // Only on the error path — one extra request, never on the happy path.
      if (facts === undefined) facts = await api.tryGetCompanyFacts(match.cik);
      const availableNamespaces = facts ? Object.keys(facts.facts) : [];

      let hint: string;
      if (facts && availableNamespaces.length > 0) {
        const { facts: namespaces } = facts;
        const namespaceSummary = availableNamespaces
          .map((ns) => {
            const nsTags = Object.keys(namespaces[ns] ?? {});
            const searchTerm = tagsTried[0]?.toLowerCase().replace(/_/g, '') ?? '';
            // Surface a few matching tags when the requested concept overlaps with this namespace
            const matchingTags = searchTerm
              ? nsTags.filter((t) => t.toLowerCase().includes(searchTerm)).slice(0, 3)
              : [];
            return matchingTags.length > 0
              ? `${ns} (${nsTags.length} tags, e.g. ${matchingTags.join(', ')})`
              : `${ns} (${nsTags.length} tags)`;
          })
          .join('; ');
        hint = `This filer reports under: ${namespaceSummary}. Try a raw XBRL tag from one of these namespaces, or switch taxonomy to match.`;
      } else {
        hint =
          taxonomy === 'ifrs-full'
            ? 'Try a raw XBRL tag instead of a friendly name, or check the company uses IFRS.'
            : "This company may use a different tag or taxonomy. Try 'ifrs-full' for foreign filers.";
      }

      throw ctx.fail(
        'no_concept_data',
        `No XBRL data for '${input.concept}' under ${taxonomy} for this company.`,
        {
          recovery: { hint },
          concept: input.concept,
          taxonomy,
          tags_tried: tagsTried,
          available_namespaces: availableNamespaces.length > 0 ? availableNamespaces : undefined,
        },
      );
    }

    /**
     * Read from the full deduped set, not the period-filtered slice: an annual
     * view that stops a year behind a still-current quarterly series is a
     * property of the filter, not of the concept. Undefined exactly when no
     * value carried a frame.
     */
    const newestFramed = [...byFrameClean.values()].reduce<FramedUnit | undefined>(
      (newest, unit) => (!newest || unit.end > newest.end ? unit : newest),
      undefined,
    );
    if (!newestFramed) {
      throw ctx.fail(
        'no_frame_data',
        `'${conceptTag}' exists for this company but has no standard-period data.`,
        {
          ...ctx.recoveryFor('no_frame_data'),
          tag: conceptTag,
        },
      );
    }

    // Filter by period type using frame pattern (fp reflects the filing, not the data point)
    // resolvedPeriodType tracks the actual period type after the instant fallback (#48).
    let resolvedPeriodType = effectivePeriodType;
    let filtered = Array.from(byFrameClean.values()).filter((u) =>
      matchesPeriodType(u.frame, effectivePeriodType),
    );

    // If period_type filter removed everything, check for instant-concept fallback (#48)
    if (filtered.length === 0 && byFrameClean.size > 0) {
      const sample = byFrameClean.values().next().value;
      const hasInstant = sample && /I$/.test(sample.frame);

      /**
       * Post-fetch instant fallback (#48): when `period_type` was NOT explicitly set
       * and the annual filter emptied a non-empty series whose frames are all instant
       * (CY####Q#I), return the full set. The caller asked for the concept's default
       * period — the right answer is the series that actually exists, not an error.
       */
      if (hasInstant && input.period_type === undefined) {
        filtered = Array.from(byFrameClean.values());
        resolvedPeriodType = 'all';
      } else {
        const hint = hasInstant
          ? 'This is a balance sheet (instant) item — try period_type: "quarterly" or "all".'
          : effectivePeriodType === 'annual'
            ? 'No annual data found — try period_type: "quarterly" or "all".'
            : 'No quarterly data found — try period_type: "annual" or "all".';
        throw ctx.fail('no_period_data', `No ${effectivePeriodType} data for '${conceptTag}'.`, {
          recovery: { hint },
          tag: conceptTag,
          period_type: effectivePeriodType,
        });
      }
    }

    // Sort newest first
    filtered.sort((a, b) => b.end.localeCompare(a.end));

    /**
     * Off-calendar filers lose a whole calendar quarter from the frame-tagged
     * series — SEC reports fiscal Q4 as the 10-K residual, never as a discrete
     * quarterly fact — so a caller sees a gap with no way to tell "did not
     * report" from "frame tagging does not expose it". `fetch_frames` already
     * flags the same hazard from the period side; this names the specific
     * quarter for this filer (#95). Detection reads the resolved frames, so it
     * runs over the full deduped set rather than the period-filtered slice.
     */
    const caveats = [
      ...(resolvedPeriodType === 'annual' ? [] : missingQuarterCaveats(byFrameClean.keys())),
      /**
       * The tag that won the walk can be one SEC retired years ago, which
       * happens exactly when no current tag reports for this filer; the values
       * look ordinary and the taxonomy label is the only tell (#98). A current
       * tag whose series simply stops carries no tell at all, so the gap to
       * today is the signal — one companyconcept payload is all this tool reads,
       * and it holds no filer-wide period to compare against (#102).
       */
      ...seriesStalenessCaveats(conceptTag, conceptResponse.label, newestFramed, {
        date: new Date().toISOString().slice(0, 10),
        kind: 'current-date',
      }),
    ];

    /** The newest value's unit key, alongside its tag describing the line. */
    const unitKey = newestFramed.unit;

    const data = filtered.map((u) => ({
      period: u.frame,
      value: u.val,
      start: u.start || undefined,
      end: u.end,
      fiscal_year: u.fy,
      fiscal_period: u.fp,
      form: u.form,
      filed: u.filed,
      accession_number: u.accn,
      tag: u.tag,
    }));

    let dataset: { name: string; row_count: number; expires_at: string } | undefined;
    const bridge = getCanvasBridge();
    if (bridge && data.length > 0) {
      const rows = filtered.map((u) => ({
        cik: match.cik,
        entity_name: match.name ?? null,
        concept: conceptTag,
        tag: u.tag,
        taxonomy,
        unit: u.unit,
        period: u.frame,
        value: u.val,
        period_start: u.start || null,
        period_end: u.end,
        // Named for what they are — the SOURCE FILING's fy/fp, not the data
        // period. Bare fiscal_year/fiscal_period invited ORDER BY/GROUP BY
        // against the wrong key; period_end is the time key (#72).
        source_filing_fy: u.fy,
        source_filing_fp: u.fp,
        form: u.form,
        filed: u.filed,
        accession_number: u.accn,
      }));
      const registered = await bridge.registerDataframe(ctx, {
        rows,
        sourceTool: 'secedgar_get_financials',
        queryParams: {
          company: input.company,
          cik: match.cik,
          concept: conceptTag,
          taxonomy,
          period_type: resolvedPeriodType,
        },
      });
      if (registered) dataset = toDatasetField(registered);
    }

    // Slice inline view when a limit was requested; the dataframe holds the
    // full series, so older periods stay queryable via the dataframe handle (#32).
    const inlineData = input.limit ? data.slice(0, input.limit) : data;
    if (input.limit && data.length > input.limit) {
      ctx.enrich.truncated({
        shown: inlineData.length,
        cap: input.limit,
        guidance: `Showing the ${inlineData.length} most-recent of ${data.length} periods. ${
          dataset ? dataframeGuidance(dataset) : 'Raise limit to see more inline.'
        }`,
      });
    } else if (dataset) {
      ctx.enrich.notice(dataframeGuidance(dataset));
    }

    ctx.log.info('Financials retrieved', {
      company: match.cik,
      concept: conceptTag,
      dataPoints: data.length,
      datasetName: dataset?.name,
    });

    return {
      company: match.name || input.company,
      cik: match.cik,
      concept: conceptTag,
      label: conceptResponse.label || label,
      description: conceptResponse.description || undefined,
      unit: unitKey,
      data: inlineData,
      tags_tried: tagsTried.length > 1 ? tagsTried : undefined,
      dataset,
      caveats: caveats.length > 0 ? caveats : undefined,
    };
  },

  format: (result) => {
    const lines = [`**${result.label}** — ${result.company} (CIK ${result.cik}, ${result.unit})`];
    lines.push(`XBRL tag: ${result.concept}`);
    if (result.description) lines.push(result.description);
    if (result.tags_tried?.length) {
      lines.push(`Tags tried: ${result.tags_tried.join(', ')}`);
    }
    lines.push('');
    for (const d of result.data) {
      const formatted =
        result.unit === 'USD'
          ? `$${(d.value / 1_000_000).toFixed(1)}M`
          : result.unit === 'USD/shares'
            ? `$${d.value.toFixed(2)}`
            : d.value.toLocaleString();
      const fy = d.fiscal_year != null ? `FY${d.fiscal_year}` : null;
      const fp = d.fiscal_period ?? null;
      const fiscalCtx = [fy, fp].filter(Boolean).join(' ');
      const range = d.start ? `${d.start} → ${d.end}` : d.end;
      const filingCtx = fiscalCtx
        ? `${d.form} (${fiscalCtx}) filed ${d.filed} [${d.accession_number}]`
        : `${d.form} filed ${d.filed} [${d.accession_number}]`;
      // Rows from the concept tag carry it in the header line above.
      const tagCtx = d.tag === result.concept ? '' : ` | tag ${d.tag}`;
      lines.push(`${d.period}: ${formatted} (raw ${d.value}) | ${range} | ${filingCtx}${tagCtx}`);
    }
    if (result.dataset) {
      const sliceNote =
        result.dataset.row_count > result.data.length
          ? ` — showing the ${result.data.length} most-recent of ${result.dataset.row_count} periods inline; full series on the dataframe`
          : '';
      lines.push(
        `\nDataset: ${result.dataset.name} (${result.dataset.row_count} rows, expires ${result.dataset.expires_at})${sliceNote} — query with secedgar_dataframe_query.`,
      );
    }
    for (const caveat of result.caveats ?? []) {
      lines.push(`\nCaveat: ${caveat}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
