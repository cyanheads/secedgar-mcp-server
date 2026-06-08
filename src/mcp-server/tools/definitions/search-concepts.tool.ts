/**
 * @fileoverview Search supported XBRL financial concepts by keyword, statement group, or taxonomy.
 * Discovery tool for the friendly names accepted by secedgar_get_financials and secedgar_fetch_frames.
 * Also performs reverse lookup: passing a raw XBRL tag returns the friendly mapping(s) it belongs to.
 * @module mcp-server/tools/definitions/search-concepts
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { searchConcepts } from '@/services/edgar/concept-map.js';
import type { ConceptGroup, ConceptTaxonomy } from '@/services/edgar/types.js';

const GROUP_VALUES = [
  'income_statement',
  'balance_sheet',
  'cash_flow',
  'per_share',
  'entity_info',
] as const satisfies readonly ConceptGroup[];

const TAXONOMY_VALUES = [
  'us-gaap',
  'ifrs-full',
  'dei',
] as const satisfies readonly ConceptTaxonomy[];

export const searchConceptsTool = tool('secedgar_search_concepts', {
  description:
    'Search supported XBRL financial concepts by keyword, statement group, or taxonomy. Use before secedgar_get_financials or secedgar_fetch_frames to discover the right friendly name, or pass a raw XBRL tag (e.g., "NetIncomeLoss") to reverse-lookup which friendly names map to it. Empty search with no filters returns the full catalog.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    search: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring matched against friendly name, label, and XBRL tags. Examples: "cash" finds cash and operating_cash_flow; "earnings" finds eps_basic and eps_diluted; "NetIncomeLoss" reverse-maps to net_income. Omit to list all concepts.',
      ),
    group: z
      .enum(GROUP_VALUES)
      .optional()
      .describe(
        'Filter to a single financial statement group. income_statement covers P&L items; balance_sheet covers position items (use instant periods in secedgar_fetch_frames); cash_flow covers CF statement items; per_share covers EPS; entity_info covers DEI items like shares outstanding.',
      ),
    taxonomy: z
      .enum(TAXONOMY_VALUES)
      .optional()
      .describe(
        'Filter to a single XBRL taxonomy. us-gaap for US filers, ifrs-full for foreign filers, dei for entity info.',
      ),
  }),

  // Agent-facing context — empty-result guidance populated via ctx.enrich so it
  // reaches structuredContent and content[] automatically; no format() entry needed.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no concepts matched — echoes the search term and suggests alternatives.',
      ),
  },

  output: z.object({
    total: z.number().describe('Number of concepts matching the filters.'),
    concepts: z
      .array(
        z
          .object({
            name: z
              .string()
              .describe(
                'Friendly name to pass as the concept argument to secedgar_get_financials or secedgar_fetch_frames.',
              ),
            label: z.string().describe('Human-readable concept label.'),
            tags: z
              .array(z.string())
              .describe(
                'XBRL tags this friendly name resolves to, tried in order. Multiple tags cover historical naming changes (e.g., pre- vs post-ASC 606 revenue).',
              ),
            related_tags: z
              .array(
                z
                  .object({
                    tag: z
                      .string()
                      .describe(
                        'Alternate-definition XBRL tag some filers use as their primary line.',
                      ),
                    note: z
                      .string()
                      .describe('How this tag differs in definition from the mapped tags.'),
                  })
                  .describe('One alternate-definition tag and the reason it differs.'),
              )
              .optional()
              .describe(
                'Alternate-DEFINITION tags (different meaning from `tags`, not historical synonyms) that a meaningful share of filers report this metric under instead — surfaced by secedgar_fetch_frames as `related_tags`. Present only when the concept has a known high-coverage alternate (e.g. cash → restricted-cash-inclusive total, equity → NCI-inclusive total). Query these separately; do not blindly union them with the base tag.',
              ),
            taxonomy: z
              .enum(TAXONOMY_VALUES)
              .describe(
                'XBRL taxonomy this concept lives in: us-gaap (US filers), ifrs-full (foreign filers), or dei (entity info).',
              ),
            unit: z
              .string()
              .describe(
                'Unit of measure (USD, USD/shares, shares, pure). secedgar_fetch_frames accepts both slash and dashed forms.',
              ),
            group: z
              .enum(GROUP_VALUES)
              .describe(
                'Statement section this concept belongs to: income_statement, balance_sheet, cash_flow, per_share, or entity_info.',
              ),
          })
          .describe('One XBRL concept mapping with its friendly name, tags, and grouping.'),
      )
      .describe('Matching concepts, ordered by group then alphabetical by name.'),
  }),

  handler(input, ctx) {
    // Pass taxonomy to searchConcepts so ifrs-full queries are pre-filtered to
    // concepts with confirmed IFRS tag mappings, rather than falling back to
    // us-gaap-only entries whose taxonomy field never equals 'ifrs-full'.
    let results = searchConcepts(input.search ?? '', input.taxonomy);

    if (input.group) {
      results = results.filter((c) => c.group === input.group);
    }
    if (input.taxonomy && input.taxonomy !== 'ifrs-full') {
      // ifrs-full filtering is handled inside searchConcepts; standard taxonomy
      // filtering (us-gaap, dei) still uses the taxonomy field on the entry.
      results = results.filter((c) => c.taxonomy === input.taxonomy);
    }

    ctx.log.info('Concept search completed', {
      search: input.search,
      group: input.group,
      taxonomy: input.taxonomy,
      matches: results.length,
    });

    if (results.length === 0) {
      const filters: string[] = [];
      if (input.group) filters.push(`group=${input.group}`);
      if (input.taxonomy) filters.push(`taxonomy=${input.taxonomy}`);
      const filterSuffix = filters.length ? ` with filters (${filters.join(', ')})` : '';
      ctx.enrich.notice(
        `No concepts matched "${input.search ?? '(all)'}"${filterSuffix}. Try a broader search term, a different group, or call with no filters to see the full catalog.`,
      );
    }

    return {
      total: results.length,
      concepts: results.map((c) => ({
        name: c.name,
        label: c.label,
        tags: c.tags,
        ...(c.relatedTags?.length ? { related_tags: c.relatedTags } : {}),
        taxonomy: c.taxonomy,
        unit: c.unit,
        group: c.group,
      })),
    };
  },

  format: (result) => {
    if (result.total === 0) {
      return [{ type: 'text', text: `Found 0 concepts.` }];
    }

    const lines = [`Found ${result.total} concept${result.total === 1 ? '' : 's'}:`, ''];

    let currentGroup: string | undefined;
    for (const c of result.concepts) {
      if (c.group !== currentGroup) {
        if (currentGroup) lines.push('');
        lines.push(`## ${formatGroup(c.group)} (\`${c.group}\`)`);
        currentGroup = c.group;
      }
      const tagList = c.tags.map((t) => `\`${t}\``).join(', ');
      lines.push(`- \`${c.name}\` — ${c.label} (${c.taxonomy}, ${c.unit}) → ${tagList}`);
      if (c.related_tags?.length) {
        const rel = c.related_tags.map((r) => `\`${r.tag}\` (${r.note})`).join('; ');
        lines.push(`    related (alternate definition): ${rel}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function formatGroup(group: ConceptGroup): string {
  return group
    .split('_')
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(' ');
}
