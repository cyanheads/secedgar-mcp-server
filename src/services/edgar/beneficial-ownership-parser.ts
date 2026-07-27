/**
 * @fileoverview Parsers for the structured SCHEDULE 13D and SCHEDULE 13G `primary_doc.xml`
 * that SEC began requiring in December 2024. The two forms are separate schemas, not one
 * shape with optional fields: 13D (`.../edgar/schedule13D`) repeats
 * `reportingPersons/reportingPersonInfo` with the power fields flat on each person and the
 * percentage in `percentOfClass`, while 13G (`.../edgar/schedule13g`) repeats
 * `coverPageHeaderReportingPersonDetails` with the power fields nested a level deeper and
 * the percentage in `classPercent`. 13G also has no purpose-of-transaction field at all —
 * its item 4 is structured ownership data, which is what makes it the passive form. Each
 * schema therefore gets its own branch, and {@link parseBeneficialOwnershipXml} dispatches
 * between them. Ownership powers are per reporting person on both forms, including on joint
 * filings, so the parsed owner list is never collapsed to one group total.
 * @module services/edgar/beneficial-ownership-parser
 */

import type { Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { childText, childTexts, findTag, findTags, parseNumber, toIsoDate } from './xml-nodes.js';

/** Which schedule a parsed document came from. 13D is the activist form, 13G the passive one. */
export type BeneficialOwnershipForm = '13D' | '13G';

/** One reporting person's cover-page ownership block. */
export interface BeneficialOwner {
  /** Aggregate amount beneficially owned, in shares. */
  aggregate_amount_owned: number | undefined;
  /** Reporting person's CIK, zero-padded. Absent on every 13G — that schema carries no CIK. */
  cik: string | undefined;
  /** Two-letter SEC citizenship / place-of-organization code (e.g. "DE", "X1"). */
  citizenship: string | undefined;
  /** True when the reported aggregate excludes shares the person disclaims. */
  excludes_certain_shares: boolean | undefined;
  name: string;
  /** The filer's own cover-page footnote, usually the share count the percentage is computed against. */
  notes: string | undefined;
  /** Percent of the class held by THIS person (0-100). Joint filers each report their own. */
  percent_of_class: number | undefined;
  /** SEC type-of-reporting-person codes (IN, CO, PN, IA, …). One person may carry several. */
  person_types: string[];
  shared_dispositive_power: number | undefined;
  shared_voting_power: number | undefined;
  sole_dispositive_power: number | undefined;
  sole_voting_power: number | undefined;
}

/** A parsed SCHEDULE 13D or 13G primary document. */
export interface ParsedBeneficialOwnership {
  /** Amendment sequence number from the cover page. Absent on an original filing. */
  amendment_number: string | undefined;
  /** Date of the event that triggered the filing (YYYY-MM-DD). */
  event_date: string | undefined;
  form: BeneficialOwnershipForm;
  issuer_cik: string | undefined;
  /** CUSIPs of the subject class, as listed on the cover page. */
  issuer_cusips: string[];
  issuer_name: string | undefined;
  owners: BeneficialOwner[];
  /** Item 4 purpose-of-transaction prose. 13D only — 13G has no such field. */
  purpose_of_transaction: string | undefined;
  /** Title of the class of securities the schedule covers. */
  security_class: string | undefined;
}

/** SEC writes these flags as a bare Y/N. Undefined when the element is absent. */
function parseYesNo(value: string | undefined): boolean | undefined {
  if (value === undefined) return;
  const v = value.trim().toUpperCase();
  if (v === 'Y' || v === 'YES' || v === 'TRUE') return true;
  if (v === 'N' || v === 'NO' || v === 'FALSE') return false;
  return;
}

/** Cover-page CUSIPs — `issuerCusips/issuerCusipNumber` (X02) or a bare `issuerCusip` (X01). */
function issuerCusips(cover: Element | undefined): string[] {
  const listed = childTexts(cover, 'issuerCusipNumber');
  if (listed.length > 0) return listed;
  const single = childText(cover, 'issuerCusip');
  return single ? [single] : [];
}

/** Parse one `reportingPersonInfo` block from a SCHEDULE 13D. */
function parse13DOwner(el: Element): BeneficialOwner {
  return {
    cik: childText(el, 'reportingPersonCIK'),
    name: childText(el, 'reportingPersonName') ?? '',
    citizenship: childText(el, 'citizenshipOrOrganization'),
    sole_voting_power: parseNumber(childText(el, 'soleVotingPower')),
    shared_voting_power: parseNumber(childText(el, 'sharedVotingPower')),
    sole_dispositive_power: parseNumber(childText(el, 'soleDispositivePower')),
    shared_dispositive_power: parseNumber(childText(el, 'sharedDispositivePower')),
    aggregate_amount_owned: parseNumber(childText(el, 'aggregateAmountOwned')),
    percent_of_class: parseNumber(childText(el, 'percentOfClass')),
    person_types: childTexts(el, 'typeOfReportingPerson'),
    excludes_certain_shares: parseYesNo(childText(el, 'isAggregateExcludeShares')),
    notes: childText(el, 'commentContent'),
  };
}

/** Parse one `coverPageHeaderReportingPersonDetails` block from a SCHEDULE 13G. */
function parse13GOwner(el: Element): BeneficialOwner {
  // The four power fields sit inside reportingPersonBeneficiallyOwnedNumberOfShares here,
  // one level deeper than on 13D. Scope the lookup to that wrapper so a future sibling
  // element carrying the same tag names cannot be read as this person's powers.
  const powers = findTag(el.children, 'reportingPersonBeneficiallyOwnedNumberOfShares');
  const power = (tag: string) => parseNumber(childText(powers, tag));
  return {
    cik: undefined,
    name: childText(el, 'reportingPersonName') ?? '',
    citizenship: childText(el, 'citizenshipOrOrganization'),
    sole_voting_power: power('soleVotingPower'),
    shared_voting_power: power('sharedVotingPower'),
    sole_dispositive_power: power('soleDispositivePower'),
    shared_dispositive_power: power('sharedDispositivePower'),
    aggregate_amount_owned: parseNumber(
      childText(el, 'reportingPersonBeneficiallyOwnedAggregateNumberOfShares'),
    ),
    percent_of_class: parseNumber(childText(el, 'classPercent')),
    person_types: childTexts(el, 'typeOfReportingPerson'),
    excludes_certain_shares: parseYesNo(childText(el, 'aggregateAmountExcludesCertainSharesFlag')),
    notes: childText(el, 'comments'),
  };
}

/** Parse a SCHEDULE 13D `primary_doc.xml`. */
export function parseSchedule13DXml(xml: string): ParsedBeneficialOwnership {
  const doc = parseDocument(xml, { xmlMode: true, decodeEntities: true });
  const formData = findTag(doc.children, 'formData');
  const cover = findTag(formData?.children, 'coverPageHeader');
  const issuer = findTag(cover?.children, 'issuerInfo');
  const items = findTag(formData?.children, 'items1To7');
  const item4 = findTag(items?.children, 'item4');
  const persons = findTag(formData?.children, 'reportingPersons');

  return {
    form: '13D',
    amendment_number: childText(cover, 'amendmentNo'),
    issuer_cik: childText(issuer, 'issuerCIK'),
    issuer_name: childText(issuer, 'issuerName'),
    issuer_cusips: issuerCusips(cover),
    security_class: childText(cover, 'securitiesClassTitle'),
    event_date: toIsoDate(childText(cover, 'dateOfEvent')),
    purpose_of_transaction: childText(item4, 'transactionPurpose'),
    owners: findTags(persons?.children, 'reportingPersonInfo').map(parse13DOwner),
  };
}

/** Parse a SCHEDULE 13G `primary_doc.xml`. */
export function parseSchedule13GXml(xml: string): ParsedBeneficialOwnership {
  const doc = parseDocument(xml, { xmlMode: true, decodeEntities: true });
  const formData = findTag(doc.children, 'formData');
  const cover = findTag(formData?.children, 'coverPageHeader');
  const issuer = findTag(cover?.children, 'issuerInfo');

  return {
    form: '13G',
    amendment_number: childText(cover, 'amendmentNo'),
    issuer_cik: childText(issuer, 'issuerCik'),
    issuer_name: childText(issuer, 'issuerName'),
    issuer_cusips: issuerCusips(cover),
    security_class: childText(cover, 'securitiesClassTitle'),
    event_date: toIsoDate(childText(cover, 'eventDateRequiresFilingThisStatement')),
    // 13G item 4 is structured ownership data, not prose — there is no purpose to report.
    purpose_of_transaction: undefined,
    owners: findTags(formData?.children, 'coverPageHeaderReportingPersonDetails').map(
      parse13GOwner,
    ),
  };
}

/**
 * Parse a beneficial-ownership `primary_doc.xml`, dispatching to the 13D or 13G branch.
 * The submission type on the header is the primary signal; the repeated reporting-person
 * element is the fallback for a document whose header is missing or unrecognized. Returns
 * `undefined` when neither identifies a schedule, so a caller handed a legacy text filing
 * or an unrelated document gets a miss rather than an empty parse that reads as real.
 */
export function parseBeneficialOwnershipXml(xml: string): ParsedBeneficialOwnership | undefined {
  const kind = detectForm(xml);
  if (!kind) return;
  return kind === '13D' ? parseSchedule13DXml(xml) : parseSchedule13GXml(xml);
}

/**
 * Identify the schedule from the submission type, falling back to whichever repeated
 * reporting-person element the document carries — those two tag names are unique to their
 * schema. A string scan rather than a parse, so dispatch does not build a DOM the chosen
 * branch immediately rebuilds.
 */
function detectForm(xml: string): BeneficialOwnershipForm | undefined {
  const submissionType = xml.match(/<(?:\w+:)?submissionType>\s*([^<]+)</i)?.[1]?.toUpperCase();
  if (submissionType?.includes('13D')) return '13D';
  if (submissionType?.includes('13G')) return '13G';
  if (xml.includes('<reportingPersonInfo')) return '13D';
  if (xml.includes('<coverPageHeaderReportingPersonDetails')) return '13G';
  return;
}

/** Map an EDGAR form name (`SCHEDULE 13G/A`) to its schedule kind. Undefined for anything else. */
export function formNameToSchedule(form: string): BeneficialOwnershipForm | undefined {
  const upper = form.toUpperCase();
  if (!upper.startsWith('SCHEDULE 13')) return;
  if (upper.includes('13D')) return '13D';
  if (upper.includes('13G')) return '13G';
  return;
}
