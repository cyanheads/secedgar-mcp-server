/**
 * @fileoverview One parameter name per concept across the tool surface (#115).
 * Every tool naming a company, a filing-date bound, or a form filter uses the
 * canonical key — `company`, `filed_after` / `filed_before`, `forms` — and
 * accepts the same set of other spellings as aliases, so a caller carrying a
 * parameter name from one tool to the next is never rejected for it. The
 * per-tool test files drive each alias through the argument parser; this file
 * pins that the declarations agree across tools.
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

const tools = buildToolDefinitions({ dropEnabled: true }).map((def) => ({
  name: def.name,
  keys: Object.keys((def.input as unknown as { shape: Record<string, unknown> }).shape),
  aliases: def.inputAliases ?? {},
}));

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

  it('declares aliases only on tools carrying their target', () => {
    for (const tool of tools) {
      for (const target of Object.values(tool.aliases)) {
        expect(tool.keys, `${tool.name} aliases to ${target}`).toContain(target);
      }
    }
  });
});
