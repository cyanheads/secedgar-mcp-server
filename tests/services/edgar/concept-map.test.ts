/**
 * @fileoverview Tests for concept-map service — friendly name resolution and full concept listing.
 * @module tests/services/edgar/concept-map
 */

import { describe, expect, it } from 'vitest';
import { getAllConcepts, resolveConcept, searchConcepts } from '@/services/edgar/concept-map.js';

describe('resolveConcept', () => {
  it('resolves a known friendly name', () => {
    const mapping = resolveConcept('revenue');
    expect(mapping).toBeDefined();
    expect(mapping!.label).toBe('Revenue');
    expect(mapping!.taxonomy).toBe('us-gaap');
    expect(mapping!.unit).toBe('USD');
    expect(mapping!.tags.length).toBeGreaterThan(0);
    expect(mapping!.tags).toContain('Revenues');
  });

  it('resolves names with hyphens', () => {
    expect(resolveConcept('net-income')).toEqual(resolveConcept('net_income'));
  });

  it('resolves names with spaces', () => {
    expect(resolveConcept('net income')).toEqual(resolveConcept('net_income'));
  });

  it('is case-insensitive', () => {
    expect(resolveConcept('Revenue')).toEqual(resolveConcept('revenue'));
    expect(resolveConcept('NET_INCOME')).toEqual(resolveConcept('net_income'));
  });

  it('returns undefined for unknown names', () => {
    expect(resolveConcept('not_a_real_concept')).toBeUndefined();
  });

  it('returns undefined for raw XBRL tags (not friendly names)', () => {
    expect(resolveConcept('RevenueFromContractWithCustomerExcludingAssessedTax')).toBeUndefined();
  });

  it('resolves dei taxonomy concepts', () => {
    const mapping = resolveConcept('shares_outstanding');
    expect(mapping).toBeDefined();
    expect(mapping!.taxonomy).toBe('dei');
    expect(mapping!.unit).toBe('shares');
  });

  it('resolves concepts with multiple XBRL tags', () => {
    const mapping = resolveConcept('revenue');
    expect(mapping!.tags.length).toBeGreaterThan(1);
  });

  it('resolves concepts with USD/shares unit', () => {
    const mapping = resolveConcept('eps_diluted');
    expect(mapping).toBeDefined();
    expect(mapping!.unit).toBe('USD/shares');
  });

  it('resolves depreciation_amortization with cross-company tag fallbacks', () => {
    const mapping = resolveConcept('depreciation_amortization');
    expect(mapping).toBeDefined();
    expect(mapping!.group).toBe('cash_flow');
    expect(mapping!.tags).toEqual([
      'DepreciationDepletionAndAmortization',
      'DepreciationAndAmortization',
      'Depreciation',
    ]);
  });

  it('resolves notes_payable with notes-specific then debt-fallback tags', () => {
    const mapping = resolveConcept('notes_payable');
    expect(mapping).toBeDefined();
    expect(mapping!.group).toBe('balance_sheet');
    expect(mapping!.tags).toEqual(['LongTermNotesPayable', 'NotesPayable', 'LongTermDebt']);
  });
});

describe('resolveConcept — IFRS tag variants', () => {
  it('revenue mapping includes ifrsTags', () => {
    const mapping = resolveConcept('revenue');
    expect(mapping?.ifrsTags).toBeDefined();
    expect(mapping!.ifrsTags).toContain('RevenueFromContractsWithCustomers');
  });

  it('net_income mapping includes ifrsTags', () => {
    const mapping = resolveConcept('net_income');
    expect(mapping?.ifrsTags).toBeDefined();
    expect(mapping!.ifrsTags).toContain('ProfitLoss');
  });

  it('assets mapping includes ifrsTags', () => {
    const mapping = resolveConcept('assets');
    expect(mapping?.ifrsTags).toBeDefined();
    expect(mapping!.ifrsTags).toContain('Assets');
  });

  it('concepts without IFRS variants have no ifrsTags', () => {
    // equity has no confirmed universal IFRS tag
    const mapping = resolveConcept('equity');
    expect(mapping?.ifrsTags).toBeUndefined();
  });
});

describe('searchConcepts — taxonomy filtering', () => {
  it('returns non-empty results for taxonomy ifrs-full', () => {
    const results = searchConcepts('', 'ifrs-full');
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns only concepts with ifrsTags when taxonomy is ifrs-full', () => {
    const results = searchConcepts('', 'ifrs-full');
    for (const r of results) {
      expect(r.ifrsTags).toBeDefined();
      expect(r.ifrsTags!.length).toBeGreaterThan(0);
    }
  });

  it('includes revenue, net_income, assets when taxonomy is ifrs-full', () => {
    const results = searchConcepts('', 'ifrs-full');
    const names = results.map((r) => r.name);
    expect(names).toContain('revenue');
    expect(names).toContain('net_income');
    expect(names).toContain('assets');
  });

  it('does not include equity when taxonomy is ifrs-full (no confirmed IFRS tag)', () => {
    const results = searchConcepts('', 'ifrs-full');
    const names = results.map((r) => r.name);
    expect(names).not.toContain('equity');
  });

  it('matches IFRS tag names in search when taxonomy is ifrs-full', () => {
    const results = searchConcepts('ProfitLoss', 'ifrs-full');
    expect(results.some((r) => r.name === 'net_income')).toBe(true);
  });

  it('returns all concepts when taxonomy is us-gaap (standard behaviour)', () => {
    const allResults = searchConcepts('');
    const usgaapResults = searchConcepts('', 'us-gaap');
    // us-gaap taxonomy filters by mapping.taxonomy === 'us-gaap', which is handled in the tool
    // searchConcepts itself doesn't filter for us-gaap — that is done post-call in the tool handler
    expect(usgaapResults.length).toBe(allResults.length);
  });
});

describe('getAllConcepts', () => {
  it('returns all concept mappings', () => {
    const concepts = getAllConcepts();
    expect(Object.keys(concepts).length).toBeGreaterThan(0);
  });

  it('includes expected concepts', () => {
    const concepts = getAllConcepts();
    const names = Object.keys(concepts);
    expect(names).toContain('revenue');
    expect(names).toContain('net_income');
    expect(names).toContain('assets');
    expect(names).toContain('eps_basic');
    expect(names).toContain('shares_outstanding');
  });

  it('returns mappings with required fields', () => {
    const concepts = getAllConcepts();
    for (const [name, mapping] of Object.entries(concepts)) {
      expect(mapping.label, `${name} missing label`).toBeTruthy();
      expect(mapping.tags.length, `${name} has no tags`).toBeGreaterThan(0);
      expect(mapping.taxonomy, `${name} missing taxonomy`).toBeTruthy();
      expect(mapping.unit, `${name} missing unit`).toBeTruthy();
    }
  });
});
