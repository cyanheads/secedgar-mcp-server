/**
 * @fileoverview The SEC submission-header parsers: the per-document type map and
 * the submission-level form / filing date / period, read from both header sources —
 * `<accession>-index-headers.html` and the bare `<accession>.hdr.sgml` (#126).
 * @module tests/services/edgar/filing-headers
 */

import { describe, expect, it } from 'vitest';
import { parseFilingHeaders, parseSubmissionHeader } from '@/services/edgar/filing-headers.js';

/** Trimmed from JPMorgan's FY2024 10-K `index-headers.html` (0000019617-25-000270). */
const JPM_INDEX_HEADERS = `<HTML><HEAD><TITLE>SEC EDGAR Submission 0000019617-25-000270</TITLE>
<!--
<SEC-HEADER>0000019617-25-000270.hdr.sgml : 20250214
<ACCEPTANCE-DATETIME>20250214161707
<ACCESSION-NUMBER>0000019617-25-000270
<TYPE>10-K
<PUBLIC-DOCUMENT-COUNT>273
<PERIOD>20241231
<FILING-DATE>20250214
<DATE-OF-FILING-DATE-CHANGE>20250214
<FILER>
<COMPANY-DATA>
<CONFORMED-NAME>JPMORGAN CHASE & CO
<CIK>0000019617
</COMPANY-DATA>
<FILING-VALUES>
<FORM-TYPE>10-K
</FILING-VALUES>
</FILER>
</SEC-HEADER>
-->
</HEAD><BODY>
<PRE>&lt;SEC-DOCUMENT&gt;0000019617-25-000270-index.html : 20250214
&lt;SEC-HEADER&gt;0000019617-25-000270.hdr.sgml : 20250214
CONFORMED SUBMISSION TYPE:	10-K
CONFORMED PERIOD OF REPORT:	20241231
FILED AS OF DATE:		20250214
&lt;/SEC-HEADER&gt;
&lt;DOCUMENT&gt;
&lt;TYPE&gt;10-K
&lt;SEQUENCE&gt;1
&lt;FILENAME&gt;jpm-20241231.htm
&lt;DESCRIPTION&gt;10-K
&lt;TEXT&gt;
&lt;/DOCUMENT&gt;
&lt;DOCUMENT&gt;
&lt;TYPE&gt;EX-4.6
&lt;SEQUENCE&gt;2
&lt;FILENAME&gt;corp10k2024exhibit46.htm
&lt;DESCRIPTION&gt;EX-4.6
&lt;TEXT&gt;
&lt;/DOCUMENT&gt;
&lt;/SEC-DOCUMENT&gt;</PRE></BODY></HTML>`;

/** Apple's 2005 10-K `.hdr.sgml` (0001104659-05-058421), whose index-headers page 404s. */
const APPLE_2005_HDR = `<SEC-HEADER>0001104659-05-058421.hdr.sgml : 20051201
<ACCEPTANCE-DATETIME>20051130212248
<ACCESSION-NUMBER>0001104659-05-058421
<TYPE>10-K
<PUBLIC-DOCUMENT-COUNT>10
<PERIOD>20050924
<FILING-DATE>20051201
<DATE-OF-FILING-DATE-CHANGE>20051130
<FILER>
<COMPANY-DATA>
<CONFORMED-NAME>APPLE COMPUTER INC
<CIK>0000320193
</COMPANY-DATA>
</FILER>
</SEC-HEADER>
`;

/** Apple's 2014 S-8 `.hdr.sgml` (0001193125-14-160171) — no period of report. */
const APPLE_S8_HDR = `<SEC-HEADER>0001193125-14-160171.hdr.sgml : 20140425
<ACCEPTANCE-DATETIME>20140425173048
<ACCESSION-NUMBER>0001193125-14-160171
<TYPE>S-8
<PUBLIC-DOCUMENT-COUNT>4
<FILING-DATE>20140425
<DATE-OF-FILING-DATE-CHANGE>20140425
<EFFECTIVENESS-DATE>20140425
</SEC-HEADER>
`;

describe('parseFilingHeaders', () => {
  it('maps each document to its canonical type', () => {
    const { documents } = parseFilingHeaders(JPM_INDEX_HEADERS);
    expect(documents.get('jpm-20241231.htm')).toEqual({
      type: '10-K',
      sequence: '1',
      description: '10-K',
    });
    expect(documents.get('corp10k2024exhibit46.htm')?.type).toBe('EX-4.6');
    expect(documents.size).toBe(2);
  });

  it('reads the submission-level form, filing date, and period from the raw header', () => {
    expect(parseFilingHeaders(JPM_INDEX_HEADERS).submission).toEqual({
      form: '10-K',
      filingDate: '2025-02-14',
      periodOfReport: '2024-12-31',
    });
  });

  it('returns no documents and no submission fields for a page carrying neither', () => {
    expect(parseFilingHeaders('<html><body>nothing here</body></html>')).toEqual({
      documents: new Map(),
      submission: {},
    });
  });
});

describe('parseSubmissionHeader', () => {
  it('reads a bare .hdr.sgml, taking FILING-DATE rather than the acceptance time', () => {
    expect(parseSubmissionHeader(APPLE_2005_HDR)).toEqual({
      form: '10-K',
      filingDate: '2005-12-01',
      periodOfReport: '2005-09-24',
    });
  });

  it('leaves the period absent for a header with no PERIOD', () => {
    expect(parseSubmissionHeader(APPLE_S8_HDR)).toEqual({
      form: 'S-8',
      filingDate: '2014-04-25',
    });
  });

  it('ignores tags past the end of the submission header', () => {
    const text = `<SEC-HEADER>x\n<FILING-DATE>20200102\n</SEC-HEADER>\n<DOCUMENT>\n<TYPE>EX-99\n<PERIOD>20191231\n</DOCUMENT>`;
    expect(parseSubmissionHeader(text)).toEqual({ filingDate: '2020-01-02' });
  });

  it('drops a malformed date rather than passing it through', () => {
    const text = '<SEC-HEADER>x\n<TYPE>10-K\n<PERIOD>2019-12\n<FILING-DATE>junk\n</SEC-HEADER>';
    expect(parseSubmissionHeader(text)).toEqual({ form: '10-K' });
  });
});
