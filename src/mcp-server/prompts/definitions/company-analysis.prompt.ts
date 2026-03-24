/**
 * @fileoverview Prompt template for structured analysis of a public company's SEC filings.
 * @module mcp-server/prompts/definitions/company-analysis
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const companyAnalysisPrompt = prompt('secedgar_company_analysis', {
  description:
    "Guides a structured analysis of a public company's SEC filings: " +
    'identify recent filings, extract financial trends, surface risk factors, and note material events.',

  args: z.object({
    company: z.string().describe('Company name, ticker symbol, or CIK number to analyze.'),
    focus_areas: z
      .string()
      .optional()
      .describe(
        'Specific areas to focus on (e.g., "revenue growth, debt levels, insider activity"). If omitted, performs a general analysis.',
      ),
  }),

  generate: (args) => [
    {
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Analyze the SEC filings for **${args.company}**${args.focus_areas ? ` with a focus on: ${args.focus_areas}` : ''}.`,
          '',
          'Follow this structured workflow:',
          '',
          '1. **Company Identification** — Use `secedgar_company_search` to resolve the company and review recent filings.',
          '2. **Financial Trends** — Use `secedgar_get_financials` to pull key metrics (revenue, net_income, eps_diluted, assets, debt, operating_cash_flow) and identify trends over the last 3-5 years.',
          '3. **Recent Filings Review** — Use `secedgar_get_filing` to read the most recent 10-K or 10-Q for qualitative insights (risk factors, MD&A, business overview).',
          '4. **Material Events** — Search for recent 8-K filings to identify material events (M&A, leadership changes, earnings surprises).',
          '5. **Industry Context** — Use `secedgar_compare_metric` to compare key metrics against peers.',
          '',
          'Present findings as:',
          '- **Company Overview** — entity details, industry, fiscal year',
          '- **Financial Summary** — key metrics table with trends',
          '- **Risk Factors** — material risks from latest filings',
          '- **Recent Events** — notable 8-K filings and their significance',
          '- **Peer Comparison** — how the company stacks up on key metrics',
          '- **Key Takeaways** — 3-5 bullet points summarizing the analysis',
        ].join('\n'),
      },
    },
  ],
});
