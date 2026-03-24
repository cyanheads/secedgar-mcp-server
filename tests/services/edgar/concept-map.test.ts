/**
 * @fileoverview Tests for concept-map service — friendly name resolution and full concept listing.
 * @module tests/services/edgar/concept-map
 */

import { describe, expect, it } from 'vitest';
import { getAllConcepts, resolveConcept } from '@/services/edgar/concept-map.js';

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
