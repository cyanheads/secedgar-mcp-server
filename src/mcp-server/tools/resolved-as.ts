/**
 * @fileoverview The `resolvedAs` enrichment field the company-resolving tools share: how the
 * input was read when it was more than a current listing or name match (`CikMatch.reading`) —
 * an unlisted ticker spelling (#235), a former ticker or a listed one's earlier holders (#237),
 * or an EDGAR entity-index match (#236).
 * @module mcp-server/tools/resolved-as
 */

import { z } from '@cyanheads/mcp-ts-core';

export const resolvedAsField = z
  .string()
  .optional()
  .describe(
    'How the input was read: a ticker spelling, former ticker, earlier holder, or entity-index match.',
  );
