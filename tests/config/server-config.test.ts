/**
 * @fileoverview `readToolGates()`, the pre-`createApp()` read of the two switches that shape
 *   the tool list (#197): blank or unset takes the default, and an invalid value is left to
 *   `getServerConfig()` in `setup()` to report.
 * @module tests/config/server-config
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, readToolGates } from '@/config/server-config.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Set both switches; `undefined` deletes the variable. */
function gates(drop: string | undefined, clamp: string | undefined) {
  vi.stubEnv('EDGAR_DATAFRAME_DROP_ENABLED', drop);
  vi.stubEnv('EDGAR_CLAMP_OVERSIZED_LIMITS', clamp);
  return readToolGates();
}

describe('readToolGates', () => {
  it.each([
    ['unset', undefined, undefined, { dataframeDropEnabled: false, clampOversizedLimits: true }],
    ['blank', '', '  ', { dataframeDropEnabled: false, clampOversizedLimits: true }],
    ['flipped', 'true', 'false', { dataframeDropEnabled: true, clampOversizedLimits: false }],
    ['spelled out', 'on', 'no', { dataframeDropEnabled: true, clampOversizedLimits: false }],
  ])('reads %s switches', (_case, drop, clamp, expected) => {
    expect(gates(drop, clamp)).toEqual(expected);
  });

  it('reads an invalid switch as its default and leaves the failure to the full parse', () => {
    expect(gates(undefined, 'maybe')).toEqual({
      dataframeDropEnabled: false,
      clampOversizedLimits: true,
    });
    expect(() => getServerConfig()).toThrow(/EDGAR_CLAMP_OVERSIZED_LIMITS/);
  });

  it('does not read any other server variable', () => {
    vi.stubEnv('EDGAR_RATE_LIMIT_RPS', '99');
    expect(gates('false', 'true')).toEqual({
      dataframeDropEnabled: false,
      clampOversizedLimits: true,
    });
  });
});
