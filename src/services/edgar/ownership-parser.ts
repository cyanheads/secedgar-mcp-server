/**
 * @fileoverview Pure parsers for SEC ownership form XML — Form 3/4/5 (ownershipDocument)
 * and 13F-HR information tables (informationTable). Uses htmlparser2 + domutils (direct
 * dependencies). External entity expansion and
 * DTD processing are disabled by default in htmlparser2's xmlMode, preventing XXE.
 * @module services/edgar/ownership-parser
 */

import type { Element } from 'domhandler';
import { findAll, findOne, textContent } from 'domutils';
import { parseDocument } from 'htmlparser2';

/** Transaction type codes used in Form 4 nonDerivativeTransaction/derivativeTransaction. */
const TRANSACTION_CODE_MAP: Record<string, string> = {
  P: 'purchase',
  S: 'sale',
  V: 'voluntary_conversion',
  A: 'grant_or_award',
  D: 'return_to_issuer',
  F: 'tax_withholding',
  G: 'gift',
  M: 'conversion_of_derivative',
  X: 'expiration',
  C: 'conversion',
  E: 'expiration_short',
  H: 'expiration_long',
  I: 'discretionary',
  O: 'out_of_money_exercise',
  U: 'tender',
  W: 'acquired_by_will',
  Z: 'deposit_into_voting_trust',
  J: 'other',
};

/** Parsed insider transaction from Form 4 nonDerivativeTransaction or derivativeTransaction. */
export interface InsiderTransaction {
  /** True for nonDerivative, false for derivative (options, RSUs, etc.). */
  is_derivative: boolean;
  /** Nature of indirect ownership (e.g. "By Trust", "By Spouse"). */
  ownership_nature: string | undefined;
  /** D = direct ownership, I = indirect. */
  ownership_type: 'direct' | 'indirect' | undefined;
  /** Price per share. 0 for gifts and RSU awards. */
  price_per_share: number | undefined;
  security_title: string;
  shares_owned_after: number | undefined;
  /** Negative = disposal (D), positive = acquisition (A). */
  shares_traded: number | undefined;
  /** Raw 1-letter SEC code, e.g. "S", "P", "M". */
  transaction_code: string;
  transaction_date: string | undefined;
  /** Human-readable description of the code, e.g. "sale", "purchase". */
  transaction_type: string;
}

/** Reporting person info parsed from reportingOwner. */
export interface ReportingOwner {
  cik: string;
  is_director: boolean;
  is_officer: boolean;
  is_other: boolean;
  is_ten_percent_owner: boolean;
  name: string;
  officer_title: string | undefined;
}

/** Parsed result from a Form 3/4/5 ownershipDocument XML. */
export interface ParsedForm4 {
  issuer_cik: string;
  issuer_name: string;
  issuer_ticker: string | undefined;
  period_of_report: string | undefined;
  reporting_owners: ReportingOwner[];
  transactions: InsiderTransaction[];
}

/** One row from a 13F-HR informationTable/infoTable. */
export interface HoldingRow {
  cusip: string | undefined;
  investment_discretion: 'SOLE' | 'DFND' | 'OTR' | undefined;
  issuer_name: string;
  /** Present only for options positions. */
  put_call: 'Put' | 'Call' | undefined;
  shares_or_principal_amount: number | undefined;
  /** SH = shares, PRN = principal (bonds). */
  shares_or_principal_type: 'SH' | 'PRN' | undefined;
  title_of_class: string | undefined;
  /** Market value in thousands of USD. */
  value_in_thousands: number | undefined;
}

/** Parsed result from a 13F information table XML. */
export interface ParsedInfoTable {
  holdings: HoldingRow[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Return the trimmed text content of the first matching tag under `parent`, or undefined. */
function childText(parent: Element, tagName: string): string | undefined {
  const child = findOne(
    (e): e is Element => e.type === 'tag' && e.name.toLowerCase() === tagName.toLowerCase(),
    parent.children,
    true,
  );
  if (!child) return;
  const t = textContent(child).trim();
  return t || undefined;
}

/** Return the trimmed `<value>` child text of a tag, or undefined. */
function valueChild(parent: Element, tagName: string): string | undefined {
  const wrapper = findOne(
    (e): e is Element => e.type === 'tag' && e.name.toLowerCase() === tagName.toLowerCase(),
    parent.children,
    true,
  );
  if (!wrapper) return;
  const valueEl = findOne(
    (e): e is Element => e.type === 'tag' && e.name.toLowerCase() === 'value',
    wrapper.children,
    true,
  );
  if (valueEl) {
    const t = textContent(valueEl).trim();
    return t || undefined;
  }
  // Some older filings omit the <value> wrapper — use the tag text directly.
  const t = textContent(wrapper).trim();
  return t || undefined;
}

function parseFloat2(s: string | undefined): number | undefined {
  if (!s) return;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function parseBool(s: string | undefined): boolean {
  return s === 'true' || s === '1';
}

// ---------------------------------------------------------------------------
// Form 4 parser
// ---------------------------------------------------------------------------

function parseTransaction(el: Element, isDerivative: boolean): InsiderTransaction {
  const code = valueChild(el, 'transactionCode') ?? valueChild(el, 'transactionCoding') ?? '';
  // transactionCode may be nested: <transactionCoding><transactionCode><value>S</value>...
  // The valueChild call on 'transactionCoding' finds the text of the whole sub-tree if no <value>
  // directly under it — we need just the transactionCode value inside transactionCoding.
  const codingEl = findOne(
    (e): e is Element => e.type === 'tag' && e.name.toLowerCase() === 'transactioncoding',
    el.children,
    true,
  );
  const rawCode = codingEl ? (valueChild(codingEl, 'transactionCode') ?? '') : code;

  const acqDispCode = valueChild(el, 'transactionAcquiredDisposedCode') ?? 'A';
  const sharesRaw = parseFloat2(valueChild(el, 'transactionShares'));
  const shares =
    sharesRaw !== undefined
      ? acqDispCode.toUpperCase() === 'D'
        ? -sharesRaw
        : sharesRaw
      : undefined;

  const directOrIndirect = valueChild(el, 'directOrIndirectOwnership')?.toUpperCase();
  const ownershipType: 'direct' | 'indirect' | undefined =
    directOrIndirect === 'D' ? 'direct' : directOrIndirect === 'I' ? 'indirect' : undefined;
  const ownershipNature = valueChild(el, 'natureOfOwnership');

  return {
    security_title: valueChild(el, 'securityTitle') ?? '',
    transaction_date: valueChild(el, 'transactionDate'),
    transaction_code: rawCode.toUpperCase(),
    transaction_type: TRANSACTION_CODE_MAP[rawCode.toUpperCase()] ?? 'other',
    is_derivative: isDerivative,
    shares_traded: shares,
    price_per_share: parseFloat2(valueChild(el, 'transactionPricePerShare')),
    shares_owned_after: parseFloat2(valueChild(el, 'sharesOwnedFollowingTransaction')),
    ownership_type: ownershipType,
    ownership_nature: ownershipNature,
  };
}

function parseReportingOwner(el: Element): ReportingOwner {
  const idEl = findOne(
    (e): e is Element => e.type === 'tag' && e.name.toLowerCase() === 'reportingownerid',
    el.children,
    true,
  );
  const relEl = findOne(
    (e): e is Element => e.type === 'tag' && e.name.toLowerCase() === 'reportingownerrelationship',
    el.children,
    true,
  );

  return {
    cik: (idEl ? childText(idEl, 'rptOwnerCik') : undefined) ?? '',
    name: (idEl ? childText(idEl, 'rptOwnerName') : undefined) ?? '',
    is_director: parseBool(relEl ? childText(relEl, 'isDirector') : undefined),
    is_officer: parseBool(relEl ? childText(relEl, 'isOfficer') : undefined),
    is_ten_percent_owner: parseBool(relEl ? childText(relEl, 'isTenPercentOwner') : undefined),
    is_other: parseBool(relEl ? childText(relEl, 'isOther') : undefined),
    officer_title: relEl ? childText(relEl, 'officerTitle') : undefined,
  };
}

/**
 * Parse a Form 3/4/5 ownershipDocument XML string.
 * Disables external entity loading via htmlparser2's xmlMode (no DTD/entity expansion).
 */
export function parseForm4Xml(xml: string): ParsedForm4 {
  const doc = parseDocument(xml, { xmlMode: true, decodeEntities: true });

  const rootEl = findOne(
    (e): e is Element => e.type === 'tag' && e.name.toLowerCase() === 'ownershipdocument',
    doc.children,
    true,
  );

  const issuerEl = rootEl
    ? findOne(
        (e): e is Element => e.type === 'tag' && e.name.toLowerCase() === 'issuer',
        rootEl.children,
        false,
      )
    : null;

  const ownerEls = rootEl
    ? findAll(
        (e): e is Element => e.type === 'tag' && e.name.toLowerCase() === 'reportingowner',
        rootEl.children,
      )
    : [];

  // Collect both nonDerivativeTransaction and derivativeTransaction elements
  const nonDerivTxEls = rootEl
    ? findAll(
        (e): e is Element =>
          e.type === 'tag' && e.name.toLowerCase() === 'nonderivativetransaction',
        rootEl.children,
      )
    : [];

  const derivTxEls = rootEl
    ? findAll(
        (e): e is Element => e.type === 'tag' && e.name.toLowerCase() === 'derivativetransaction',
        rootEl.children,
      )
    : [];

  const transactions: InsiderTransaction[] = [
    ...nonDerivTxEls.map((el) => parseTransaction(el, false)),
    ...derivTxEls.map((el) => parseTransaction(el, true)),
  ];

  return {
    issuer_cik: (issuerEl ? childText(issuerEl, 'issuerCik') : undefined) ?? '',
    issuer_name: (issuerEl ? childText(issuerEl, 'issuerName') : undefined) ?? '',
    issuer_ticker: (issuerEl ? childText(issuerEl, 'issuerTradingSymbol') : undefined) || undefined,
    period_of_report: rootEl ? childText(rootEl, 'periodOfReport') : undefined,
    reporting_owners: ownerEls.map(parseReportingOwner),
    transactions,
  };
}

// ---------------------------------------------------------------------------
// 13F information table parser
// ---------------------------------------------------------------------------

/**
 * Parse a 13F-HR information table XML string.
 * Handles both the default namespace (xmlns="...") and ns1-prefixed variants
 * (xmlns:ns1="...") used by different filers.
 */
export function parseInfoTableXml(xml: string): ParsedInfoTable {
  const doc = parseDocument(xml, { xmlMode: true, decodeEntities: true });

  // infoTable elements may appear under <informationTable> or <ns1:informationTable>
  // htmlparser2 in xmlMode preserves namespace prefixes as part of tag names.
  const infoTableEls = findAll(
    (e): e is Element =>
      e.type === 'tag' &&
      (e.name.toLowerCase() === 'infotable' || e.name.toLowerCase() === 'ns1:infotable'),
    doc.children,
  );

  const holdings: HoldingRow[] = infoTableEls.map((el) => {
    const nameOfIssuer = childText(el, 'nameOfIssuer') ?? childText(el, 'ns1:nameOfIssuer') ?? '';
    const titleOfClass = childText(el, 'titleOfClass') ?? childText(el, 'ns1:titleOfClass');
    const cusip = childText(el, 'cusip') ?? childText(el, 'ns1:cusip');
    const valueStr = childText(el, 'value') ?? childText(el, 'ns1:value');
    const putCallStr = childText(el, 'putCall') ?? childText(el, 'ns1:putCall');
    const investDisc =
      childText(el, 'investmentDiscretion') ?? childText(el, 'ns1:investmentDiscretion');

    // shrsOrPrnAmt block
    const amtEl =
      findOne(
        (e): e is Element =>
          e.type === 'tag' &&
          (e.name.toLowerCase() === 'shrsorprnamt' || e.name.toLowerCase() === 'ns1:shrsorprnamt'),
        el.children,
        true,
      ) ?? null;

    const sshPrnamt = amtEl
      ? (childText(amtEl, 'sshPrnamt') ?? childText(amtEl, 'ns1:sshPrnamt'))
      : undefined;
    const sshPrnamtType = amtEl
      ? (childText(amtEl, 'sshPrnamtType') ?? childText(amtEl, 'ns1:sshPrnamtType'))
      : undefined;

    const putCallNorm = putCallStr === 'Put' ? 'Put' : putCallStr === 'Call' ? 'Call' : undefined;
    const typeNorm: 'SH' | 'PRN' | undefined =
      sshPrnamtType?.toUpperCase() === 'SH'
        ? 'SH'
        : sshPrnamtType?.toUpperCase() === 'PRN'
          ? 'PRN'
          : undefined;

    const investDiscNorm =
      investDisc === 'SOLE'
        ? 'SOLE'
        : investDisc === 'DFND'
          ? 'DFND'
          : investDisc === 'OTR'
            ? 'OTR'
            : undefined;

    return {
      issuer_name: nameOfIssuer,
      title_of_class: titleOfClass || undefined,
      cusip: cusip || undefined,
      value_in_thousands: parseFloat2(valueStr),
      shares_or_principal_amount: parseFloat2(sshPrnamt),
      shares_or_principal_type: typeNorm,
      put_call: putCallNorm as 'Put' | 'Call' | undefined,
      investment_discretion: investDiscNorm,
    };
  });

  return { holdings };
}
