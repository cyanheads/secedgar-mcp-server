/**
 * @fileoverview The scope one tool call's SEC requests run under: the caller's
 * cancellation signal and the call's failure budget (#179). Built once per tool
 * call from `ctx.signal` and passed to every `EdgarApiService` method that reaches
 * SEC, which takes it as a required parameter.
 * @module services/edgar/call-scope
 */

/**
 * The most time one tool call may spend on SEC failing it: waits on attempts that
 * got no response or a 5xx, retry backoff, and the idle wait a body stalled on
 * (#179). Healthy progress never counts — pacer queue time, answered requests, a
 * body still arriving — so no call SEC keeps answering with a 2xx is cut. Each attempt's
 * header wait and each body-idle wait is the lesser of its own 15 s cap and the
 * budget left; once it is spent no further attempt or backoff starts. Under the
 * MCP SDK client's 60 s default request timeout with room for the response.
 */
export const CALL_FAILURE_BUDGET_MS = 40_000;

/** What a shared load runs under: no one caller owns it, so nothing cancels it. */
const UNOWNED_SIGNAL = new AbortController().signal;

/**
 * One tool call's hold on SEC. `signal` is the caller's: once it fires, every SEC
 * request the call has queued, in flight, reading a body, or sleeping a backoff
 * ends with its reason, unretried and unclassified. The budget is charged by the
 * service as SEC fails the call, and only by the service.
 */
export class CallScope {
  readonly signal: AbortSignal;
  #spentMs = 0;

  constructor(signal: AbortSignal) {
    this.signal = signal;
  }

  /**
   * A scope for work several calls await — the ticker-index load: a full budget of
   * its own and a signal that never fires, so one waiter's cancel ends only its own
   * wait.
   */
  static unowned(): CallScope {
    return new CallScope(UNOWNED_SIGNAL);
  }

  /** Budget left, in ms; 0 once spent. */
  get remainingMs(): number {
    return Math.max(0, CALL_FAILURE_BUDGET_MS - this.#spentMs);
  }

  /** Failure time charged so far, in ms. */
  get spentMs(): number {
    return this.#spentMs;
  }

  /** Charge `ms` of time SEC spent failing this call. */
  charge(ms: number): void {
    this.#spentMs += ms;
  }
}
