/**
 * @fileoverview One parameter name per concept across the tool surface (#115).
 * Every tool naming a company, a filing-date bound, or a form filter uses the
 * canonical key — `company`, `filed_after` / `filed_before`, `forms` — and
 * accepts the same set of other spellings as aliases, so a caller carrying a
 * parameter name from one tool to the next is never rejected for it. A tool whose
 * only company input carries another name (`query`, `issuer`) accepts the
 * company-identifier spellings on it too (#152), and a tool whose one count input
 * counts filings accepts `company_search`'s name for that count (#212). The
 * per-tool test files drive each alias through the argument parser; this file pins
 * that the declarations agree across tools.
 * @module tests/mcp-server/tools/input-aliases
 */

import { describe, expect, it } from 'vitest';
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

/** Canonical key → every other spelling a tool declaring that key must accept. */
const ALIASES_BY_KEY: Record<string, string[]> = {
  company: ['ticker', 'cik', 'ticker_or_cik'],
  filed_after: ['start_date', 'date_from'],
  filed_before: ['end_date', 'date_to'],
  forms: ['form_types'],
};

const RETIRED_KEYS = ['ticker_or_cik', 'start_date', 'end_date', 'form_types'];

/** Tools whose single company input is not named `company` → that key and the spellings it takes (#152). */
const COMPANY_INPUT_UNDER_ANOTHER_NAME: Record<string, { key: string; spellings: string[] }> = {
  secedgar_company_search: {
    key: 'query',
    spellings: ['company', 'ticker', 'cik', 'ticker_or_cik', 'name', 'search'],
  },
  secedgar_find_holders: {
    key: 'issuer',
    spellings: ['company', 'ticker', 'cik', 'ticker_or_cik'],
  },
  secedgar_get_beneficial_owners: {
    key: 'issuer',
    spellings: ['company', 'ticker', 'cik', 'ticker_or_cik'],
  },
};

/** Tools whose `limit` counts filings, so `filing_limit` maps onto it (#212). */
const FILING_COUNT_TOOLS = [
  'secedgar_get_beneficial_owners',
  'secedgar_get_material_events',
  'secedgar_search_filings',
];

const tools = buildToolDefinitions({ dropEnabled: true, clampOversizedLimits: true }).map(
  (def) => ({
    name: def.name,
    keys: Object.keys((def.input as unknown as { shape: Record<string, unknown> }).shape),
    aliases: def.inputAliases ?? {},
  }),
);

describe('parameter names across tools (#115)', () => {
  it('declares no retired spelling as a parameter', () => {
    for (const tool of tools) {
      for (const retired of RETIRED_KEYS) {
        expect(tool.keys, `${tool.name} declares ${retired}`).not.toContain(retired);
      }
    }
  });

  it('gives every tool carrying a canonical key the full alias set for it', () => {
    const covered = new Set<string>();
    for (const tool of tools) {
      for (const [key, spellings] of Object.entries(ALIASES_BY_KEY)) {
        if (!tool.keys.includes(key)) continue;
        covered.add(`${tool.name}.${key}`);
        for (const spelling of spellings) {
          expect(tool.aliases[spelling], `${tool.name}: ${spelling} → ${key}`).toBe(key);
        }
      }
    }
    expect([...covered].sort()).toEqual([
      'secedgar_company_search.filed_after',
      'secedgar_company_search.filed_before',
      'secedgar_company_search.forms',
      'secedgar_get_financials.company',
      'secedgar_get_insider_transactions.company',
      'secedgar_get_insider_transactions.filed_after',
      'secedgar_get_insider_transactions.filed_before',
      'secedgar_get_institutional_holdings.company',
      'secedgar_get_material_events.company',
      'secedgar_get_material_events.filed_after',
      'secedgar_get_material_events.filed_before',
      'secedgar_get_snapshot.company',
      'secedgar_search_filings.filed_after',
      'secedgar_search_filings.filed_before',
      'secedgar_search_filings.forms',
    ]);
  });

  it('maps the company-identifier spellings onto a company input under another name (#152)', () => {
    for (const [name, { key, spellings }] of Object.entries(COMPANY_INPUT_UNDER_ANOTHER_NAME)) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.keys, `${name} declares ${key}`).toContain(key);
      for (const spelling of spellings) {
        expect(tool?.aliases[spelling], `${name}: ${spelling} → ${key}`).toBe(key);
      }
    }
  });

  it('leaves a fund and a company list unaliased (#152)', () => {
    // `fund` names a fund or series and `companies` is an array: neither takes the
    // single-company spellings.
    for (const name of ['secedgar_get_fund_holdings', 'secedgar_compare_companies']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.aliases, name).not.toHaveProperty('company');
      expect(tool?.aliases, name).not.toHaveProperty('ticker');
    }
  });

  it('declares aliases only on tools carrying their target', () => {
    for (const tool of tools) {
      for (const target of Object.values(tool.aliases)) {
        expect(tool.keys, `${tool.name} aliases to ${target}`).toContain(target);
      }
    }
  });

  it('maps filing_limit onto limit exactly where limit counts filings (#212)', () => {
    const aliased = tools.filter((tool) => 'filing_limit' in tool.aliases);
    expect(aliased.map((tool) => tool.name).sort()).toEqual(FILING_COUNT_TOOLS);
    for (const tool of aliased) expect(tool.aliases.filing_limit, tool.name).toBe('limit');
    // On a company search, `limit` would read as a count of companies.
    const companySearch = tools.find((tool) => tool.name === 'secedgar_company_search');
    expect(companySearch?.aliases).not.toHaveProperty('limit');
  });

  it('keeps every alias with the limit clamps switched off', () => {
    const off = buildToolDefinitions({ dropEnabled: true, clampOversizedLimits: false });
    for (const tool of tools) {
      const def = off.find((d) => d.name === tool.name);
      expect(def?.inputAliases ?? {}, tool.name).toEqual(tool.aliases);
    }
  });
});
