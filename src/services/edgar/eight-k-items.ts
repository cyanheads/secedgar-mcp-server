/**
 * @fileoverview Form 8-K item-code decode tables for both numbering regimes.
 * SEC replaced the original single-integer item numbering with the current
 * `x.xx` scheme in Release 33-8400, effective 2004-08-23, so EDGAR carries two
 * disjoint vocabularies in the same `items` field. Decoding is driven by the
 * code's SHAPE, not the filing date: a dotted code is always current-regime, a
 * bare integer is always legacy. That makes a mis-decode impossible for filings
 * straddling the changeover, where filers reported pre-changeover events under
 * the old numbers for months after the effective date.
 * @module services/edgar/eight-k-items
 */

/** Which Form 8-K item-numbering regime a code belongs to. */
export type EightKItemRegime = 'current' | 'legacy';

/**
 * Effective date of SEC Release 33-8400, which introduced the current `x.xx`
 * item numbering. Reported as context on legacy-coded filings; never used to
 * pick a decode table (see the module header).
 */
export const EIGHT_K_RENUMBERING_DATE = '2004-08-23';

/** Current-regime section headings, keyed by the code's leading digit. */
export const EIGHT_K_SECTIONS: Record<string, string> = {
  '1': "Registrant's Business and Operations",
  '2': 'Financial Information',
  '3': 'Securities and Trading Markets',
  '4': 'Matters Related to Accountants and Financial Statements',
  '5': 'Corporate Governance and Management',
  '6': 'Asset-Backed Securities',
  '7': 'Regulation FD',
  '8': 'Other Events',
  '9': 'Financial Statements and Exhibits',
};

/**
 * Current Form 8-K items (filings numbered under the post-2004-08-23 scheme),
 * transcribed from the item headings of SEC's Form 8-K.
 */
export const CURRENT_EIGHT_K_ITEMS: Record<string, string> = {
  '1.01': 'Entry into a Material Definitive Agreement',
  '1.02': 'Termination of a Material Definitive Agreement',
  '1.03': 'Bankruptcy or Receivership',
  '1.04': 'Mine Safety — Reporting of Shutdowns and Patterns of Violations',
  '1.05': 'Material Cybersecurity Incidents',
  '2.01': 'Completion of Acquisition or Disposition of Assets',
  '2.02': 'Results of Operations and Financial Condition',
  '2.03':
    'Creation of a Direct Financial Obligation or an Obligation under an Off-Balance Sheet Arrangement of a Registrant',
  '2.04':
    'Triggering Events That Accelerate or Increase a Direct Financial Obligation or an Obligation under an Off-Balance Sheet Arrangement',
  '2.05': 'Costs Associated with Exit or Disposal Activities',
  '2.06': 'Material Impairments',
  '3.01':
    'Notice of Delisting or Failure to Satisfy a Continued Listing Rule or Standard; Transfer of Listing',
  '3.02': 'Unregistered Sales of Equity Securities',
  '3.03': 'Material Modification to Rights of Security Holders',
  '4.01': "Changes in Registrant's Certifying Accountant",
  '4.02':
    'Non-Reliance on Previously Issued Financial Statements or a Related Audit Report or Completed Interim Review',
  '5.01': 'Changes in Control of Registrant',
  '5.02':
    'Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers; Compensatory Arrangements of Certain Officers',
  '5.03': 'Amendments to Articles of Incorporation or Bylaws; Change in Fiscal Year',
  '5.04': "Temporary Suspension of Trading Under Registrant's Employee Benefit Plans",
  '5.05':
    "Amendments to the Registrant's Code of Ethics, or Waiver of a Provision of the Code of Ethics",
  '5.06': 'Change in Shell Company Status',
  '5.07': 'Submission of Matters to a Vote of Security Holders',
  '5.08': 'Shareholder Director Nominations',
  '6.01': 'ABS Informational and Computational Material',
  '6.02': 'Change of Servicer or Trustee',
  '6.03': 'Change in Credit Enhancement or Other External Support',
  '6.04': 'Failure to Make a Required Distribution',
  '6.05': 'Securities Act Updating Disclosure',
  '6.06': 'Static Pool',
  '7.01': 'Regulation FD Disclosure',
  '8.01': 'Other Events',
  '9.01': 'Financial Statements and Exhibits',
};

/**
 * Legacy Form 8-K items — the single-integer numbering used before
 * 2004-08-23. Items 10-12 were added in 2002-2003 and retired along with the
 * rest at the changeover; item 12 (results of operations) is the direct
 * ancestor of today's 2.02, and item 9 of today's 7.01.
 */
export const LEGACY_EIGHT_K_ITEMS: Record<string, string> = {
  '1': 'Changes in Control of Registrant',
  '2': 'Acquisition or Disposition of Assets',
  '3': 'Bankruptcy or Receivership',
  '4': "Changes in Registrant's Certifying Accountant",
  '5': 'Other Events',
  '6': "Resignations of Registrant's Directors",
  '7': 'Financial Statements, Pro Forma Financial Information and Exhibits',
  '8': 'Change in Fiscal Year',
  '9': 'Regulation FD Disclosure',
  '10': "Amendments to the Registrant's Code of Ethics, or Waiver of a Provision of the Code of Ethics",
  '11': "Temporary Suspension of Trading Under Registrant's Employee Benefit Plans",
  '12': 'Results of Operations and Financial Condition',
};

/**
 * Every filterable item code across both regimes. Backs the `items` input enum,
 * so a caller reads the whole vocabulary off the JSON Schema and an unknown code
 * is rejected before any fetch. Declared current-first, but the schema serves the
 * bare integers first regardless: Zod keys its enum by value, and a JS object
 * orders integer-like keys ahead of the rest. The `items` describe text carries
 * which shape belongs to which regime, since the order cannot.
 */
export const EIGHT_K_ITEM_CODES = [
  ...Object.keys(CURRENT_EIGHT_K_ITEMS),
  ...Object.keys(LEGACY_EIGHT_K_ITEMS),
] as [string, ...string[]];

/** One decoded item code. `label` is absent for a code neither table defines. */
export interface DecodedEightKItem {
  code: string;
  label?: string | undefined;
  regime?: EightKItemRegime | undefined;
}

/**
 * Decode one item code by shape — dotted (`2.02`) is current-regime, a bare
 * integer (`12`) is legacy. A code matching neither shape, or matching a shape
 * but absent from that regime's table, comes back with the code alone so the
 * caller sees exactly what EDGAR reported instead of a guessed label.
 */
export function decodeEightKItem(code: string): DecodedEightKItem {
  if (/^\d\.\d{2}$/.test(code)) {
    const label = CURRENT_EIGHT_K_ITEMS[code];
    return label ? { code, label, regime: 'current' } : { code, regime: 'current' };
  }
  if (/^\d{1,2}$/.test(code)) {
    const label = LEGACY_EIGHT_K_ITEMS[code];
    return label ? { code, label, regime: 'legacy' } : { code, regime: 'legacy' };
  }
  return { code };
}

/**
 * Split the submissions API's `items` field (a comma-separated code list, e.g.
 * `"2.02,9.01"`) into codes. An absent or empty field yields no codes — most
 * 8-K filings carry items, but EDGAR leaves the field blank on some older ones.
 */
export function parseEightKItems(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
}
