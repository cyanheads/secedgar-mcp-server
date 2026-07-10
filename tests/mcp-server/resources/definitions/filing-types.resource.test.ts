/**
 * @fileoverview Tests for filing-types resource — SEC filing type reference listing.
 * @module tests/mcp-server/resources/definitions/filing-types.resource
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { filingTypesResource } from '@/mcp-server/resources/definitions/filing-types.resource.js';

describe('filingTypesResource', () => {
  it('returns markdown content with filing type table', () => {
    const ctx = createMockContext();
    const result = filingTypesResource.handler({}, ctx);
    expect(typeof result).toBe('string');
    const text = result as string;
    expect(text).toContain('# SEC Filing Types');
    expect(text).toContain('| Form |');
    expect(text).toContain('| Cadence |');
  });

  it('includes major filing types', () => {
    const ctx = createMockContext();
    const text = filingTypesResource.handler({}, ctx) as string;
    expect(text).toContain('10-K');
    expect(text).toContain('10-Q');
    expect(text).toContain('8-K');
    expect(text).toContain('DEF 14A');
    expect(text).toContain('S-1');
    expect(text).toContain('13F-HR');
    expect(text).toContain('Form 4');
  });

  it('includes descriptions and use cases', () => {
    const ctx = createMockContext();
    const text = filingTypesResource.handler({}, ctx) as string;
    expect(text).toContain('Annual report');
    expect(text).toContain('Financial analysis');
  });

  // #83 — beneficial-ownership filings use the structured SCHEDULE 13D/13G form
  // names since December 2024; the legacy SC 13D/SC 13G names match zero current
  // filings, so the resource must list the current names plus the transition note.
  it('uses the current SCHEDULE 13D/13G form names, not the legacy SC 13D/SC 13G', () => {
    const ctx = createMockContext();
    const text = filingTypesResource.handler({}, ctx) as string;
    expect(text).toContain('SCHEDULE 13D');
    expect(text).toContain('SCHEDULE 13G');
    // The legacy names must not appear as the table's form label.
    expect(text).not.toContain('**SC 13D**');
    expect(text).not.toContain('**SC 13G**');
  });

  it('notes the December 2024 structured-form transition', () => {
    const ctx = createMockContext();
    const text = filingTypesResource.handler({}, ctx) as string;
    expect(text).toContain('December 2024');
    expect(text).toContain('primary_doc.xml');
  });

  it('lists resources correctly', async () => {
    const listing = await filingTypesResource.list!();
    expect(listing.resources).toHaveLength(1);
    expect(listing.resources[0]).toMatchObject({
      uri: 'secedgar://filing-types',
      name: 'SEC Filing Types',
      mimeType: 'text/markdown',
    });
  });
});
