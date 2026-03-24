/**
 * @fileoverview Static mapping of friendly financial concept names to XBRL tags.
 * @module services/edgar/concept-map
 */

import type { ConceptMapping } from './types.js';

/** Friendly name → XBRL tag mapping. Tags are tried in order for companyconcept lookups. */
const CONCEPT_MAP: Record<string, ConceptMapping> = {
  revenue: {
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
    tags: ['NetIncomeLoss'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Net Income (Loss)',
  },
  operating_income: {
    tags: ['OperatingIncomeLoss'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Operating Income (Loss)',
  },
  gross_profit: {
    tags: ['GrossProfit'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Gross Profit',
  },
  eps_basic: {
    tags: ['EarningsPerShareBasic'],
    taxonomy: 'us-gaap',
    unit: 'USD/shares',
    label: 'Earnings Per Share (Basic)',
  },
  eps_diluted: {
    tags: ['EarningsPerShareDiluted'],
    taxonomy: 'us-gaap',
    unit: 'USD/shares',
    label: 'Earnings Per Share (Diluted)',
  },
  assets: {
    tags: ['Assets'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Total Assets',
  },
  liabilities: {
    tags: ['Liabilities'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Total Liabilities',
  },
  equity: {
    tags: ['StockholdersEquity'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: "Stockholders' Equity",
  },
  cash: {
    tags: ['CashAndCashEquivalentsAtCarryingValue'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Cash and Cash Equivalents',
  },
  debt: {
    tags: ['LongTermDebt', 'LongTermDebtNoncurrent'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Long-Term Debt',
  },
  shares_outstanding: {
    tags: ['EntityCommonStockSharesOutstanding'],
    taxonomy: 'dei',
    unit: 'shares',
    label: 'Shares Outstanding',
  },
  operating_cash_flow: {
    tags: ['NetCashProvidedByUsedInOperatingActivities'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Operating Cash Flow',
  },
  capex: {
    tags: ['PaymentsToAcquirePropertyPlantAndEquipment'],
    taxonomy: 'us-gaap',
    unit: 'USD',
    label: 'Capital Expenditures',
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
