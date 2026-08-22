/**
 * @fileoverview Tests for search-concepts tool — XBRL concept discovery.
 * @module tests/mcp-server/tools/definitions/search-concepts.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { searchConceptsTool } from '@/mcp-server/tools/definitions/search-concepts.tool.js';
import { blockAt, blockText } from '../../../support/assertions.js';

describe('searchConceptsTool', () => {
  it('returns concepts for a keyword match', async () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ search: 'revenue' });
    const result = await searchConceptsTool.handler(input, ctx);

    expect(result.total).toBeGreaterThan(0);
    expect(result.concepts.length).toBe(result.total);
  });

  it('returns full catalog when search is empty', async () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({});
    const result = await searchConceptsTool.handler(input, ctx);

    expect(result.total).toBeGreaterThan(0);
  });

  it('filters by group', async () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ group: 'income_statement' });
    const result = await searchConceptsTool.handler(input, ctx);

    expect(result.total).toBeGreaterThan(0);
    expect(result.concepts.every((c) => c.group === 'income_statement')).toBe(true);
  });

  it('populates enrichment notice when no concepts match', async () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ search: 'zzz_no_match_concept' });
    const result = await searchConceptsTool.handler(input, ctx);

    expect(result.total).toBe(0);
    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('zzz_no_match_concept');
  });

  it('does not populate enrichment notice when concepts are found', async () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ search: 'revenue' });
    await searchConceptsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeUndefined();
  });

  it('formats non-empty results with group headers', async () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ search: 'revenue' });
    const result = await searchConceptsTool.handler(input, ctx);
    const blocks = searchConceptsTool.format!(result);

    expect(blocks).toHaveLength(1);
    expect(blockAt(blocks).type).toBe('text');
    expect(blockText(blocks)).toContain('revenue');
  });

  it('formats empty results without guidance text (enrichment handles it)', async () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ search: 'zzznomatch' });
    const result = await searchConceptsTool.handler(input, ctx);
    const blocks = searchConceptsTool.format!(result);

    expect(blockText(blocks)).toContain('0 concepts');
  });

  it('surfaces related_tags for concepts with an alternate-definition tag (cash) (#36)', async () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ search: 'cash' });
    const result = await searchConceptsTool.handler(input, ctx);

    const cash = result.concepts.find((c) => c.name === 'cash');
    expect(cash?.related_tags?.map((r) => r.tag)).toContain(
      'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
    );
  });

  it('omits related_tags for concepts without an alternate (revenue) (#36)', async () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ search: 'revenue' });
    const result = await searchConceptsTool.handler(input, ctx);

    const revenue = result.concepts.find((c) => c.name === 'revenue');
    expect(revenue?.related_tags).toBeUndefined();
  });

  it('renders the related (alternate definition) line in format text (#36)', async () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ search: 'cash' });
    const result = await searchConceptsTool.handler(input, ctx);
    const blocks = searchConceptsTool.format!(result);

    expect(blockText(blocks)).toContain('related (alternate definition)');
    expect(blockText(blocks)).toContain(
      'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
    );
  });
  it('surfaces the IFRS element set, which differs from tags (#99)', async () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ search: 'inventory' });
    const result = await searchConceptsTool.handler(input, ctx);

    const inventory = result.concepts.find((c) => c.name === 'inventory');
    expect(inventory?.tags).toContain('InventoryNet');
    // Without this, an ifrs-full caller reads the us-gaap tags as the whole story.
    expect(inventory?.ifrs_tags).toEqual(['Inventories']);
  });

  it('omits ifrs_tags for a concept with no IFRS equivalent (#99)', async () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ search: 'notes_payable' });
    const result = await searchConceptsTool.handler(input, ctx);

    expect(result.concepts.find((c) => c.name === 'notes_payable')?.ifrs_tags).toBeUndefined();
  });

  it('renders the ifrs-full line in format text (#99)', async () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ search: 'inventory' });
    const result = await searchConceptsTool.handler(input, ctx);
    const blocks = searchConceptsTool.format!(result);

    expect(blockText(blocks)).toContain('ifrs-full: `Inventories`');
  });
});
