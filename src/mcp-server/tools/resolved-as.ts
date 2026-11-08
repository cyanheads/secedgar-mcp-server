/**
 * @fileoverview The `resolvedAs` enrichment field the company-resolving tools share: how a
 * ticker spelling the registry does not list was read (`CikMatch.reading`).
 * @module mcp-server/tools/resolved-as
 */

import { z } from '@cyanheads/mcp-ts-core';

export const resolvedAsField = z
  .string()
  .optional()
  .describe('How an unlisted ticker spelling was read, e.g. "UEC.N read as UEC".');
