/**
 * @fileoverview Tests for concept-map service — friendly name resolution and full concept listing.
 * @module tests/services/edgar/concept-map
 */

import { describe, expect, it } from 'vitest';
import {
  describeUnknownConcepts,
  findUnknownConcept,
  getAllConcepts,
  listConcepts,
  resolveConcept,
  resolveConceptTarget,
  searchConcepts,
  unknownConceptHint,
} from '@/services/edgar/concept-map.js';

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

  it('covers both ASC 606 assessed-tax variants, net first (#98)', () => {
    // A filer presenting revenue gross of excise/sales tax reports only the
    // Including variant. Without it the walk fell through to tags SEC retired in
    // 2018 and returned a series that stops there. Excluding stays at index 0 so
    // a filer reporting both still resolves to the net total (#44 tag priority).
    const tags = resolveConcept('revenue')!.tags;
    expect(tags).toEqual([
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'SalesRevenueNet',
      'SalesRevenueGoodsNet',
    ]);
  });

  it('keeps the Including variant behind Revenues (#98)', () => {
    // The two disagree for filers that present gross sales and net-of-excise
    // sales under separate elements. Ahead of `Revenues` the Including variant
    // takes over the frames `Revenues` already covered and switches the series
    // definition partway through its history; behind it, it only fills frames no
    // current tag reports, which is the fall-through this concept exists to stop.
    const tags = resolveConcept('revenue')!.tags;
    expect(tags.indexOf('Revenues')).toBeLessThan(
      tags.indexOf('RevenueFromContractWithCustomerIncludingAssessedTax'),
    );
  });

  it('keeps every retired tag behind every current one (#98)', () => {
    // A retired tag is a last-resort fallback for filers whose history predates
    // its replacement. If one ever preceded a current tag it would win the
    // priority walk outright and pin the series to a dead element.
    const retired = new Set(['SalesRevenueNet', 'SalesRevenueGoodsNet', 'CostOfGoodsSold']);
    for (const [name, mapping] of Object.entries(getAllConcepts())) {
      const firstRetired = mapping.tags.findIndex((t) => retired.has(t));
      if (firstRetired === -1) continue;
      const currentAfter = mapping.tags.slice(firstRetired + 1).filter((t) => !retired.has(t));
      expect(currentAfter, `${name} lists a current tag after a retired one`).toEqual([]);
    }
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

  it('maps every statement group, not just the income statement (#99)', () => {
    // The IFRS roster used to be revenue/net_income/assets, so a caller asking
    // for a balance-sheet, cash-flow, or per-share line under ifrs-full got a
    // gap for a concept the filer does in fact report.
    const expected: Record<string, string> = {
      // balance sheet
      liabilities: 'Liabilities',
      cash: 'CashAndCashEquivalents',
      debt: 'LongtermBorrowings',
      current_assets: 'CurrentAssets',
      current_liabilities: 'CurrentLiabilities',
      inventory: 'Inventories',
      accounts_receivable: 'CurrentTradeReceivables',
      accounts_payable: 'TradeAndOtherCurrentPayables',
      goodwill: 'Goodwill',
      intangible_assets: 'IntangibleAssetsOtherThanGoodwill',
      // income statement
      operating_income: 'ProfitLossFromOperatingActivities',
      gross_profit: 'GrossProfit',
      cogs: 'CostOfSales',
      rd_expense: 'ResearchAndDevelopmentExpense',
      sga_expense: 'SellingGeneralAndAdministrativeExpense',
      stock_based_compensation: 'ExpenseFromSharebasedPaymentTransactionsWithEmployees',
      // cash flow
      operating_cash_flow: 'CashFlowsFromUsedInOperatingActivities',
      investing_cash_flow: 'CashFlowsFromUsedInInvestingActivities',
      financing_cash_flow: 'CashFlowsFromUsedInFinancingActivities',
      capex: 'PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
      dividends_paid: 'DividendsPaid',
      share_repurchases: 'PaymentsToAcquireOrRedeemEntitysShares',
      depreciation_amortization: 'DepreciationAndAmortisationExpense',
      // per share
      eps_basic: 'BasicEarningsLossPerShare',
      eps_diluted: 'DilutedEarningsLossPerShare',
    };
    for (const [concept, tag] of Object.entries(expected)) {
      expect(resolveConcept(concept)?.ifrsTags?.[0], `${concept} ifrsTags[0]`).toBe(tag);
    }
  });

  it('equity prefers the parent-attributable line, mirroring its us-gaap ordering (#99)', () => {
    // us-gaap tags[0] is StockholdersEquity (parent only) with the
    // NCI-inclusive total as a relatedTag; the IFRS ordering has to match or the
    // two taxonomies would answer the same question with different quantities.
    expect(resolveConcept('equity')?.ifrsTags).toEqual([
      'EquityAttributableToOwnersOfParent',
      'Equity',
    ]);
  });

  it('interest_expense prefers the exact tag over the broader IFRS caption (#99)', () => {
    // FinanceCosts also carries discount unwinding and other financing charges,
    // so it is a fallback for filers with no separate interest line — never the
    // winner when the filer reports both.
    expect(resolveConcept('interest_expense')?.ifrsTags).toEqual([
      'InterestExpense',
      'FinanceCosts',
    ]);
  });

  it('accounts_receivable prefers the trade-only caption (#99)', () => {
    // us-gaap tags[0] is AccountsReceivableNetCurrent (trade only). The combined
    // IFRS caption also carries prepayments, deposits, and tax receivables and
    // runs roughly half again as large for a filer reporting both, so it belongs
    // behind the trade-only element, not ahead of it.
    expect(resolveConcept('accounts_receivable')?.ifrsTags).toEqual([
      'CurrentTradeReceivables',
      'TradeAndOtherCurrentReceivables',
    ]);
  });

  it('share_repurchases prefers the financing outflow over the treasury-only line (#99)', () => {
    // A filer that cancels repurchased shares rather than holding them tags
    // PurchaseOfTreasuryShares zero while running a buyback, so leading with it
    // would report zero repurchases for a real one.
    expect(resolveConcept('share_repurchases')?.ifrsTags).toEqual([
      'PaymentsToAcquireOrRedeemEntitysShares',
      'PurchaseOfTreasuryShares',
    ]);
  });

  it('leaves notes_payable unmapped rather than pointing it at a borrowings total (#99)', () => {
    // IFRS presents borrowings as one caption and has no element for the
    // notes/debt split, so the concept is a gap under ifrs-full by design.
    expect(resolveConcept('notes_payable')?.ifrsTags).toBeUndefined();
  });
});

describe('successor tags behind the current leaders (#125)', () => {
  it('appends the productive-assets successor behind the PP&E-only capex tag', () => {
    // The successor also counts software and intangibles, so it only fills the
    // frames the PP&E tag does not report.
    expect(resolveConcept('capex')?.tags).toEqual([
      'PaymentsToAcquirePropertyPlantAndEquipment',
      'PaymentsToAcquireProductiveAssets',
    ]);
  });

  it('appends the nonoperating interest caption behind both existing interest tags', () => {
    expect(resolveConcept('interest_expense')?.tags).toEqual([
      'InterestExpense',
      'InterestExpenseDebt',
      'InterestExpenseNonoperating',
    ]);
  });

  it('leaves the capex IFRS counterpart unchanged (interest_expense is pinned under #99)', () => {
    expect(resolveConcept('capex')?.ifrsTags).toEqual([
      'PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
    ]);
  });
});

describe('ppe_net, pretax_income, and shares_diluted (#130)', () => {
  it('maps net PP&E as an instant balance-sheet line, keeping the lease-inclusive total out of tags', () => {
    expect(resolveConcept('ppe_net')).toMatchObject({
      group: 'balance_sheet',
      tags: ['PropertyPlantAndEquipmentNet'],
      ifrsTags: ['PropertyPlantAndEquipment'],
      taxonomy: 'us-gaap',
      unit: 'USD',
    });
    expect(resolveConcept('ppe_net')?.relatedTags?.map((r) => r.tag)).toEqual([
      'PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization',
    ]);
    expect(resolveConcept('ppe_net')?.relatedTags?.[0]?.note).toMatch(/finance-lease/i);
  });

  it('maps pre-tax income as a two-tag ladder, the equity-method-inclusive caption first', () => {
    expect(resolveConcept('pretax_income')).toMatchObject({
      group: 'income_statement',
      tags: [
        'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
        'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments',
      ],
      ifrsTags: ['ProfitLossBeforeTax'],
      unit: 'USD',
    });
  });

  it('maps the diluted share count beside the EPS it divides, in the shares unit', () => {
    expect(resolveConcept('shares_diluted')).toMatchObject({
      group: 'per_share',
      tags: ['WeightedAverageNumberOfDilutedSharesOutstanding'],
      ifrsTags: ['AdjustedWeightedAverageShares'],
      taxonomy: 'us-gaap',
      unit: 'shares',
    });
  });

  it('lists all three under ifrs-full and resolves them to their IFRS leads', () => {
    const names = searchConcepts('', 'ifrs-full').map((r) => r.name);
    for (const concept of ['ppe_net', 'pretax_income', 'shares_diluted']) {
      expect(names).toContain(concept);
    }
    expect(resolveConceptTarget('ppe_net', 'ifrs-full').tags).toEqual([
      'PropertyPlantAndEquipment',
    ]);
    expect(resolveConceptTarget('pretax_income', 'ifrs-full').tags).toEqual([
      'ProfitLossBeforeTax',
    ]);
    expect(resolveConceptTarget('shares_diluted', 'ifrs-full').tags).toEqual([
      'AdjustedWeightedAverageShares',
    ]);
  });

  it('brings the catalog to 36 concepts', () => {
    expect(listConcepts()).toHaveLength(36);
  });
});

describe('resolveConceptTarget — tag selection (#101)', () => {
  it('gives stock_based_compensation both IFRS elements, employee first', () => {
    // Seven of twelve sampled 20-F filers report the employee element as their
    // real line, so it keeps index 0; TSM and HSBC never tag it and had no value
    // at all until the IFRS 2.51(a) total joined the array.
    expect(resolveConceptTarget('stock_based_compensation', 'ifrs-full').tags).toEqual([
      'ExpenseFromSharebasedPaymentTransactionsWithEmployees',
      'ExpenseFromSharebasedPaymentTransactionsInWhichGoodsOrServicesReceivedDidNotQualifyForRecognitionAsAssets',
    ]);
  });

  it('selects that concept’s IFRS tags by coverage, since the two invert between filers', () => {
    expect(resolveConceptTarget('stock_based_compensation', 'ifrs-full').tagSelection).toBe(
      'coverage',
    );
  });

  it('keeps the us-gaap side of the same concept on declared priority', () => {
    // AllocatedShareBasedCompensationExpense is the disaggregated line and
    // out-covers the total for filers including Alphabet, IBM, Tesla, and P&G,
    // so coverage there would demote ShareBasedCompensation.
    const target = resolveConceptTarget('stock_based_compensation', 'us-gaap');
    expect(target.tags[0]).toBe('ShareBasedCompensation');
    expect(target.tagSelection).toBe('priority');
  });

  it('leaves every other concept on declared priority, under both taxonomies', () => {
    // Coverage ranks a retired tag or a differently-defined sibling ahead of the
    // preferred total whenever the filer maintained it longer — Molson Coors
    // tags eleven years under a 2018-retired revenue element — so it must stay
    // opt-in per concept rather than spreading.
    for (const entry of listConcepts()) {
      if (entry.name === 'stock_based_compensation') continue;
      for (const taxonomy of ['us-gaap', 'ifrs-full'] as const) {
        expect(
          resolveConceptTarget(entry.name, taxonomy).tagSelection,
          `${entry.name} / ${taxonomy}`,
        ).toBe('priority');
      }
    }
  });

  it('treats a raw XBRL tag as a single-tag priority lookup', () => {
    expect(resolveConceptTarget('AccountsPayableCurrent', 'ifrs-full')).toMatchObject({
      tags: ['AccountsPayableCurrent'],
      tagSelection: 'priority',
    });
  });
});

describe('resolveConcept — alternate-definition relatedTags (#36)', () => {
  it('cash surfaces the restricted-cash-inclusive alternate', () => {
    const mapping = resolveConcept('cash');
    expect(mapping?.relatedTags).toBeDefined();
    expect(mapping!.relatedTags!.map((r) => r.tag)).toContain(
      'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
    );
    for (const r of mapping!.relatedTags!) expect(r.note).toBeTruthy();
  });

  it('equity surfaces the noncontrolling-interest-inclusive alternate', () => {
    const mapping = resolveConcept('equity');
    expect(mapping!.relatedTags!.map((r) => r.tag)).toContain(
      'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
    );
  });

  it('operating/investing/financing cash flow surface their continuing-operations variant', () => {
    for (const name of ['operating_cash_flow', 'investing_cash_flow', 'financing_cash_flow']) {
      const mapping = resolveConcept(name);
      expect(mapping!.relatedTags, `${name} missing relatedTags`).toBeDefined();
      expect(mapping!.relatedTags!.some((r) => /ContinuingOperations$/.test(r.tag))).toBe(true);
    }
  });

  it('keeps alternate tags OUT of tags[] so get_financials never conflates them', () => {
    // The whole reason relatedTags is separate from tags: alternates carry a
    // different definition and must not enter get_financials' fallback chain.
    const cash = resolveConcept('cash');
    expect(cash!.tags).toEqual(['CashAndCashEquivalentsAtCarryingValue']);
    expect(cash!.tags).not.toContain(
      'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
    );
  });

  it('same-meaning multi-tag concepts have no relatedTags (revenue, assets)', () => {
    expect(resolveConcept('revenue')?.relatedTags).toBeUndefined();
    expect(resolveConcept('assets')?.relatedTags).toBeUndefined();
  });

  it('reverse-lookup: searching an alternate tag finds its base concept', () => {
    const results = searchConcepts('CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents');
    expect(results.some((r) => r.name === 'cash')).toBe(true);
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

  it('includes the balance-sheet and cash-flow concepts under ifrs-full (#99)', () => {
    const names = searchConcepts('', 'ifrs-full').map((r) => r.name);
    for (const concept of ['equity', 'cash', 'inventory', 'operating_cash_flow', 'eps_diluted']) {
      expect(names, `${concept} missing from the ifrs-full roster`).toContain(concept);
    }
  });

  it('excludes concepts with no confirmed IFRS tag when taxonomy is ifrs-full', () => {
    const names = searchConcepts('', 'ifrs-full').map((r) => r.name);
    // notes_payable: no IFRS element for the notes/debt split.
    // shares_outstanding: a dei concept, outside the financial taxonomies.
    expect(names).not.toContain('notes_payable');
    expect(names).not.toContain('shares_outstanding');
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

describe('findUnknownConcept (#128)', () => {
  it('passes every catalog name in any case, separator, or padding form', () => {
    for (const { name } of listConcepts()) {
      const spaced = name.replace(/_/g, ' ');
      for (const form of [
        name,
        name.toUpperCase(),
        spaced,
        name.replace(/_/g, '-'),
        ` ${spaced.toUpperCase()}\t`,
      ]) {
        expect(findUnknownConcept(form), JSON.stringify(form)).toBeUndefined();
      }
    }
  });

  it('passes anything shaped like an XBRL element name, under any taxonomy and deprecated ones too', () => {
    for (const tag of [
      'NetIncomeLoss',
      'Revenues',
      'SalesRevenueNet',
      'ProfitLoss',
      'EntityCommonStockSharesOutstanding',
      'A',
      'Tag2024',
      ' NetIncomeLoss ',
    ]) {
      expect(findUnknownConcept(tag), tag).toBeUndefined();
    }
  });

  it('flags lowercase, prefixed, punctuated, path-shaped, and blank input', () => {
    for (const input of [
      'netincomeloss',
      'us-gaap:NetIncomeLoss',
      'Net Income!',
      '../submissions/CIK0000320193',
      'NetIncome/Loss',
      '2024Revenue',
      '',
      '   ',
    ]) {
      expect(findUnknownConcept(input), JSON.stringify(input)).toBeDefined();
    }
  });

  it('echoes the input trimmed', () => {
    expect(findUnknownConcept('  total_debt ')?.concept).toBe('total_debt');
  });

  it('answers a standard combination with its formula instead of suggestions', () => {
    expect(findUnknownConcept('free_cash_flow')).toMatchObject({
      derivation: 'operating_cash_flow − capex',
      suggestions: [],
    });
    expect(findUnknownConcept('Free Cash Flow')?.derivation).toBe('operating_cash_flow − capex');
    expect(findUnknownConcept('EBITDA')?.derivation).toBe(
      'operating_income + depreciation_amortization',
    );
    expect(findUnknownConcept('working-capital')?.derivation).toBe(
      'current_assets − current_liabilities',
    );
    const fcf = findUnknownConcept('free_cash_flow');
    expect(fcf && unknownConceptHint(fcf)).toMatch(
      /^Derive it as operating_cash_flow − capex from those concepts\. .*secedgar_search_concepts/,
    );
  });

  it('builds every formula from catalog names, and no formula shadows one', () => {
    const catalog = new Set(listConcepts().map((c) => c.name));
    for (const name of ['free_cash_flow', 'ebitda', 'working_capital']) {
      expect(catalog.has(name), `${name} is a catalog name`).toBe(false);
      const operands = findUnknownConcept(name)?.derivation?.split(/ [−+] /) ?? [];
      expect(operands).toHaveLength(2);
      for (const operand of operands) expect(catalog.has(operand), operand).toBe(true);
    }
  });

  it('carries no formula for total_debt, whose parts the catalog cannot cover', () => {
    expect(findUnknownConcept('total_debt')?.derivation).toBeUndefined();
    expect(findUnknownConcept('total_debt')?.suggestions).toContain('debt');
  });

  it('suggests capex for capital_expenditures, reached through its label', () => {
    expect(findUnknownConcept('capital_expenditures')?.suggestions).toEqual(['capex']);
    expect(findUnknownConcept('long_term_debt')?.suggestions).toEqual(['debt']);
  });

  it('suggests nothing below the threshold, and still names secedgar_search_concepts', () => {
    const fcf = findUnknownConcept('fcf');
    expect(fcf?.suggestions).toEqual([]);
    expect(fcf && unknownConceptHint(fcf)).toMatch(
      /^List every supported name with secedgar_search_concepts/,
    );
    expect(findUnknownConcept('../submissions/CIK0000320193')?.suggestions).toEqual([]);
  });

  it('caps suggestions at three, highest score first, ties broken by name', () => {
    // The three cash-flow totals score identically against "cash_flow".
    expect(findUnknownConcept('cash_flow')?.suggestions).toEqual([
      'financing_cash_flow',
      'investing_cash_flow',
      'operating_cash_flow',
    ]);
    expect(findUnknownConcept('netincomeloss')?.suggestions).toEqual([
      'net_income',
      'operating_income',
      'pretax_income',
    ]);
  });

  it('suggests the newest catalog entries like any other (#130)', () => {
    expect(findUnknownConcept('pretax')?.suggestions).toEqual(['pretax_income']);
    expect(findUnknownConcept('ppe')?.suggestions).toEqual(['ppe_net']);
    expect(findUnknownConcept('diluted_shares')?.suggestions[0]).toBe('shares_diluted');
  });
});

describe('describeUnknownConcepts (#128)', () => {
  it('words one concept with its own hint', () => {
    const unknown = findUnknownConcept('total_debt');
    expect(unknown).toBeDefined();
    expect(describeUnknownConcepts(unknown ? [unknown] : [])).toEqual({
      message: "'total_debt' is neither a supported concept name nor an XBRL tag.",
      hint: 'Closest supported names are assets, debt, liabilities. List every supported name with secedgar_search_concepts; a raw XBRL tag is an element name in UpperCamelCase, such as NetIncomeLoss.',
    });
  });

  it('names each concept in turn when several are unknown', () => {
    const unknowns = ['free_cash_flow', 'total_debt', 'fcf'].flatMap((c) => {
      const u = findUnknownConcept(c);
      return u ? [u] : [];
    });
    const { message, hint } = describeUnknownConcepts(unknowns);
    expect(message).toBe(
      "None of the requested concepts is a supported concept name or an XBRL tag: 'free_cash_flow', 'total_debt', 'fcf'.",
    );
    expect(hint).toBe(
      'free_cash_flow — derive it as operating_cash_flow − capex from those concepts; total_debt — closest supported names are assets, debt, liabilities; fcf — no supported name is close. List every supported name with secedgar_search_concepts; a raw XBRL tag is an element name in UpperCamelCase, such as NetIncomeLoss.',
    );
  });
});

describe('trimming (#128)', () => {
  it('resolves a padded friendly name', () => {
    expect(resolveConcept(' revenue\n')).toBe(resolveConcept('revenue'));
  });

  it('trims a raw tag before it becomes the lookup key', () => {
    expect(resolveConceptTarget('  NetIncomeLoss ', 'us-gaap')).toMatchObject({
      label: 'NetIncomeLoss',
      tags: ['NetIncomeLoss'],
    });
  });
});

describe('unknown-concept wording (#128)', () => {
  it('names a single suggestion in the singular', () => {
    const unknown = findUnknownConcept('capital_expenditures');
    expect(unknown && unknownConceptHint(unknown)).toMatch(
      /^The closest supported name is capex\. List every supported name/,
    );
  });

  it('says an empty concept is empty rather than quoting nothing', () => {
    const unknown = findUnknownConcept('   ');
    expect(describeUnknownConcepts(unknown ? [unknown] : []).message).toBe(
      'An empty concept is neither a supported concept name nor an XBRL tag.',
    );
  });
});
