/**
 * @fileoverview Tests for the company-analysis prompt — ownership-focused routing (#75).
 * @module tests/mcp-server/prompts/definitions/company-analysis.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { companyAnalysisPrompt } from '@/mcp-server/prompts/definitions/company-analysis.prompt.js';
import { compareCompaniesTool } from '@/mcp-server/tools/definitions/compare-companies.tool.js';
import { fetchFramesTool } from '@/mcp-server/tools/definitions/fetch-frames.tool.js';
import { getFinancialsTool } from '@/mcp-server/tools/definitions/get-financials.tool.js';
import { getSnapshotTool } from '@/mcp-server/tools/definitions/get-snapshot.tool.js';
import { at } from '../../../support/assertions.js';

/** Parse args and flatten the generated messages to a single searchable string. */
function generatedText(args: { company: string; focus_areas?: string }): string {
  const parsed = companyAnalysisPrompt.args!.parse(args);
  return JSON.stringify(companyAnalysisPrompt.generate(parsed));
}

describe('companyAnalysisPrompt', () => {
  it('generates a well-formed user message', async () => {
    const messages = await companyAnalysisPrompt.generate(
      companyAnalysisPrompt.args!.parse({ company: 'AAPL' }),
    );
    expect(messages).toHaveLength(1);
    expect(at(messages)).toHaveProperty('role', 'user');
    expect(at(messages)).toHaveProperty('content');
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
      // The Material Events step routes through the item-code-aware tool; a
      // form-level secedgar_search_filings query cannot see 8-K items (#82).
      'secedgar_get_material_events',
      'secedgar_fetch_frames',
    ]) {
      expect(text).toContain(toolName);
    }
    expect(text).not.toContain('secedgar_get_insider_transactions');
    expect(text).not.toContain('secedgar_get_institutional_holdings');
  });

  it('names the item codes an agent needs to scope the material-events step (#82)', () => {
    const text = generatedText({ company: 'AAPL' });
    expect(text).toContain('2.02');
    expect(text).toContain('5.02');
  });

  it('routes issuer-side ownership through secedgar_find_holders before the 13F reader (#81)', () => {
    const text = generatedText({ company: 'AAPL', focus_areas: '13F institutional holdings' });
    expect(text).toContain('secedgar_find_holders');
    expect(text).toContain('filer_cik');
  });

  it('keeps secedgar_search_filings as the fallback even on an ownership focus (#75)', () => {
    const text = generatedText({ company: 'AAPL', focus_areas: 'insider activity' });
    expect(text).toContain('secedgar_search_filings');
  });

  it('scopes the insider step to the tool’s real Form 4 / 4-A contract (#92)', () => {
    const text = generatedText({ company: 'AAPL', focus_areas: 'insider selling' });
    // The tool fetches only ['4', '4/A'] — claiming Forms 3/4/5 would let an agent
    // believe it reviewed initial and annual statements it never queried.
    expect(text).not.toContain('Form 3/4/5');
    expect(text).toContain('Form 4 / 4-A');
  });

  it('routes Forms 3 and 5 to the filing tools rather than the Form 4 parser (#92)', () => {
    const text = generatedText({ company: 'AAPL', focus_areas: 'insider selling' });
    expect(text).toContain('does not cover Form 3');
    expect(text).toContain('secedgar_search_filings');
  });

  it('routes an activist-stake focus through secedgar_get_beneficial_owners (#83)', () => {
    const text = generatedText({ company: 'AAPL', focus_areas: 'activist stake' });
    expect(text).toContain('secedgar_get_beneficial_owners');
    expect(text).toContain('2024-12-18');
  });

  it('adds the blockholder step to a generic ownership focus alongside the other two (#83)', () => {
    const text = generatedText({ company: 'AAPL', focus_areas: 'ownership' });
    expect(text).toContain('secedgar_get_insider_transactions');
    expect(text).toContain('secedgar_find_holders');
    expect(text).toContain('secedgar_get_beneficial_owners');
  });

  it('leaves the blockholder step out of an insider-only focus (#83)', () => {
    const text = generatedText({ company: 'AAPL', focus_areas: 'insider selling' });
    expect(text).not.toContain('secedgar_get_beneficial_owners');
  });
});

describe('companyAnalysisPrompt — profile and peer steps (#129)', () => {
  /** The numbered step whose bold title is `title`, from the baseline prompt. */
  function step(
    title: string,
    args: { company: string; focus_areas?: string } = { company: 'AAPL' },
  ) {
    const [message] = companyAnalysisPrompt.generate(
      companyAnalysisPrompt.args!.parse(args),
    ) as Array<{
      content: { text: string };
    }>;
    const line = message?.content.text.split('\n').find((l) => l.includes(`**${title}**`));
    if (!line) throw new Error(`No ${title} step in the prompt.`);
    return line;
  }

  /** Backticked argument names in a step — every one must be a real input of the tool it names. */
  const argNames = (line: string) =>
    [...line.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((n) => !n?.startsWith('secedgar_'));

  it('profiles the company with get_snapshot, then trends with get_financials', () => {
    const line = step('Financial Trends');
    expect(line.indexOf('secedgar_get_snapshot')).toBeGreaterThan(-1);
    expect(line.indexOf('secedgar_get_financials')).toBeGreaterThan(
      line.indexOf('secedgar_get_snapshot'),
    );
    // get_snapshot reads every catalog concept and takes no concept list.
    expect(Object.keys(getSnapshotTool.input.shape)).not.toContain('concepts');
    for (const name of argNames(line)) {
      expect(
        [
          ...Object.keys(getSnapshotTool.input.shape),
          ...Object.keys(getFinancialsTool.input.shape),
        ],
        name,
      ).toContain(name);
    }
  });

  it('compares named peers with compare_companies, keeping fetch_frames for a market-wide ranking', () => {
    const line = step('Industry Context');
    expect(line).toContain('secedgar_compare_companies');
    expect(line).toContain('secedgar_fetch_frames');
    const names = argNames(line);
    expect(names).toContain('companies');
    for (const name of names) {
      expect(
        [
          ...Object.keys(compareCompaniesTool.input.shape),
          ...Object.keys(fetchFramesTool.input.shape),
        ],
        name,
      ).toContain(name);
    }
    // The prompt takes one company; the peers are the model's to choose.
    expect(Object.keys(companyAnalysisPrompt.args!.shape)).toEqual(['company', 'focus_areas']);
  });

  it('keeps Industry Context last, after the ownership steps', () => {
    const text = generatedText({ company: 'AAPL', focus_areas: 'ownership' });
    const order = [
      'Insider Activity',
      'Institutional Ownership',
      'Blockholders',
      'Industry Context',
    ].map((t) => text.indexOf(`**${t}**`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('names all four financial tools in the baseline workflow', () => {
    const text = generatedText({ company: 'AAPL' });
    for (const name of [
      'secedgar_get_snapshot',
      'secedgar_get_financials',
      'secedgar_compare_companies',
      'secedgar_fetch_frames',
    ]) {
      expect(text).toContain(name);
    }
  });
});
