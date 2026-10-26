---
name: secedgar-guide
description: Route SEC EDGAR research across the secedgar_* tools — which ownership tool answers each who-holds-what question, where CIKs, accession numbers, CUSIPs, fund series IDs, and filer CIKs come from, how XBRL period keys relate to fiscal years, and the coverage limits to check before calling a filing, figure, or holder absent. Use when answering questions about a company's SEC filings, financials, insiders, institutional or 5% holders, or fund portfolios with secedgar_* tools.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

Every filing on EDGAR from 1993, the XBRL facts filers tag in their financial statements, and the structured ownership disclosures: Form 4, 13F-HR, SCHEDULE 13D/13G, and NPORT-P. Keyless and read-only.

Not here: market prices, quotes, or returns (the only prices are the per-share prices on Form 4 transactions), estimates, and companies that do not file with the SEC. A figure no filer tagged in XBRL, such as anything from before XBRL or a number that appears only in MD&A prose, is read from the filing text with secedgar_get_filing.

## Identifiers

| Identifier | Comes from | Goes to |
|:-----------|:-----------|:--------|
| CIK (up to 10 digits) | secedgar_company_search, from a ticker, name, or CIK | any company, issuer, filer, or fund input, and secedgar_get_filing's `cik` |
| Accession number (`0000320193-23-000106`) | filing rows of secedgar_company_search and secedgar_search_filings, and the `accession_number` on every data row | secedgar_get_filing. Its first ten digits name the submitter, often a filing agent, so never read the company's CIK off it |
| Concept (`eps_diluted`) or raw tag (`NetIncomeLoss`) | secedgar_search_concepts, which also reverse-maps a raw tag to its friendly name | secedgar_get_financials, secedgar_compare_companies, secedgar_fetch_frames |
| Frame period (`CY2024`, `CY2024Q2`, `CY2024Q4I`) | written directly; the `I` suffix marks a balance-sheet instant | secedgar_fetch_frames |
| Filer CIK | rows of secedgar_find_holders | secedgar_get_institutional_holdings, with the same quarter |
| CUSIP (9 characters, one per share class) | positions returned by secedgar_get_institutional_holdings or secedgar_get_fund_holdings; no tool maps a ticker to a CUSIP | secedgar_find_holders, or a quoted term in secedgar_search_filings |
| Fund series ID (`S` plus 9 digits) | secedgar_company_search on a fund ticker, the `series_required` error, or the header of an NPORT-P report | secedgar_get_fund_holdings |
| 8-K item code (`2.02`; legacy `12`) | the `secedgar://filing-types` resource | secedgar_get_material_events |
| `df_<id>` | the `dataset` handle on a data tool's response | secedgar_dataframe_describe, then secedgar_dataframe_query |

## Gates

### Before reporting something absent

- **XBRL tagging phased in from 2009.** Earlier years appear only as comparatives restated in later filings, so they are sparse. No financial facts for a year means the year was never tagged, not that the company did not report the line. Read the 10-K or 10-Q text instead.
- **Foreign private issuers file 20-F or 40-F**, where a domestic company files 10-K, and many report under `ifrs-full`. Check those forms before saying no annual report exists, and on `no_concept_data` retry with the taxonomy its hint names. secedgar_fetch_frames holds no IFRS filers at all, so a cross-company screen silently leaves them out.
- **Structured coverage has start dates.** Form 4 XML starts in mid-2003. SCHEDULE 13D/13G XML starts 2024-12-18; earlier stakes are legacy `SC 13D` / `SC 13G` text filings, so a forms filter spanning that date must list both spellings.
- **Ownership filings lag their period.** A 13F-HR is due 45 days after its quarter ends, so a quarter still inside that window holds only the managers that filed early. An NPORT-P publishes about two months after its period. Managers under $100M in 13(f) securities file no 13F, and a 13F-NT means another manager reported the holdings.
- **Fiscal Q4 is not a quarterly fact.** A quarterly series skips the calendar quarter a filer's fiscal Q4 spans. Derive that quarter as the annual total minus the three reported quarters, as the caveat says, instead of reporting it missing.

### Before stating a number

- **Label each value by its period end, never by `fiscal_year`.** On secedgar_get_financials rows, `fiscal_year` and `fiscal_period` (`source_filing_fy` / `source_filing_fp` in the dataframe) belong to the filing that reported the value, and a restated comparative carries the later filing's year. Key time on `end` (`period_end` in the dataframe).
- **A `CY` key is SEC's calendar frame, not a fiscal-year label.** One column of secedgar_compare_companies holds fiscal years that end on different dates. Name each company's fiscal year from the cell's `period_end`.
- **Derived metrics are not concepts.** Free cash flow is `operating_cash_flow` − `capex`, EBITDA is `operating_income` + `depreciation_amortization`, and working capital is `current_assets` − `current_liabilities`. `debt` is long-term debt only, and no concept gives total debt.
- **Search totals are lower bounds** unless `total_is_exact` is true. Full-text search stops at 10,000 hits, so count a large set by splitting the date range.
- **Check whether a dataframe is complete** before presenting an aggregate as the whole population: secedgar_dataframe_describe reports `truncated`. secedgar_find_holders reads at most 500 13F filings, and secedgar_get_insider_transactions parses at most 100 Form 4 filings.
- **Insider "sale" and "purchase" are open-market trades only** (codes S and P). Tax withholding (F), gifts (G), awards, and exercises appear only under `all`; total every disposal with `direction`. The date bounds filter filing dates, and a Form 4 is filed after its trade, so filter on `transaction_date` for when trades happened and let the window run past the period end.
- **Forms filters differ between tools.** secedgar_company_search matches forms exactly, so `10-K` leaves out `10-K/A`. secedgar_search_filings's `10-K` also returns `10-K/A`. Check a row's form before reading it as the annual report.

## Workflows

### Ownership: which tool answers which question

| Question | Tool, and its input | Notes |
|:---------|:--------------------|:------|
| What did officers, directors, or 10% owners trade? | secedgar_get_insider_transactions, the issuer | Form 4 and 4-A. Forms 3 and 5 only through secedgar_search_filings plus secedgar_get_filing |
| Who holds 5% or more, and with what intent? | secedgar_get_beneficial_owners, the issuer | A 13D states a purpose; a 13G is passive and has none. Percent of class is per reporting person and never sums across a joint filing |
| Which institutional managers hold it? | secedgar_find_holders, the issuer and its CUSIP | Unranked; open a position with secedgar_get_institutional_holdings and the filer CIK for size |
| What does one manager hold? | secedgar_get_institutional_holdings, the manager | Never the issuer: an operating company files no 13F |
| What does one fund hold? | secedgar_get_fund_holdings, the fund ticker or series ID | One series per report; a multi-fund trust needs the series |
| Which funds hold it? | secedgar_search_filings, the CUSIP in quotes as the query and forms `NPORT-P` | No dedicated tool, and the hits are a relevance-ordered sample, not a complete list. Each hit names the registrant trust; the report's header names the series for secedgar_get_fund_holdings |

**Getting a CUSIP.** secedgar_find_holders is precise only with a CUSIP, and a name search both over- and under-matches. Read one off any position that already holds the security: secedgar_get_institutional_holdings for a broad manager such as VANGUARD GROUP INC (CIK `0000102909`; when its latest quarter is a 13F-NT, an earlier quarter still lists the positions), then a query on its dataframe filtering `issuer_name`; or secedgar_get_fund_holdings for a broad index fund such as VOO when the company is in the S&P 500. A multi-class issuer has one CUSIP per class, so run secedgar_find_holders once per class.

### Dataframes

Data tools stage their full result as a `df_<id>` table, named by the response's `dataset` handle, on one canvas that every secedgar_* call shares. Call secedgar_dataframe_describe for the table's column names before writing SQL, then secedgar_dataframe_query with one read-only SELECT. Tables from different tools join where they share a key: 13F positions, NPORT-P positions, and blockholder rows on `cusip`; insider and blockholder rows on `issuer_cik`. Insider rows carry no `cusip` and 13F rows no `issuer_cik`. A table expires a fixed time after it is staged (a day by default), and queries do not extend it; `missing_table` means the source tool has to run again. A deployment without a canvas, such as the MCPB bundle, returns results inline only.
