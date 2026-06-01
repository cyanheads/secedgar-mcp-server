/**
 * @fileoverview Minimal logger + abort signal for the out-of-band mirror scripts.
 * Scripts run outside the MCP request pipeline, so they have no `Context`; this
 * wires console output and a SIGINT/SIGTERM-driven AbortController to the
 * `MirrorLogger` shape the ingesters consume — an interrupt lets the framework
 * persist sync state before exit, so a re-run resumes cleanly.
 * @module scripts/_mirror-context
 */

type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error';

function makeLogger(prefix: string) {
  const emit = (level: LogLevel, message: string, meta?: object): void => {
    const tag = `[${new Date().toISOString()}] ${level.toUpperCase()} ${prefix}`;
    const metaStr = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    const line = `${tag} ${message}${metaStr}`;
    if (level === 'error') console.error(line);
    else if (level === 'warning') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m: string, meta?: object) => emit('debug', m, meta),
    info: (m: string, meta?: object) => emit('info', m, meta),
    notice: (m: string, meta?: object) => emit('notice', m, meta),
    warning: (m: string, meta?: object) => emit('warning', m, meta),
    error: (m: string, meta?: object) => emit('error', m, meta),
  };
}

/** Build a script context: a `MirrorLogger` plus a SIGINT/SIGTERM-aborted signal. */
export function makeScriptContext(prefix: string): {
  log: ReturnType<typeof makeLogger>;
  signal: AbortSignal;
} {
  const controller = new AbortController();
  const onSignal = (sig: string) => () => {
    console.error(`\nReceived ${sig}; aborting mirror sync (state is persisted per page)...`);
    controller.abort(new Error(`Aborted by ${sig}`));
  };
  process.once('SIGINT', onSignal('SIGINT'));
  process.once('SIGTERM', onSignal('SIGTERM'));
  return { log: makeLogger(prefix), signal: controller.signal };
}
