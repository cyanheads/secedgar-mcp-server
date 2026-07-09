/**
 * @fileoverview Prompt template for structured analysis of a public company's SEC filings.
 * @module mcp-server/prompts/definitions/company-analysis
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const companyAnalysisPrompt = prompt('secedgar_company_analysis', {
  description: `Guide a structured analysis of a public company's SEC filings: identify recent filings, extract financial trends, surface risk factors, and note material events.`,

  args: z.object({
    company: z.string().describe('Company name, ticker symbol, or CIK number to analyze.'),
    focus_areas: z
      .string()
      .optional()
      .describe(
        'Specific areas to focus on (e.g., "revenue growth, debt levels, insider activity"). If omitted, performs a general analysis.',
      ),
  }),

  generate: (args) => {
    // Route ownership-focused analyses to the purpose-built ownership tools (#75).
    // "ownership" is generic, so it surfaces both the insider and institutional steps;
    // the baseline financial/filing/event/peer workflow is unchanged, and
    // secedgar_search_filings stays the fallback for broad discovery.
    const focus = (args.focus_areas ?? '').toLowerCase();
    const wantsInsider = /insider|management transaction|ownership/.test(focus);
    const wantsInstitutional = /institutional|13[\s-]?f|ownership/.test(focus);

    const steps: string[] = [
      '**Company Identification** — Use `secedgar_company_search` to resolve the company and review recent filings.',
      '**Financial Trends** — Use `secedgar_get_financials` to pull key metrics (revenue, net_income, eps_diluted, assets, debt, operating_cash_flow) and identify trends over the last 3-5 years.',
      '**Recent Filings Review** — Use `secedgar_get_filing` to read the most recent 10-K or 10-Q for qualitative insights (risk factors, MD&A, business overview).',
      '**Material Events** — Use `secedgar_search_filings` (or call `secedgar_company_search` with `form_types: ["8-K"]`) to surface recent material events (M&A, leadership changes, earnings surprises).',
    ];
    if (wantsInsider) {
      steps.push(
        '**Insider Activity** — Use `secedgar_get_insider_transactions` to review Form 3/4/5 buying and selling by officers, directors, and 10% owners.',
      );
    }
    if (wantsInstitutional) {
      steps.push(
        "**Institutional Ownership** — Use `secedgar_get_institutional_holdings` for a 13F filer's reported positions (pass the institutional manager, not the issuer — EDGAR has no issuer-to-holder index).",
      );
    }
    steps.push(
      '**Industry Context** — Use `secedgar_fetch_frames` to compare key metrics against peers.',
    );

    const findings: string[] = [
      '- **Company Overview** — entity details, industry, fiscal year',
      '- **Financial Summary** — key metrics table with trends',
      '- **Risk Factors** — material risks from latest filings',
      '- **Recent Events** — notable 8-K filings and their significance',
    ];
    if (wantsInsider || wantsInstitutional) {
      findings.push(
        '- **Ownership Activity** — insider transactions and/or institutional holdings for the focus',
      );
    }
    findings.push('- **Peer Comparison** — how the company stacks up on key metrics');
    findings.push('- **Key Takeaways** — 3-5 bullet points summarizing the analysis');

    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Analyze the SEC filings for **${args.company}**${args.focus_areas ? ` with a focus on: ${args.focus_areas}` : ''}.`,
            '',
            'Follow this structured workflow:',
            '',
            ...steps.map((step, i) => `${i + 1}. ${step}`),
            '',
            'Present findings as:',
            ...findings,
          ].join('\n'),
        },
      },
    ];
  },
});
