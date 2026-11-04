/**
 * @fileoverview The one cut every ambiguity error shows of the candidates a name resolves to,
 * rendered for the error message itself (clients that read only `content[]` otherwise get a
 * "pick from the matches list" instruction with no list to pick from, #90) and for the error
 * data, with the full count and the sentence that says a list is partial (#229, #230).
 * @module mcp-server/tools/ambiguous-matches
 */

/** Candidates named per ambiguous resolution. */
const MAX_SHOWN = 10;

/** One candidate an ambiguous resolution names. */
export interface AmbiguousCandidate {
  cik: string;
  name?: string | undefined;
  ticker?: string | undefined;
}

/** How many candidates match in all, when an upstream reports more than it returns (#230). */
export interface MatchTotal {
  count: number;
  /** `count` is a floor the upstream reports (EDGAR full-text search's `relation: "gte"`). */
  lowerBound?: boolean;
}

/** How a consumer's input shapes the cut's count and its partial-list sentence. */
export interface AmbiguousMatchesOptions {
  /**
   * The input is one token with no spaces (`search_filings`' `ticker:` value), which cannot
   * carry a fuller name, so the sentence offers only a ticker or CIK.
   */
  singleToken?: boolean;
  /**
   * Defaults to every candidate passed, so a caller hands over the whole list, never a
   * pre-cut one.
   */
  total?: MatchTotal | undefined;
}

/** An ambiguity error's candidate list, its parts exposed for a consumer that words its own. */
export interface AmbiguousMatches {
  /** The error-data fields: `shown` as `cik`/`name`/`ticker` rows, and the full count. */
  data: {
    matches: Array<{ cik: string; name: string | undefined; ticker: string | undefined }>;
    total_matches: number;
    total_matches_is_lower_bound?: true;
  };
  /** `shown` as `<cik> <name> (<ticker>), …`, the default list for the message. */
  list: string;
  /**
   * `''` for a complete list; otherwise the sentence that ends the message, leading space
   * included: ` Showing 10 of 66 matches; for one not listed, retry with a fuller name, its
   * ticker, or its CIK.` (`of at least 10,000` for a floor; `retry with its ticker or CIK.`
   * for a single-token input).
   */
  showing: string;
  /** The first {@link MAX_SHOWN} candidates, in the order given. */
  shown: readonly AmbiguousCandidate[];
}

/** Cut `candidates` to {@link MAX_SHOWN} and describe the cut. */
export function ambiguousMatches(
  candidates: readonly AmbiguousCandidate[],
  { total = { count: candidates.length }, singleToken = false }: AmbiguousMatchesOptions = {},
): AmbiguousMatches {
  const shown = candidates.slice(0, MAX_SHOWN);
  const lowerBound = total.lowerBound === true;
  const of = `${lowerBound ? 'at least ' : ''}${total.count.toLocaleString('en-US')}`;
  const retry = singleToken ? 'its ticker or CIK' : 'a fuller name, its ticker, or its CIK';
  return {
    shown,
    list: shown
      .map((m) => `${m.cik} ${m.name ?? 'Unknown'}${m.ticker ? ` (${m.ticker})` : ''}`)
      .join(', '),
    showing:
      shown.length < total.count || lowerBound
        ? ` Showing ${shown.length} of ${of} matches; for one not listed, retry with ${retry}.`
        : '',
    data: {
      matches: shown.map((m) => ({ cik: m.cik, name: m.name, ticker: m.ticker })),
      total_matches: total.count,
      ...(lowerBound ? { total_matches_is_lower_bound: true as const } : {}),
    },
  };
}
