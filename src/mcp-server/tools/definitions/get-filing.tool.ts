/**
 * @fileoverview Fetch a specific filing's metadata and document content by accession number.
 * @module mcp-server/tools/definitions/get-filing
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { filingToText } from '@/services/edgar/filing-to-text.js';

export const getFilingTool = tool('secedgar_get_filing', {
  description:
    "Fetch a specific filing's metadata and document content by accession number. " +
    'Returns the primary document as readable text, with option to fetch specific exhibits.',
  annotations: { readOnlyHint: true },

  input: z.object({
    accession_number: z
      .string()
      .describe(
        'Filing accession number in either format: "0000320193-23-000106" (dashes) or "000032019323000106" (no dashes). Obtained from secedgar_company_search or secedgar_search_filings results.',
      ),
    cik: z
      .string()
      .optional()
      .describe(
        'Company CIK. Optional but recommended — speeds up URL construction. If omitted, derived from the accession number prefix.',
      ),
    content_limit: z
      .number()
      .int()
      .min(1000)
      .max(200000)
      .default(50000)
      .describe(
        'Maximum characters of document text to return. 10-K filings can exceed 500,000 characters. ' +
          'Default 50,000 captures ~12,000 words (typically business overview, risk factors, and MD&A). ' +
          'Increase to 200,000 for full financial statements, or decrease for quick summaries.',
      ),
    document: z
      .string()
      .optional()
      .describe(
        'Specific document filename within the filing (e.g., "ex-21.htm" for subsidiaries list). Default: the primary document. Available documents listed in the response metadata.',
      ),
  }),

  output: z.object({
    accession_number: z.string().describe('Filing accession number.'),
    form: z.string().describe('Form type.'),
    filing_date: z.string().describe('Date filed.'),
    company_name: z.string().describe('Filing entity name.'),
    cik: z.string().describe('Company CIK.'),
    period_ending: z.string().optional().describe('Period of report.'),
    primary_document: z.string().describe('Primary document filename.'),
    documents: z
      .array(
        z.object({
          name: z.string().describe('Document filename.'),
          type: z.string().describe('Document type.'),
          size: z.number().optional().describe('File size in bytes.'),
        }),
      )
      .describe(
        'All documents in this filing. Use the name field with the document input param to fetch exhibits.',
      ),
    content: z.string().describe('Document text content, truncated to content_limit.'),
    content_truncated: z.boolean().describe('True if content was truncated.'),
    content_total_length: z.number().describe('Full document length before truncation.'),
    filing_url: z.string().describe('Direct URL to the filing on SEC.gov.'),
  }),

  async handler(input, ctx) {
    const api = getEdgarApiService();

    // Normalize accession number to dash format
    const accn = normalizeAccessionNumber(input.accession_number);
    const accnNoDashes = accn.replace(/-/g, '');

    // Derive CIK from accession number prefix if not provided
    const cik = input.cik ?? accn.split('-')[0] ?? accn.slice(0, 10);
    const paddedCik = cik.padStart(10, '0');

    // Fetch filing index
    const index = await api.getFilingIndex(paddedCik, accn);

    const items = index.directory.item;
    const documents = items.map((item) => ({
      name: item.name,
      type: item.type,
      size: item.size ? Number.parseInt(item.size, 10) : undefined,
    }));

    // Find the target document
    const targetName = input.document || findPrimaryDocument(items);
    if (!targetName) {
      throw notFound(
        `No document found in filing ${accn}. Available documents: ${items.map((i) => i.name).join(', ')}`,
      );
    }

    const docExists = items.some((i) => i.name === targetName);
    if (!docExists) {
      throw notFound(
        `Document '${targetName}' not found in this filing. Available documents: ${items.map((i) => i.name).join(', ')}. Use one of these names.`,
      );
    }

    // Fetch and convert document
    const html = await api.getFilingDocument(paddedCik, accn, targetName);
    const { text, truncated, totalLength } = filingToText(html, input.content_limit);

    // Get filing metadata from submissions
    let form = '';
    let filingDate = '';
    let companyName = '';
    let periodEnding: string | undefined;

    // Try to get metadata from the index page or a quick submissions lookup
    const submissions = await api.getSubmissions(paddedCik);
    companyName = submissions.name;

    const recentAccns = submissions.filings.recent.accessionNumber;
    const idx = recentAccns.indexOf(accn);
    if (idx >= 0) {
      form = submissions.filings.recent.form[idx] ?? '';
      filingDate = submissions.filings.recent.filingDate[idx] ?? '';
      periodEnding = submissions.filings.recent.reportDate[idx] || undefined;
    }

    ctx.log.info('Filing retrieved', {
      accessionNumber: accn,
      cik: paddedCik,
      contentLength: totalLength,
    });

    return {
      accession_number: accn,
      form,
      filing_date: filingDate,
      company_name: companyName,
      cik: paddedCik,
      period_ending: periodEnding,
      primary_document: targetName,
      documents,
      content: text,
      content_truncated: truncated,
      content_total_length: totalLength,
      filing_url: `https://www.sec.gov/Archives/edgar/data/${paddedCik}/${accnNoDashes}/${targetName}`,
    };
  },

  format: (result) => {
    const header = `**${result.form}** — ${result.company_name} (${result.filing_date})`;
    const meta = `Accession: ${result.accession_number} | ${result.content_total_length.toLocaleString()} chars${result.content_truncated ? ' (truncated)' : ''}`;
    return [{ type: 'text', text: `${header}\n${meta}\n\n${result.content}` }];
  },
});

/** Normalize accession number to dash format (0000320193-23-000106). */
function normalizeAccessionNumber(input: string): string {
  const cleaned = input.replace(/[^0-9-]/g, '');
  if (cleaned.includes('-')) return cleaned;
  // Convert 18-digit no-dash format to dash format
  if (cleaned.length === 18) {
    return `${cleaned.slice(0, 10)}-${cleaned.slice(10, 12)}-${cleaned.slice(12)}`;
  }
  return cleaned;
}

/** Find the primary document in a filing index (typically the largest .htm file). */
function findPrimaryDocument(
  items: Array<{ name: string; type: string; size: string }>,
): string | undefined {
  // Prefer .htm/.html files, skip index files
  const htmlDocs = items.filter(
    (i) =>
      (i.name.endsWith('.htm') || i.name.endsWith('.html')) &&
      !i.name.includes('index') &&
      !i.name.startsWith('R'),
  );

  if (htmlDocs.length === 0) return items[0]?.name;

  // Return the largest HTML file (likely the primary document)
  const sorted = htmlDocs.sort(
    (a, b) => (Number.parseInt(b.size, 10) || 0) - (Number.parseInt(a.size, 10) || 0),
  );
  return sorted[0]?.name;
}
