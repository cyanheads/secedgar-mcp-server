/**
 * @fileoverview The three error-contract entries every tool that reaches SEC declares: the
 * rate-limit block, no complete answer (`sec_unreachable`), and a 5xx once retries are spent
 * (`sec_unavailable`). All are raised by `EdgarApiService`, hence `thrownBy: 'service'`.
 * @module mcp-server/tools/sec-upstream-errors
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

export const SEC_UPSTREAM_ERRORS = [
  {
    reason: 'rate_limited',
    code: JsonRpcErrorCode.RateLimited,
    when: "SEC is rate-limiting this server's IP — SEC answered 429, or the call was refused without being sent while the cool-down after one runs",
    recovery:
      'Wait the retryAfter seconds the error carries, then retry — SEC lifts the block only once requests stop for ten minutes.',
    retryable: true,
    thrownBy: 'service',
  },
  {
    reason: 'sec_unreachable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: "SEC EDGAR gave no complete, readable response — on the last attempt made (the third, or an earlier one once this call's 40-second budget for SEC failures ran out) the connection failed, no response headers arrived within 15 seconds, or the body broke off or stalled for 15 seconds, each wait capped at what was left of that budget; a 200 body was not the JSON SEC serves; or earlier SEC failures had spent that budget, so the request was never sent",
    recovery:
      'Retry the same call in a minute — SEC EDGAR did not deliver a complete, readable response, and nothing in the request needs to change.',
    retryable: true,
    thrownBy: 'service',
  },
  {
    reason: 'sec_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: "SEC EDGAR answered HTTP 500, 502, 503, or 504 on the last attempt made (the third, or an earlier one once this call's 40-second budget for SEC failures ran out)",
    recovery:
      'Retry the same call in a minute — SEC EDGAR failed on its side, and nothing in the request needs to change.',
    retryable: true,
    thrownBy: 'service',
  },
] as const;
