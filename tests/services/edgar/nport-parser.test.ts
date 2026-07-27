/**
 * @fileoverview Tests for the NPORT-P parser — the cheap header read a series scan depends
 * on, the full report parse, and the two shapes that make a naive parse wrong: a registrant
 * that files as one fund with no series, and fund-level blocks that reuse the `name` element
 * the holdings scan looks for.
 * @module tests/services/edgar/nport-parser
 */

import { describe, expect, it } from 'vitest';
import { parseNportHeader, parseNportXml } from '@/services/edgar/nport-parser.js';

/** Header of a series-trust report, as far as the identity block a routing scan reads. */
const HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/nport">
  <headerData>
    <submissionType>NPORT-P</submissionType>
    <filerInfo>
      <seriesClassInfo>
        <seriesId>S000002839</seriesId>
        <classId>C000007774</classId>
        <classId>C000092055</classId>
      </seriesClassInfo>
    </filerInfo>
  </headerData>
  <formData>
    <genInfo>
      <regName>Vanguard Index Funds</regName>
      <regCik>0000036405</regCik>
      <seriesName>VANGUARD 500 INDEX FUND</seriesName>
      <seriesId>S000002839</seriesId>
      <repPdEnd>2026-12-31</repPdEnd>
      <repPdDate>2026-03-31</repPdDate>
      <isFinalFiling>N</isFinalFiling>
    </genInfo>`;

const FULL = `${HEADER}
    <fundInfo>
      <totAssets>1423980320891.15</totAssets>
      <totLiabs>2717009488.26</totLiabs>
      <netAssets>1421263311402.89</netAssets>
      <securitiesLending>
        <name>COUNTERPARTY BANK NA</name>
        <lei>NOTAHOLDING00000000</lei>
      </securitiesLending>
    </fundInfo>
    <invstOrSecs>
      <invstOrSec>
        <name>NVIDIA Corp</name>
        <lei>549300S4KLFTLO7GSQ80</lei>
        <title>NVIDIA CORP</title>
        <cusip>67066G104</cusip>
        <identifiers><isin value="US67066G1040"/></identifiers>
        <balance>617520783</balance>
        <units>NS</units>
        <curCd>USD</curCd>
        <valUSD>107695624555.20</valUSD>
        <pctVal>7.577500000000</pctVal>
        <payoffProfile>Long</payoffProfile>
        <assetCat>EC</assetCat>
        <issuerCat>CORP</issuerCat>
        <invCountry>US</invCountry>
      </invstOrSec>
      <invstOrSec>
        <name>Cash Collateral Pool</name>
        <balance>1,000,000</balance>
        <units>PA</units>
        <curCd>EUR</curCd>
        <valUSD>1100000</valUSD>
        <pctVal>0.0001</pctVal>
        <assetCat>STIV</assetCat>
      </invstOrSec>
    </invstOrSecs>
  </formData>
</edgarSubmission>`;

/** A registrant organized as a single fund writes "N/A" into the series name element. */
const SERIESLESS = `<?xml version="1.0" encoding="UTF-8"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/nport">
  <headerData><submissionType>NPORT-P</submissionType><filerInfo/></headerData>
  <formData>
    <genInfo>
      <regName>State Street(R) SPDR(R) S&amp;P 500(R) ETF Trust</regName>
      <regCik>0000884394</regCik>
      <seriesName>N/A</seriesName>
      <repPdEnd>2026-09-30</repPdEnd>
      <repPdDate>2026-03-31</repPdDate>
      <isFinalFiling>N</isFinalFiling>
    </genInfo>
    <invstOrSecs/>
  </formData>
</edgarSubmission>`;

/**
 * A commodity-strategy swap and an equity right — the two shapes a naive read gets wrong.
 * The swap fills every identifier element it has nothing for with the literal "N/A" and
 * classifies its issuer through `issuerConditional` with a "N/A" description, so only the
 * bare code survives; the right classifies its asset through `assetConditional`, where the
 * filer's own description is the whole content and the code is just "OTHER".
 */
const CONDITIONAL = `<?xml version="1.0" encoding="UTF-8"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/nport">
  <headerData><submissionType>NPORT-P</submissionType><filerInfo/></headerData>
  <formData>
    <genInfo><regName>Invesco</regName><regCik>0001595386</regCik><repPdDate>2026-03-31</repPdDate></genInfo>
    <invstOrSecs>
      <invstOrSec>
        <name>N/A</name>
        <lei>N/A</lei>
        <title>BOFA MERRILL LYNCH COMMODITY MLBXIVMB EXCESS RETURN STRATEGY</title>
        <cusip>N/A</cusip>
        <identifiers><isin value="N/A"/></identifiers>
        <balance>1.00000000</balance>
        <units>NC</units>
        <curCd>USD</curCd>
        <valUSD>38053753.49</valUSD>
        <pctVal>0.600311428818</pctVal>
        <payoffProfile>N/A</payoffProfile>
        <assetCat>DCO</assetCat>
        <issuerConditional desc="N/A" issuerCat="OTHER"/>
        <invCountry>N/A</invCountry>
      </invstOrSec>
      <invstOrSec>
        <name>Sandisk Corp</name>
        <title>Sandisk Corp Right</title>
        <cusip>80004C204</cusip>
        <identifiers><isin value="US80004C2044"/></identifiers>
        <balance>1200</balance>
        <units>NS</units>
        <curCd>USD</curCd>
        <valUSD>4200</valUSD>
        <pctVal>0.000006</pctVal>
        <payoffProfile>Long</payoffProfile>
        <assetConditional assetCat="OTHER" desc="Right"/>
        <issuerCat>CORP</issuerCat>
        <invCountry>US</invCountry>
      </invstOrSec>
    </invstOrSecs>
  </formData>
</edgarSubmission>`;

describe('parseNportHeader', () => {
  it('reads the series identity from a document cut off after the identity block', () => {
    const header = parseNportHeader(HEADER);
    expect(header.series_id).toBe('S000002839');
    expect(header.series_name).toBe('VANGUARD 500 INDEX FUND');
    expect(header.registrant_cik).toBe('0000036405');
    expect(header.registrant_name).toBe('Vanguard Index Funds');
  });

  it('separates the portfolio date from the fiscal year end', () => {
    const header = parseNportHeader(HEADER);
    expect(header.report_period_date).toBe('2026-03-31');
    expect(header.report_period_end).toBe('2026-12-31');
  });

  it('lists every share class of the series the filing covers', () => {
    expect(parseNportHeader(HEADER).class_ids).toEqual(['C000007774', 'C000092055']);
  });

  it('reports a single-fund registrant as having no series rather than naming it "N/A"', () => {
    const header = parseNportHeader(SERIESLESS);
    expect(header.series_id).toBeUndefined();
    expect(header.series_name).toBeUndefined();
    expect(header.registrant_cik).toBe('0000884394');
  });

  it('prefers the genInfo series id, which a truncated read reaches together with the names', () => {
    const disagreeing = HEADER.replace(
      '<seriesId>S000002839</seriesId>\n        <classId>',
      '<seriesId>S000000001</seriesId>\n        <classId>',
    );
    expect(parseNportHeader(disagreeing).series_id).toBe('S000002839');
  });

  it('falls back to the header block when genInfo has not arrived yet', () => {
    const headerOnly = HEADER.slice(0, HEADER.indexOf('<formData>'));
    expect(parseNportHeader(headerOnly).series_id).toBe('S000002839');
    expect(parseNportHeader(headerOnly).series_name).toBeUndefined();
  });
});

describe('parseNportXml', () => {
  it('carries the fund-level totals', () => {
    const report = parseNportXml(FULL);
    expect(report.net_assets_usd).toBe(1421263311402.89);
    expect(report.total_assets_usd).toBe(1423980320891.15);
    expect(report.total_liabilities_usd).toBe(2717009488.26);
    expect(report.is_final_filing).toBe(false);
  });

  it('scopes positions to invstOrSecs, leaving fund-level counterparty names out', () => {
    const report = parseNportXml(FULL);
    expect(report.holdings).toHaveLength(2);
    expect(report.holdings.map((h) => h.name)).toEqual(['NVIDIA Corp', 'Cash Collateral Pool']);
  });

  it('reads every reported field of a position, ISIN off its value attribute', () => {
    const [nvidia] = parseNportXml(FULL).holdings;
    expect(nvidia).toMatchObject({
      name: 'NVIDIA Corp',
      title: 'NVIDIA CORP',
      cusip: '67066G104',
      isin: 'US67066G1040',
      lei: '549300S4KLFTLO7GSQ80',
      balance: 617520783,
      units: 'NS',
      currency: 'USD',
      value_usd: 107695624555.2,
      percent_of_net_assets: 7.5775,
      payoff_profile: 'Long',
      asset_category: 'EC',
      issuer_category: 'CORP',
      country: 'US',
    });
  });

  it('leaves unreported position fields absent instead of defaulting them', () => {
    const [, cash] = parseNportXml(FULL).holdings;
    expect(cash?.cusip).toBeUndefined();
    expect(cash?.isin).toBeUndefined();
    expect(cash?.lei).toBeUndefined();
    expect(cash?.issuer_category).toBeUndefined();
    expect(cash?.balance).toBe(1000000);
    expect(cash?.currency).toBe('EUR');
  });

  it('reports an empty portfolio as no holdings, with the identity still readable', () => {
    const report = parseNportXml(SERIESLESS);
    expect(report.holdings).toEqual([]);
    expect(report.report_period_date).toBe('2026-03-31');
    expect(report.registrant_name).toBe('State Street(R) SPDR(R) S&P 500(R) ETF Trust');
  });

  it('marks a liquidating fund final when the filer says so', () => {
    const final = FULL.replace('<isFinalFiling>N<', '<isFinalFiling>Y<');
    expect(parseNportXml(final).is_final_filing).toBe(true);
  });

  it('drops the "N/A" a derivative fills its required identifier elements with', () => {
    const [swap] = parseNportXml(CONDITIONAL).holdings;
    expect(swap?.cusip).toBeUndefined();
    expect(swap?.isin).toBeUndefined();
    expect(swap?.lei).toBeUndefined();
    expect(swap?.country).toBeUndefined();
    // The two the filer means literally: "N/A" is a documented payoff profile, and the
    // instrument is named in the title because the issuer element has nothing to hold.
    expect(swap?.payoff_profile).toBe('N/A');
    expect(swap?.name).toBe('N/A');
    expect(swap?.value_usd).toBe(38053753.49);
  });

  it('reads a category the filer reports through the conditional element', () => {
    const [swap, right] = parseNportXml(CONDITIONAL).holdings;
    // The description is the content when there is one; "OTHER" is the fallback.
    expect(right?.asset_category).toBe('Right');
    expect(right?.issuer_category).toBe('CORP');
    expect(swap?.asset_category).toBe('DCO');
    expect(swap?.issuer_category).toBe('OTHER');
  });
});
