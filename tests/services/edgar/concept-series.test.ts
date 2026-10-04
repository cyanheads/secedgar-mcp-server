/**
 * @fileoverview Tests for the shared frame-aligned series resolution — the tag
 * priority and restatement rules extracted from `get_financials` so the
 * snapshot and comparison tools produce identical numbers.
 * @module tests/services/edgar/concept-series
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type FramedUnit,
  fiscalYearEnds,
  isProxyForm,
  isQuarterlyForm,
  matchesPeriodType,
  newestReportedPeriod,
  preferredTagIndex,
  rankSeriesUnits,
  resolveFrameSeries,
  resolveFrameSeriesByUnit,
  seriesFromCompanyFacts,
  seriesStalenessCaveats,
  type TagPrioritizedUnit,
} from '@/services/edgar/concept-series.js';
import type { CompanyConceptUnit, CompanyFactsResponse } from '@/services/edgar/types.js';

function unit(overrides: Partial<TagPrioritizedUnit>): TagPrioritizedUnit {
  const tagIndex = overrides.tagIndex ?? 0;
  return {
    accn: '0000320193-24-000001',
    end: '2024-09-28',
    filed: '2024-11-01',
    form: '10-K',
    fp: 'FY',
    fy: 2024,
    tag: `Tag${tagIndex}`,
    tagIndex,
    unit: 'USD',
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

  it('passes every reported field of the winning fact through unchanged', () => {
    const resolved = resolveFrameSeries([
      unit({
        accn: '0000320193-24-000123',
        end: '2024-09-28',
        filed: '2024-11-01',
        form: '10-K',
        fp: 'FY',
        frame: 'CY2024',
        fy: 2024,
        start: '2023-10-01',
        val: 391_035_000_000,
      }),
    ]);
    expect(resolved.get('CY2024')).toMatchObject({
      accn: '0000320193-24-000123',
      end: '2024-09-28',
      filed: '2024-11-01',
      form: '10-K',
      fp: 'FY',
      frame: 'CY2024',
      fy: 2024,
      start: '2023-10-01',
      val: 391_035_000_000,
    });
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

/**
 * Since the pay-versus-performance rule a DEF 14A re-tags five fiscal years of
 * `NetIncomeLoss`, and SEC frames the latest-filed fact for a period — so the
 * proxy row holds the annual frame, often rounded, mis-scaled, or sign-flipped.
 */
describe('resolveFrameSeries — proxy-held frames (#123)', () => {
  const FY2021 = { start: '2021-01-01', end: '2021-12-31' };

  /** Merck's CY2021 shape: the DEF 14A holds the frame, two 10-Ks carry the period. */
  const merckShaped = (): TagPrioritizedUnit[] => [
    unit({
      ...FY2021,
      accn: '0001193125-26-147704',
      filed: '2026-04-08',
      form: 'DEF 14A',
      fp: null,
      frame: 'CY2021',
      fy: null,
      val: 12_345_000_000,
    }),
    unit({
      ...FY2021,
      accn: '0000310158-22-000010',
      filed: '2022-02-25',
      form: '10-K',
      fp: 'FY',
      fy: 2021,
      val: 13_049_000_000,
    }),
    unit({
      ...FY2021,
      accn: '0000310158-24-000009',
      filed: '2024-02-27',
      form: '10-K',
      fp: 'FY',
      fy: 2023,
      val: 13_049_000_000,
    }),
  ];

  it('swaps a proxy frame holder for the latest-filed fact from another form, keeping the frame', () => {
    const resolved = resolveFrameSeries(merckShaped());
    expect(resolved.get('CY2021')).toMatchObject({
      ...FY2021,
      accn: '0000310158-24-000009',
      filed: '2024-02-27',
      form: '10-K',
      fp: 'FY',
      frame: 'CY2021',
      fy: 2023,
      val: 13_049_000_000,
    });
  });

  it('never replaces a frame held by any other form — an 8-K recast carries the restatement', () => {
    // Bank of America CY2013: the 2016 8-K recast differs from the 10-K before it.
    const resolved = resolveFrameSeries([
      unit({
        start: '2013-01-01',
        end: '2013-12-31',
        filed: '2016-11-01',
        form: '8-K',
        frame: 'CY2013',
        val: 10_539_000_000,
      }),
      unit({
        start: '2013-01-01',
        end: '2013-12-31',
        filed: '2016-02-24',
        form: '10-K',
        val: 11_431_000_000,
      }),
    ]);
    expect(resolved.get('CY2013')).toMatchObject({ form: '8-K', val: 10_539_000_000 });
  });

  it('matches the twin on tag, unit key, start, and end — keeping the proxy value when none qualifies', () => {
    const proxy = unit({ ...FY2021, form: 'DEF 14A', frame: 'CY2021', val: 1 });
    const resolved = resolveFrameSeries([
      proxy,
      unit({ ...FY2021, unit: 'EUR', val: 2 }), // other unit key
      unit({ ...FY2021, tagIndex: 1, val: 3 }), // other tag
      unit({ ...FY2021, start: '2021-04-01', val: 4 }), // other start
      unit({ ...FY2021, end: '2021-12-30', val: 5 }), // other end
      unit({ ...FY2021, form: 'PRE 14A', filed: '2026-05-01', val: 6 }), // another proxy
    ]);
    expect(resolved.get('CY2021')).toMatchObject({ form: 'DEF 14A', val: 1 });
  });

  it('corrects a proxy-held frame within its own tag before cross-tag priority runs', () => {
    const resolved = resolveFrameSeries([
      unit({ ...FY2021, form: 'DEF 14A', frame: 'CY2021', val: 12_345 }),
      unit({ ...FY2021, form: '10-K', filed: '2022-02-25', val: 13_049 }),
      unit({ ...FY2021, tagIndex: 1, form: '10-K', frame: 'CY2021', val: 99 }),
    ]);
    expect(resolved.get('CY2021')).toMatchObject({ tag: 'Tag0', form: '10-K', val: 13_049 });
  });

  it('never hands a proxy-held frame to a lower tag when its own tag has no twin', () => {
    const resolved = resolveFrameSeries([
      unit({ ...FY2021, form: 'DEF 14A', frame: 'CY2021', val: 12_345 }),
      unit({ ...FY2021, tagIndex: 1, form: '10-K', frame: 'CY2021', val: 99 }),
    ]);
    expect(resolved.get('CY2021')).toMatchObject({ tag: 'Tag0', val: 12_345 });
  });

  it('leaves quarterly and instant frames held by periodic forms untouched', () => {
    const resolved = resolveFrameSeries([
      unit({ start: '2024-07-01', end: '2024-09-30', form: '10-Q', frame: 'CY2024Q3', val: 5 }),
      unit({ start: '2024-07-01', end: '2024-09-30', form: '10-K', filed: '2025-02-01', val: 6 }),
      unit({ end: '2024-12-31', form: '10-K', frame: 'CY2024Q4I', val: 7 }),
      unit({ end: '2024-12-31', form: '10-K/A', filed: '2025-06-01', val: 8 }),
    ]);
    expect(resolved.get('CY2024Q3')?.val).toBe(5);
    expect(resolved.get('CY2024Q4I')?.val).toBe(7);
  });

  it('applies inside the winning tag under coverage selection too', () => {
    const resolved = resolveFrameSeries(
      [...merckShaped(), unit({ tagIndex: 1, frame: 'CY2019', val: 1 })],
      'coverage',
    );
    expect(resolved.get('CY2021')?.val).toBe(13_049_000_000);
  });
});

describe('isProxyForm (#123)', () => {
  it.each(['DEF 14A', 'PRE 14A', 'DEFA14A', 'DEFR14A', 'DEFM14A', 'PRER14A', 'DEF 14C', 'PRE 14C'])(
    'treats %s as a Schedule 14A/14C proxy form',
    (form) => {
      expect(isProxyForm(form)).toBe(true);
    },
  );

  it.each(['10-K', '10-K/A', '10-Q', '8-K', '20-F', '40-F', '6-K', 'S-1', '10-KT'])(
    'treats %s as a reporting form',
    (form) => {
      expect(isProxyForm(form)).toBe(false);
    },
  );
});

/**
 * SEC frames any roughly year-long duration as `CY####`, including a
 * trailing-twelve-month figure a 10-Q discloses; when that 10-Q fact is the
 * latest filed, it holds the annual frame for a year the filer has not closed.
 */
describe('resolveFrameSeries — quarterly-report-held annual frames (#142)', () => {
  /** Amazon's shape: FY2025 from the 10-K, then a Q2-2026 10-Q TTM framed CY2026. */
  const fy2025 = unit({
    start: '2025-01-01',
    end: '2025-12-31',
    filed: '2026-02-06',
    form: '10-K',
    frame: 'CY2025',
    val: 77_670_000_000,
  });
  const ttm2026 = unit({
    start: '2025-07-01',
    end: '2026-06-30',
    filed: '2026-07-31',
    form: '10-Q',
    fp: 'Q2',
    fy: 2026,
    frame: 'CY2026',
    val: 135_281_000_000,
  });

  it('leaves a 10-Q trailing-twelve-month frame out of the annual series', () => {
    const resolved = resolveFrameSeries([fy2025, ttm2026]);
    expect([...resolved.keys()]).toEqual(['CY2025']);
    expect(resolved.get('CY2025')?.val).toBe(77_670_000_000);
  });

  it('treats a 10-QT the same way', () => {
    const resolved = resolveFrameSeries([fy2025, { ...ttm2026, form: '10-QT' }]);
    expect(resolved.has('CY2026')).toBe(false);
  });

  it('answers the frame with a same-period fact from an annual report when one exists', () => {
    // Walmart CY2012: a 10-Q repeats the fiscal-year dividend the 10-K reported.
    const resolved = resolveFrameSeries([
      unit({
        start: '2012-02-01',
        end: '2013-01-31',
        filed: '2013-06-07',
        form: '10-Q',
        fp: 'Q1',
        frame: 'CY2012',
        val: 1.59,
      }),
      unit({
        start: '2012-02-01',
        end: '2013-01-31',
        filed: '2013-03-26',
        form: '10-K',
        val: 1.59,
      }),
    ]);
    expect(resolved.get('CY2012')).toMatchObject({ form: '10-K', filed: '2013-03-26' });
  });

  it('keeps a closed fiscal year that only a later 10-Q reports', () => {
    // Merck's AccountsReceivableSale CY2020 sits in its Q3-2021 10-Q alone; the
    // period ends on the filer's fiscal-year end, so it is a real annual value.
    const resolved = resolveFrameSeries([
      unit({ start: '2019-01-01', end: '2019-12-31', form: '10-K', frame: 'CY2019', val: 1 }),
      unit({
        start: '2020-01-01',
        end: '2020-12-31',
        filed: '2021-11-05',
        form: '10-Q',
        fp: 'Q3',
        frame: 'CY2020',
        val: 2,
      }),
    ]);
    expect(resolved.get('CY2020')).toMatchObject({ form: '10-Q', val: 2 });
  });

  it('keeps a 10-Q-held year when the series shows no fiscal-year end to test it against', () => {
    const resolved = resolveFrameSeries([
      unit({
        start: '2020-01-01',
        end: '2020-12-31',
        filed: '2021-11-05',
        form: '10-Q',
        frame: 'CY2020',
        val: 2,
      }),
    ]);
    expect(resolved.get('CY2020')?.val).toBe(2);
  });

  it('matches a 52/53-week fiscal-year end within a week', () => {
    // Costco closes its year on the Sunday nearest August 31.
    const resolved = resolveFrameSeries([
      unit({ start: '2023-09-04', end: '2024-09-01', form: '10-K', frame: 'CY2024', val: 1 }),
      unit({
        start: '2022-08-29',
        end: '2023-09-03',
        filed: '2024-03-13',
        form: '10-Q',
        frame: 'CY2023',
        val: 2,
      }),
    ]);
    expect(resolved.get('CY2023')?.val).toBe(2);
  });

  it('leaves out a 10-Q full-year figure for a year that had not ended when it was filed', () => {
    const resolved = resolveFrameSeries([
      fy2025,
      unit({
        start: '2026-01-01',
        end: '2026-12-31',
        filed: '2026-07-31',
        form: '10-Q',
        frame: 'CY2026',
        val: 9,
      }),
    ]);
    expect(resolved.has('CY2026')).toBe(false);
  });

  it('keeps a June fiscal-year 10-K framed CY2026', () => {
    const resolved = resolveFrameSeries([
      unit({
        start: '2025-07-01',
        end: '2026-06-30',
        filed: '2026-07-29',
        form: '10-K',
        frame: 'CY2026',
        val: 104,
      }),
    ]);
    expect(resolved.get('CY2026')).toMatchObject({ form: '10-K', val: 104 });
  });

  it('leaves 10-Q quarterly and instant frames alone', () => {
    const resolved = resolveFrameSeries([
      fy2025,
      unit({
        start: '2026-04-01',
        end: '2026-06-30',
        filed: '2026-07-31',
        form: '10-Q',
        frame: 'CY2026Q2',
        val: 3,
      }),
      unit({ end: '2026-06-30', filed: '2026-07-31', form: '10-Q', frame: 'CY2026Q2I', val: 4 }),
    ]);
    expect(resolved.get('CY2026Q2')?.val).toBe(3);
    expect(resolved.get('CY2026Q2I')?.val).toBe(4);
  });

  it('lets a lower tag fill the frame once the leader’s TTM is left out', () => {
    const resolved = resolveFrameSeries([
      fy2025,
      ttm2026,
      unit({
        start: '2025-07-01',
        end: '2026-06-30',
        filed: '2026-07-29',
        form: '10-K',
        frame: 'CY2026',
        tagIndex: 1,
        val: 5,
      }),
    ]);
    expect(resolved.get('CY2026')).toMatchObject({ tag: 'Tag1', val: 5 });
  });
});

/** A fact as a companyfacts or companyconcept payload serves it — no tag of its own. */
function fact(overrides: Partial<CompanyConceptUnit>): CompanyConceptUnit {
  const { tag: _tag, tagIndex: _tagIndex, unit: _unit, ...served } = unit(overrides);
  return served;
}

/**
 * Amazon's `EffectOfExchangeRateOnCashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents`
 * as companyfacts serves it: four facts, all from one Q1-2022 10-Q, two of them
 * April–March trailing-twelve-month figures SEC framed CY2020 and CY2021.
 */
const amazonFxFacts: CompanyConceptUnit[] = (
  [
    ['2020-04-01', '2021-03-31', 'CY2020', 809_000_000],
    ['2021-01-01', '2021-03-31', 'CY2021Q1', -293_000_000],
    ['2021-04-01', '2022-03-31', 'CY2021', -55_000_000],
    ['2022-01-01', '2022-03-31', 'CY2022Q1', 16_000_000],
  ] as const
).map(([start, end, frame, val]) =>
  fact({
    start,
    end,
    frame,
    val,
    accn: '0001018724-22-000013',
    filed: '2022-04-29',
    form: '10-Q',
    fp: 'Q1',
    fy: 2022,
  }),
);

/**
 * Deere's `RestructuringAndRelatedCostIncurredCost`: two November–October fiscal
 * years and an unframed nine-month figure, all from one Q3-2010 10-Q.
 */
const deereRestructuringFacts: CompanyConceptUnit[] = (
  [
    ['2007-11-01', '2008-10-31', 'CY2008', 49_000_000],
    ['2008-11-01', '2009-10-31', 'CY2009', 48_000_000],
    ['2009-11-01', '2010-07-31', undefined, 9_000_000],
  ] as const
).map(([start, end, frame, val]) =>
  fact({
    start,
    end,
    ...(frame ? { frame } : {}),
    val,
    accn: '0001104659-10-046204',
    filed: '2010-08-27',
    form: '10-Q',
    fp: 'Q3',
    fy: 2010,
  }),
);

describe('fiscalYearEnds (#148)', () => {
  it('takes each annual report’s latest year-long end that closed before it was filed', () => {
    const ends = fiscalYearEnds([
      {
        USD: [
          fact({ accn: 'k-2023', start: '2023-01-01', end: '2023-12-31', filed: '2024-02-02' }),
          fact({ accn: 'k-2023', start: '2022-01-01', end: '2022-12-31', filed: '2024-02-02' }),
          // A forward-looking year-long figure in the same report ends after filing.
          fact({ accn: 'k-2023', start: '2024-01-01', end: '2024-12-31', filed: '2024-02-02' }),
          fact({ accn: 'k-2021', start: '2021-01-01', end: '2021-12-31', filed: '2022-02-04' }),
        ],
      },
    ]);
    expect(ends).toEqual(['2021-12-31', '2023-12-31']);
  });

  it('reads every tag and unit, keeping each end once', () => {
    const ends = fiscalYearEnds([
      { USD: [fact({ accn: 'k', start: '2023-01-01', end: '2023-12-31', filed: '2024-02-02' })] },
      {
        // A 53-week figure in another tag of the same report ends latest.
        shares: [fact({ accn: 'k', start: '2023-01-02', end: '2024-01-03', filed: '2024-02-02' })],
        'USD/shares': [
          fact({
            accn: 'k-amended',
            form: '10-K/A',
            start: '2023-01-02',
            end: '2024-01-03',
            filed: '2024-05-01',
          }),
        ],
      },
    ]);
    expect(ends).toEqual(['2024-01-03']);
  });

  it.each(['10-K', '10-K/A', '10-KT', '10-KT/A', '20-F', '20-F/A', '40-F', '40-F/A'])(
    'counts a %s',
    (form) => {
      expect(
        fiscalYearEnds([
          { USD: [fact({ form, start: '2023-04-01', end: '2024-03-31', filed: '2024-06-20' })] },
        ]),
      ).toEqual(['2024-03-31']);
    },
  );

  it('ignores quarterly reports, proxies, current reports, and spans that are not a year', () => {
    const yearLong = { start: '2023-01-01', end: '2023-12-31', filed: '2024-04-30' };
    expect(
      fiscalYearEnds([
        {
          USD: [
            fact({ ...yearLong, form: '10-Q' }),
            fact({ ...yearLong, form: 'DEF 14A' }),
            fact({ ...yearLong, form: '8-K' }),
            fact({ form: '10-K', start: '2023-07-01', end: '2023-12-31', filed: '2024-02-02' }),
            fact({ form: '10-K', end: '2023-12-31', filed: '2024-02-02' }),
          ],
        },
      ]),
    ).toEqual([]);
  });

  it('skips a unit served as an object instead of an array (#141)', () => {
    expect(fiscalYearEnds([{ USD: {} }])).toEqual([]);
  });
});

describe('resolveFrameSeries — a 10-Q-held year tested against the filer’s fiscal-year ends (#148)', () => {
  const asUnits = (served: readonly CompanyConceptUnit[]): TagPrioritizedUnit[] =>
    served.map((f) => ({ ...f, tag: 'Tag0', tagIndex: 0, unit: 'USD' }));

  it('leaves out a trailing-twelve-month frame no fiscal-year end of the filer matches', () => {
    const resolved = resolveFrameSeries(asUnits(amazonFxFacts), 'priority', () => [
      '2020-12-31',
      '2021-12-31',
    ]);
    expect([...resolved.keys()]).toEqual(['CY2021Q1', 'CY2022Q1']);
  });

  it('keeps a closed fiscal year that lands within a week of one (Deere’s 52/53-week years)', () => {
    const resolved = resolveFrameSeries(asUnits(deereRestructuringFacts), 'priority', () => [
      '2008-10-31',
      '2009-11-01',
      '2010-10-31',
    ]);
    expect([...resolved].map(([frame, u]) => [frame, u.val])).toEqual([
      ['CY2008', 49_000_000],
      ['CY2009', 48_000_000],
    ]);
  });

  it('keeps the frame untested when the filer has no annual-report accession', () => {
    const resolved = resolveFrameSeries(asUnits(amazonFxFacts), 'priority', () => []);
    expect(resolved.get('CY2021')?.val).toBe(-55_000_000);
    expect(resolved.get('CY2020')?.val).toBe(809_000_000);
  });

  it('keeps the frame untested when the filer’s ends are not at hand', () => {
    expect(resolveFrameSeries(asUnits(amazonFxFacts), 'priority', () => undefined).size).toBe(4);
    expect(resolveFrameSeries(asUnits(amazonFxFacts)).size).toBe(4);
  });

  it('asks for the filer’s ends only for a holder its own tag and unit cannot test', () => {
    const filerYearEnds = vi.fn(() => ['2021-12-31']);
    // Testable in its own series (Merck's AccountsReceivableSale shape), answered
    // by a 10-K twin, and a year still open when filed: none needs the filer.
    resolveFrameSeries(
      [
        unit({ start: '2019-01-01', end: '2019-12-31', form: '10-K', frame: 'CY2019' }),
        unit({
          start: '2020-01-01',
          end: '2020-12-31',
          filed: '2021-11-05',
          form: '10-Q',
          frame: 'CY2020',
        }),
        unit({
          start: '2021-01-01',
          end: '2021-12-31',
          filed: '2022-04-29',
          form: '10-Q',
          frame: 'CY2021',
          tagIndex: 1,
        }),
        unit({
          start: '2021-01-01',
          end: '2021-12-31',
          filed: '2022-02-04',
          form: '10-K',
          tagIndex: 1,
        }),
        unit({
          start: '2022-01-01',
          end: '2022-12-31',
          filed: '2022-07-29',
          form: '10-Q',
          frame: 'CY2022',
          tagIndex: 2,
        }),
      ],
      'priority',
      filerYearEnds,
    );
    expect(filerYearEnds).not.toHaveBeenCalled();

    resolveFrameSeries(asUnits(amazonFxFacts), 'priority', filerYearEnds);
    expect(filerYearEnds).toHaveBeenCalled();
  });

  it('tests within each unit key: a unit with its own year-long fact never asks', () => {
    const filerYearEnds = vi.fn(() => ['2021-12-31']);
    const byUnit = resolveFrameSeriesByUnit(
      [
        ...asUnits(amazonFxFacts).map((u) => ({ ...u, unit: 'EUR' })),
        unit({ start: '2020-04-01', end: '2021-03-31', form: '20-F', frame: 'CY2020', val: 7 }),
        unit({
          start: '2021-04-01',
          end: '2022-03-31',
          filed: '2022-04-29',
          form: '10-Q',
          frame: 'CY2021',
          val: 8,
        }),
      ],
      'priority',
      filerYearEnds,
    );
    expect([...(byUnit.get('EUR')?.keys() ?? [])]).toEqual(['CY2021Q1', 'CY2022Q1']);
    // USD's own 20-F year ends 03-31, so its 10-Q-held CY2021 is a closed year.
    expect(byUnit.get('USD')?.get('CY2021')?.val).toBe(8);
    // Once per EUR annual holder; never for USD's.
    expect(filerYearEnds).toHaveBeenCalledTimes(2);
  });
});

describe('seriesFromCompanyFacts — the filer’s fiscal-year ends from the payload (#148)', () => {
  const fxTag =
    'EffectOfExchangeRateOnCashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents';
  const amazonFacts: CompanyFactsResponse = {
    cik: 1018724,
    entityName: 'AMAZON COM INC',
    facts: {
      'us-gaap': {
        NetIncomeLoss: {
          label: 'Net Income (Loss)',
          units: {
            USD: [
              fact({
                accn: '0001018724-22-000005',
                start: '2021-01-01',
                end: '2021-12-31',
                filed: '2022-02-04',
                frame: 'CY2021',
                val: 33_364_000_000,
              }),
            ],
          },
        },
        [fxTag]: { label: 'Effect of Exchange Rate', units: { USD: amazonFxFacts } },
      },
    },
  };

  it('leaves Amazon’s April–March trailing-twelve-month frames out, keeping the quarters', () => {
    const series = seriesFromCompanyFacts(amazonFacts, 'us-gaap', [fxTag]);
    expect(series?.series.map((u) => u.frame)).toEqual(['CY2022Q1', 'CY2021Q1']);
    expect(
      seriesFromCompanyFacts(amazonFacts, 'us-gaap', ['NetIncomeLoss'])?.series.map((u) => u.frame),
    ).toEqual(['CY2021']);
  });

  it('keeps Deere’s November–October years, which end on its 10-K year ends', () => {
    const deereFacts: CompanyFactsResponse = {
      cik: 315189,
      entityName: 'DEERE & CO',
      facts: {
        'us-gaap': {
          NetIncomeLoss: {
            label: 'Net Income (Loss)',
            units: {
              USD: (
                [
                  ['2007-11-01', '2008-10-31', '2010-12-17', 'CY2008'],
                  ['2008-11-01', '2009-10-31', '2011-12-19', 'CY2009'],
                ] as const
              ).map(([start, end, filed, frame]) =>
                fact({ accn: `de-${frame}`, start, end, filed, frame }),
              ),
            },
          },
          RestructuringAndRelatedCostIncurredCost: {
            label: 'Restructuring',
            units: { USD: deereRestructuringFacts },
          },
        },
      },
    };
    const series = seriesFromCompanyFacts(deereFacts, 'us-gaap', [
      'RestructuringAndRelatedCostIncurredCost',
    ]);
    expect(series?.series.map((u) => [u.frame, u.val])).toEqual([
      ['CY2009', 48_000_000],
      ['CY2008', 49_000_000],
    ]);
  });

  it('keeps the untested frames for a filer with no annual-report accession', () => {
    const quarterlyOnly: CompanyFactsResponse = {
      ...amazonFacts,
      facts: { 'us-gaap': { [fxTag]: { label: 'FX', units: { USD: amazonFxFacts } } } },
    };
    expect(
      seriesFromCompanyFacts(quarterlyOnly, 'us-gaap', [fxTag])?.series.map((u) => u.frame),
    ).toEqual(['CY2021', 'CY2022Q1', 'CY2020', 'CY2021Q1']);
  });
});

describe('resolveFrameSeries — one unit per series (#146)', () => {
  /** An annual fact ending on Harmony's 30 June fiscal year end. */
  const fy = (year: number, overrides: Partial<TagPrioritizedUnit>) =>
    unit({
      frame: `CY${year}`,
      start: `${year - 1}-07-01`,
      end: `${year}-06-30`,
      form: '20-F',
      ...overrides,
    });

  it('keeps a convenience translation out of a reporting-currency series', () => {
    // Harmony's Revenue: ZAR from CY2017, a USD translation for CY2016–CY2018
    // filed on one 20-F/A before the ZAR facts for the same years.
    const resolved = resolveFrameSeries([
      fy(2016, { unit: 'USD', val: 1_264, filed: '2018-11-23' }),
      fy(2017, { unit: 'USD', val: 1_416, filed: '2018-11-23' }),
      fy(2018, { unit: 'USD', val: 1_584, filed: '2018-11-23' }),
      fy(2017, { unit: 'ZAR', val: 19_494, filed: '2019-10-24' }),
      fy(2018, { unit: 'ZAR', val: 20_452, filed: '2020-10-29' }),
      fy(2019, { unit: 'ZAR', val: 26_912, filed: '2021-10-29' }),
    ]);
    expect([...resolved].map(([frame, u]) => [frame, u.val, u.unit])).toEqual([
      ['CY2017', 19_494, 'ZAR'],
      ['CY2018', 20_452, 'ZAR'],
      ['CY2019', 26_912, 'ZAR'],
    ]);
  });

  it('takes the unit of the newest value over the unit with more periods', () => {
    // Prudential plc moved its presentation currency from GBP to USD.
    const resolved = resolveFrameSeries([
      ...[2015, 2016, 2017, 2018].map((year) =>
        unit({ frame: `CY${year}`, end: `${year}-12-31`, unit: 'GBP', filed: '2019-03-14' }),
      ),
      ...[2017, 2018, 2019].map((year) =>
        unit({ frame: `CY${year}`, end: `${year}-12-31`, unit: 'USD', filed: '2019-03-01' }),
      ),
    ]);
    expect([...resolved.keys()]).toEqual(['CY2017', 'CY2018', 'CY2019']);
    expect(new Set([...resolved.values()].map((u) => u.unit))).toEqual(new Set(['USD']));
  });

  it('breaks a tie on the newest value by the number of framed periods', () => {
    // A 20-F's USD convenience translation covers fewer years than the CNY series.
    const resolved = resolveFrameSeries([
      ...[2023, 2024, 2025].map((year) =>
        unit({ frame: `CY${year}`, end: `${year}-03-31`, unit: 'CNY', val: year }),
      ),
      ...[2024, 2025].map((year) =>
        unit({ frame: `CY${year}`, end: `${year}-03-31`, unit: 'USD', filed: '2026-01-01' }),
      ),
    ]);
    expect([...resolved.values()].map((u) => [u.frame, u.unit])).toEqual([
      ['CY2023', 'CNY'],
      ['CY2024', 'CNY'],
      ['CY2025', 'CNY'],
    ]);
  });

  it('breaks a full tie alphabetically, whatever the payload order or filing date', () => {
    // SAP's AverageForeignExchangeRate: every pair framed for the same years.
    const resolved = resolveFrameSeries([
      unit({ frame: 'CY2025', end: '2025-12-31', unit: 'USD/EUR', val: 1.13, filed: '2026-03-01' }),
      unit({ frame: 'CY2025', end: '2025-12-31', unit: 'AUD/EUR', val: 1.75, filed: '2026-02-01' }),
    ]);
    expect(resolved.get('CY2025')).toMatchObject({ unit: 'AUD/EUR', val: 1.75 });
  });

  it('resolves a tag reported under one unit exactly as before', () => {
    const units = [
      unit({ frame: 'CY2024', val: 100, filed: '2024-11-01' }),
      unit({ frame: 'CY2024', val: 200, filed: '2025-01-15' }),
      unit({ frame: 'CY2023', end: '2023-09-30', val: 90, tagIndex: 1 }),
    ];
    expect([...resolveFrameSeries(units)].map(([frame, u]) => [frame, u.val])).toEqual([
      ['CY2024', 200],
      ['CY2023', 90],
    ]);
  });

  it('returns an empty map when no unit carries a frame', () => {
    expect(resolveFrameSeries([unit({ unit: 'USD' }), unit({ unit: 'EUR' })]).size).toBe(0);
  });
});

describe('resolveFrameSeriesByUnit (#146)', () => {
  const FY2021 = { start: '2021-01-01', end: '2021-12-31' };

  it('resolves every unit key on its own, a unit with no frame included', () => {
    const byUnit = resolveFrameSeriesByUnit([
      unit({ frame: 'CY2024', unit: 'USD', val: 1 }),
      unit({ frame: 'CY2024', unit: 'EUR', val: 2 }),
      unit({ unit: 'pure', val: 3 }), // no frame
    ]);
    expect([...byUnit.keys()]).toEqual(['USD', 'EUR', 'pure']);
    expect(byUnit.get('USD')?.get('CY2024')?.val).toBe(1);
    expect(byUnit.get('EUR')?.get('CY2024')?.val).toBe(2);
    expect(byUnit.get('pure')?.size).toBe(0);
  });

  it('applies tag priority inside each unit, so a lower tag fills that unit’s gaps only', () => {
    const byUnit = resolveFrameSeriesByUnit([
      unit({ frame: 'CY2024', unit: 'USD', val: 10, tagIndex: 0 }),
      unit({ frame: 'CY2024', unit: 'USD', val: 11, tagIndex: 1 }),
      unit({ frame: 'CY2023', end: '2023-09-30', unit: 'EUR', val: 12, tagIndex: 1 }),
    ]);
    expect(byUnit.get('USD')?.get('CY2024')).toMatchObject({ val: 10, tag: 'Tag0' });
    expect([...(byUnit.get('USD')?.keys() ?? [])]).toEqual(['CY2024']);
    expect(byUnit.get('EUR')?.get('CY2023')).toMatchObject({ val: 12, tag: 'Tag1' });
  });

  it('keeps the proxy-holder twin inside the holder’s own unit', () => {
    const byUnit = resolveFrameSeriesByUnit([
      unit({ ...FY2021, form: 'DEF 14A', frame: 'CY2021', filed: '2026-04-08', val: 1 }),
      unit({ ...FY2021, unit: 'EUR', form: '10-K', frame: 'CY2021', filed: '2022-02-25', val: 2 }),
    ]);
    // No USD twin: the proxy value stands, never borrowed from the EUR 10-K.
    expect(byUnit.get('USD')?.get('CY2021')).toMatchObject({ form: 'DEF 14A', val: 1 });
    expect(byUnit.get('EUR')?.get('CY2021')).toMatchObject({ form: '10-K', val: 2 });
  });

  it('drops a coverage loser’s units along with the tag', () => {
    const byUnit = resolveFrameSeriesByUnit(
      [
        unit({ frame: 'CY2024', unit: 'EUR', tagIndex: 0 }),
        unit({ frame: 'CY2023', end: '2023-09-30', unit: 'EUR', tagIndex: 1 }),
        unit({ frame: 'CY2024', unit: 'EUR', tagIndex: 1 }),
        unit({ frame: 'CY2024', unit: 'USD', tagIndex: 0 }),
      ],
      'coverage',
    );
    expect([...byUnit.keys()]).toEqual(['EUR']);
    expect([...(byUnit.get('EUR')?.values() ?? [])].map((u) => u.tag)).toEqual(['Tag1', 'Tag1']);
  });
});

describe('rankSeriesUnits (#146)', () => {
  const series = (...frames: Array<[string, string]>) =>
    new Map(frames.map(([frame, end]) => [frame, { ...unit({ end }), frame }]));

  it('orders units by newest value, then framed periods, then name, leaving out empty ones', () => {
    const ranked = rankSeriesUnits(
      new Map([
        ['USD', series(['CY2024', '2024-12-31'])],
        ['pure', new Map()],
        ['JPY', series(['CY2025', '2025-12-31'])],
        ['EUR', series(['CY2024', '2024-12-31'], ['CY2023', '2023-12-31'])],
        ['AUD', series(['CY2024', '2024-12-31'])],
      ]),
    );
    expect(ranked).toEqual(['JPY', 'EUR', 'AUD', 'USD']);
  });

  it('returns no unit when nothing carried a frame', () => {
    expect(rankSeriesUnits(new Map([['USD', new Map()]]))).toEqual([]);
  });
});

describe('isQuarterlyForm (#142)', () => {
  it.each(['10-Q', '10-Q/A', '10-QT', '10-QT/A'])('treats %s as a quarterly report', (form) => {
    expect(isQuarterlyForm(form)).toBe(true);
  });
  it.each(['10-K', '10-KT', '8-K', 'DEF 14A', '20-F', '6-K'])(
    'treats %s as another form',
    (form) => {
      expect(isQuarterlyForm(form)).toBe(false);
    },
  );
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

  it('lets a lower tag fill the frames the leader does not report (priority ladder)', () => {
    const ladder: CompanyFactsResponse = {
      facts: {
        'us-gaap': {
          Revenues: {
            label: 'Revenues',
            units: { USD: [unit({ frame: 'CY2024', end: '2024-12-31', val: 500 })] },
          },
          SalesRevenueNet: {
            label: 'Sales Revenue, Net',
            units: {
              USD: [
                unit({ frame: 'CY2023', end: '2023-12-31', val: 400 }),
                unit({ frame: 'CY2024', end: '2024-12-31', val: 499 }),
              ],
            },
          },
        },
      },
    };
    const resolved = seriesFromCompanyFacts(ladder, 'us-gaap', ['Revenues', 'SalesRevenueNet']);
    expect(resolved?.series.map((s) => [s.frame, s.val])).toEqual([
      ['CY2024', 500],
      ['CY2023', 400],
    ]);
  });

  it('resolves a proxy-held annual frame to the 10-K fact (#123)', () => {
    const proxyHeld: CompanyFactsResponse = {
      facts: {
        'us-gaap': {
          NetIncomeLoss: {
            label: 'Net Income (Loss) Attributable to Parent',
            units: {
              USD: [
                unit({
                  start: '2021-01-01',
                  end: '2021-12-31',
                  accn: '0001193125-26-147704',
                  filed: '2026-04-08',
                  form: 'DEF 14A',
                  frame: 'CY2021',
                  val: 12_345_000_000,
                }),
                unit({
                  start: '2021-01-01',
                  end: '2021-12-31',
                  accn: '0000310158-22-000010',
                  filed: '2022-02-25',
                  form: '10-K',
                  val: 13_049_000_000,
                }),
              ],
            },
          },
        },
      },
    };
    const resolved = seriesFromCompanyFacts(proxyHeld, 'us-gaap', ['NetIncomeLoss']);
    expect(resolved?.series[0]).toMatchObject({
      frame: 'CY2021',
      form: '10-K',
      accn: '0000310158-22-000010',
      val: 13_049_000_000,
    });
  });

  it('names each value’s tag and lets the line follow the newest value (#125)', () => {
    /** NVIDIA's capex shape: the PP&E tag stops in 2020, the successor runs on. */
    const successor: CompanyFactsResponse = {
      facts: {
        'us-gaap': {
          PaymentsToAcquirePropertyPlantAndEquipment: {
            label: 'Payments to Acquire Property, Plant, and Equipment',
            description: 'PP&E only.',
            units: {
              USD: [
                unit({ frame: 'CY2019', end: '2020-01-26', val: 489_000_000 }),
                unit({ frame: 'CY2020', end: '2021-01-31', val: 1_128_000_000 }),
              ],
            },
          },
          PaymentsToAcquireProductiveAssets: {
            label: 'Payments to Acquire Productive Assets',
            description: 'Capex, software, and other intangibles.',
            units: {
              USD: [
                unit({ frame: 'CY2020', end: '2021-01-31', val: 1_130_000_000 }),
                unit({ frame: 'CY2025', end: '2026-01-25', val: 6_042_000_000 }),
              ],
            },
          },
        },
      },
    };
    const resolved = seriesFromCompanyFacts(successor, 'us-gaap', [
      'PaymentsToAcquirePropertyPlantAndEquipment',
      'PaymentsToAcquireProductiveAssets',
    ]);
    expect(resolved?.series.map((s) => [s.frame, s.val, s.tag])).toEqual([
      ['CY2025', 6_042_000_000, 'PaymentsToAcquireProductiveAssets'],
      ['CY2020', 1_128_000_000, 'PaymentsToAcquirePropertyPlantAndEquipment'],
      ['CY2019', 489_000_000, 'PaymentsToAcquirePropertyPlantAndEquipment'],
    ]);
    expect(resolved).toMatchObject({
      tag: 'PaymentsToAcquireProductiveAssets',
      label: 'Payments to Acquire Productive Assets',
      description: 'Capex, software, and other intangibles.',
      unit: 'USD',
    });
  });

  it('leaves the label empty when SEC serves the tag without one, never the raw tag', () => {
    const unlabeled: CompanyFactsResponse = {
      facts: {
        'us-gaap': {
          InterestExpenseNonoperating: {
            units: { USD: [unit({ frame: 'CY2025', end: '2025-12-31', val: 259 })] },
          },
        },
      },
    };
    const resolved = seriesFromCompanyFacts(unlabeled, 'us-gaap', ['InterestExpenseNonoperating']);
    expect(resolved?.tag).toBe('InterestExpenseNonoperating');
    expect(resolved?.label).toBe('');
  });

  it('reads a tag framed under two unit keys as one unit, never the later filing per frame (#146)', () => {
    // SAP's shape: PP&E framed in EUR (the reporting currency) and, for one
    // year, in a USD convenience translation filed after the EUR fact. Frames
    // compete within one unit, so the later USD filing no longer takes CY2017Q4I.
    const twoUnits: CompanyFactsResponse = {
      facts: {
        'ifrs-full': {
          PropertyPlantAndEquipment: {
            label: 'Property, plant and equipment',
            units: {
              EUR: [
                unit({ frame: 'CY2016Q4I', end: '2016-12-31', filed: '2018-02-28', val: 2_580 }),
                unit({ frame: 'CY2017Q4I', end: '2017-12-31', filed: '2018-02-28', val: 2_967 }),
              ],
              USD: [
                unit({ frame: 'CY2017Q4I', end: '2017-12-31', filed: '2019-02-28', val: 3_567 }),
              ],
            },
          },
        },
      },
    };
    const resolved = seriesFromCompanyFacts(twoUnits, 'ifrs-full', ['PropertyPlantAndEquipment']);
    expect(resolved?.series.map((s) => [s.frame, s.val, s.unit])).toEqual([
      ['CY2017Q4I', 2_967, 'EUR'],
      ['CY2016Q4I', 2_580, 'EUR'],
    ]);
    expect(resolved?.unit).toBe('EUR');
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
