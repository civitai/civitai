// Marks a console write that the app's console backstop must not forward: its line already reaches
// the structured-log sink by another path (the logger's own `emitLog` call), or it is kept on stdout
// on purpose (a per-statement query log). See `src/server/logging/console-otlp-backstop.ts`.
//
// Synchronous by design: a console method writes before it returns, so the mark only has to cover
// the call itself, and it cannot leak onto unrelated work.
//
// No imports, so any package or app module can use it without adding an edge to its graph.

/**
 * globalThis-pinned, not module scope: the bundler emits a module like this one many times into one
 * server build, and every copy must read the same depth. `Symbol.for` makes the copies agree.
 */
const SUPPRESSED_KEY = Symbol.for('@civitai/console.forwardingSuppressed');

type SuppressionDepth = { depth: number };

function suppression(): SuppressionDepth {
  const g = globalThis as typeof globalThis & { [SUPPRESSED_KEY]?: SuppressionDepth };
  return (g[SUPPRESSED_KEY] ??= { depth: 0 });
}

/** Run `write` (a console call) so that the console backstop does not forward what it prints. */
export function withConsoleForwardingSuppressed<T>(write: () => T): T {
  const s = suppression();
  s.depth++;
  try {
    return write();
  } finally {
    s.depth--;
  }
}

/** True while a `withConsoleForwardingSuppressed` call is on the stack. */
export function isConsoleForwardingSuppressed(): boolean {
  return suppression().depth > 0;
}
