/**
 * @fileoverview Tests for the shared frame-aligned series resolution — the tag
 * priority and restatement rules extracted from `get_financials` so the
 * snapshot and comparison tools produce identical numbers.
 * @module tests/services/edgar/concept-series
 */

import { describe, expect, it } from 'vitest';
import {
  type FramedUnit,
  matchesPeriodType,
  newestReportedPeriod,
  preferredTagIndex,
  resolveFrameSeries,
  seriesFromCompanyFacts,
  seriesStalenessCaveats,
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

/**
 * The SAP/Sanofi shape from #101 in miniature: two tags, one covering a long
 * run and the other a two-period fringe, with which is which flipping between
 * filers. Declared order cannot answer that; period count can.
 */
describe('resolveFrameSeries under coverage selection (#101)', () => {
  const sapShaped: TagPrioritizedUnit[] = [
    unit({ frame: 'CY2019', end: '2019-12-31', val: 79, tagIndex: 0 }),
    unit({ frame: 'CY2020', end: '2020-12-31', val: 46, tagIndex: 0 }),
    unit({ frame: 'CY2019', end: '2019-12-31', val: 1835, tagIndex: 1 }),
    unit({ frame: 'CY2020', end: '2020-12-31', val: 1084, tagIndex: 1 }),
    unit({ frame: 'CY2021', end: '2021-12-31', val: 1334, tagIndex: 1 }),
    unit({ frame: 'CY2022', end: '2022-12-31', val: 1431, tagIndex: 1 }),
  ];

  it('lets the wider-covering tag take frames the declared leader also reports', () => {
    const resolved = resolveFrameSeries(sapShaped, 'coverage');
    expect(resolved.get('CY2020')?.val).toBe(1084);
    expect(resolved.get('CY2019')?.val).toBe(1835);
  });

  it('leaves the declared leader in place under the default priority selection', () => {
    const resolved = resolveFrameSeries(sapShaped);
    expect(resolved.get('CY2020')?.val).toBe(46);
  });

  it('resolves the inverse filer the other way from the same rule', () => {
    // Sanofi: the declared leader IS the real line and the fringe sits behind it.
    const sanofiShaped: TagPrioritizedUnit[] = [
      unit({ frame: 'CY2019', end: '2019-12-31', val: 252, tagIndex: 0 }),
      unit({ frame: 'CY2020', end: '2020-12-31', val: 274, tagIndex: 0 }),
      unit({ frame: 'CY2021', end: '2021-12-31', val: 244, tagIndex: 0 }),
      unit({ frame: 'CY2022', end: '2022-12-31', val: 245, tagIndex: 0 }),
      unit({ frame: 'CY2019', end: '2019-12-31', val: 1.7, tagIndex: 1 }),
    ];
    const resolved = resolveFrameSeries(sanofiShaped, 'coverage');
    expect(resolved.get('CY2019')?.val).toBe(252);
  });

  it('drops the losing tag entirely rather than filling the winner’s gaps', () => {
    /**
     * Ferrari's shape: the two elements overlap on CY2021-CY2022 and disagree
     * there, so splicing the loser's later years onto the winner would print a
     * step that is a tag switch rather than a business fact.
     */
    const ferrariShaped: TagPrioritizedUnit[] = [
      unit({ frame: 'CY2020', end: '2020-12-31', val: 17_401, tagIndex: 0 }),
      unit({ frame: 'CY2021', end: '2021-12-31', val: 11_689, tagIndex: 0 }),
      unit({ frame: 'CY2022', end: '2022-12-31', val: 16_172, tagIndex: 0 }),
      unit({ frame: 'CY2021', end: '2021-12-31', val: 13_895, tagIndex: 1 }),
      unit({ frame: 'CY2022', end: '2022-12-31', val: 20_860, tagIndex: 1 }),
      unit({ frame: 'CY2023', end: '2023-12-31', val: 29_939, tagIndex: 1 }),
    ];
    const resolved = resolveFrameSeries(ferrariShaped, 'coverage');
    expect([...resolved.keys()].sort()).toEqual(['CY2020', 'CY2021', 'CY2022']);
    expect(resolved.get('CY2022')?.val).toBe(16_172);
  });

  it('breaks a coverage tie on the declared order', () => {
    const resolved = resolveFrameSeries(
      [
        unit({ frame: 'CY2024', val: 15673, tagIndex: 0 }),
        unit({ frame: 'CY2024', val: 606, tagIndex: 1 }),
      ],
      'coverage',
    );
    expect(resolved.get('CY2024')?.val).toBe(15673);
  });

  it('still resolves a restatement within the winning tag', () => {
    const resolved = resolveFrameSeries(
      [
        unit({ frame: 'CY2024', val: 100, filed: '2024-11-01', tagIndex: 1 }),
        unit({ frame: 'CY2024', val: 200, filed: '2025-01-15', tagIndex: 1 }),
        unit({ frame: 'CY2023', val: 90, tagIndex: 1 }),
        unit({ frame: 'CY2024', val: 5, tagIndex: 0 }),
      ],
      'coverage',
    );
    expect(resolved.get('CY2024')?.val).toBe(200);
  });
});

describe('preferredTagIndex', () => {
  it('returns the lowest declared index under priority selection', () => {
    expect(
      preferredTagIndex([
        unit({ frame: 'CY2024', tagIndex: 2 }),
        unit({ frame: 'CY2023', tagIndex: 1 }),
      ]),
    ).toBe(1);
  });

  it('returns the widest-covering index under coverage selection', () => {
    expect(
      preferredTagIndex(
        [
          unit({ frame: 'CY2024', tagIndex: 0 }),
          unit({ frame: 'CY2024', tagIndex: 1 }),
          unit({ frame: 'CY2023', tagIndex: 1 }),
        ],
        'coverage',
      ),
    ).toBe(1);
  });

  it('ranks a tag with no standard periods last rather than dropping it', () => {
    expect(
      preferredTagIndex(
        [unit({ tagIndex: 0 }), unit({ frame: 'CY2024', tagIndex: 1 })],
        'coverage',
      ),
    ).toBe(1);
  });

  it('returns undefined when no tag reported anything', () => {
    expect(preferredTagIndex([], 'coverage')).toBeUndefined();
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

  it('describes the series by the winning tag, not the first one present (#101)', () => {
    // SalesRevenueNet covers one period against Revenues' two, so under coverage
    // the declared leader loses and the label/unit must follow the winner.
    const wide: CompanyFactsResponse = {
      ...facts,
      facts: {
        'us-gaap': {
          SalesRevenueNet: facts.facts['us-gaap']?.Revenues as never,
          Revenues: facts.facts['us-gaap']?.SalesRevenueNet as never,
        },
      },
    };
    const resolved = seriesFromCompanyFacts(
      wide,
      'us-gaap',
      ['Revenues', 'SalesRevenueNet'],
      'coverage',
    );
    expect(resolved?.tag).toBe('SalesRevenueNet');
    expect(resolved?.label).toBe('Revenues');
    expect(resolved?.series.map((s) => s.frame)).toEqual(['CY2024', 'CY2023']);
    expect(resolved?.tagsTried).toEqual(['Revenues', 'SalesRevenueNet']);
  });
});

describe('newestReportedPeriod (#102)', () => {
  it('returns the newest standard period the filer reports across the catalog', () => {
    expect(newestReportedPeriod(facts, 'us-gaap')).toBe('2024-09-28');
  });

  it('returns an empty string when the filer reports nothing under the taxonomy', () => {
    expect(newestReportedPeriod(facts, 'ifrs-full')).toBe('');
  });

  it('ignores the dei cover-page namespace', () => {
    /**
     * Toyota's shape: the us-gaap statements stop years back after a migration
     * to IFRS while the cover page keeps filing. Counting `dei` would put every
     * us-gaap line behind a cover-page date and flag the whole profile at once.
     */
    const migrated: CompanyFactsResponse = {
      ...facts,
      facts: {
        ...facts.facts,
        dei: {
          EntityCommonStockSharesOutstanding: {
            label: 'Entity Common Stock, Shares Outstanding',
            units: {
              shares: [unit({ frame: 'CY2026Q1I', end: '2026-03-31', val: 100 })].map(
                ({ tagIndex: _t, ...u }) => u,
              ),
            },
          },
        },
      },
    };
    expect(newestReportedPeriod(migrated, 'us-gaap')).toBe('2024-09-28');
  });

  it('ignores values carrying no standard calendar frame', () => {
    const unframedOnly: CompanyFactsResponse = {
      ...facts,
      facts: {
        'us-gaap': {
          Revenues: {
            label: 'Revenues',
            units: { USD: [{ ...unit({ end: '2030-01-01' }), tagIndex: undefined } as never] },
          },
        },
      },
    };
    expect(newestReportedPeriod(unframedOnly, 'us-gaap')).toBe('');
  });
});

const framed = (frame: string, end: string): FramedUnit => ({ ...unit({ end }), frame });

/** A period end that is current relative to any reference used below. */
const CURRENT = framed('CY2024', '2024-12-31');

describe('seriesStalenessCaveats — retired tag (#98)', () => {
  it('flags a tag whose taxonomy label carries SEC’s retirement stamp', () => {
    const caveats = seriesStalenessCaveats(
      'SalesRevenueGoodsNet',
      'Sales Revenue, Goods, Net (Deprecated 2018-01-31)',
      CURRENT,
      { date: '2025-06-30', kind: 'current-date' },
    );
    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toContain('SalesRevenueGoodsNet');
    expect(caveats[0]).toContain('2018-01-31');
    expect(caveats[0]).toContain('secedgar_search_concepts');
  });

  it('generalizes past the revenue pair to any retired tag', () => {
    // cogs carries the same shape: CostOfGoodsSold is its lowest-priority
    // fallback and was retired on the same date.
    expect(
      seriesStalenessCaveats(
        'CostOfGoodsSold',
        'Cost of Goods Sold (Deprecated 2018-01-31)',
        CURRENT,
        {
          date: '2025-06-30',
          kind: 'current-date',
        },
      ),
    ).toHaveLength(1);
  });

  it('stays silent for a current tag reporting through the reference', () => {
    expect(
      seriesStalenessCaveats(
        'RevenueFromContractWithCustomerIncludingAssessedTax',
        'Revenue from Contract with Customer, Including Assessed Tax',
        CURRENT,
        { date: '2025-06-30', kind: 'current-date' },
      ),
    ).toEqual([]);
  });

  it('does not fire on an unrelated mention of the word', () => {
    // The signal is SEC's parenthesized stamp with a date, not the bare word.
    expect(
      seriesStalenessCaveats('SomeTag', 'Deprecated Plan Obligations, Net', CURRENT, {
        date: '2025-06-30',
        kind: 'current-date',
      }),
    ).toEqual([]);
  });
});

describe('seriesStalenessCaveats — current tag whose series stops (#102)', () => {
  const STOPPED = framed('CY2022', '2022-12-31');

  it('flags a current tag two full years behind the filer’s newest reported period', () => {
    const caveats = seriesStalenessCaveats(
      'ExpenseFromSharebasedPaymentTransactionsWithEmployees',
      'Expense from share-based payment transactions with employees',
      STOPPED,
      { date: '2025-12-31', kind: 'reported-period' },
    );
    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toContain('CY2022');
    expect(caveats[0]).toContain('2022-12-31');
    expect(caveats[0]).toContain('3.0 years');
    expect(caveats[0]).toContain('the newest period this filer reports (ending 2025-12-31)');
    expect(caveats[0]).toContain('is a current tag');
    // The caller already holds the whole profile, so it is not sent back to it.
    expect(caveats[0]).not.toContain('secedgar_get_snapshot');
    expect(caveats[0]).toContain('secedgar_search_concepts');
  });

  it('names today when that is the only reference available', () => {
    const caveats = seriesStalenessCaveats('Revenues', 'Revenues', STOPPED, {
      date: '2026-07-26',
      kind: 'current-date',
    });
    expect(caveats[0]).toContain('today (2026-07-26)');
    // A single-concept read has no filer-wide view, so the snapshot is the step up.
    expect(caveats[0]).toContain('secedgar_get_snapshot');
  });

  it('fires exactly at the two-year floor and stays silent one day short', () => {
    // 2022-12-31 + 730 days = 2024-12-30.
    expect(
      seriesStalenessCaveats('Revenues', 'Revenues', STOPPED, {
        date: '2024-12-30',
        kind: 'reported-period',
      }),
    ).toHaveLength(1);
    expect(
      seriesStalenessCaveats('Revenues', 'Revenues', STOPPED, {
        date: '2024-12-29',
        kind: 'reported-period',
      }),
    ).toEqual([]);
  });

  it('stays silent for a filer one fiscal year plus a filing window behind', () => {
    // The floor has to clear this: a 20-F filer's newest annual period sits a
    // year back until the next report lands, four months after year end.
    expect(
      seriesStalenessCaveats('Revenue', 'Revenue', framed('CY2024', '2024-12-31'), {
        date: '2026-04-29',
        kind: 'current-date',
      }),
    ).toEqual([]);
  });

  it('stays silent when the reference precedes the series', () => {
    expect(
      seriesStalenessCaveats('Revenues', 'Revenues', framed('CY2025', '2025-12-31'), {
        date: '2024-01-01',
        kind: 'reported-period',
      }),
    ).toEqual([]);
  });

  it('stays silent when the series carries no standard period at all', () => {
    expect(
      seriesStalenessCaveats('Revenues', 'Revenues', undefined, {
        date: '2026-07-26',
        kind: 'current-date',
      }),
    ).toEqual([]);
  });

  it('reports a retired tag once, not twice in different words', () => {
    // Both causes apply — the tag is retired AND the series stopped eight years
    // back. The retirement stamp names the concrete cause, so it wins alone.
    const caveats = seriesStalenessCaveats(
      'SalesRevenueGoodsNet',
      'Sales Revenue, Goods, Net (Deprecated 2018-01-31)',
      framed('CY2017', '2017-12-31'),
      { date: '2026-07-26', kind: 'current-date' },
    );
    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toContain('retired from the taxonomy');
    expect(caveats[0]).not.toContain('is a current tag');
  });
});
