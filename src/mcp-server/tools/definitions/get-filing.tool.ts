/**
 * @fileoverview Fetch a specific filing's metadata and document content by accession number.
 * @module mcp-server/tools/definitions/get-filing
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { filingToText } from '@/services/edgar/filing-to-text.js';
import type { FilingIndex } from '@/services/edgar/types.js';

const MAX_DOCUMENTS_IN_FORMAT = 10;
type FilingIndexItem = FilingIndex['directory']['item'][number];

export const getFilingTool = tool('secedgar_get_filing', {
  description:
    "Fetch a specific filing's metadata and document content by accession number. Returns the primary document as readable text, with option to fetch specific exhibits.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'document_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'A specific document was requested but not present in the filing archive',
      recovery: 'Pick a name from the available_documents list returned in error data.',
    },
    {
      reason: 'no_documents',
      code: JsonRpcErrorCode.NotFound,
      when: 'Filing index lists items but no fetchable primary document was found',
      recovery: 'Specify a document name from available_documents in error data.',
    },
    {
      reason: 'filing_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No filing matches the accession number under any candidate CIK',
      recovery: 'Verify the accession number and pass the company CIK explicitly.',
    },
  ],

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
        'Company CIK. Optional but recommended — speeds up archive lookup. If omitted, the server resolves likely filing CIKs from SEC search metadata and archive paths.',
      ),
    content_limit: z
      .number()
      .int()
      .min(1000)
      .max(200000)
      .default(50000)
      .describe(
        'Maximum characters of document text to return. 10-K filings can exceed 500,000 characters. Default 50,000 captures ~12,000 words (typically business overview, risk factors, and MD&A). Increase to 200,000 for full financial statements, or decrease for quick summaries.',
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
    form: z
      .string()
      .optional()
      .describe('Form type. Omitted when the filing predates the recent-submissions window.'),
    filing_date: z
      .string()
      .optional()
      .describe('Date filed. Omitted when the filing predates the recent-submissions window.'),
    company_name: z
      .string()
      .optional()
      .describe('Filing entity name, if the CIK resolved to a known entity.'),
    cik: z.string().describe('Company CIK.'),
    period_ending: z.string().optional().describe('Period of report.'),
    primary_document: z.string().describe('Primary document filename.'),
    documents: z
      .array(
        z
          .object({
            name: z.string().describe('Document filename.'),
            type: z.string().describe('Document type.'),
            size: z.number().optional().describe('File size in bytes.'),
          })
          .describe('One document entry from the filing archive index.'),
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

    const accn = normalizeAccessionNumber(input.accession_number);
    const { cik, index, html, targetName } = await resolveFilingArchive(
      api,
      accn,
      input.cik,
      input.document,
    );
    const accnNoDashes = accn.replace(/-/g, '');
    const items = index.directory.item;
    const documents = items.map((item) => ({
      name: item.name,
      type: item.type,
      size: item.size ? Number.parseInt(item.size, 10) : undefined,
    }));

    const { text, truncated, totalLength } = filingToText(html, input.content_limit);

    // Enrich with metadata from the recent-submissions window — not every accession lands here
    // (older filings live in paginated archive files), so these fields remain optional.
    const submissions = await api.getSubmissions(cik);
    const recentAccns = submissions.filings.recent.accessionNumber;
    const idx = recentAccns.indexOf(accn);

    const form = idx >= 0 ? submissions.filings.recent.form[idx] : undefined;
    const filingDate = idx >= 0 ? submissions.filings.recent.filingDate[idx] : undefined;
    const periodEnding =
      idx >= 0 ? submissions.filings.recent.reportDate[idx] || undefined : undefined;

    ctx.log.info('Filing retrieved', {
      accessionNumber: accn,
      cik,
      contentLength: totalLength,
      inRecentWindow: idx >= 0,
    });

    return {
      accession_number: accn,
      form: form || undefined,
      filing_date: filingDate || undefined,
      company_name: submissions.name || undefined,
      cik,
      period_ending: periodEnding,
      primary_document: targetName,
      documents,
      content: text,
      content_truncated: truncated,
      content_total_length: totalLength,
      filing_url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accnNoDashes}/${targetName}`,
    };
  },

  format: (result) => {
    const formLabel = result.form ?? 'Filing';
    const entity = result.company_name ?? 'Unknown entity';
    const header = `**${formLabel}** — ${entity} (CIK ${result.cik})`;

    const filedPart = result.filing_date ? `Filed: ${result.filing_date}` : 'Filed: Unknown';
    const periodPart = result.period_ending ? ` | Period: ${result.period_ending}` : '';
    const dateLine = `${filedPart}${periodPart}`;

    const meta = `Accession: ${result.accession_number} | Primary: ${result.primary_document} | ${result.content_total_length} chars${result.content_truncated ? ' (truncated)' : ''}`;

    let docs = '';
    if (result.documents.length) {
      const shown = result.documents.slice(0, MAX_DOCUMENTS_IN_FORMAT);
      const extra = result.documents.length - shown.length;
      const list = shown
        .map((d) => `${d.name} (${d.type}${d.size !== undefined ? `, ${d.size}B` : ''})`)
        .join(', ');
      docs = `\nDocuments (${result.documents.length}): ${list}${extra > 0 ? `, +${extra} more` : ''}`;
    }

    const url = `\nURL: ${result.filing_url}`;
    return [
      { type: 'text', text: `${header}\n${dateLine}\n${meta}${docs}${url}\n\n${result.content}` },
    ];
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

async function resolveFilingArchive(
  api: ReturnType<typeof getEdgarApiService>,
  accessionNumber: string,
  providedCik: string | undefined,
  requestedDocument: string | undefined,
): Promise<{ cik: string; html: string; index: FilingIndex; targetName: string }> {
  const candidateCiks = await resolveCandidateCiks(api, accessionNumber, providedCik);
  let lastIndexedItems: FilingIndexItem[] = [];

  for (const cik of candidateCiks) {
    const index = await api.tryGetFilingIndex(cik, accessionNumber);
    if (!index) continue;

    const items = index.directory.item;
    lastIndexedItems = items;

    const targetName = requestedDocument ?? findPrimaryDocument(items);
    if (!targetName) continue;
    if (!items.some((item) => item.name === targetName)) continue;

    const html = await api.tryGetFilingDocument(cik, accessionNumber, targetName);
    if (!html) continue;

    return { cik, html, index, targetName };
  }

  const availableDocuments = lastIndexedItems.map((item) => item.name);

  if (requestedDocument && availableDocuments.length > 0) {
    throw new McpError(
      JsonRpcErrorCode.NotFound,
      `Document '${requestedDocument}' not found in this filing.`,
      {
        reason: 'document_not_found',
        requested_document: requestedDocument,
        available_documents: availableDocuments,
        recovery: {
          hint: `Pick one of: ${availableDocuments.join(', ')}.`,
        },
      },
    );
  }

  if (availableDocuments.length > 0) {
    throw new McpError(
      JsonRpcErrorCode.NotFound,
      `No primary document found in filing ${accessionNumber}.`,
      {
        reason: 'no_documents',
        accession_number: accessionNumber,
        available_documents: availableDocuments,
        recovery: {
          hint: `Specify the document input from: ${availableDocuments.join(', ')}.`,
        },
      },
    );
  }

  const cikSuffix = providedCik ? ` (CIK ${providedCik.padStart(10, '0')})` : '';
  const recoveryHint = providedCik
    ? 'Verify the accession number and CIK are correct.'
    : 'Verify the accession number and pass the company CIK explicitly.';
  throw new McpError(
    JsonRpcErrorCode.NotFound,
    `Filing '${accessionNumber}' not found${cikSuffix}.`,
    {
      reason: 'filing_not_found',
      accession_number: accessionNumber,
      cik: providedCik,
      recovery: { hint: recoveryHint },
    },
  );
}

async function resolveCandidateCiks(
  api: ReturnType<typeof getEdgarApiService>,
  accessionNumber: string,
  providedCik: string | undefined,
): Promise<string[]> {
  if (providedCik) return [providedCik.padStart(10, '0')];

  const ciks = await api.findFilingCiks(accessionNumber);
  const prefixCik = (accessionNumber.split('-')[0] ?? accessionNumber.slice(0, 10)).padStart(
    10,
    '0',
  );

  return [...new Set([...ciks, prefixCik])];
}

/** Find the primary document in a filing index (prefer real filing docs over SEC index pages). */
function findPrimaryDocument(items: FilingIndexItem[]): string | undefined {
  const htmlDocs = items.filter(
    (item) =>
      isNonIndexFile(item.name) &&
      (item.name.endsWith('.htm') || item.name.endsWith('.html')) &&
      !item.name.startsWith('R'),
  );
  if (htmlDocs.length > 0) return getLargestDocument(htmlDocs)?.name;

  const xmlDocs = items.filter(
    (item) =>
      isNonIndexFile(item.name) && item.name.endsWith('.xml') && !isXbrlSupportFile(item.name),
  );
  if (xmlDocs.length > 0) return getLargestDocument(xmlDocs)?.name;

  const textDocs = items.filter((item) => isNonIndexFile(item.name) && item.name.endsWith('.txt'));
  if (textDocs.length > 0) return getLargestDocument(textDocs)?.name;

  return items.find((item) => isNonIndexFile(item.name))?.name ?? items[0]?.name;
}

function getLargestDocument(items: FilingIndexItem[]): FilingIndexItem | undefined {
  return [...items].sort(
    (a, b) => (Number.parseInt(b.size, 10) || 0) - (Number.parseInt(a.size, 10) || 0),
  )[0];
}

function isNonIndexFile(name: string): boolean {
  return !name.toLowerCase().includes('index');
}

function isXbrlSupportFile(name: string): boolean {
  return /(?:_cal|_def|_lab|_pre|_sch)\.xml$/i.test(name);
}
