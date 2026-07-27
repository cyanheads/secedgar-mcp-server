/**
 * @fileoverview Parser for the NPORT-P `primary_doc.xml` a registered fund files each
 * quarter — the public portfolio report. One filing covers exactly one series (and every
 * share class of it), so the header carries the series identity a caller routes on and the
 * body carries the holdings. {@link parseNportHeader} reads only the identity block, which
 * lets a caller stop reading a wrong-series document after a few kilobytes instead of
 * pulling a multi-megabyte holdings list it will discard.
 * @module services/edgar/nport-parser
 */

import type { AnyNode, Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { childAttr, childText, childTexts, findTag, findTags, parseNumber } from './xml-nodes.js';

/** The series identity block, readable from the first few kilobytes of the document. */
export interface NportHeader {
  /** Share classes of this series covered by the filing (e.g. "C000092055"). */
  class_ids: string[];
  registrant_cik: string | undefined;
  registrant_name: string | undefined;
  /** Last day of the reporting period this report covers (YYYY-MM-DD). */
  report_period_date: string | undefined;
  /** Last day of the fiscal year the reporting period falls in (YYYY-MM-DD). */
  report_period_end: string | undefined;
  /** SEC fund series identifier (e.g. "S000002839"). Absent on a registrant that files as a single fund. */
  series_id: string | undefined;
  /** Fund name as the filer states it. Absent when the filing carries no series. */
  series_name: string | undefined;
}

/** One portfolio position from `invstOrSecs/invstOrSec`. */
export interface NportHolding {
  /** SEC asset-type code — EC equity-common, DBT debt, RA repo, STIV short-term investment vehicle, … */
  asset_category: string | undefined;
  /** Units held, in the unit named by `units`. */
  balance: number | undefined;
  /** ISO 3166 country of investment. */
  country: string | undefined;
  /** ISO 4217 code the position is denominated in. */
  currency: string | undefined;
  cusip: string | undefined;
  isin: string | undefined;
  /** SEC issuer-type code — CORP, MUN, USGSE, … — or the filer's own label when it reports "Other". */
  issuer_category: string | undefined;
  lei: string | undefined;
  /** Issuer name as filed. Derivative positions routinely carry the literal "N/A" here, with the instrument named in {@link NportHolding.title}. */
  name: string;
  /** "Long", "Short", or "N/A" for instruments with no direction. */
  payoff_profile: string | undefined;
  /** Percentage of the fund's net assets, already expressed as a percent (not a fraction). */
  percent_of_net_assets: number | undefined;
  /** Issuer's own title for the security, often an abbreviated trading name. */
  title: string | undefined;
  /** Unit the balance is counted in — NS number of shares, PA principal amount, NC contracts, OU other. */
  units: string | undefined;
  value_usd: number | undefined;
}

/** A parsed NPORT-P report. */
export interface ParsedNportReport extends NportHeader {
  holdings: NportHolding[];
  /** True when the fund reports this as its final filing on the series. */
  is_final_filing: boolean | undefined;
  net_assets_usd: number | undefined;
  total_assets_usd: number | undefined;
  total_liabilities_usd: number | undefined;
}

/**
 * Drop the literal "N/A" a filer writes into an identifier or classification element it has
 * nothing to put in. These are required elements, so a derivative position fills them rather
 * than omitting them — 598 of the 1,946 positions in one broad small-cap index fund's report
 * carry it for `lei` alone. Carried through, it reads as a value: a CUSIP of "N/A" joins
 * nothing, and an ISO country of "N/A" is not a country.
 */
function realValue(value: string | undefined): string | undefined {
  return value === undefined || value.toUpperCase() === 'N/A' ? undefined : value;
}

function readHeader(root: AnyNode[]): NportHeader {
  const seriesClass = findTag(root, 'seriesClassInfo');
  const genInfo = findTag(root, 'genInfo');
  return {
    // The identity appears twice — headerData/filerInfo/seriesClassInfo carries the class
    // list, genInfo the human-readable names. Prefer genInfo for the ids too: a truncated
    // read that reached genInfo has both, and genInfo is the block the filer fills in.
    series_id: childText(genInfo, 'seriesId') ?? childText(seriesClass, 'seriesId'),
    // A registrant organized as one fund rather than a series trust still has to fill the
    // element in, and writes "N/A" — a literal that would otherwise be carried downstream
    // as the fund's name.
    series_name: realValue(childText(genInfo, 'seriesName')),
    class_ids: childTexts(seriesClass, 'classId'),
    registrant_name: childText(genInfo, 'regName'),
    registrant_cik: childText(genInfo, 'regCik'),
    report_period_date: childText(genInfo, 'repPdDate'),
    report_period_end: childText(genInfo, 'repPdEnd'),
  };
}

/**
 * Read only the series identity from an NPORT-P document. Tolerates a truncated document,
 * so a caller streaming the response can stop once `</genInfo>` has arrived.
 */
export function parseNportHeader(xml: string): NportHeader {
  return readHeader(parseDocument(xml, { xmlMode: true, decodeEntities: true }).children);
}

/**
 * Read a category the schema expresses two ways: a plain code element (`assetCat`), or —
 * when the filer picks "Other" — a `*Conditional` element carrying the code as an attribute
 * alongside its own free-text label. Prefer the label there; the bare code is "OTHER",
 * which says nothing the caller did not already know from the element being absent.
 */
function category(el: Element, codeTag: string, conditionalTag: string): string | undefined {
  const code = childText(el, codeTag);
  if (code) return code;
  const conditional = findTag(el.children, conditionalTag);
  if (!conditional) return;
  return (
    realValue(conditional.attribs.desc?.trim() || undefined) ??
    realValue(conditional.attribs[codeTag]?.trim() || undefined)
  );
}

function parseHolding(el: Element): NportHolding {
  const identifiers = findTag(el.children, 'identifiers');
  return {
    name: childText(el, 'name') ?? '',
    title: childText(el, 'title'),
    cusip: realValue(childText(el, 'cusip')),
    isin: realValue(childAttr(identifiers, 'isin', 'value')),
    lei: realValue(childText(el, 'lei')),
    balance: parseNumber(childText(el, 'balance')),
    units: childText(el, 'units'),
    currency: childText(el, 'curCd'),
    value_usd: parseNumber(childText(el, 'valUSD')),
    percent_of_net_assets: parseNumber(childText(el, 'pctVal')),
    payoff_profile: childText(el, 'payoffProfile'),
    asset_category: category(el, 'assetCat', 'assetConditional'),
    issuer_category: category(el, 'issuerCat', 'issuerConditional'),
    country: realValue(childText(el, 'invCountry')),
  };
}

/** Parse a complete NPORT-P `primary_doc.xml` into fund-level totals plus every position. */
export function parseNportXml(xml: string): ParsedNportReport {
  const doc = parseDocument(xml, { xmlMode: true, decodeEntities: true });
  const genInfo = findTag(doc.children, 'genInfo');
  const fundInfo = findTag(doc.children, 'fundInfo');
  const investments = findTag(doc.children, 'invstOrSecs');

  const isFinal = childText(genInfo, 'isFinalFiling');
  return {
    ...readHeader(doc.children),
    total_assets_usd: parseNumber(childText(fundInfo, 'totAssets')),
    total_liabilities_usd: parseNumber(childText(fundInfo, 'totLiabs')),
    net_assets_usd: parseNumber(childText(fundInfo, 'netAssets')),
    is_final_filing: isFinal === undefined ? undefined : isFinal.toUpperCase() === 'Y',
    // Scope the position scan to invstOrSecs. Several fundInfo sub-blocks (borrowers,
    // securities-lending counterparties) carry a `name` element too, and an unscoped
    // descendant walk would sweep them in as holdings.
    holdings: findTags(investments?.children, 'invstOrSec').map(parseHolding),
  };
}
