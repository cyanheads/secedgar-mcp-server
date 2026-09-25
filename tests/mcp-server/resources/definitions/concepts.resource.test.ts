/**
 * @fileoverview Tests for concepts resource — XBRL concept reference listing.
 * @module tests/mcp-server/resources/definitions/concepts.resource
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { conceptsResource } from '@/mcp-server/resources/definitions/concepts.resource.js';
import { listResources } from '../../../support/assertions.js';

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

  it('surfaces alternate-definition tags for concepts that have them (#36)', () => {
    const ctx = createMockContext();
    const text = conceptsResource.handler({}, ctx) as string;
    expect(text).toContain('CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents');
    expect(text).toContain('alt (different definition');
  });

  it('lists ppe_net, pretax_income, and shares_diluted with their tags (#130)', () => {
    const ctx = createMockContext();
    const text = conceptsResource.handler({}, ctx) as string;
    for (const needle of [
      '`ppe_net`',
      '`pretax_income`',
      '`shares_diluted`',
      'PropertyPlantAndEquipmentNet',
      'ProfitLossBeforeTax',
      'WeightedAverageNumberOfDilutedSharesOutstanding',
      'PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization',
    ]) {
      expect(text).toContain(needle);
    }
  });

  it('lists resources correctly', async () => {
    const listing = await listResources(conceptsResource.list!);
    expect(listing.resources).toHaveLength(1);
    expect(listing.resources[0]).toMatchObject({
      uri: 'secedgar://concepts',
      name: 'XBRL Financial Concepts',
      mimeType: 'text/markdown',
    });
  });
});

describe('conceptsResource — the tools its names feed (#129)', () => {
  const conceptTools = [
    'secedgar_get_financials',
    'secedgar_compare_companies',
    'secedgar_fetch_frames',
  ];

  it('names every tool that takes a friendly name in the markdown intro, and not get_snapshot', () => {
    const text = conceptsResource.handler({}, createMockContext()) as string;
    const intro = text.slice(0, text.indexOf('\n## '));
    for (const name of conceptTools) expect(intro).toContain(`\`${name}\``);
    expect(intro).not.toContain('secedgar_get_snapshot');
  });

  it('names the same three tools in its description', () => {
    for (const name of conceptTools) expect(conceptsResource.description).toContain(name);
    expect(conceptsResource.description).not.toContain('secedgar_get_snapshot');
  });
});
