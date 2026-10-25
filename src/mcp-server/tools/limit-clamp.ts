/**
 * @fileoverview Serving an over-cap numeric input at its cap (#197). A count or
 * size input above the cap its handler applies returns exactly what the call at
 * the cap returns, so rejecting it only costs the caller a retry.
 *
 * One switch, `EDGAR_CLAMP_OVERSIZED_LIMITS` (default on), governs every field
 * built here:
 *
 * | Switch | Value | Schema | Handler reads | Log line + counter |
 * |:-------|:------|:-------|:--------------|:-------------------|
 * | on | at most `cap` | accepted | the value | none |
 * | on | above `cap`, at most `bound` | accepted | `cap` | one each |
 * | on | above `bound` | rejected | — | — |
 * | off | at most `cap` | accepted | the value | none |
 * | off | above `cap` | rejected (`maximum` is `cap`) | — | — |
 *
 * The handler is the same in both modes: switched off, the schema rejects every
 * value `apply()` would cut, so only the advertised and validated bound changes.
 * A clamped call carries no notice of its own — the result must equal the call
 * at the cap — and reports the applied value wherever the tool already reports
 * its cap (`cap`, the page it returns, its continuation).
 *
 * @module mcp-server/tools/limit-clamp
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';

/** The deployment switch the clamped fields are built from (`EDGAR_CLAMP_OVERSIZED_LIMITS`). */
export interface LimitClampOptions {
  clampOversizedLimits: boolean;
}

/**
 * Created on the first clamp, never at import: a module-scope counter binds to
 * the OTel no-op meter before the SDK registers its provider, and stays a no-op.
 */
let clampedCalls: ReturnType<typeof createCounter> | undefined;

/** One numeric input served at its cap. */
export interface LimitClamp<S extends z.ZodType> {
  /**
   * The value every handler read uses: `min(value, cap)`. A clamp writes one
   * `ctx.log` line and adds 1 to `secedgar.input.clamped`, tagged with tool and
   * field. An omitted optional value passes through.
   */
  apply<V extends number | undefined>(value: V, ctx: Context): V;
  readonly field: string;
  /** The field's schema: `maximum` is `bound` when clamping, else `cap`. */
  schema(clampOversizedLimits: boolean): S;
}

/**
 * Define a clamped numeric input. `shape` adds the field's default or optional
 * marker; `description` is the field's own text, to which the cap sentence for
 * the mode is appended.
 */
export function limitClamp<S extends z.ZodType>(spec: {
  tool: string;
  field: string;
  min: number;
  cap: number;
  bound: number;
  shape: (bounded: z.ZodNumber) => S;
  description: string;
}): LimitClamp<S> {
  const { tool: toolName, field, min, cap, bound, shape, description } = spec;
  return {
    field,
    schema: (clampOversizedLimits) =>
      shape(
        z
          .number()
          .int()
          .min(min)
          .max(clampOversizedLimits ? bound : cap),
      ).describe(
        clampOversizedLimits
          ? `${description} Capped at ${cap}: a larger value, up to ${bound}, returns what ${cap} returns.`
          : `${description} At most ${cap}.`,
      ),
    apply<V extends number | undefined>(value: V, ctx: Context): V {
      if (value === undefined || value <= cap) return value;
      ctx.log.info('Numeric input above its cap served at the cap', {
        tool: toolName,
        field,
        requested: value,
        applied: cap,
      });
      clampedCalls ??= createCounter(
        'secedgar.input.clamped',
        'Calls whose numeric input exceeded its cap and was served at the cap',
        '{calls}',
      );
      clampedCalls.add(1, { [ATTR_MCP_TOOL_NAME]: toolName, 'secedgar.input.field': field });
      return cap as V;
    },
  };
}

/**
 * The definition to register for this deployment. Switched on, the definition
 * as built (its clamped fields take `schema(true)`); off, the same definition
 * with each clamped field's schema rebuilt so its maximum is the cap.
 */
export function withLimitClamps<D extends { name: string; input: z.ZodObject }>(
  definition: D,
  clamps: readonly LimitClamp<z.ZodType>[],
  { clampOversizedLimits }: LimitClampOptions,
): D {
  if (clampOversizedLimits) return definition;
  const bounded = Object.fromEntries(clamps.map((clamp) => [clamp.field, clamp.schema(false)]));
  // Only the clamped fields' maxima change, so the handler's input type is unchanged.
  return tool(definition.name, {
    ...(definition as unknown as Parameters<typeof tool>[1]),
    input: definition.input.extend(bounded),
  }) as unknown as D;
}
