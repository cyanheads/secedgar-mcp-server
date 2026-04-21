/**
 * @fileoverview Search supported XBRL financial concepts by keyword, statement group, or taxonomy.
 * Discovery tool for the friendly names accepted by secedgar_get_financials and secedgar_compare_metric.
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
    'Search supported XBRL financial concepts by keyword, statement group, or taxonomy. Use before secedgar_get_financials or secedgar_compare_metric to discover the right friendly name, or pass a raw XBRL tag (e.g., "NetIncomeLoss") to reverse-lookup which friendly names map to it. Empty search with no filters returns the full catalog.',
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
        'Filter to a single financial statement group. income_statement covers P&L items; balance_sheet covers position items (use instant periods in compare_metric); cash_flow covers CF statement items; per_share covers EPS; entity_info covers DEI items like shares outstanding.',
      ),
    taxonomy: z
      .enum(TAXONOMY_VALUES)
      .optional()
      .describe(
        'Filter to a single XBRL taxonomy. us-gaap for US filers, ifrs-full for foreign filers, dei for entity info.',
      ),
  }),

  output: z.object({
    total: z.number().describe('Number of concepts matching the filters.'),
    concepts: z
      .array(
        z.object({
          name: z
            .string()
            .describe(
              'Friendly name to pass as the concept argument to secedgar_get_financials or secedgar_compare_metric.',
            ),
          label: z.string().describe('Human-readable concept label.'),
          tags: z
            .array(z.string())
            .describe(
              'XBRL tags this friendly name resolves to, tried in order. Multiple tags cover historical naming changes (e.g., pre- vs post-ASC 606 revenue).',
            ),
          taxonomy: z.enum(TAXONOMY_VALUES).describe('XBRL taxonomy.'),
          unit: z
            .string()
            .describe(
              'Unit of measure (USD, USD/shares, shares, pure). Note: secedgar_compare_metric expects the dashed form USD-per-shares.',
            ),
          group: z.enum(GROUP_VALUES).describe('Financial statement group.'),
        }),
      )
      .describe('Matching concepts, ordered by group then alphabetical by name.'),
  }),

  handler(input, ctx) {
    let results = searchConcepts(input.search ?? '');

    if (input.group) {
      results = results.filter((c) => c.group === input.group);
    }
    if (input.taxonomy) {
      results = results.filter((c) => c.taxonomy === input.taxonomy);
    }

    ctx.log.info('Concept search completed', {
      search: input.search,
      group: input.group,
      taxonomy: input.taxonomy,
      matches: results.length,
    });

    return {
      total: results.length,
      concepts: results.map((c) => ({
        name: c.name,
        label: c.label,
        tags: c.tags,
        taxonomy: c.taxonomy,
        unit: c.unit,
        group: c.group,
      })),
    };
  },

  format: (result) => {
    if (result.total === 0) {
      return [
        {
          type: 'text',
          text: 'No concepts matched. Try a broader search, different group, or call with no filters to see the full catalog.',
        },
      ];
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
