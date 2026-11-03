/**
 * @fileoverview The candidates an ambiguous company resolution names, rendered for the error
 * message itself (clients that read only `content[]` otherwise get a "pick from the matches
 * list" instruction with no list to pick from, #90) and for the `matches` data field.
 * @module mcp-server/tools/ambiguous-matches
 */

import type { CikMatch } from '@/services/edgar/types.js';

/** Candidates named per ambiguous resolution. */
const MAX_SHOWN = 10;

/**
 * The first {@link MAX_SHOWN} candidates of a multi-match `resolveCik` result: `list` reads
 * `<cik> <name> (<ticker>), …` for the message, `matches` carries the same rows as data.
 */
export function ambiguousMatches(resolved: readonly CikMatch[]) {
  const shown = resolved.slice(0, MAX_SHOWN);
  return {
    list: shown
      .map((m) => `${m.cik} ${m.name ?? 'Unknown'}${m.ticker ? ` (${m.ticker})` : ''}`)
      .join(', '),
    matches: shown.map((m) => ({ cik: m.cik, name: m.name, ticker: m.ticker })),
  };
}
