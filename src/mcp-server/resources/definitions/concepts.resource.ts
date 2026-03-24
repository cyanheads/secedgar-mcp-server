/**
 * @fileoverview Reference list of common XBRL financial concepts grouped by financial statement.
 * The "menu" an agent reads before calling secedgar_get_financials.
 * @module mcp-server/resources/definitions/concepts
 */

import { resource } from '@cyanheads/mcp-ts-core';
import { getAllConcepts } from '@/services/edgar/concept-map.js';

export const conceptsResource = resource('secedgar://concepts', {
  name: 'XBRL Financial Concepts',
  description:
    'Reference list of common XBRL financial concepts grouped by financial statement, ' +
    'mapping friendly names to XBRL tags. Read this before calling secedgar_get_financials to see available concept names.',
  mimeType: 'text/markdown',

  handler(_params, _ctx) {
    const concepts = getAllConcepts();

    const groups: Record<
      string,
      Array<{ name: string; label: string; tags: string[]; taxonomy: string; unit: string }>
    > = {
      'Income Statement': [],
      'Balance Sheet': [],
      'Cash Flow': [],
      'Per Share': [],
      'Entity Info': [],
    };

    const groupMap: Record<string, string> = {
      revenue: 'Income Statement',
      net_income: 'Income Statement',
      operating_income: 'Income Statement',
      gross_profit: 'Income Statement',
      assets: 'Balance Sheet',
      liabilities: 'Balance Sheet',
      equity: 'Balance Sheet',
      cash: 'Balance Sheet',
      debt: 'Balance Sheet',
      eps_basic: 'Per Share',
      eps_diluted: 'Per Share',
      operating_cash_flow: 'Cash Flow',
      capex: 'Cash Flow',
      shares_outstanding: 'Entity Info',
    };

    for (const [name, mapping] of Object.entries(concepts)) {
      const group = groupMap[name] ?? 'Other';
      if (!groups[group]) groups[group] = [];
      groups[group].push({
        name,
        label: mapping.label,
        tags: mapping.tags,
        taxonomy: mapping.taxonomy,
        unit: mapping.unit,
      });
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

    for (const [group, items] of Object.entries(groups)) {
      if (items.length === 0) continue;
      lines.push(`## ${group}`, '');
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
