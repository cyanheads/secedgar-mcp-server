/**
 * @fileoverview Tests for the company-analysis prompt — ownership-focused routing (#75).
 * @module tests/mcp-server/prompts/definitions/company-analysis.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { companyAnalysisPrompt } from '@/mcp-server/prompts/definitions/company-analysis.prompt.js';

/** Parse args and flatten the generated messages to a single searchable string. */
function generatedText(args: { company: string; focus_areas?: string }): string {
  const parsed = companyAnalysisPrompt.args!.parse(args);
  return JSON.stringify(companyAnalysisPrompt.generate(parsed));
}

describe('companyAnalysisPrompt', () => {
  it('generates a well-formed user message', () => {
    const messages = companyAnalysisPrompt.generate(
      companyAnalysisPrompt.args!.parse({ company: 'AAPL' }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toHaveProperty('role', 'user');
    expect(messages[0]).toHaveProperty('content');
  });

  it('routes insider-focused analysis through secedgar_get_insider_transactions (#75)', () => {
    // The issue's repro: an insider focus must name the insider tool.
    const text = generatedText({
      company: 'AAPL',
      focus_areas: 'revenue trend, risk factors, insider selling',
    });
    expect(text).toContain('secedgar_get_insider_transactions');
  });

  it('routes 13F/institutional-focused analysis through secedgar_get_institutional_holdings (#75)', () => {
    const text = generatedText({
      company: 'Berkshire Hathaway',
      focus_areas: '13F institutional holdings',
    });
    expect(text).toContain('secedgar_get_institutional_holdings');
  });

  it('routes a generic "ownership" focus through both ownership tools (#75)', () => {
    const text = generatedText({ company: 'AAPL', focus_areas: 'ownership structure' });
    expect(text).toContain('secedgar_get_insider_transactions');
    expect(text).toContain('secedgar_get_institutional_holdings');
  });

  it('does not add ownership tools for a non-ownership focus (#75)', () => {
    const text = generatedText({ company: 'AAPL', focus_areas: 'revenue trend, debt levels' });
    expect(text).not.toContain('secedgar_get_insider_transactions');
    expect(text).not.toContain('secedgar_get_institutional_holdings');
  });

  it('generates the full baseline workflow when focus_areas is omitted (#75)', () => {
    const text = generatedText({ company: 'AAPL' });
    for (const toolName of [
      'secedgar_company_search',
      'secedgar_get_financials',
      'secedgar_get_filing',
      'secedgar_search_filings',
      'secedgar_fetch_frames',
    ]) {
      expect(text).toContain(toolName);
    }
    expect(text).not.toContain('secedgar_get_insider_transactions');
    expect(text).not.toContain('secedgar_get_institutional_holdings');
  });

  it('keeps secedgar_search_filings as the fallback even on an ownership focus (#75)', () => {
    const text = generatedText({ company: 'AAPL', focus_areas: 'insider activity' });
    expect(text).toContain('secedgar_search_filings');
  });
});
