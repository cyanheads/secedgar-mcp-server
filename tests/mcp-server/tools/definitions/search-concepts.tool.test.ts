/**
 * @fileoverview Tests for search-concepts tool — XBRL concept discovery.
 * @module tests/mcp-server/tools/definitions/search-concepts.tool
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { searchConceptsTool } from '@/mcp-server/tools/definitions/search-concepts.tool.js';

describe('searchConceptsTool', () => {
  it('returns concepts for a keyword match', () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ search: 'revenue' });
    const result = searchConceptsTool.handler(input, ctx);

    expect(result.total).toBeGreaterThan(0);
    expect(result.concepts.length).toBe(result.total);
  });

  it('returns full catalog when search is empty', () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({});
    const result = searchConceptsTool.handler(input, ctx);

    expect(result.total).toBeGreaterThan(0);
  });

  it('filters by group', () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ group: 'income_statement' });
    const result = searchConceptsTool.handler(input, ctx);

    expect(result.total).toBeGreaterThan(0);
    expect(result.concepts.every((c) => c.group === 'income_statement')).toBe(true);
  });

  it('populates enrichment notice when no concepts match', () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ search: 'zzz_no_match_concept' });
    const result = searchConceptsTool.handler(input, ctx);

    expect(result.total).toBe(0);
    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('zzz_no_match_concept');
  });

  it('does not populate enrichment notice when concepts are found', () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ search: 'revenue' });
    searchConceptsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeUndefined();
  });

  it('formats non-empty results with group headers', () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ search: 'revenue' });
    const result = searchConceptsTool.handler(input, ctx);
    const blocks = searchConceptsTool.format!(result);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('revenue');
  });

  it('formats empty results without guidance text (enrichment handles it)', () => {
    const ctx = createMockContext();
    const input = searchConceptsTool.input.parse({ search: 'zzznomatch' });
    const result = searchConceptsTool.handler(input, ctx);
    const blocks = searchConceptsTool.format!(result);

    expect(blocks[0].text).toContain('0 concepts');
  });
});
