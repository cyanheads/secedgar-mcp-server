/**
 * @fileoverview Static mapping of friendly financial concept names to XBRL tags.
 * @module services/edgar/concept-map
 */

import type { ConceptMapping } from './types.js';

/** Friendly name → XBRL tag mapping. Tags are tried in order for companyconcept lookups. */
const CONCEPT_MAP: Record<string, ConceptMapping> = {
  revenue: {
    group: 'income_statement',
    tags: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
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
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Operating Income (Loss)',
  },
  gross_profit: {
    group: 'income_statement',
    tags: ['GrossProfit'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Gross Profit',
  },
  eps_basic: {
    group: 'per_share',
    tags: ['EarningsPerShareBasic'],
    taxonomy: 'us-gaap',
    unit: 'USD/shares',
    label: 'Earnings Per Share (Basic)',
  },
  eps_diluted: {
    group: 'per_share',
    tags: ['EarningsPerShareDiluted'],
    taxonomy: 'us-gaap',
    unit: 'USD/shares',
    label: 'Earnings Per Share (Diluted)',
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
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Cash and Cash Equivalents',
  },
  debt: {
    group: 'balance_sheet',
    tags: ['LongTermDebt', 'LongTermDebtNoncurrent'],
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
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Operating Cash Flow',
  },
  capex: {
    group: 'cash_flow',
    tags: ['PaymentsToAcquirePropertyPlantAndEquipment'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Capital Expenditures',
  },
  depreciation_amortization: {
    group: 'cash_flow',
    tags: ['DepreciationDepletionAndAmortization', 'DepreciationAndAmortization', 'Depreciation'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Depreciation & Amortization',
  },
  // Distinct from `debt` (which targets long-term debt directly). `notes_payable` prefers
  // the notes-specific tags and only falls back to LongTermDebt for filers that report it
  // there exclusively.
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
    tags: ['CostOfGoodsAndServicesSold', 'CostOfRevenue', 'CostOfGoodsSold'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Cost of Goods Sold',
  },
  rd_expense: {
    group: 'income_statement',
    tags: ['ResearchAndDevelopmentExpense'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Research & Development Expense',
  },
  sga_expense: {
    group: 'income_statement',
    tags: ['SellingGeneralAndAdministrativeExpense'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Selling, General & Administrative Expense',
  },
  interest_expense: {
    group: 'income_statement',
    tags: ['InterestExpense', 'InterestExpenseDebt'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Interest Expense',
  },
  tax_expense: {
    group: 'income_statement',
    tags: ['IncomeTaxExpenseBenefit'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Income Tax Expense (Benefit)',
  },
  stock_based_compensation: {
    group: 'income_statement',
    tags: ['ShareBasedCompensation', 'AllocatedShareBasedCompensationExpense'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Stock-Based Compensation',
  },

  // Balance sheet
  current_assets: {
    group: 'balance_sheet',
    tags: ['AssetsCurrent'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Current Assets',
  },
  current_liabilities: {
    group: 'balance_sheet',
    tags: ['LiabilitiesCurrent'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Current Liabilities',
  },
  inventory: {
    group: 'balance_sheet',
    tags: ['InventoryNet', 'InventoryGross'],
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
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Accounts Receivable (Net)',
  },
  accounts_payable: {
    group: 'balance_sheet',
    tags: ['AccountsPayableCurrent'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Accounts Payable',
  },
  goodwill: {
    group: 'balance_sheet',
    tags: ['Goodwill'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Goodwill',
  },
  intangible_assets: {
    group: 'balance_sheet',
    tags: ['FiniteLivedIntangibleAssetsNet', 'IntangibleAssetsNetExcludingGoodwill'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Intangible Assets (Net)',
  },

  // Cash flow
  dividends_paid: {
    group: 'cash_flow',
    tags: ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock'],
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
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Financing Cash Flow',
  },
};

/**
 * Resolve a concept input to its mapping. Accepts friendly names or raw XBRL tags.
 * Returns undefined if the input is not a known friendly name (caller should treat it as a raw tag).
 */
export function resolveConcept(input: string): ConceptMapping | undefined {
  const normalized = input.toLowerCase().replace(/[- ]/g, '_');
  return CONCEPT_MAP[normalized];
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
