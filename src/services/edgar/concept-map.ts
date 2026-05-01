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
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Revenue',
  },
  net_income: {
    group: 'income_statement',
    tags: ['NetIncomeLoss'],
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
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: "Stockholders' Equity",
  },
  cash: {
    group: 'balance_sheet',
    tags: ['CashAndCashEquivalentsAtCarryingValue'],
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
 */
export function searchConcepts(query: string): ConceptEntry[] {
  const needle = normalizeForSearch(query);
  if (!needle) return listConcepts();

  return listConcepts().filter((entry) => {
    const haystacks = [
      normalizeForSearch(entry.name),
      normalizeForSearch(entry.label),
      ...entry.tags.map(normalizeForSearch),
    ];
    return haystacks.some((h) => h.includes(needle));
  });
}
