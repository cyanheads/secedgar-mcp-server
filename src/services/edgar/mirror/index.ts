/**
 * @fileoverview Public barrel and server-side singleton for the EDGAR local
 * mirror. The singleton is constructed in `setup()` only when the mirror is
 * enabled and the runtime supports it (Node/Bun, not Workers); `getEdgarMirror()`
 * returns `undefined` otherwise and the service stays on the live API.
 * @module services/edgar/mirror
 */

import { EdgarMirror, type EdgarMirrorOptions } from './edgar-mirror.js';

export { EdgarMirror, type EdgarMirrorOptions, type MirrorRunArgs } from './edgar-mirror.js';
export * from './types.js';

let _mirror: EdgarMirror | undefined;

/** Construct and register the server-side mirror singleton. */
export function initEdgarMirror(opts: EdgarMirrorOptions): EdgarMirror {
  _mirror = new EdgarMirror(opts);
  return _mirror;
}

/** The registered mirror singleton, or `undefined` when the mirror is disabled. */
export function getEdgarMirror(): EdgarMirror | undefined {
  return _mirror;
}

/**
 * Close the mirror's SQLite handles and drop the singleton. A no-op when the
 * mirror was never initialized — the disabled path and an unsupported runtime
 * both leave the singleton unset, and shutdown runs either way.
 */
export async function closeEdgarMirror(): Promise<void> {
  const mirror = _mirror;
  if (!mirror) return;
  _mirror = undefined;
  await mirror.close();
}
