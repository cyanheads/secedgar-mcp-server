/**
 * @fileoverview Reference list of common XBRL financial concepts grouped by financial statement.
 * The "menu" an agent reads before calling secedgar_get_financials.
 * @module mcp-server/resources/definitions/concepts
 */

import { resource } from '@cyanheads/mcp-ts-core';
import type { ConceptEntry } from '@/services/edgar/concept-map.js';
import { listConcepts } from '@/services/edgar/concept-map.js';
import type { ConceptGroup } from '@/services/edgar/types.js';

const GROUP_LABELS: Record<ConceptGroup, string> = {
  income_statement: 'Income Statement',
  balance_sheet: 'Balance Sheet',
  cash_flow: 'Cash Flow',
  per_share: 'Per Share',
  entity_info: 'Entity Info',
};

export const conceptsResource = resource('secedgar://concepts', {
  name: 'XBRL Financial Concepts',
  description:
    'Reference list of common XBRL financial concepts grouped by financial statement, ' +
    'mapping friendly names to XBRL tags. Read this before calling secedgar_get_financials to see available concept names.',
  mimeType: 'text/markdown',

  handler(_params, _ctx) {
    const groups = new Map<ConceptGroup, ConceptEntry[]>();
    for (const entry of listConcepts()) {
      const list = groups.get(entry.group) ?? [];
      list.push(entry);
      groups.set(entry.group, list);
    }

    const lines: string[] = ['# XBRL Financial Concepts', ''];
    lines.push(
      'Use these friendly names with `secedgar_get_financials` and `secedgar_compare_metric`.',
      '',
    );
    lines.push(
      'Raw XBRL tags are also accepted as an escape hatch for concepts not listed here.',
      '',
    );

    for (const [group, items] of groups) {
      if (items.length === 0) continue;
      lines.push(`## ${GROUP_LABELS[group]}`, '');
      lines.push('| Friendly Name | Label | XBRL Tags | Taxonomy | Unit |');
      lines.push('|:------|:------|:----------|:---------|:-----|');
      for (const item of items) {
        lines.push(
          `| \`${item.name}\` | ${item.label} | ${item.tags.map((t) => `\`${t}\``).join(', ')} | ${item.taxonomy} | ${item.unit} |`,
        );
      }
      lines.push('');
    }

    return lines.join('\n');
  },

  list: async () => ({
    resources: [
      {
        uri: 'secedgar://concepts',
        name: 'XBRL Financial Concepts',
        description: 'Common financial concept names and their XBRL tag mappings',
        mimeType: 'text/markdown',
      },
    ],
  }),
});
