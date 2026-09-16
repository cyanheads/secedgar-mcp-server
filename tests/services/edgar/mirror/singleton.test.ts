/**
 * @fileoverview Covers the mirror singleton's lifecycle — the seam `createApp`'s
 * `teardown` hook runs on shutdown. `closeEdgarMirror` must release the SQLite
 * handles when `setup()` initialized a mirror and do nothing when it did not
 * (mirror disabled, or a runtime without SQLite), since shutdown runs either way.
 * @module tests/services/edgar/mirror/singleton
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeEdgarMirror,
  EdgarMirror,
  getEdgarMirror,
  initEdgarMirror,
} from '@/services/edgar/mirror/index.js';

const dirs: string[] = [];

function tempMirrorDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'edgar-mirror-singleton-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeEdgarMirror();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('EDGAR mirror singleton', () => {
  it('closes the initialized mirror and clears the singleton', async () => {
    const close = vi.spyOn(EdgarMirror.prototype, 'close').mockResolvedValue();
    const mirror = initEdgarMirror({ dir: tempMirrorDir(), userAgent: 'test test@example.com' });

    expect(getEdgarMirror()).toBe(mirror);

    await closeEdgarMirror();

    expect(close).toHaveBeenCalledTimes(1);
    expect(getEdgarMirror()).toBeUndefined();
  });

  it('is a no-op when no mirror was initialized', async () => {
    const close = vi.spyOn(EdgarMirror.prototype, 'close').mockResolvedValue();

    expect(getEdgarMirror()).toBeUndefined();
    await expect(closeEdgarMirror()).resolves.toBeUndefined();

    expect(close).not.toHaveBeenCalled();
  });

  it('does not re-close an already-closed mirror', async () => {
    const close = vi.spyOn(EdgarMirror.prototype, 'close').mockResolvedValue();
    initEdgarMirror({ dir: tempMirrorDir(), userAgent: 'test test@example.com' });

    await closeEdgarMirror();
    await closeEdgarMirror();

    expect(close).toHaveBeenCalledTimes(1);
  });
});
