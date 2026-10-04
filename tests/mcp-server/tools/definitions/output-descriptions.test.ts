/**
 * @fileoverview Bounds the output and enrichment field descriptions every tool
 *   advertises as `outputSchema` in `tools/list` (#131): their total size, the
 *   size of each, sentences repeated across one tool's descriptions, and a
 *   description on every field.
 * @module tests/mcp-server/tools/definitions/output-descriptions
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { buildToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

/** Combined UTF-8 bytes of every output and enrichment description, across all tools. */
const TOTAL_BYTE_BUDGET = 40_000;
/** UTF-8 bytes any one description may take. */
const DESCRIPTION_BYTE_LIMIT = 300;
/** Sentences at least this long may appear in only one description string per tool. */
const REPEATED_SENTENCE_MIN_LENGTH = 40;

interface DefinitionSchemas {
  enrichment?: z.ZodRawShape;
  name: string;
  output: z.ZodObject;
}

const encoder = new TextEncoder();

/**
 * The success schema the framework advertises — `output.extend(enrichment)` — for
 * every definition, the drop tool included while its gate is off.
 */
const tools = (buildToolDefinitions({ dropEnabled: false }) as unknown as DefinitionSchemas[]).map(
  (def) => ({ name: def.name, schema: def.output.extend(def.enrichment ?? {}) }),
);

/** Every `description` string in a JSON Schema, in document order. */
function descriptionsIn(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(descriptionsIn);
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === 'description' && typeof value === 'string' ? [value] : descriptionsIn(value),
  );
}

/** Paths of `properties` entries that carry no description. */
function undescribedFields(node: unknown, path: string): string[] {
  if (Array.isArray(node))
    return node.flatMap((item, i) => undescribedFields(item, `${path}[${i}]`));
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) => {
    if (key !== 'properties' || value === null || typeof value !== 'object') {
      return undescribedFields(value, `${path}/${key}`);
    }
    return Object.entries(value).flatMap(([field, schema]) => {
      const description = (schema as { description?: unknown }).description;
      const missing =
        typeof description === 'string' && description.trim() ? [] : [`${path}.${field}`];
      return [...missing, ...undescribedFields(schema, `${path}.${field}`)];
    });
  });
}

const bytesOf = (text: string) => encoder.encode(text).length;

describe('output and enrichment descriptions', () => {
  it(`total at most ${TOTAL_BYTE_BUDGET} bytes across every tool`, () => {
    const total = tools
      .flatMap(({ schema }) => descriptionsIn(z.toJSONSchema(schema)))
      .reduce((sum, text) => sum + bytesOf(text), 0);

    expect(total).toBeLessThanOrEqual(TOTAL_BYTE_BUDGET);
  });

  it(`keep each description to ${DESCRIPTION_BYTE_LIMIT} bytes`, () => {
    const oversized = tools.flatMap(({ name, schema }) =>
      descriptionsIn(z.toJSONSchema(schema))
        .filter((text) => bytesOf(text) > DESCRIPTION_BYTE_LIMIT)
        .map((text) => `${name} (${bytesOf(text)} bytes): ${text}`),
    );

    expect(oversized).toEqual([]);
  });

  /**
   * `reused: 'ref'` emits a subschema used at several paths once, under `$defs`,
   * so a reused schema's strings count once while the same text written on two
   * separate fields counts twice.
   */
  it(`state no sentence of ${REPEATED_SENTENCE_MIN_LENGTH}+ characters in two descriptions of one tool`, () => {
    const repeated = tools.flatMap(({ name, schema }) => {
      const firstSeenIn = new Map<string, number>();
      return descriptionsIn(z.toJSONSchema(schema, { reused: 'ref' })).flatMap((text, index) =>
        text
          .split(/(?<=[.!?])\s+/)
          .filter((sentence) => sentence.length >= REPEATED_SENTENCE_MIN_LENGTH)
          .flatMap((sentence) => {
            const first = firstSeenIn.get(sentence);
            if (first === undefined) firstSeenIn.set(sentence, index);
            return first === undefined || first === index ? [] : [`${name}: ${sentence}`];
          }),
      );
    });

    expect(repeated).toEqual([]);
  });

  it('describe every field', () => {
    const undescribed = tools.flatMap(({ name, schema }) =>
      undescribedFields(z.toJSONSchema(schema), name),
    );

    expect(undescribed).toEqual([]);
  });
});
