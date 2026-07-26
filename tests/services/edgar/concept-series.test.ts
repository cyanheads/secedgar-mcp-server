/**
 * @fileoverview Tests for the shared frame-aligned series resolution — the tag
 * priority and restatement rules extracted from `get_financials` so the
 * snapshot and comparison tools produce identical numbers.
 * @module tests/services/edgar/concept-series
 */

import { describe, expect, it } from 'vitest';
import {
  matchesPeriodType,
  resolveFrameSeries,
  seriesFromCompanyFacts,
  type TagPrioritizedUnit,
} from '@/services/edgar/concept-series.js';
import type { CompanyFactsResponse } from '@/services/edgar/types.js';

function unit(overrides: Partial<TagPrioritizedUnit>): TagPrioritizedUnit {
  return {
    accn: '0000320193-24-000001',
    end: '2024-09-28',
    filed: '2024-11-01',
    form: '10-K',
    fp: 'FY',
    fy: 2024,
    tagIndex: 0,
    val: 1,
    ...overrides,
  };
}

describe('resolveFrameSeries', () => {
  it('drops entries with no frame', () => {
    const resolved = resolveFrameSeries([
      unit({ frame: 'CY2024', val: 10 }),
      unit({ val: 999 }), // no frame — a non-standard period
    ]);
    expect([...resolved.keys()]).toEqual(['CY2024']);
    expect(resolved.get('CY2024')?.val).toBe(10);
  });

  it('returns an empty map when nothing carries a frame', () => {
    expect(resolveFrameSeries([unit({ val: 1 }), unit({ val: 2 })]).size).toBe(0);
  });

  it('lets the lower tag index win a same-frame collision', () => {
    const resolved = resolveFrameSeries([
      unit({ frame: 'CY2024', val: 606, tagIndex: 1 }),
      unit({ frame: 'CY2024', val: 15673, tagIndex: 0 }),
    ]);
    expect(resolved.get('CY2024')?.val).toBe(15673);
  });

  it('does not let a later filing from a lower-priority tag displace the preferred total', () => {
    const resolved = resolveFrameSeries([
      unit({ frame: 'CY2024', val: 15673, tagIndex: 0, filed: '2025-02-01' }),
      unit({ frame: 'CY2024', val: 606, tagIndex: 1, filed: '2025-06-01' }),
    ]);
    expect(resolved.get('CY2024')?.val).toBe(15673);
  });

  it('lets the later filed date win within one tag (restatement)', () => {
    const resolved = resolveFrameSeries([
      unit({ frame: 'CY2024', val: 100, filed: '2024-11-01' }),
      unit({ frame: 'CY2024', val: 200, filed: '2025-01-15' }),
    ]);
    expect(resolved.get('CY2024')?.val).toBe(200);
  });

  it('strips the internal tag index from resolved values', () => {
    const resolved = resolveFrameSeries([unit({ frame: 'CY2024' })]);
    expect(resolved.get('CY2024')).not.toHaveProperty('tagIndex');
  });
});

describe('matchesPeriodType', () => {
  it('matches annual against full-year duration frames only', () => {
    expect(matchesPeriodType('CY2024', 'annual')).toBe(true);
    expect(matchesPeriodType('CY2024Q2', 'annual')).toBe(false);
    expect(matchesPeriodType('CY2024Q2I', 'annual')).toBe(false);
  });

  it('matches quarterly against both duration and instant quarter frames', () => {
    expect(matchesPeriodType('CY2024Q2', 'quarterly')).toBe(true);
    expect(matchesPeriodType('CY2024Q2I', 'quarterly')).toBe(true);
    expect(matchesPeriodType('CY2024', 'quarterly')).toBe(false);
  });

  it('matches everything under all', () => {
    for (const frame of ['CY2024', 'CY2024Q2', 'CY2024Q2I']) {
      expect(matchesPeriodType(frame, 'all')).toBe(true);
    }
  });
});

const facts: CompanyFactsResponse = {
  cik: 320193,
  entityName: 'Apple Inc.',
  facts: {
    'us-gaap': {
      Revenues: {
        label: 'Revenues',
        description: 'Total revenue',
        units: {
          USD: [
            unit({ frame: 'CY2023', end: '2023-09-30', val: 383285 }),
            unit({ frame: 'CY2024', end: '2024-09-28', val: 391035 }),
          ].map(({ tagIndex: _t, ...u }) => u),
        },
      },
      SalesRevenueNet: {
        label: 'Sales Revenue, Net',
        units: {
          USD: [unit({ frame: 'CY2024', end: '2024-09-28', val: 1 })].map(
            ({ tagIndex: _t, ...u }) => u,
          ),
        },
      },
    },
  },
};

describe('seriesFromCompanyFacts', () => {
  it('resolves the first reporting tag and sorts newest first', () => {
    const resolved = seriesFromCompanyFacts(facts, 'us-gaap', ['Revenues', 'SalesRevenueNet']);
    expect(resolved?.tag).toBe('Revenues');
    expect(resolved?.label).toBe('Revenues');
    expect(resolved?.description).toBe('Total revenue');
    expect(resolved?.unit).toBe('USD');
    expect(resolved?.series.map((s) => s.frame)).toEqual(['CY2024', 'CY2023']);
  });

  it('applies tag priority across tags sharing a frame', () => {
    const resolved = seriesFromCompanyFacts(facts, 'us-gaap', ['Revenues', 'SalesRevenueNet']);
    // Both tags report CY2024; index 0 (Revenues) must win.
    expect(resolved?.series.find((s) => s.frame === 'CY2024')?.val).toBe(391035);
  });

  it('skips a leading tag the filer does not report and records every tag tried', () => {
    const resolved = seriesFromCompanyFacts(facts, 'us-gaap', ['NotReported', 'Revenues']);
    expect(resolved?.tag).toBe('Revenues');
    expect(resolved?.tagsTried).toEqual(['NotReported', 'Revenues']);
  });

  it('returns undefined for an unknown taxonomy', () => {
    expect(seriesFromCompanyFacts(facts, 'ifrs-full', ['Revenue'])).toBeUndefined();
  });

  it('returns undefined when no candidate tag is reported', () => {
    expect(seriesFromCompanyFacts(facts, 'us-gaap', ['Goodwill'])).toBeUndefined();
  });
});
