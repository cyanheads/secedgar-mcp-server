/**
 * @fileoverview The over-cap clamp every clamped numeric input is built from (#197): the
 *   schema bounds in both switch states, the applied value, and the log line and counter a
 *   clamp emits. Tool suites prove only their wiring; the behavior table lives here.
 * @module tests/mcp-server/tools/limit-clamp
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const counterAdd = vi.fn();
const createCounter = vi.fn((_name: string, _description: string, _unit?: string) => ({
  add: counterAdd,
}));

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: (name: string, description: string, unit?: string) =>
    createCounter(name, description, unit),
}));

type LimitClampModule = typeof import('@/mcp-server/tools/limit-clamp.js');

/** A fresh module per test, so the lazily created counter starts unset each time. */
let mod: LimitClampModule;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  mod = await import('@/mcp-server/tools/limit-clamp.js');
});

const spec = {
  tool: 'secedgar_example',
  field: 'limit',
  min: 1,
  cap: 100,
  bound: 1000,
  shape: (n: z.ZodNumber) => n.default(25),
  description: 'Rows to return.',
};

/** The JSON Schema a client sees for one field. */
function advertised(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
}

describe('limitClamp — schema', () => {
  it.each([
    [
      true,
      1000,
      'Rows to return. Capped at 100: a larger value, up to 1000, returns what 100 returns.',
    ],
    [false, 100, 'Rows to return. At most 100.'],
  ])('switch %s advertises maximum %i and names the cap', (clamp, maximum, description) => {
    const schema = mod.limitClamp(spec).schema(clamp);
    expect(advertised(schema)).toMatchObject({ minimum: 1, maximum, default: 25, description });
  });

  it.each([
    // [switch, value, accepted]
    [true, 1, true],
    [true, 100, true],
    [true, 101, true],
    [true, 1000, true],
    [true, 1001, false],
    [true, 0, false],
    [true, 100.5, false],
    [false, 100, true],
    [false, 101, false],
    [false, 1001, false],
  ])('switch %s: %d accepted is %s', (clamp, value, accepted) => {
    expect(mod.limitClamp(spec).schema(clamp).safeParse(value).success).toBe(accepted);
  });

  it('keeps an optional field optional in both states', () => {
    const optional = mod.limitClamp({ ...spec, min: 0, shape: (n) => n.optional() });
    for (const clamp of [true, false]) {
      expect(optional.schema(clamp).parse(undefined)).toBeUndefined();
    }
  });
});

describe('limitClamp — apply', () => {
  it.each([
    [1, 1],
    [100, 100],
    [101, 100],
    [1000, 100],
  ])('reads %d as %d', (value, applied) => {
    const ctx = createMockContext();
    expect(mod.limitClamp(spec).apply(value, ctx)).toBe(applied);
  });

  it('passes an omitted optional value through', () => {
    const ctx = createMockContext();
    expect(mod.limitClamp(spec).apply(undefined, ctx)).toBeUndefined();
  });

  it('writes no log line and counts nothing at or below the cap', () => {
    const ctx = createMockContext();
    const info = vi.spyOn(ctx.log, 'info');
    const clamp = mod.limitClamp(spec);
    clamp.apply(1, ctx);
    clamp.apply(100, ctx);
    clamp.apply(undefined, ctx);

    expect(info).not.toHaveBeenCalled();
    expect(createCounter).not.toHaveBeenCalled();
    expect(counterAdd).not.toHaveBeenCalled();
  });

  it('above the cap, writes one log line and adds 1 to the counter tagged with tool and field', () => {
    const ctx = createMockContext();
    const info = vi.spyOn(ctx.log, 'info');
    mod.limitClamp(spec).apply(250, ctx);

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('Numeric input above its cap served at the cap', {
      tool: 'secedgar_example',
      field: 'limit',
      requested: 250,
      applied: 100,
    });
    expect(counterAdd).toHaveBeenCalledTimes(1);
    expect(counterAdd).toHaveBeenCalledWith(1, {
      'mcp.tool.name': 'secedgar_example',
      'secedgar.input.field': 'limit',
    });
  });

  it('creates the counter on the first clamp, not at import, and only once', () => {
    const ctx = createMockContext();
    const first = mod.limitClamp(spec);
    const second = mod.limitClamp({ ...spec, tool: 'secedgar_other', field: 'periods', cap: 12 });
    expect(createCounter).not.toHaveBeenCalled();

    first.apply(101, ctx);
    second.apply(13, ctx);
    first.apply(500, ctx);

    expect(createCounter).toHaveBeenCalledTimes(1);
    expect(createCounter).toHaveBeenCalledWith(
      'secedgar.input.clamped',
      expect.any(String),
      '{calls}',
    );
    expect(counterAdd.mock.calls.map(([, attrs]) => attrs)).toEqual([
      { 'mcp.tool.name': 'secedgar_example', 'secedgar.input.field': 'limit' },
      { 'mcp.tool.name': 'secedgar_other', 'secedgar.input.field': 'periods' },
      { 'mcp.tool.name': 'secedgar_example', 'secedgar.input.field': 'limit' },
    ]);
  });
});

describe('withLimitClamps', () => {
  const build = () => {
    const limit = mod.limitClamp(spec);
    const definition = tool('secedgar_example', {
      description: 'Example tool for the clamp wiring.',
      input: z.object({
        query: z.string().describe('Search text.'),
        limit: limit.schema(true),
      }),
      output: z.object({ applied: z.number().describe('Limit the handler read.') }),
      handler: (input, ctx) => ({ applied: limit.apply(input.limit, ctx) }),
    });
    return { limit, definition };
  };

  it('returns the definition as built when the switch is on', () => {
    const { limit, definition } = build();
    expect(mod.withLimitClamps(definition, [limit], { clampOversizedLimits: true })).toBe(
      definition,
    );
  });

  it('switched off, rebuilds only the clamped field, at the cap, keeping key order and strictness', () => {
    const { limit, definition } = build();
    const off = mod.withLimitClamps(definition, [limit], { clampOversizedLimits: false });

    type ObjectSchema = {
      properties: Record<string, Record<string, unknown>>;
      additionalProperties?: unknown;
    };
    const json = advertised(off.input) as ObjectSchema;
    const built = advertised(definition.input) as ObjectSchema;
    expect(Object.keys(json.properties)).toEqual(['query', 'limit']);
    expect(json.properties.limit).toMatchObject({ maximum: 100, default: 25 });
    expect(built.properties.limit).toMatchObject({ maximum: 1000, default: 25 });
    expect(json.properties.query).toEqual(built.properties.query);
    expect(json.additionalProperties).toBe(false);
    expect(off.input.safeParse({ query: 'x', limit: 101 }).success).toBe(false);
    expect(off.input.safeParse({ query: 'x', limit: 100 }).success).toBe(true);
    expect(off.handler).toBe(definition.handler);
    expect(off.name).toBe(definition.name);
    expect(off.description).toBe(definition.description);
    expect(off.output).toBe(definition.output);
  });
});
