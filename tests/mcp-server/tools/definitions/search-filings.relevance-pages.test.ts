/**
 * @fileoverview Page boundaries of `secedgar_search_filings` under sort=relevance:
 *   EDGAR pages server-side by matching document, so each page lists the filings of
 *   its own `limit` documents and stepping offset by limit shows a filing again only
 *   when its matching documents straddle a page edge (#124).
 * @module tests/mcp-server/tools/definitions/search-filings.relevance-pages
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchFilingsTool } from '@/mcp-server/tools/definitions/search-filings.tool.js';

vi.mock('@/services/edgar/edgar-api-service.js', async (importActual) => ({
  ...(await importActual<typeof import('@/services/edgar/edgar-api-service.js')>()),
  getEdgarApiService: vi.fn(),
  initEdgarApiService: vi.fn(),
}));

vi.mock('@/services/canvas-bridge/canvas-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/canvas-bridge/canvas-bridge.js')>()),
  getCanvasBridge: vi.fn(),
}));

import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { getEdgarApiService } from '@/services/edgar/edgar-api-service.js';
import { blockText } from '../../../support/assertions.js';

/** One matching document as an EFTS hit; `id` is `<accession>:<filename>`. */
function documentHit(id: string) {
  const [accession = ''] = id.split(':');
  return {
    _id: id,
    _source: {
      adsh: accession,
      form: '8-K',
      file_type: id.endsWith('ex99.htm') ? 'EX-99.1' : '8-K',
      file_date: '2025-04-02',
      display_names: ['Example Corp  (EXMP)  (CIK 0000000001)'],
      ciks: ['0000000001'],
    },
  };
}

/**
 * Six matching documents of three filings, in rank order: each filing's body and its
 * press-release exhibit both match.
 */
const RANKED = [
  '0000000001-25-000001:a8k.htm',
  '0000000001-25-000001:aex99.htm',
  '0000000001-25-000002:b8k.htm',
  '0000000001-25-000002:bex99.htm',
  '0000000001-25-000003:c8k.htm',
  '0000000001-25-000003:cex99.htm',
].map(documentHit);

/** EFTS ignores `size`: it answers up to 100 documents from `from`, whatever was asked. */
const searchFilings = vi.fn(async ({ from = 0 }: { from?: number }) => ({
  hits: {
    total: { value: RANKED.length, relation: 'eq' },
    hits: RANKED.slice(from, from + 100),
  },
}));

type SearchContent = ReturnType<typeof searchFilingsTool.output.parse>;

const page = async (offset: number) => {
  const result = await runToolContract(searchFilingsTool, {
    query: 'tariff',
    sort: 'relevance',
    limit: 2,
    offset,
  } as never);
  return { result, out: result.structuredContent as SearchContent };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEdgarApiService).mockReturnValue({ searchFilings } as never);
  vi.mocked(getCanvasBridge).mockReturnValue(undefined);
});

describe('searchFilingsTool — sort=relevance pages (#124)', () => {
  it('lists the filings of the first limit documents only', async () => {
    const { result, out } = await page(0);

    expect(searchFilings).toHaveBeenCalledWith(expect.objectContaining({ from: 0, size: 2 }));
    expect(out.results.map((r) => r.accession_number)).toEqual(['0000000001-25-000001']);
    expect(out.results[0]?.matched_documents).toEqual([
      { name: 'a8k.htm', type: '8-K' },
      { name: 'aex99.htm', type: 'EX-99.1' },
    ]);
    // The window held every match, so total still counts all three filings.
    expect(out.total).toBe(3);
    expect(out.total_is_exact).toBe(true);
    const text = blockText(result.content);
    expect(text).toContain('[0000000001-25-000001]');
    expect(text).not.toContain('[0000000001-25-000002]');
  });

  it('shows each filing once when stepping offset by limit and no filing straddles an edge', async () => {
    const seen: string[] = [];
    for (const offset of [0, 2, 4]) {
      const { out } = await page(offset);
      seen.push(...out.results.map((r) => r.accession_number));
    }

    expect(seen).toEqual(['0000000001-25-000001', '0000000001-25-000002', '0000000001-25-000003']);
  });

  it('shows a filing on both pages when its matching documents straddle the edge', async () => {
    const pages: string[][] = [];
    for (const offset of [1, 3]) {
      const { out } = await page(offset);
      pages.push(out.results.map((r) => r.accession_number));
    }

    // Documents 1–2 hold filings 1 and 2; documents 3–4 hold filings 2 and 3.
    expect(pages).toEqual([
      ['0000000001-25-000001', '0000000001-25-000002'],
      ['0000000001-25-000002', '0000000001-25-000003'],
    ]);
  });
});
