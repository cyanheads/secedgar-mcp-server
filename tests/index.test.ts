/**
 * @fileoverview Startup configuration failures of the server entry (`src/index.ts`): an
 *   invalid server variable fails through the framework's configuration banner, naming the
 *   variable, instead of an uncaught throw before `createApp()` (#197). Spawns the entry
 *   under Bun, which runs it from source.
 * @module tests/index
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Run the entry with `env` layered on this process's, stdin closed, bounded at 20 s. */
function startServer(
  env: Record<string, string>,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['src/index.ts'], {
      cwd: ROOT,
      env: { ...process.env, MCP_TRANSPORT_TYPE: 'stdio', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('server entry startup', () => {
  it('fails an invalid EDGAR_RATE_LIMIT_RPS through the configuration banner, naming the variable', async () => {
    const { code, output } = await startServer({ EDGAR_RATE_LIMIT_RPS: '99' });

    expect(code).toBe(1);
    expect(output).toContain('Configuration error — server failed to start');
    expect(output).toContain('EDGAR_RATE_LIMIT_RPS (rateLimitRps)');
    // An uncaught throw prints its stack frames; the banner keeps them behind DEBUG=true.
    expect(output).not.toMatch(/^\s+at \S/m);
  }, 30_000);
});
