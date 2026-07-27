/**
 * @fileoverview Tests for the SCHEDULE 13D / 13G parsers. The two forms are separate
 * schemas, so the coverage that matters is where they diverge: the percentage element name,
 * the nesting depth of the power fields, the CIK 13G never carries, and the
 * purpose-of-transaction item that exists only on 13D. Joint filings are the normal case,
 * so per-person reporting is asserted on both branches.
 * @module tests/services/edgar/beneficial-ownership-parser
 */

import { describe, expect, it } from 'vitest';
import {
  formNameToSchedule,
  parseBeneficialOwnershipXml,
  parseSchedule13DXml,
  parseSchedule13GXml,
} from '@/services/edgar/beneficial-ownership-parser.js';

const THIRTEEN_D = `<?xml version="1.0" encoding="UTF-8"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/schedule13D">
  <headerData><submissionType>SCHEDULE 13D</submissionType></headerData>
  <formData>
    <coverPageHeader>
      <amendmentNo>2</amendmentNo>
      <issuerInfo>
        <issuerCIK>0001906364</issuerCIK>
        <issuerName>BOXABL Inc.</issuerName>
      </issuerInfo>
      <issuerCusips><issuerCusipNumber>10316W107</issuerCusipNumber></issuerCusips>
      <securitiesClassTitle>Class A Common Stock</securitiesClassTitle>
      <dateOfEvent>07/17/2026</dateOfEvent>
    </coverPageHeader>
    <reportingPersons>
      <reportingPersonInfo>
        <reportingPersonCIK>0001996026</reportingPersonCIK>
        <reportingPersonName>Paolo Tiramani</reportingPersonName>
        <citizenshipOrOrganization>X1</citizenshipOrOrganization>
        <soleVotingPower>172470048</soleVotingPower>
        <sharedVotingPower>0</sharedVotingPower>
        <soleDispositivePower>172470048</soleDispositivePower>
        <sharedDispositivePower>0</sharedDispositivePower>
        <aggregateAmountOwned>172470048</aggregateAmountOwned>
        <percentOfClass>94.8</percentOfClass>
        <typeOfReportingPerson>IN</typeOfReportingPerson>
        <isAggregateExcludeShares>Y</isAggregateExcludeShares>
        <commentContent>Includes Class B conversion shares.</commentContent>
      </reportingPersonInfo>
      <reportingPersonInfo>
        <reportingPersonCIK>0001996021</reportingPersonCIK>
        <reportingPersonName>Galiano Tiramani</reportingPersonName>
        <citizenshipOrOrganization>X1</citizenshipOrOrganization>
        <soleVotingPower>59613662</soleVotingPower>
        <sharedVotingPower>439019</sharedVotingPower>
        <soleDispositivePower>59613662</soleDispositivePower>
        <sharedDispositivePower>439019</sharedDispositivePower>
        <aggregateAmountOwned>60052681</aggregateAmountOwned>
        <percentOfClass>86.5</percentOfClass>
        <typeOfReportingPerson>IN</typeOfReportingPerson>
        <typeOfReportingPerson>OO</typeOfReportingPerson>
        <isAggregateExcludeShares>N</isAggregateExcludeShares>
      </reportingPersonInfo>
    </reportingPersons>
    <items1To7>
      <item4><transactionPurpose>The Reporting Person may seek board representation.</transactionPurpose></item4>
    </items1To7>
  </formData>
</edgarSubmission>`;

const THIRTEEN_G = `<?xml version="1.0" encoding="UTF-8"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/schedule13g">
  <headerData><submissionType>SCHEDULE 13G/A</submissionType></headerData>
  <formData>
    <coverPageHeader>
      <amendmentNo>11</amendmentNo>
      <issuerInfo>
        <issuerCik>0000320193</issuerCik>
        <issuerName>Apple Inc.</issuerName>
      </issuerInfo>
      <issuerCusip>037833100</issuerCusip>
      <securitiesClassTitle>Common Stock</securitiesClassTitle>
      <eventDateRequiresFilingThisStatement>03/31/2026</eventDateRequiresFilingThisStatement>
    </coverPageHeader>
    <coverPageHeaderReportingPersonDetails>
      <reportingPersonName>Vanguard Capital Management</reportingPersonName>
      <citizenshipOrOrganization>PA</citizenshipOrOrganization>
      <reportingPersonBeneficiallyOwnedNumberOfShares>
        <soleVotingPower>145321305</soleVotingPower>
        <sharedVotingPower>0</sharedVotingPower>
        <soleDispositivePower>1099168953</soleDispositivePower>
        <sharedDispositivePower>0</sharedDispositivePower>
      </reportingPersonBeneficiallyOwnedNumberOfShares>
      <reportingPersonBeneficiallyOwnedAggregateNumberOfShares>1099168953</reportingPersonBeneficiallyOwnedAggregateNumberOfShares>
      <classPercent>7.48</classPercent>
      <typeOfReportingPerson>IA</typeOfReportingPerson>
      <aggregateAmountExcludesCertainSharesFlag>N</aggregateAmountExcludesCertainSharesFlag>
      <comments>Held across advised funds.</comments>
    </coverPageHeaderReportingPersonDetails>
    <coverPageHeaderReportingPersonDetails>
      <reportingPersonName>Vanguard Fiduciary Trust</reportingPersonName>
      <citizenshipOrOrganization>PA</citizenshipOrOrganization>
      <reportingPersonBeneficiallyOwnedNumberOfShares>
        <soleVotingPower>10</soleVotingPower>
        <sharedVotingPower>20</sharedVotingPower>
        <soleDispositivePower>30</soleDispositivePower>
        <sharedDispositivePower>40</sharedDispositivePower>
      </reportingPersonBeneficiallyOwnedNumberOfShares>
      <reportingPersonBeneficiallyOwnedAggregateNumberOfShares>100</reportingPersonBeneficiallyOwnedAggregateNumberOfShares>
      <classPercent>0.01</classPercent>
      <typeOfReportingPerson>BK</typeOfReportingPerson>
    </coverPageHeaderReportingPersonDetails>
  </formData>
</edgarSubmission>`;

describe('parseSchedule13DXml', () => {
  it('reads the cover page, normalizing the MM/DD/YYYY event date', () => {
    const parsed = parseSchedule13DXml(THIRTEEN_D);
    expect(parsed.form).toBe('13D');
    expect(parsed.issuer_cik).toBe('0001906364');
    expect(parsed.issuer_name).toBe('BOXABL Inc.');
    expect(parsed.issuer_cusips).toEqual(['10316W107']);
    expect(parsed.security_class).toBe('Class A Common Stock');
    expect(parsed.event_date).toBe('2026-07-17');
    expect(parsed.amendment_number).toBe('2');
  });

  it('keeps each reporting person separate rather than collapsing a joint filing', () => {
    const owners = parseSchedule13DXml(THIRTEEN_D).owners;
    expect(owners).toHaveLength(2);
    expect(owners.map((o) => o.percent_of_class)).toEqual([94.8, 86.5]);
    expect(owners.map((o) => o.name)).toEqual(['Paolo Tiramani', 'Galiano Tiramani']);
  });

  it('reads the four power fields flat on the person and the 13D percent element', () => {
    const [first] = parseSchedule13DXml(THIRTEEN_D).owners;
    expect(first).toMatchObject({
      cik: '0001996026',
      citizenship: 'X1',
      sole_voting_power: 172470048,
      shared_voting_power: 0,
      sole_dispositive_power: 172470048,
      shared_dispositive_power: 0,
      aggregate_amount_owned: 172470048,
      percent_of_class: 94.8,
      excludes_certain_shares: true,
      notes: 'Includes Class B conversion shares.',
    });
  });

  it('carries several reporting-person type codes for one person', () => {
    const [, second] = parseSchedule13DXml(THIRTEEN_D).owners;
    expect(second?.person_types).toEqual(['IN', 'OO']);
    expect(second?.excludes_certain_shares).toBe(false);
  });

  it('carries the item 4 purpose-of-transaction prose', () => {
    expect(parseSchedule13DXml(THIRTEEN_D).purpose_of_transaction).toBe(
      'The Reporting Person may seek board representation.',
    );
  });
});

describe('parseSchedule13GXml', () => {
  it('reads the cover page off the 13G element names, which differ in case and spelling', () => {
    const parsed = parseSchedule13GXml(THIRTEEN_G);
    expect(parsed.form).toBe('13G');
    expect(parsed.issuer_cik).toBe('0000320193');
    expect(parsed.issuer_cusips).toEqual(['037833100']);
    expect(parsed.event_date).toBe('2026-03-31');
    expect(parsed.amendment_number).toBe('11');
  });

  it('reads the percentage from classPercent, the element 13D does not use', () => {
    expect(parseSchedule13GXml(THIRTEEN_G).owners.map((o) => o.percent_of_class)).toEqual([
      7.48, 0.01,
    ]);
  });

  it('reads the power fields from the wrapper they nest inside on this form', () => {
    const [, second] = parseSchedule13GXml(THIRTEEN_G).owners;
    expect(second).toMatchObject({
      sole_voting_power: 10,
      shared_voting_power: 20,
      sole_dispositive_power: 30,
      shared_dispositive_power: 40,
      aggregate_amount_owned: 100,
    });
  });

  it('reports no CIK, because the 13G cover page has no such field', () => {
    expect(parseSchedule13GXml(THIRTEEN_G).owners.every((o) => o.cik === undefined)).toBe(true);
  });

  it('reports no purpose of transaction — 13G has no such item at all', () => {
    expect(parseSchedule13GXml(THIRTEEN_G).purpose_of_transaction).toBeUndefined();
  });

  it('leaves an unanswered exclusion flag absent rather than reading it as false', () => {
    const [, second] = parseSchedule13GXml(THIRTEEN_G).owners;
    expect(second?.excludes_certain_shares).toBeUndefined();
  });
});

describe('parseBeneficialOwnershipXml', () => {
  it('dispatches on the submission type', () => {
    expect(parseBeneficialOwnershipXml(THIRTEEN_D)?.form).toBe('13D');
    expect(parseBeneficialOwnershipXml(THIRTEEN_G)?.form).toBe('13G');
  });

  it('falls back to the repeated reporting-person element when the header is missing', () => {
    const headerless = THIRTEEN_G.replace(
      '<headerData><submissionType>SCHEDULE 13G/A</submissionType></headerData>',
      '',
    );
    const parsed = parseBeneficialOwnershipXml(headerless);
    expect(parsed?.form).toBe('13G');
    expect(parsed?.owners).toHaveLength(2);
  });

  it('returns undefined for a document that is neither schedule', () => {
    expect(
      parseBeneficialOwnershipXml('<ownershipDocument><issuer/></ownershipDocument>'),
    ).toBeUndefined();
  });
});

describe('formNameToSchedule', () => {
  it('maps the structured form names, amendments included', () => {
    expect(formNameToSchedule('SCHEDULE 13D')).toBe('13D');
    expect(formNameToSchedule('SCHEDULE 13D/A')).toBe('13D');
    expect(formNameToSchedule('SCHEDULE 13G')).toBe('13G');
    expect(formNameToSchedule('schedule 13g/a')).toBe('13G');
  });

  it('rejects the legacy names, which carry no parseable XML', () => {
    expect(formNameToSchedule('SC 13D')).toBeUndefined();
    expect(formNameToSchedule('SC 13G/A')).toBeUndefined();
  });

  it('rejects unrelated forms', () => {
    expect(formNameToSchedule('13F-HR')).toBeUndefined();
    expect(formNameToSchedule('10-K')).toBeUndefined();
  });
});
