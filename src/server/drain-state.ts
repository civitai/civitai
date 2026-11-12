// Process-wide "this pod is shutting down" flag, read by the /api/readyz probe.
//
// Once the process has received SIGTERM (or SIGINT) it should stop being picked for new traffic,
// so /api/readyz answers 503 from then on. The flag only records the signal: exiting stays the job
// of the server's own signal handler (Next's start-server, or scripts/trpc-server/server.cjs).
// Both of those install a handler unless NEXT_MANUAL_SIG_HANDLE is set, so adding a listener here
// does not take away Node's default exit-on-signal.
//
// The state lives on `globalThis`, not in a module-level `let`. Next compiles instrumentation
// into a separate bundle from the API routes, so each bundle gets its own copy of this module.
// The signal handler is installed from instrumentation and /api/readyz reads from the route
// bundle; a module-local flag set in one copy would never be seen by the other.
// `src/server/warmup.ts` pins its warm state the same way for the same reason.

declare global {
  // eslint-disable-next-line no-var
  var __civitaiDrainState:
    | { draining: boolean; sinceMs: number | null; handlersInstalled: boolean }
    | undefined;
}

const drain = (globalThis.__civitaiDrainState ??= {
  draining: false,
  sinceMs: null,
  handlersInstalled: false,
});

export const isDraining = () => drain.draining;
export const getDrainingSinceMs = () => drain.sinceMs;

export function markDraining(now = Date.now()) {
  if (drain.draining) return;
  drain.draining = true;
  drain.sinceMs = now;
}

/**
 * Sets the draining flag on SIGTERM / SIGINT. Idempotent across bundles (the guard is on the
 * shared global). Prepended so the flag is set before any handler that starts closing the server.
 */
export function registerDrainSignalHandlers() {
  if (drain.handlersInstalled) return;
  drain.handlersInstalled = true;
  const onSignal = () => markDraining();
  process.prependListener('SIGTERM', onSignal);
  process.prependListener('SIGINT', onSignal);
}
