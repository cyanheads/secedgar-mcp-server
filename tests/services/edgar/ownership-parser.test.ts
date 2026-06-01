/**
 * @fileoverview Tests for ownership-parser — Form 4 and 13F XML parsing.
 * @module tests/services/edgar/ownership-parser
 */

import { describe, expect, it } from 'vitest';
import { parseForm4Xml, parseInfoTableXml } from '@/services/edgar/ownership-parser.js';

// ---------------------------------------------------------------------------
// Form 4 parsing
// ---------------------------------------------------------------------------

const FORM4_SIMPLE = `<?xml version="1.0"?>
<ownershipDocument>
  <schemaVersion>X0609</schemaVersion>
  <documentType>4</documentType>
  <periodOfReport>2026-05-27</periodOfReport>
  <issuer>
    <issuerCik>0000320193</issuerCik>
    <issuerName>Apple Inc.</issuerName>
    <issuerTradingSymbol>AAPL</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0001214128</rptOwnerCik>
      <rptOwnerName>LEVINSON ARTHUR D</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>true</isDirector>
      <isOfficer>false</isOfficer>
      <isTenPercentOwner>false</isTenPercentOwner>
      <isOther>false</isOther>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle>
        <value>Common Stock</value>
      </securityTitle>
      <transactionDate>
        <value>2026-05-27</value>
      </transactionDate>
      <transactionCoding>
        <transactionFormType>4</transactionFormType>
        <transactionCode>S</transactionCode>
        <equitySwapInvolved>0</equitySwapInvolved>
      </transactionCoding>
      <transactionAmounts>
        <transactionShares>
          <value>50000</value>
        </transactionShares>
        <transactionPricePerShare>
          <value>311.02</value>
        </transactionPricePerShare>
        <transactionAcquiredDisposedCode>
          <value>D</value>
        </transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction>
          <value>3764576</value>
        </sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature>
        <directOrIndirectOwnership>
          <value>D</value>
        </directOrIndirectOwnership>
      </ownershipNature>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

const FORM4_GIFT = `<?xml version="1.0"?>
<ownershipDocument>
  <periodOfReport>2026-05-27</periodOfReport>
  <issuer>
    <issuerCik>0000320193</issuerCik>
    <issuerName>Apple Inc.</issuerName>
    <issuerTradingSymbol>AAPL</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0001214128</rptOwnerCik>
      <rptOwnerName>LEVINSON ARTHUR D</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>true</isDirector>
      <isOfficer>false</isOfficer>
      <isTenPercentOwner>false</isTenPercentOwner>
      <isOther>false</isOther>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-05-27</value></transactionDate>
      <transactionCoding>
        <transactionCode>G</transactionCode>
      </transactionCoding>
      <transactionAmounts>
        <transactionShares><value>65000</value></transactionShares>
        <transactionPricePerShare><value>0</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>3699576</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature>
        <directOrIndirectOwnership><value>D</value></directOrIndirectOwnership>
      </ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeHolding>
      <securityTitle><value>Common Stock</value></securityTitle>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>56000</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature>
        <directOrIndirectOwnership><value>I</value></directOrIndirectOwnership>
        <natureOfOwnership><value>By Spouse</value></natureOfOwnership>
      </ownershipNature>
    </nonDerivativeHolding>
  </nonDerivativeTable>
</ownershipDocument>`;

describe('parseForm4Xml', () => {
  it('parses issuer metadata', () => {
    const result = parseForm4Xml(FORM4_SIMPLE);
    expect(result.issuer_cik).toBe('0000320193');
    expect(result.issuer_name).toBe('Apple Inc.');
    expect(result.issuer_ticker).toBe('AAPL');
    expect(result.period_of_report).toBe('2026-05-27');
  });

  it('parses reporting owner', () => {
    const result = parseForm4Xml(FORM4_SIMPLE);
    expect(result.reporting_owners).toHaveLength(1);
    const owner = result.reporting_owners[0];
    expect(owner?.cik).toBe('0001214128');
    expect(owner?.name).toBe('LEVINSON ARTHUR D');
    expect(owner?.is_director).toBe(true);
    expect(owner?.is_officer).toBe(false);
    expect(owner?.is_ten_percent_owner).toBe(false);
  });

  it('parses a sale transaction with negative shares', () => {
    const result = parseForm4Xml(FORM4_SIMPLE);
    expect(result.transactions).toHaveLength(1);
    const tx = result.transactions[0]!;
    expect(tx.transaction_code).toBe('S');
    expect(tx.transaction_type).toBe('sale');
    expect(tx.shares_traded).toBe(-50000); // disposal → negative
    expect(tx.price_per_share).toBe(311.02);
    expect(tx.shares_owned_after).toBe(3764576);
    expect(tx.is_derivative).toBe(false);
    expect(tx.ownership_type).toBe('direct');
    expect(tx.security_title).toBe('Common Stock');
    expect(tx.transaction_date).toBe('2026-05-27');
  });

  it('parses a gift transaction (code G)', () => {
    const result = parseForm4Xml(FORM4_GIFT);
    // Only transactions, not holdings
    expect(result.transactions).toHaveLength(1);
    const tx = result.transactions[0]!;
    expect(tx.transaction_code).toBe('G');
    expect(tx.transaction_type).toBe('gift');
    expect(tx.shares_traded).toBe(-65000); // disposal → negative
    expect(tx.price_per_share).toBe(0);
  });

  it('returns empty transactions for filings with only holdings', () => {
    // A filing with only nonDerivativeHolding (no transactions) produces no transactions
    const holdingOnlyXml = `<?xml version="1.0"?><ownershipDocument>
      <issuer><issuerCik>123</issuerCik><issuerName>Test</issuerName></issuer>
      <reportingOwner><reportingOwnerId><rptOwnerCik>456</rptOwnerCik><rptOwnerName>Test Person</rptOwnerName></reportingOwnerId>
        <reportingOwnerRelationship><isDirector>false</isDirector><isOfficer>false</isOfficer><isTenPercentOwner>false</isTenPercentOwner><isOther>false</isOther></reportingOwnerRelationship>
      </reportingOwner>
      <nonDerivativeTable>
        <nonDerivativeHolding>
          <securityTitle><value>Common Stock</value></securityTitle>
          <postTransactionAmounts><sharesOwnedFollowingTransaction><value>1000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
          <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
        </nonDerivativeHolding>
      </nonDerivativeTable>
    </ownershipDocument>`;
    const result = parseForm4Xml(holdingOnlyXml);
    expect(result.transactions).toHaveLength(0);
  });

  it('handles malformed/empty XML gracefully', () => {
    const result = parseForm4Xml('<ownershipDocument></ownershipDocument>');
    expect(result.issuer_cik).toBe('');
    expect(result.transactions).toHaveLength(0);
    expect(result.reporting_owners).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 13F info table parsing
// ---------------------------------------------------------------------------

const INFO_TABLE_XML = `<?xml version="1.0" ?>
<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
  <infoTable>
    <nameOfIssuer>1 800 FLOWERS COM INC</nameOfIssuer>
    <titleOfClass>CL A</titleOfClass>
    <cusip>68243Q106</cusip>
    <value>412257</value>
    <shrsOrPrnAmt>
      <sshPrnamt>104900</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
    <putCall>Call</putCall>
    <investmentDiscretion>DFND</investmentDiscretion>
    <votingAuthority>
      <Sole>104900</Sole>
      <Shared>0</Shared>
      <None>0</None>
    </votingAuthority>
  </infoTable>
  <infoTable>
    <nameOfIssuer>APPLE INC</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>037833100</cusip>
    <value>5000000</value>
    <shrsOrPrnAmt>
      <sshPrnamt>26000</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
    <investmentDiscretion>SOLE</investmentDiscretion>
    <votingAuthority>
      <Sole>26000</Sole>
      <Shared>0</Shared>
      <None>0</None>
    </votingAuthority>
  </infoTable>
</informationTable>`;

const INFO_TABLE_NS1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ns1:informationTable xmlns:ns1="http://www.sec.gov/edgar/document/thirteenf/informationtable">
  <ns1:infoTable>
    <ns1:nameOfIssuer>Vanguard Index S&amp;P 500 (voo)</ns1:nameOfIssuer>
    <ns1:titleOfClass>ETF</ns1:titleOfClass>
    <ns1:cusip>922908363</ns1:cusip>
    <ns1:value>1347848</ns1:value>
    <ns1:shrsOrPrnAmt>
      <ns1:sshPrnamt>2201</ns1:sshPrnamt>
      <ns1:sshPrnamtType>SH</ns1:sshPrnamtType>
    </ns1:shrsOrPrnAmt>
    <ns1:investmentDiscretion>SOLE</ns1:investmentDiscretion>
    <ns1:votingAuthority>
      <ns1:Sole>2201</ns1:Sole>
      <ns1:Shared>0</ns1:Shared>
      <ns1:None>0</ns1:None>
    </ns1:votingAuthority>
  </ns1:infoTable>
</ns1:informationTable>`;

describe('parseInfoTableXml', () => {
  it('parses multiple holdings rows', () => {
    const result = parseInfoTableXml(INFO_TABLE_XML);
    expect(result.holdings).toHaveLength(2);
  });

  it('parses a Call option row', () => {
    const result = parseInfoTableXml(INFO_TABLE_XML);
    const h = result.holdings[0]!;
    expect(h.issuer_name).toBe('1 800 FLOWERS COM INC');
    expect(h.title_of_class).toBe('CL A');
    expect(h.cusip).toBe('68243Q106');
    expect(h.value_reported).toBe(412257);
    expect(h.shares_or_principal_amount).toBe(104900);
    expect(h.shares_or_principal_type).toBe('SH');
    expect(h.put_call).toBe('Call');
    expect(h.investment_discretion).toBe('DFND');
  });

  it('parses a regular equity row without put/call', () => {
    const result = parseInfoTableXml(INFO_TABLE_XML);
    const h = result.holdings[1]!;
    expect(h.issuer_name).toBe('APPLE INC');
    expect(h.put_call).toBeUndefined();
    expect(h.investment_discretion).toBe('SOLE');
    expect(h.value_reported).toBe(5000000);
  });

  it('handles ns1: namespace prefix variant', () => {
    const result = parseInfoTableXml(INFO_TABLE_NS1);
    expect(result.holdings).toHaveLength(1);
    const h = result.holdings[0]!;
    expect(h.issuer_name).toBe('Vanguard Index S&P 500 (voo)');
    expect(h.cusip).toBe('922908363');
    expect(h.shares_or_principal_amount).toBe(2201);
    expect(h.investment_discretion).toBe('SOLE');
  });

  it('returns empty holdings for empty table', () => {
    const result = parseInfoTableXml(
      '<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable"></informationTable>',
    );
    expect(result.holdings).toHaveLength(0);
  });
});
