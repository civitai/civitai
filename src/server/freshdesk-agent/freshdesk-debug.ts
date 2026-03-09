export type FreshdeskDebugContext = {
  debug: boolean;
  dryRun: boolean;
  ticketId: number;
  phase: string;
};

let _ctx: FreshdeskDebugContext | null = null;
export function setDebugContext(ctx: FreshdeskDebugContext) {
  _ctx = ctx;
}
export function getDebugContext() {
  return _ctx;
}
export function clearDebugContext() {
  _ctx = null;
}

export function agentLog(label: string, data?: unknown) {
  if (!_ctx?.debug) return;
  const prefix = `\x1b[36m[FD #${_ctx.ticketId}/${_ctx.phase}]\x1b[0m`;
  const tag = `\x1b[33m${label}\x1b[0m`;
  if (data !== undefined) {
    const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    const truncated =
      str.length > 2000 ? str.slice(0, 2000) + `\n... (truncated, ${str.length} chars)` : str;
    console.log(`${prefix} ${tag}`, truncated);
  } else {
    console.log(`${prefix} ${tag}`);
  }
}
