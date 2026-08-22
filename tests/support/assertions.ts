/**
 * @fileoverview Typed narrowing helpers shared by the test suite. Each one turns
 *   an assumption a test already makes — "this index exists", "this block is
 *   text", "this call threw an McpError" — into a checked assertion, so the
 *   suite type-checks under `noUncheckedIndexedAccess` without non-null
 *   assertions or casts papering over a genuinely absent value.
 * @module tests/support/assertions
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { ListExtra } from '@cyanheads/mcp-ts-core/resources';

/**
 * Element at `index`, asserting the array is long enough.
 *
 * Index reads are optional under `noUncheckedIndexedAccess`; a fixture-driven
 * test knows the element is there, and a wrong index should fail loudly rather
 * than surface as `Cannot read properties of undefined`.
 */
export function at<T>(items: readonly T[] | undefined, index = 0): T {
  if (items === undefined) throw new Error('Expected a list, got undefined.');
  const value = items[index];
  if (value === undefined) {
    throw new Error(`Expected an element at index ${index}, but the list holds ${items.length}.`);
  }
  return value;
}

/** One content block, asserting the block list is long enough. */
export function blockAt(blocks: readonly ContentBlock[], index = 0): ContentBlock {
  return at(blocks, index);
}

/** Text of one content block, asserting it exists and carries text. */
export function blockText(blocks: readonly ContentBlock[], index = 0): string {
  const block = blockAt(blocks, index);
  if (block.type !== 'text') {
    throw new Error(`Expected a text block at index ${index}, got '${block.type}'.`);
  }
  return block.text;
}

/**
 * Runs a handler expected to throw and returns the `McpError` it threw, with
 * `data` narrowed to a present bag. Resolving instead of throwing fails the
 * test rather than returning a value the caller would read as an error.
 */
export async function caught(run: unknown): Promise<McpError & { data: Record<string, unknown> }> {
  try {
    await run;
  } catch (error) {
    if (!(error instanceof McpError)) throw error;
    return Object.assign(error, { data: error.data ?? {} });
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

/**
 * Narrows an untyped JSON-RPC `data` field to a list of records. Real check —
 * a field that is not an array of objects fails here rather than downstream.
 */
export function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error(`Expected an array, got ${typeof value}.`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Expected an object at index ${i}, got ${typeof entry}.`);
    }
    return entry as Record<string, unknown>;
  });
}

/**
 * Invokes a resource's `list()` provider.
 *
 * `ListExtra` is the SDK's live server request scope — a running transport, not
 * a value a unit test can construct — and every `list()` in this server ignores
 * it. The stand-in is confined here rather than repeated at each call site.
 */
export function listResources<T>(list: (extra: ListExtra) => T): T {
  return list({} as ListExtra);
}

/** Narrows an untyped JSON-RPC `data` field to a record. */
export function bag(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected an object, got ${Array.isArray(value) ? 'array' : typeof value}.`);
  }
  return value as Record<string, unknown>;
}

/** The `data.recovery.hint` an error carries, asserting the contract populated it. */
export function recoveryHint(err: McpError): string {
  const hint = bag(err.data?.recovery).hint;
  if (typeof hint !== 'string') {
    throw new Error(`Expected data.recovery.hint to be a string, got ${typeof hint}.`);
  }
  return hint;
}

/**
 * Runs a call expected to reject and returns the `Error` it threw, without
 * requiring an `McpError`. Use where the assertion is about the error that
 * propagates from below the handler — a raw service throw the framework would
 * classify at the wrapper, not at the call site a test exercises.
 */
export async function rejection(run: unknown): Promise<Error> {
  try {
    await run;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
  throw new Error('Expected the call to reject, but it resolved.');
}
