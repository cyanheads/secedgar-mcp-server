/**
 * @fileoverview Fetch a specific filing's metadata and document content by accession number.
 * @module mcp-server/tools/definitions/get-filing
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import type { FilingDocumentHeader } from '@/services/edgar/filing-headers.js';
import { filingToText } from '@/services/edgar/filing-to-text.js';
import type { FilingIndex } from '@/services/edgar/types.js';

const MAX_DOCUMENTS_IN_FORMAT = 10;
type FilingIndexItem = FilingIndex['directory']['item'][number];

interface DocumentEntry {
  description?: string | undefined;
  name: string;
  size?: number | undefined;
  type: string;
}

interface CategorizedDocuments {
  auxiliary: DocumentEntry[];
  exhibits: DocumentEntry[];
  primary: DocumentEntry[];
  xbrl?: DocumentEntry[] | undefined;
}

type ResolveOutcome =
  | {
      ok: true;
      cik: string;
      html: string;
      index: FilingIndex;
      /** The document actually fetched (may be an exhibit if `document` param was specified). */
      targetName: string;
      /** The filing's actual primary document (independent of the `document` param). */
      filingPrimaryName: string;
    }
  | {
      ok: false;
      kind: 'document_not_found';
      requestedDocument: string;
      availableDocuments: string[];
    }
  | { ok: false; kind: 'no_documents'; availableDocuments: string[] }
  | { ok: false; kind: 'filing_not_found'; providedCik: string | undefined };

const documentEntrySchema = z
  .object({
    name: z.string().describe('Document filename within the filing archive.'),
    type: z
      .string()
      .describe(
        'SEC document type from the submission header (e.g., "10-K", "EX-21.1", "GRAPHIC", "XML"). When the submission header is unavailable, falls back to a label inferred from the filename for known XBRL artifacts ("XBRL-LINKBASE", "XBRL-INSTANCE", etc.) and "unknown" for everything else.',
      ),
    description: z
      .string()
      .optional()
      .describe(
        'Human-readable description (e.g., "Annual Report", "Subsidiaries of the Registrant"). Absent when SEC published none for this entry.',
      ),
    size: z.number().optional().describe('File size in bytes.'),
  })
  .describe('One document entry from the filing.');

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
        'Company CIK (resolve via secedgar_company_search if you have a ticker or name). Optional but recommended — speeds up archive lookup. If omitted, likely filing CIKs are inferred from SEC search metadata and archive paths.',
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
    include_xbrl: z
      .boolean()
      .default(false)
      .describe(
        'Include XBRL viewer artifacts and machine-readable taxonomy files (R*.htm fragments, *_cal/_def/_lab/_pre.xml linkbases, *_htm.xml inline instance, *.xsd schemas, MetaLinks.json, FilingSummary.xml, Show.js, report.css, *-xbrl.zip, Financial_Report.xlsx, EX-101.* technical exhibits) under documents.xbrl. Off by default — these dominate filing indexes (~100 entries on a typical 10-K) and are rarely relevant when reading filing content.',
      ),
  }),

  output: z.object({
    accession_number: z.string().describe('Filing accession number, normalized to dash format.'),
    form: z
      .string()
      .optional()
      .describe(
        'Form type (e.g., "10-K", "10-Q"). Absent for filings older than the last ~1,000 the company has filed (SEC does not surface metadata for those without a separate fetch).',
      ),
    filing_date: z
      .string()
      .optional()
      .describe(
        'Date the filing was submitted (YYYY-MM-DD). Absent under the same conditions as form.',
      ),
    company_name: z
      .string()
      .optional()
      .describe('Filing entity name. Absent if the CIK did not resolve to a known entity.'),
    cik: z.string().describe('Filing entity CIK, zero-padded to 10 digits.'),
    period_ending: z
      .string()
      .optional()
      .describe(
        'Period the filing reports on (YYYY-MM-DD). Absent under the same conditions as form.',
      ),
    primary_document: z
      .string()
      .describe("Filename of the filing's actual primary document (e.g., the 10-K HTML file)."),
    requested_document: z
      .string()
      .optional()
      .describe(
        'Filename of the specific document requested via the document param. Only present when document differs from primary_document.',
      ),
    documents: z
      .object({
        primary: z
          .array(documentEntrySchema)
          .describe(
            'Primary filing document(s). Typically a single entry whose type matches the form (e.g., "10-K").',
          ),
        exhibits: z
          .array(documentEntrySchema)
          .describe(
            'Filed exhibits (EX-21 subsidiaries, EX-31/32 certifications, EX-99 press releases, etc.). Excludes XBRL technical exhibits (EX-101.*). Identified by the EX- prefix on the document type. Some exhibits may appear under auxiliary when the submission header is unavailable and the filename has no recognizable pattern.',
          ),
        auxiliary: z
          .array(documentEntrySchema)
          .describe(
            "Other supporting documents that aren't the primary, exhibits, or XBRL artifacts (cover pages, audit consent letters, embedded graphics).",
          ),
        xbrl: z
          .array(documentEntrySchema)
          .optional()
          .describe(
            'XBRL viewer artifacts and machine-readable taxonomy files. Only present when include_xbrl=true.',
          ),
      })
      .describe(
        'Filing documents grouped by category. Names from any list are valid values for the document input. XBRL viewer artifacts are suppressed by default; setting include_xbrl=true surfaces them under the xbrl bucket.',
      ),
    content: z.string().describe('Document text content, truncated to content_limit.'),
    content_truncated: z.boolean().describe('True if content was truncated.'),
    content_total_length: z.number().describe('Full document length before truncation.'),
    filing_url: z.string().describe('Direct URL to the filing on SEC.gov.'),
  }),

  async handler(input, ctx) {
    const api = getEdgarApiService();

    const accn = normalizeAccessionNumber(input.accession_number);
    const resolved = await resolveFilingArchive(api, accn, input.cik, input.document);
    if (!resolved.ok) {
      if (resolved.kind === 'document_not_found') {
        throw ctx.fail(
          'document_not_found',
          `Document '${resolved.requestedDocument}' not found in this filing.`,
          {
            requested_document: resolved.requestedDocument,
            available_documents: resolved.availableDocuments,
            recovery: { hint: `Pick one of: ${resolved.availableDocuments.join(', ')}.` },
          },
        );
      }
      if (resolved.kind === 'no_documents') {
        throw ctx.fail('no_documents', `No primary document found in filing ${accn}.`, {
          accession_number: accn,
          available_documents: resolved.availableDocuments,
          recovery: {
            hint: `Specify the document input from: ${resolved.availableDocuments.join(', ')}.`,
          },
        });
      }
      const cikSuffix = resolved.providedCik
        ? ` (CIK ${resolved.providedCik.padStart(10, '0')})`
        : '';
      const recoveryHint = resolved.providedCik
        ? 'Verify the accession number and CIK are correct.'
        : 'Verify the accession number and pass the company CIK explicitly.';
      throw ctx.fail('filing_not_found', `Filing '${accn}' not found${cikSuffix}.`, {
        accession_number: accn,
        cik: resolved.providedCik,
        recovery: { hint: recoveryHint },
      });
    }
    const { cik, index, html, targetName, filingPrimaryName } = resolved;
    const accnNoDashes = accn.replace(/-/g, '');

    const { text, truncated, totalLength } = filingToText(html, input.content_limit);

    // Parallelize: submissions metadata (recent-window enrichment) and submission
    // headers (canonical document types). Headers are best-effort — categorization
    // falls back to name-pattern inference when absent.
    const [submissions, headers] = await Promise.all([
      api.getSubmissions(cik),
      api.tryGetFilingHeaders(cik, accn),
    ]);

    const documents = categorizeDocuments(
      index.directory.item,
      filingPrimaryName,
      headers,
      input.include_xbrl,
    );

    // Enrich with metadata from the recent-submissions window — not every accession lands here
    // (older filings live in paginated archive files), so these fields remain optional.
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
      headersResolved: headers !== null,
    });

    const requestedDocument =
      input.document && input.document !== filingPrimaryName ? input.document : undefined;

    return {
      accession_number: accn,
      form: form || undefined,
      filing_date: filingDate || undefined,
      company_name: submissions.name || undefined,
      cik,
      period_ending: periodEnding,
      primary_document: filingPrimaryName,
      requested_document: requestedDocument,
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

    const docLabel = result.requested_document
      ? `Primary: ${result.primary_document} | Requested: ${result.requested_document}`
      : `Primary: ${result.primary_document}`;
    const meta = `Accession: ${result.accession_number} | ${docLabel} | ${result.content_total_length} chars${result.content_truncated ? ' (truncated)' : ''}`;

    const docs = formatDocumentSection(result.documents);

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
): Promise<ResolveOutcome> {
  const candidateCiks = await resolveCandidateCiks(api, accessionNumber, providedCik);
  let lastIndexedItems: FilingIndexItem[] = [];

  for (const cik of candidateCiks) {
    const index = await api.tryGetFilingIndex(cik, accessionNumber);
    if (!index) continue;

    const items = index.directory.item;
    lastIndexedItems = items;

    // Always resolve the filing's actual primary document independently of what the caller requested.
    const filingPrimaryName = findPrimaryDocument(items);
    if (!filingPrimaryName) continue;

    const targetName = requestedDocument ?? filingPrimaryName;
    if (!items.some((item) => item.name === targetName)) continue;

    const html = await api.tryGetFilingDocument(cik, accessionNumber, targetName);
    if (!html) continue;

    return { ok: true, cik, html, index, targetName, filingPrimaryName };
  }

  const availableDocuments = lastIndexedItems.map((item) => item.name);

  if (requestedDocument && availableDocuments.length > 0) {
    return { ok: false, kind: 'document_not_found', requestedDocument, availableDocuments };
  }
  if (availableDocuments.length > 0) {
    return { ok: false, kind: 'no_documents', availableDocuments };
  }
  return { ok: false, kind: 'filing_not_found', providedCik };
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

/**
 * Categorize filing documents into primary / exhibits / auxiliary / xbrl buckets.
 * Uses canonical SEC TYPE values from the submission header when present, falling
 * back to filename-pattern inference. XBRL viewer artifacts and taxonomy files
 * are suppressed unless `includeXbrl` is true.
 */
function categorizeDocuments(
  items: FilingIndexItem[],
  primaryName: string,
  headers: Map<string, FilingDocumentHeader> | null,
  includeXbrl: boolean,
): CategorizedDocuments {
  const primary: DocumentEntry[] = [];
  const exhibits: DocumentEntry[] = [];
  const auxiliary: DocumentEntry[] = [];
  const xbrl: DocumentEntry[] = [];

  for (const item of items) {
    const header = headers?.get(item.name);
    const type = header?.type ?? inferTypeFromName(item.name);
    const entry: DocumentEntry = {
      name: item.name,
      type,
      description: header?.description,
      size: item.size ? Number.parseInt(item.size, 10) || undefined : undefined,
    };

    if (item.name === primaryName) {
      primary.push(entry);
    } else if (isXbrlArtifact(item.name, type)) {
      xbrl.push(entry);
    } else if (/^EX-/i.test(type)) {
      exhibits.push(entry);
    } else {
      auxiliary.push(entry);
    }
  }

  return includeXbrl ? { primary, exhibits, auxiliary, xbrl } : { primary, exhibits, auxiliary };
}

const XBRL_VIEWER_ASSETS = new Set([
  'MetaLinks.json',
  'Show.js',
  'report.css',
  'Financial_Report.xlsx',
  'FilingSummary.xml',
]);

function isXbrlArtifact(name: string, type: string): boolean {
  if (/^R\d+\.htm$/i.test(name)) return true; // viewer fragments
  if (/_(?:cal|def|lab|pre|sch)\.xml$/i.test(name)) return true; // linkbases
  if (/_htm\.xml$/i.test(name)) return true; // inline XBRL instance
  if (/\.xsd$/i.test(name)) return true; // taxonomy schema
  if (/-xbrl\.zip$/i.test(name)) return true; // packaged XBRL bundle
  if (XBRL_VIEWER_ASSETS.has(name)) return true;
  return /^EX-101/i.test(type); // EX-101.INS / .CAL / .DEF / .LAB / .PRE / .SCH
}

/** Fallback type label when the submission header is unavailable. */
function inferTypeFromName(name: string): string {
  if (/^R\d+\.htm$/i.test(name)) return 'XBRL-VIEWER';
  if (/_(?:cal|def|lab|pre|sch)\.xml$/i.test(name)) return 'XBRL-LINKBASE';
  if (/_htm\.xml$/i.test(name)) return 'XBRL-INSTANCE';
  if (/\.xsd$/i.test(name)) return 'XBRL-SCHEMA';
  if (/-xbrl\.zip$/i.test(name)) return 'XBRL-BUNDLE';
  if (name === 'MetaLinks.json') return 'XBRL-METADATA';
  if (name === 'FilingSummary.xml') return 'FILING-SUMMARY';
  if (name === 'Show.js' || name === 'report.css') return 'XBRL-VIEWER-ASSET';
  if (name === 'Financial_Report.xlsx') return 'FINANCIAL-REPORT';
  return 'unknown';
}

function formatDocumentSection(docs: CategorizedDocuments): string {
  const sections: string[] = [];
  if (docs.primary.length) {
    sections.push(`Primary (${docs.primary.length}): ${formatDocList(docs.primary)}`);
  }
  if (docs.exhibits.length) {
    sections.push(`Exhibits (${docs.exhibits.length}): ${formatDocList(docs.exhibits)}`);
  }
  if (docs.auxiliary.length) {
    sections.push(`Auxiliary (${docs.auxiliary.length}): ${formatDocList(docs.auxiliary)}`);
  }
  if (docs.xbrl?.length) {
    sections.push(`XBRL (${docs.xbrl.length}): ${formatDocList(docs.xbrl)}`);
  }
  return sections.length ? `\n${sections.join('\n')}` : '';
}

function formatDocList(entries: DocumentEntry[]): string {
  const shown = entries.slice(0, MAX_DOCUMENTS_IN_FORMAT);
  const extra = entries.length - shown.length;
  const list = shown
    .map((d) => {
      const tail = [
        d.type,
        d.size !== undefined ? `${d.size}B` : null,
        d.description ? `"${d.description}"` : null,
      ]
        .filter(Boolean)
        .join(', ');
      return `${d.name} [${tail}]`;
    })
    .join(', ');
  return `${list}${extra > 0 ? `, +${extra} more` : ''}`;
}
