/**
 * @fileoverview Tests for concepts resource — XBRL concept reference listing.
 * @module tests/mcp-server/resources/definitions/concepts.resource
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { conceptsResource } from '@/mcp-server/resources/definitions/concepts.resource.js';

describe('conceptsResource', () => {
  it('returns markdown content with concept tables', () => {
    const ctx = createMockContext();
    const result = conceptsResource.handler({}, ctx);
    expect(typeof result).toBe('string');
    const text = result as string;
    expect(text).toContain('# XBRL Financial Concepts');
    expect(text).toContain('Friendly Name');
    expect(text).toContain('XBRL Tags');
  });

  it('includes all expected statement groups', () => {
    const ctx = createMockContext();
    const text = conceptsResource.handler({}, ctx) as string;
    expect(text).toContain('## Income Statement');
    expect(text).toContain('## Balance Sheet');
    expect(text).toContain('## Cash Flow');
    expect(text).toContain('## Per Share');
    expect(text).toContain('## Entity Info');
  });

  it('includes known concepts in the output', () => {
    const ctx = createMockContext();
    const text = conceptsResource.handler({}, ctx) as string;
    expect(text).toContain('`revenue`');
    expect(text).toContain('`net_income`');
    expect(text).toContain('`assets`');
    expect(text).toContain('`eps_diluted`');
    expect(text).toContain('`shares_outstanding`');
  });

  it('lists resources correctly', async () => {
    const listing = await conceptsResource.list!();
    expect(listing.resources).toHaveLength(1);
    expect(listing.resources[0]).toMatchObject({
      uri: 'secedgar://concepts',
      name: 'XBRL Financial Concepts',
      mimeType: 'text/markdown',
    });
  });
});
