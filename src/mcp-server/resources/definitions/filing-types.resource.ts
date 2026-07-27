/**
 * @fileoverview Reference list of common SEC filing types with descriptions and use cases.
 * @module mcp-server/resources/definitions/filing-types
 */

import { resource } from '@cyanheads/mcp-ts-core';
import {
  CURRENT_EIGHT_K_ITEMS,
  EIGHT_K_RENUMBERING_DATE,
  EIGHT_K_SECTIONS,
  LEGACY_EIGHT_K_ITEMS,
} from '@/services/edgar/eight-k-items.js';

const FILING_TYPES = [
  {
    form: '10-K',
    cadence: 'Annual',
    description:
      'Annual report with audited financials, MD&A, risk factors, and business overview.',
    use_cases: 'Financial analysis, due diligence, competitive research',
  },
  {
    form: '10-Q',
    cadence: 'Quarterly (Q1-Q3)',
    description: 'Quarterly report with unaudited financials, MD&A, and market risks.',
    use_cases: 'Tracking quarterly performance, identifying trends',
  },
  {
    form: '8-K',
    cadence: 'Event-driven',
    description:
      'Current report for material events, scoped by item code (see the item tables below).',
    use_cases: 'Breaking news, material events, earnings announcements',
  },
  {
    form: 'DEF 14A',
    cadence: 'Annual proxy',
    description:
      'Definitive proxy statement with board elections, executive pay, and shareholder votes.',
    use_cases: 'Executive compensation analysis, governance research',
  },
  {
    form: '13F-HR',
    cadence: 'Quarterly',
    description: 'Institutional investment manager holdings ($100M+ AUM).',
    use_cases: 'Tracking institutional ownership, portfolio analysis',
  },
  {
    form: 'Form 4',
    cadence: 'Per-transaction',
    description: 'Insider buy/sell report: date, shares, price, and transaction code.',
    use_cases: 'Insider trading activity, management confidence signals',
  },
  {
    form: 'SCHEDULE 13D',
    cadence: 'Threshold',
    description: 'Beneficial ownership report for 5%+ activist investors.',
    use_cases: 'Activist investor tracking, ownership changes',
  },
  {
    form: 'SCHEDULE 13G',
    cadence: 'Threshold',
    description: 'Beneficial ownership report for 5%+ passive investors.',
    use_cases: 'Passive institutional ownership tracking',
  },
  {
    form: 'S-1',
    cadence: 'One-time',
    description: 'IPO registration statement with prospectus, financials, and risk factors.',
    use_cases: 'IPO research, pre-IPO due diligence',
  },
  {
    form: '20-F',
    cadence: 'Annual',
    description: 'Foreign private issuer annual report (equivalent of 10-K).',
    use_cases: 'International company analysis',
  },
] as const;

export const filingTypesResource = resource('secedgar://filing-types', {
  name: 'SEC Filing Types',
  description:
    'Reference list of common SEC filing types with descriptions, cadence, and typical use cases, plus the full 8-K item-code decode tables for both numbering regimes. Helps choose the forms parameter for secedgar_search_filings, the form_types filter for secedgar_company_search, or the items filter for secedgar_get_material_events.',
  mimeType: 'text/markdown',

  handler(_params, _ctx) {
    const lines: string[] = ['# SEC Filing Types', ''];
    lines.push(
      'Use these form types with `secedgar_company_search` (form_types filter) and `secedgar_search_filings` (forms filter).',
      '',
    );
    lines.push('| Form | Cadence | Description | Use Cases |');
    lines.push('|:-----|:--------|:------------|:----------|');
    for (const ft of FILING_TYPES) {
      lines.push(`| **${ft.form}** | ${ft.cadence} | ${ft.description} | ${ft.use_cases} |`);
    }
    lines.push(
      '',
      '> **Beneficial-ownership form names (December 2024 transition):** 5%+ ownership filings now use the structured form names `SCHEDULE 13D` / `SCHEDULE 13G` (with a `primary_doc.xml`). The legacy `SC 13D` / `SC 13G` names stopped appearing on new filings, so filter EFTS (`secedgar_search_filings` forms) on the current names to reach recent filings.',
    );

    lines.push(
      '',
      '## 8-K item codes',
      '',
      `An 8-K reports one or more numbered items, and the item is what identifies the event. Pass these codes to \`secedgar_get_material_events\` (\`items\` filter). SEC replaced the original single-integer numbering with the dotted scheme effective **${EIGHT_K_RENUMBERING_DATE}**; the two vocabularies are disjoint, so a filter of dotted codes never matches a pre-changeover filing and vice versa.`,
      '',
      `### Current numbering (${EIGHT_K_RENUMBERING_DATE} onward)`,
      '',
      '| Item | Title |',
      '|:-----|:------|',
    );
    let currentSection = '';
    for (const [code, label] of Object.entries(CURRENT_EIGHT_K_ITEMS)) {
      const section = EIGHT_K_SECTIONS[code.slice(0, 1)];
      if (section && section !== currentSection) {
        currentSection = section;
        lines.push(`| | *Section ${code.slice(0, 1)} — ${section}* |`);
      }
      lines.push(`| \`${code}\` | ${label} |`);
    }

    lines.push(
      '',
      `### Legacy numbering (before ${EIGHT_K_RENUMBERING_DATE})`,
      '',
      '| Item | Title |',
      '|:-----|:------|',
    );
    for (const [code, label] of Object.entries(LEGACY_EIGHT_K_ITEMS)) {
      lines.push(`| \`${code}\` | ${label} |`);
    }
    lines.push(
      '',
      "> Legacy item 12 is the ancestor of today's 2.02 (results of operations), item 9 of today's 7.01 (Regulation FD), and item 7 of today's 9.01 (financial statements and exhibits). Items 10-12 were added in 2002-2003 and retired at the changeover along with the rest.",
    );
    return lines.join('\n');
  },

  list: async () => ({
    resources: [
      {
        uri: 'secedgar://filing-types',
        name: 'SEC Filing Types',
        description: 'Common SEC filing types with descriptions and use cases',
        mimeType: 'text/markdown',
      },
    ],
  }),
});
