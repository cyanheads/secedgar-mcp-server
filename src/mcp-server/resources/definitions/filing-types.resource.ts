/**
 * @fileoverview Reference list of common SEC filing types with descriptions and use cases.
 * @module mcp-server/resources/definitions/filing-types
 */

import { resource } from '@cyanheads/mcp-ts-core';

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
      'Current report for material events: M&A (1.01), earnings (2.02), exec changes (5.02).',
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
    form: 'SC 13D',
    cadence: 'Threshold',
    description: 'Beneficial ownership report for 5%+ activist investors.',
    use_cases: 'Activist investor tracking, ownership changes',
  },
  {
    form: 'SC 13G',
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
    'Reference list of common SEC filing types with descriptions, cadence, and typical use cases. ' +
    'Helps determine which form_types to filter when searching filings.',
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
