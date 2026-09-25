/**
 * @fileoverview Static mapping of friendly financial concept names to XBRL tags.
 * @module services/edgar/concept-map
 */

import { trigramSimilarity } from './trigram-similarity.js';
import type { ConceptMapping, ConceptTaxonomy, TagSelection } from './types.js';

/**
 * Friendly name → XBRL tag mapping. Tags are tried in order for companyconcept
 * lookups, and index 0 is the preferred total when two tags report the same
 * frame (#44).
 *
 * `ifrsTags` is the `ifrs-full` counterpart, used when a caller asks for that
 * taxonomy. Every entry is confirmed present in the live companyfacts of at
 * least one 20-F IFRS filer — an IFRS element existing in the taxonomy is not
 * evidence that filers tag it. A concept with no confirmed IFRS element carries
 * no `ifrsTags` and is reported as a gap rather than mapped to a guess.
 */
const CONCEPT_MAP: Record<string, ConceptMapping> = {
  revenue: {
    group: 'income_statement',
    /**
     * ASC 606 splits the top line by whether assessed sales/excise tax is included.
     * The Including variant is the reported total for food, beverage, and tobacco
     * filers, whose ASC 606 election presents revenue gross of tax; without it those
     * filers fall through to the deprecated tags at the end of the array and return
     * a series that stops in 2018 (#98).
     *
     * It sits behind `Revenues`, not ahead of it, because the two do not agree for
     * every filer and `Revenues` was already winning those frames: a brewer tags
     * gross sales under one element and net-of-excise sales under the other, so
     * promoting the Including variant over `Revenues` swaps the definition partway
     * back through the history and prints a year-over-year step that is a tag
     * change, not a business fact. Behind `Revenues` it only fills frames no
     * current tag covers, which is the case #98 is about. Excluding stays at index
     * 0 so a filer reporting both variants still resolves to the net total (#44).
     */
    tags: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'SalesRevenueNet',
      'SalesRevenueGoodsNet',
    ],
    /**
     * IFRS tag verified against Spotify (SPOT, 20-F IFRS filer).
     * Tag-array order is semantically meaningful — index 0 is the preferred total.
     * `Revenue` (IAS 1 top-line total) leads over `RevenueFromContractsWithCustomers`
     * (an IFRS 15 component line that Spotify also reports for CY2024 at a fraction
     * of the consolidated total). The priority-aware frame dedup in get-financials
     * enforces this order when both tags report the same frame (#44).
     */
    ifrsTags: ['Revenue', 'RevenueFromContractsWithCustomers'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Revenue',
  },
  net_income: {
    group: 'income_statement',
    tags: ['NetIncomeLoss'],
    // IFRS tag verified against Spotify (SPOT, 20-F IFRS filer).
    ifrsTags: ['ProfitLoss'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Net Income (Loss)',
  },
  operating_income: {
    group: 'income_statement',
    tags: ['OperatingIncomeLoss'],
    ifrsTags: ['ProfitLossFromOperatingActivities'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Operating Income (Loss)',
  },
  gross_profit: {
    group: 'income_statement',
    tags: ['GrossProfit'],
    ifrsTags: ['GrossProfit'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Gross Profit',
  },
  eps_basic: {
    group: 'per_share',
    tags: ['EarningsPerShareBasic'],
    ifrsTags: ['BasicEarningsLossPerShare'],
    taxonomy: 'us-gaap',
    unit: 'USD/shares',
    label: 'Earnings Per Share (Basic)',
  },
  eps_diluted: {
    group: 'per_share',
    tags: ['EarningsPerShareDiluted'],
    ifrsTags: ['DilutedEarningsLossPerShare'],
    taxonomy: 'us-gaap',
    unit: 'USD/shares',
    label: 'Earnings Per Share (Diluted)',
  },
  shares_diluted: {
    group: 'per_share',
    // The EPS denominator, so it sits with the EPS lines it divides. A duration
    // concept (the period's weighted average), reported in the `shares` unit.
    tags: ['WeightedAverageNumberOfDilutedSharesOutstanding'],
    // Confirmed in the 20-F companyfacts of Spotify (SPOT) and SAP.
    ifrsTags: ['AdjustedWeightedAverageShares'],
    taxonomy: 'us-gaap',
    unit: 'shares',
    label: 'Weighted-Average Diluted Shares',
  },
  assets: {
    group: 'balance_sheet',
    tags: ['Assets'],
    // IFRS tag verified against Spotify (SPOT, 20-F IFRS filer).
    ifrsTags: ['Assets'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Total Assets',
  },
  liabilities: {
    group: 'balance_sheet',
    tags: ['Liabilities'],
    ifrsTags: ['Liabilities'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Total Liabilities',
  },
  equity: {
    group: 'balance_sheet',
    tags: ['StockholdersEquity'],
    relatedTags: [
      {
        tag: 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
        note: 'Total equity including noncontrolling interests; the primary line for filers with material minority interests.',
      },
    ],
    /**
     * Mirrors the us-gaap split: `EquityAttributableToOwnersOfParent` is the IFRS
     * counterpart of `StockholdersEquity` (parent-attributable) and leads, with the
     * `Equity` roll-up — which includes noncontrolling interests, the counterpart of
     * the relatedTag above — as the fallback for filers that tag only the total.
     */
    ifrsTags: ['EquityAttributableToOwnersOfParent', 'Equity'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: "Stockholders' Equity",
  },
  cash: {
    group: 'balance_sheet',
    tags: ['CashAndCashEquivalentsAtCarryingValue'],
    relatedTags: [
      {
        tag: 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
        note: 'Total including restricted cash (the ASU 2016-18 cash-flow reconciliation total); the primary line for many banks and filers with restricted cash.',
      },
    ],
    ifrsTags: ['CashAndCashEquivalents'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Cash and Cash Equivalents',
  },
  debt: {
    group: 'balance_sheet',
    tags: ['LongTermDebt', 'LongTermDebtNoncurrent'],
    /**
     * `LongtermBorrowings` only — the IFRS `Borrowings` element is total borrowings
     * including the current portion, a different quantity from the long-term line
     * this concept means, so it is not used as a fallback.
     */
    ifrsTags: ['LongtermBorrowings'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Long-Term Debt',
  },
  shares_outstanding: {
    group: 'entity_info',
    tags: ['EntityCommonStockSharesOutstanding'],
    taxonomy: 'dei',
    unit: 'shares',
    label: 'Shares Outstanding',
  },
  operating_cash_flow: {
    group: 'cash_flow',
    tags: ['NetCashProvidedByUsedInOperatingActivities'],
    relatedTags: [
      {
        tag: 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
        note: 'Continuing operations only — excludes discontinued operations; some filers report only this variant.',
      },
    ],
    ifrsTags: ['CashFlowsFromUsedInOperatingActivities'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Operating Cash Flow',
  },
  capex: {
    group: 'cash_flow',
    /**
     * `PaymentsToAcquireProductiveAssets` is the successor several large filers
     * moved to (NVIDIA, Amazon, and Visa report capex only under it). It sits
     * behind the PP&E tag, not ahead of it: it also counts software and other
     * intangibles, and of the 75 filers reporting both for CY2025, 36 report a
     * larger productive-assets figure. Behind the leader it only fills frames the
     * PP&E-only tag does not report (#125, the #98 precedent).
     */
    tags: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
    ifrsTags: ['PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Capital Expenditures',
  },
  depreciation_amortization: {
    group: 'cash_flow',
    tags: ['DepreciationDepletionAndAmortization', 'DepreciationAndAmortization', 'Depreciation'],
    /**
     * Exact counterpart first, approximations behind it: the combined D&A line
     * matching `DepreciationDepletionAndAmortization` at index 0 above, then the
     * variant that folds impairment in with it, then depreciation alone. The
     * middle one runs wider than both its neighbours — it is a fallback for filers
     * that report no separate D&A line, not a widest-first lead. IFRS filers split
     * across all three rather than converging on one, so all three are needed for
     * cross-filer coverage.
     */
    ifrsTags: [
      'DepreciationAndAmortisationExpense',
      'DepreciationAmortisationAndImpairmentLossReversalOfImpairmentLossRecognisedInProfitOrLoss',
      'DepreciationExpense',
    ],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Depreciation & Amortization',
  },
  // Distinct from `debt` (which targets long-term debt directly). `notes_payable` prefers
  // the notes-specific tags and only falls back to LongTermDebt for filers that report it
  // there exclusively.
  //
  // No `ifrsTags`: IFRS presents borrowings as one caption and has no balance-sheet
  // element for the notes/debt split this concept expresses. Left unmapped rather than
  // pointed at a borrowings total that would silently answer a different question — the
  // concept comes back as a gap under `ifrs-full`, which is the honest result.
  notes_payable: {
    group: 'balance_sheet',
    tags: ['LongTermNotesPayable', 'NotesPayable', 'LongTermDebt'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Notes Payable',
  },

  // Income statement
  cogs: {
    group: 'income_statement',
    /**
     * `CostOfGoodsSold` was deprecated in the 2018 taxonomy and survives only as
     * the last fallback, for filers whose history predates the replacement tags.
     * When it wins, the resolved series carries SEC's `(Deprecated …)` label and
     * the reading tools raise a staleness caveat off it (#98).
     */
    tags: ['CostOfGoodsAndServicesSold', 'CostOfRevenue', 'CostOfGoodsSold'],
    ifrsTags: ['CostOfSales'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Cost of Goods Sold',
  },
  rd_expense: {
    group: 'income_statement',
    tags: ['ResearchAndDevelopmentExpense'],
    // The element name is identical in both taxonomies, but the lookup is
    // namespace-scoped, so ifrs-full needs its own entry to resolve.
    ifrsTags: ['ResearchAndDevelopmentExpense'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Research & Development Expense',
  },
  sga_expense: {
    group: 'income_statement',
    tags: ['SellingGeneralAndAdministrativeExpense'],
    // Same element name in ifrs-full, and IFRS filers do report the combined
    // caption. The narrower `AdministrativeExpense` is deliberately not a
    // fallback — it excludes selling costs and would understate the line.
    ifrsTags: ['SellingGeneralAndAdministrativeExpense'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Selling, General & Administrative Expense',
  },
  interest_expense: {
    group: 'income_statement',
    /**
     * `InterestExpenseNonoperating` is the income-statement caption filers moved
     * to (NVIDIA and Microsoft report interest expense only under it). It sits
     * last: it disagrees with `InterestExpense` for 26 of 53 CY2025 filers
     * reporting both and with `InterestExpenseDebt` for 47 of 67, so behind them
     * it only fills frames neither covers and moves no value either resolves
     * (#125, the #98 precedent).
     */
    tags: ['InterestExpense', 'InterestExpenseDebt', 'InterestExpenseNonoperating'],
    /**
     * `InterestExpense` leads because it is the exact counterpart of the us-gaap
     * tag. `FinanceCosts` is the IAS 1 income-statement caption and is broader —
     * it also carries discount unwinding and other financing charges — so it is
     * the fallback for filers that report no separate interest line, not the
     * preferred total. A filer reporting both resolves to the narrower, exact one.
     */
    ifrsTags: ['InterestExpense', 'FinanceCosts'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Interest Expense',
  },
  pretax_income: {
    group: 'income_statement',
    /**
     * A priority ladder. The first tag is the face-of-statement pre-tax line; the
     * second excludes equity-method income, and 217 of the 381 CY2025 filers
     * reporting it report only it. Of the 164 reporting both, 108 agree, so the
     * statement line leads and the narrower one fills the frames it lacks.
     */
    tags: [
      'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
      'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments',
    ],
    // Confirmed in the 20-F companyfacts of Spotify (SPOT) and SAP.
    ifrsTags: ['ProfitLossBeforeTax'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Pre-Tax Income (Loss)',
  },
  tax_expense: {
    group: 'income_statement',
    tags: ['IncomeTaxExpenseBenefit'],
    /**
     * IFRS names its income-statement tax caption for continuing operations
     * because IAS 1 presents discontinued operations net of tax on a separate
     * line — so this element is the whole tax expense shown on the face of the
     * statement, not a partial one. It is the only tax element IFRS filers tag.
     */
    ifrsTags: ['IncomeTaxExpenseContinuingOperations'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Income Tax Expense (Benefit)',
  },
  stock_based_compensation: {
    group: 'income_statement',
    tags: ['ShareBasedCompensation', 'AllocatedShareBasedCompensationExpense'],
    /**
     * The only concept whose IFRS tags are alternates rather than a priority
     * ladder, so it is the only one carrying `ifrsTagSelection: 'coverage'`.
     *
     * IFRS 2 filers split between the employee-scheme element and the IFRS 2.51(a)
     * expense total, and the two invert between filers: SAP reports the total as
     * its real line (an 11-period series reaching EUR 1,695M) and the employee
     * element as a two-period fringe worth EUR 46M, while Sanofi reports the exact
     * opposite (employee element EUR 245M across CY2015-CY2022, total a fringe
     * under EUR 2M across CY2016-CY2019). No fixed order is right for both: with
     * the employee element leading, SAP's series switches definition mid-history;
     * with the total leading, four of Sanofi's years collapse to a hundredth of
     * the reported expense. TSM and HSBC never tag the employee element and had no
     * value at all under a single-tag mapping (#101).
     *
     * The equity-settled split of the total is deliberately absent. Every filer
     * checked that tags it also tags the total, at or below it, so it would only
     * ever contend for a frame the total already covers — and the map's rule is
     * that an element earns a place by being some filer's real line, not by
     * existing (#99).
     *
     * Coverage picks the right one in both directions here because the fringe
     * disclosures are short: 2 periods against 11 for SAP, 4 against 8 for
     * Sanofi. It stays scoped to `ifrsTags` because the us-gaap pair is not
     * alternates — `AllocatedShareBasedCompensationExpense` is the disaggregated
     * line and out-covers `ShareBasedCompensation` for filers including Alphabet,
     * IBM, Tesla, and P&G, so coverage there would demote the total.
     */
    ifrsTags: [
      'ExpenseFromSharebasedPaymentTransactionsWithEmployees',
      'ExpenseFromSharebasedPaymentTransactionsInWhichGoodsOrServicesReceivedDidNotQualifyForRecognitionAsAssets',
    ],
    ifrsTagSelection: 'coverage',
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Stock-Based Compensation',
  },

  // Balance sheet
  current_assets: {
    group: 'balance_sheet',
    tags: ['AssetsCurrent'],
    ifrsTags: ['CurrentAssets'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Current Assets',
  },
  current_liabilities: {
    group: 'balance_sheet',
    tags: ['LiabilitiesCurrent'],
    ifrsTags: ['CurrentLiabilities'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Current Liabilities',
  },
  inventory: {
    group: 'balance_sheet',
    tags: ['InventoryNet', 'InventoryGross'],
    ifrsTags: ['Inventories'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Inventory',
  },
  accounts_receivable: {
    group: 'balance_sheet',
    tags: [
      'AccountsReceivableNetCurrent',
      'ReceivablesNetCurrent',
      'AccountsReceivableGrossCurrent',
    ],
    /**
     * IFRS filers split between a trade-only caption and the combined
     * trade-and-other one; both are needed for cross-filer coverage.
     * `CurrentTradeReceivables` leads because it is the counterpart of
     * `AccountsReceivableNetCurrent` at index 0 above — the combined caption also
     * carries prepayments, deposits, and tax receivables, and for a filer
     * reporting both it runs roughly half again as large, so leading with it
     * would answer the same concept with a different quantity under each taxonomy.
     */
    ifrsTags: ['CurrentTradeReceivables', 'TradeAndOtherCurrentReceivables'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Accounts Receivable (Net)',
  },
  accounts_payable: {
    group: 'balance_sheet',
    tags: ['AccountsPayableCurrent'],
    ifrsTags: ['TradeAndOtherCurrentPayables'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Accounts Payable',
  },
  ppe_net: {
    group: 'balance_sheet',
    tags: ['PropertyPlantAndEquipmentNet'],
    /**
     * The finance-lease-inclusive total is the primary line for 390 CY2025Q4I
     * filers that report no `PropertyPlantAndEquipmentNet` (Alphabet, Meta, and
     * Tesla among them), but it adds finance-lease right-of-use assets — a
     * different definition, so it stays out of `tags` (#36).
     */
    relatedTags: [
      {
        tag: 'PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization',
        note: 'Net PP&E plus finance-lease right-of-use assets; the primary line for filers that present the two together.',
      },
    ],
    /**
     * Confirmed in the 20-F companyfacts of Spotify (SPOT) and SAP. The IFRS
     * right-of-use-inclusive element is the counterpart of the related tag above,
     * not of `PropertyPlantAndEquipmentNet`, so it stays out for the same reason;
     * a filer that moved to it (SAP, after CY2022) reads as a stopped series.
     */
    ifrsTags: ['PropertyPlantAndEquipment'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Property, Plant & Equipment (Net)',
  },
  goodwill: {
    group: 'balance_sheet',
    tags: ['Goodwill'],
    ifrsTags: ['Goodwill'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Goodwill',
  },
  intangible_assets: {
    group: 'balance_sheet',
    tags: ['FiniteLivedIntangibleAssetsNet', 'IntangibleAssetsNetExcludingGoodwill'],
    ifrsTags: ['IntangibleAssetsOtherThanGoodwill'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Intangible Assets (Net)',
  },

  // Cash flow
  dividends_paid: {
    group: 'cash_flow',
    tags: ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock'],
    ifrsTags: ['DividendsPaid', 'DividendsPaidClassifiedAsFinancingActivities'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Dividends Paid',
  },
  share_repurchases: {
    group: 'cash_flow',
    tags: [
      'PaymentsForRepurchaseOfCommonStock',
      'PaymentsForRepurchaseOfEquity',
      'StockRepurchasedAndRetiredDuringPeriodValue',
    ],
    /**
     * `PaymentsToAcquireOrRedeemEntitysShares` leads: it is the IAS 7 financing
     * outflow for buying back own shares however they are then treated, the
     * counterpart of `PaymentsForRepurchaseOfCommonStock` at index 0 above.
     * `PurchaseOfTreasuryShares` counts only the shares a filer holds in treasury,
     * so a filer that cancels repurchased shares tags it zero — or at the value of
     * an employee-scheme purchase — while running a buyback of a wholly different
     * size, and leading with it would report that zero as the buyback.
     */
    ifrsTags: ['PaymentsToAcquireOrRedeemEntitysShares', 'PurchaseOfTreasuryShares'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Share Repurchases',
  },
  investing_cash_flow: {
    group: 'cash_flow',
    tags: ['NetCashProvidedByUsedInInvestingActivities'],
    relatedTags: [
      {
        tag: 'NetCashProvidedByUsedInInvestingActivitiesContinuingOperations',
        note: 'Continuing operations only — excludes discontinued operations; some filers report only this variant.',
      },
    ],
    ifrsTags: ['CashFlowsFromUsedInInvestingActivities'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Investing Cash Flow',
  },
  financing_cash_flow: {
    group: 'cash_flow',
    tags: ['NetCashProvidedByUsedInFinancingActivities'],
    relatedTags: [
      {
        tag: 'NetCashProvidedByUsedInFinancingActivitiesContinuingOperations',
        note: 'Continuing operations only — excludes discontinued operations; some filers report only this variant.',
      },
    ],
    ifrsTags: ['CashFlowsFromUsedInFinancingActivities'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Financing Cash Flow',
  },
};

/** The catalog key an input compares as: trimmed, lowercased, `-` and spaces as `_`. */
function catalogKey(input: string): string {
  return input.trim().toLowerCase().replace(/[- ]/g, '_');
}

/**
 * Resolve a concept input to its mapping. Accepts friendly names in any case or
 * separator form (`Net Income`, `NET_INCOME`), with surrounding whitespace ignored.
 * Returns undefined if the input is not a known friendly name.
 */
export function resolveConcept(input: string): ConceptMapping | undefined {
  return CONCEPT_MAP[catalogKey(input)];
}

/**
 * The shape of every item element in the us-gaap, ifrs-full, dei, and srt
 * taxonomies — the only elements that carry facts. SEC matches tags
 * case-sensitively (`netincomeloss` 404s where `NetIncomeLoss` answers), so an
 * input of any other shape can name nothing SEC holds, and it never reaches a
 * request URL, where tags are interpolated as path segments (#128).
 */
const XBRL_TAG_SHAPE = /^[A-Z][A-Za-z0-9]*$/;

/**
 * Standard combinations of catalog concepts, keyed like the catalog. Each is
 * answered with its formula rather than near-name suggestions, which for these
 * names are noise (`free_cash_flow` scores highest against the other two
 * cash-flow totals) or empty (`ebitda`). `total_debt` is deliberately absent:
 * `debt` is long-term debt only and the catalog has no current-portion concept,
 * so any formula would understate it. A catalog name is resolved before this
 * table is read, so a future catalog entry of the same name wins.
 */
const DERIVATIONS: Record<string, string> = {
  free_cash_flow: 'operating_cash_flow − capex',
  ebitda: 'operating_income + depreciation_amortization',
  working_capital: 'current_assets − current_liabilities',
};

/** Minimum Dice score for a catalog name to be suggested — the company-name threshold. */
const SUGGESTION_THRESHOLD = 0.3;
/** Maximum number of catalog names suggested for one unknown input. */
const SUGGESTION_LIMIT = 3;

/**
 * Up to three catalog names nearest an input's catalog key, each scored on its
 * friendly name and on its label (words, not underscores) and kept at the higher
 * of the two, ties broken by name. The label is what reaches `capex` from
 * `capital_expenditures`, which scores 0.21 against the name alone.
 */
function nearestConcepts(key: string): string[] {
  const words = key.replace(/_/g, ' ');
  return Object.entries(CONCEPT_MAP)
    .map(([name, mapping]) => ({
      name,
      score: Math.max(
        trigramSimilarity(key, name),
        trigramSimilarity(words, mapping.label.toLowerCase()),
      ),
    }))
    .filter((candidate) => candidate.score >= SUGGESTION_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, SUGGESTION_LIMIT)
    .map((candidate) => candidate.name);
}

/** Closing sentence of every unknown-concept hint. */
const UNKNOWN_CONCEPT_TAIL =
  'List every supported name with secedgar_search_concepts; a raw XBRL tag is an element name in UpperCamelCase, such as NetIncomeLoss.';

/** A concept input that is neither a catalog name nor shaped like an XBRL element name. */
export interface UnknownConcept {
  /** The input as supplied, trimmed. */
  concept: string;
  /** How to build it from catalog concepts, when it is a standard combination of them. */
  derivation?: string | undefined;
  /** Up to three nearest catalog names. Empty when a derivation applies or nothing is close. */
  suggestions: string[];
}

/** The concept-specific part of a hint, lowercase-first so it can follow a concept name. */
function unknownConceptDetail({ derivation, suggestions }: UnknownConcept): string {
  const parts = [
    ...(derivation ? [`derive it as ${derivation} from those concepts`] : []),
    ...(suggestions.length === 1 ? [`the closest supported name is ${suggestions[0]}`] : []),
    ...(suggestions.length > 1 ? [`closest supported names are ${suggestions.join(', ')}`] : []),
  ];
  return parts.join('; ') || 'no supported name is close';
}

/**
 * Recovery text for one unknown concept: its derivation or its suggestions,
 * then the pointer to secedgar_search_concepts. Every surface that reports an
 * unknown concept words it with this.
 */
export function unknownConceptHint(unknown: UnknownConcept): string {
  if (!unknown.derivation && unknown.suggestions.length === 0) return UNKNOWN_CONCEPT_TAIL;
  const detail = unknownConceptDetail(unknown);
  return `${detail[0]?.toUpperCase()}${detail.slice(1)}. ${UNKNOWN_CONCEPT_TAIL}`;
}

/**
 * Classify a concept input before any company resolution or SEC request.
 * Returns undefined for a catalog name (any case or separator form) and for
 * anything shaped like an XBRL element name — a well-formed tag the filer does
 * not report stays the tool's own no-data answer (#45). Everything else is
 * unknown, with its derivation or nearest catalog names (#128).
 */
export function findUnknownConcept(input: string): UnknownConcept | undefined {
  if (resolveConcept(input)) return;
  const concept = input.trim();
  const key = catalogKey(input);
  /**
   * Read before the tag-shape test so `EBITDA` gets its formula: no us-gaap,
   * ifrs-full, dei, or srt element is named like any derivation key, so a
   * tag-shaped spelling of one could only ever 404.
   */
  const derivation = DERIVATIONS[key];
  if (!derivation && XBRL_TAG_SHAPE.test(concept)) return;

  const suggestions = derivation ? [] : nearestConcepts(key);
  return { concept, ...(derivation ? { derivation } : {}), suggestions };
}

/**
 * Message and recovery hint for failing on one or more unknown concepts, so
 * every tool words the failure the same way. One concept carries its own hint;
 * several name each concept's detail in turn, then the shared closing sentence.
 */
export function describeUnknownConcepts(unknowns: readonly UnknownConcept[]): {
  hint: string;
  message: string;
} {
  const [only] = unknowns;
  if (only && unknowns.length === 1) {
    return {
      message: `${only.concept ? `'${only.concept}'` : 'An empty concept'} is neither a supported concept name nor an XBRL tag.`,
      hint: unknownConceptHint(only),
    };
  }
  return {
    message: `None of the requested concepts is a supported concept name or an XBRL tag: ${unknowns
      .map((u) => `'${u.concept}'`)
      .join(', ')}.`,
    hint: `${unknowns.map((u) => `${u.concept} — ${unknownConceptDetail(u)}`).join('; ')}. ${UNKNOWN_CONCEPT_TAIL}`,
  };
}

/** What a caller-supplied concept resolves to before any lookup runs. */
export interface ConceptTarget {
  /** Human-readable label — the mapping's label, or the raw tag itself. */
  label: string;
  /** How a filer reporting several of these tags resolves to one of them. */
  tagSelection: TagSelection;
  /** Tags to try in priority order. Index 0 is the preferred total. */
  tags: string[];
  /** Taxonomy to look the tags up under. */
  taxonomy: ConceptTaxonomy;
  /** Expected unit of measure. Absent for raw XBRL tags. */
  unit?: string;
}

/**
 * Resolve a concept input plus a requested taxonomy into the taxonomy and tag
 * list to query. A friendly name that prefers its own taxonomy (`dei` for
 * shares_outstanding) keeps it unless the caller asked for something other than
 * the `us-gaap` default; `ifrs-full` uses the mapping's confirmed IFRS variants
 * when it has them and falls back to the standard tags otherwise. Any other
 * input passes through, trimmed, as a raw XBRL tag under the requested
 * taxonomy — callers reject what `findUnknownConcept` flags before this runs.
 */
export function resolveConceptTarget(
  input: string,
  requestedTaxonomy: ConceptTaxonomy,
): ConceptTarget {
  const mapping = resolveConcept(input);
  if (!mapping) {
    const tag = input.trim();
    return { label: tag, tagSelection: 'priority', tags: [tag], taxonomy: requestedTaxonomy };
  }

  const taxonomy = requestedTaxonomy === 'us-gaap' ? mapping.taxonomy : requestedTaxonomy;
  /** Defined only when IFRS was asked for and the mapping has confirmed variants — they carry their own selection. */
  const ifrsTags =
    taxonomy === 'ifrs-full' && mapping.ifrsTags?.length ? mapping.ifrsTags : undefined;
  return {
    label: mapping.label,
    tagSelection: (ifrsTags ? mapping.ifrsTagSelection : undefined) ?? 'priority',
    tags: ifrsTags ?? mapping.tags,
    taxonomy,
    unit: mapping.unit,
  };
}

/** Get all concept mappings for reference resource generation. */
export function getAllConcepts(): Record<string, ConceptMapping> {
  return CONCEPT_MAP;
}

/** Entry returned by search/list operations — friendly name paired with its mapping. */
export interface ConceptEntry extends ConceptMapping {
  name: string;
}

/**
 * Return every concept entry as a flat, stable-ordered array (by group, then alphabetical by name).
 */
export function listConcepts(): ConceptEntry[] {
  return Object.entries(CONCEPT_MAP)
    .map(([name, mapping]) => ({ name, ...mapping }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

/** Normalize a string for fuzzy matching: lowercase, collapse non-alphanumerics to spaces. */
function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Search concepts by substring against friendly name, label, and XBRL tags.
 * Passing a raw XBRL tag will reverse-lookup the friendly mapping(s).
 * Empty/whitespace query returns all entries.
 *
 * When `taxonomy` is `'ifrs-full'`, only concepts that have `ifrsTags` are
 * returned (they are the only ones with confirmed IFRS-friendly-name support).
 */
export function searchConcepts(query: string, taxonomy?: string): ConceptEntry[] {
  const needle = normalizeForSearch(query);
  let entries = listConcepts();

  // For ifrs-full, narrow to concepts that have confirmed IFRS tag mappings.
  if (taxonomy === 'ifrs-full') {
    entries = entries.filter((e) => e.ifrsTags && e.ifrsTags.length > 0);
  }

  if (!needle) return entries;

  return entries.filter((entry) => {
    const haystacks = [
      normalizeForSearch(entry.name),
      normalizeForSearch(entry.label),
      ...entry.tags.map(normalizeForSearch),
      ...(entry.ifrsTags ?? []).map(normalizeForSearch),
      ...(entry.relatedTags ?? []).map((r) => normalizeForSearch(r.tag)),
    ];
    return haystacks.some((h) => h.includes(needle));
  });
}
