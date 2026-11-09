import { logToAxiom } from '~/server/logging/client';

/**
 * Record a degraded best-effort read or write (one that fell back to its inert answer) without
 * letting the recording break its caller. `name` is the log event identifier; each caller keeps
 * its own.
 *
 * Always `type: 'error'` (the field the log pipeline reads as the level); callers decide what
 * counts as degraded.
 *
 * The `.catch(() => null)` is load-bearing: nothing awaits this, so a rejected log call would
 * become an unhandled rejection in the caller it only observes. The `try` covers a logger that
 * throws synchronously, for the same reason.
 */
export function noteDegradedRead(name: string, err: unknown): void {
  try {
    logToAxiom({
      name,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      code: (err as { code?: unknown })?.code ?? null,
    }).catch(() => null);
  } catch {
    // The degraded path's whole job is to keep its caller going.
  }
}
