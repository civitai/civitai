// Request-scoped Pyroscope profile labels: tag the CPU/wall samples taken while a request runs
// with the route that request serves (`route="trpc:image.getInfinite"`, `route="api:GET /api/v1/images"`),
// so a profile can be ranked per route instead of per process.
//
// DARK unless PYROSCOPE_ENABLED='true'. Only `registerPyroscope` (src/server/pyroscope.ts) arms
// the labels, and it returns before doing so when the flag is unset — so dark, `withProfileRoute`
// is one property read and a direct call of the thunk, and the call sites skip even that (they
// branch on `pyroscopeArmed`).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY NOT THE SDK'S OWN LABEL API
// @pyroscope/nodejs 0.6.2's `wrapWithLabels(labels, fn)` sets a process-global label, runs `fn`
// SYNCHRONOUSLY, then restores the previous label. Everything after the first `await` in `fn`
// runs once `fn` has returned, so it is labelled with whatever is global at that moment — the
// label covers only the synchronous prefix of a request. `setLabels` without a restore is worse:
// concurrent requests interleave on one thread, so a global label misattributes their samples.
//
// What follows the request across `await` is the profiler's own async-context mode:
// @datadog/pprof (5.14.4, the SDK's pinned dependency) can key the sample context on an
// AsyncLocalStorage (`useCPED`, needs Node >= 22.7 — the runtime is Node 24, where
// AsyncLocalStorage is backed by AsyncContextFrame) and exposes `time.runWithContext(ctx, fn)`.
// The SDK neither enables that mode nor exposes it, so `startWallProfilingWithAsyncContext`
// below starts the SDK's wall profiler with `useCPED: true` injected into the one
// `time.start` call it makes, and `withProfileRoute` uses `time.runWithContext`. The SDK
// turns each sample's context `{ labels }` into pprof sample labels, so no SDK code changes.
//
// LIMITS (also in the PR body):
// - Samples OUTSIDE a labelled scope carry no `route` label: Next's routing, request parsing
//   before the wrapper, GC that V8 runs between continuations, and any work a request schedules
//   that outlives it (setImmediate/setTimeout created inside it DO inherit the label).
// - tRPC: the request-level label is the procedure path for a single call, `trpc:batch` for a
//   batched call (that covers context creation, batch parsing and response serialization);
//   each procedure's middleware chain + resolver is then labelled with its own path.
// - Pages-API routes are labelled only where they go through `withApiMetrics` (the endpoint
//   helper wrappers); bare `export default` handlers carry no label.
// - Cardinality: at most MAX_DISTINCT_ROUTES distinct values per process; the rest share
//   `<overflow>`. Inputs are already normalised (procedure registry / reconstructApiRoute).
// - If the SDK resolves a different @datadog/pprof copy than this app (a version bump that
//   breaks the pin in package.json), the arm detects it and leaves labels off; profiling
//   itself still runs, with pod/pool/version tags only.
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 PROCESS-WIDE STATE LIVES ON globalThis. Turbopack inlines a server module into many runtime
// modules, so module-scope state is per copy: the copy that `registerPyroscope` arms (via
// instrumentation.node.ts) is not the copy trpc.ts or endpoint-helpers.ts call. The runner and
// the route cache are therefore stored under a `Symbol.for` key that every copy resolves to the
// same slot.
//
// Server-only. Imports nothing, so it is safe to reach from any server module.

/** The Pyroscope arm flag, read once at module load. The one definition; pyroscope.ts re-exports it. */
export const pyroscopeArmed = process.env.PYROSCOPE_ENABLED === 'true';

export const PROFILE_ROUTE_LABEL = 'route';
export const MAX_DISTINCT_ROUTES = 1500;
export const OVERFLOW_ROUTE = '<overflow>';

type SampleContext = { labels: Record<string, string> };
type ContextRunner = <R>(context: SampleContext, fn: () => R) => R;
type LabelState = { run: ContextRunner; contexts: Map<string, SampleContext> };

const STATE_KEY = Symbol.for('civitai.pyroscope.profileRouteLabels');

type GlobalWithState = typeof globalThis & { [STATE_KEY]?: LabelState };

/** The subset of `@datadog/pprof`'s `time` export this module drives. */
export type PprofTime = {
  start: (options: Record<string, unknown>) => void;
  isStarted: () => boolean;
  runWithContext: <R>(context: object, fn: () => R) => R;
};

/**
 * Run `fn` with every profiler sample taken inside it — including after any `await` — labelled
 * `route=<route>`. Returns `fn()`'s result unchanged (a promise stays the same promise).
 * A pass-through when dark or when labels could not be armed.
 */
export function withProfileRoute<R>(route: string | (() => string), fn: () => R): R {
  const state = (globalThis as GlobalWithState)[STATE_KEY];
  if (!state) return fn();
  return state.run(contextFor(state, typeof route === 'function' ? route() : route), fn);
}

function contextFor(state: LabelState, route: string): SampleContext {
  const cached = state.contexts.get(route);
  if (cached) return cached;
  if (state.contexts.size >= MAX_DISTINCT_ROUTES) {
    let overflow = state.contexts.get(OVERFLOW_ROUTE);
    if (!overflow) {
      // One slot past the cap, so the overflow context is itself cached.
      overflow = { labels: { [PROFILE_ROUTE_LABEL]: OVERFLOW_ROUTE } };
      state.contexts.set(OVERFLOW_ROUTE, overflow);
    }
    return overflow;
  }
  // Frozen and reused: the profiler holds a reference per sample, so one object per route.
  const context = Object.freeze({ labels: Object.freeze({ [PROFILE_ROUTE_LABEL]: route }) });
  state.contexts.set(route, context);
  return context;
}

/**
 * Start the SDK's wall profiler with @datadog/pprof's async-context mode on, and arm
 * `withProfileRoute` if that worked. Returns whether route labels are live.
 *
 * `startWall` is the SDK's `startWallProfiling`; `time` is `@datadog/pprof`'s `time` export, or
 * undefined if it could not be loaded. The SDK calls `time.start` exactly once, from
 * `startWallProfiling` (later flushes use `stop(restart)`), so the override is installed only
 * around that call and always restored.
 *
 * Fallbacks, each leaving profiling ON without labels:
 * - `time` unavailable → plain start.
 * - async-context start throws (e.g. a Node build without AsyncContextFrame) → plain start.
 * - the SDK never called OUR `time.start`, or our copy reports not started → the SDK loaded a
 *   different @datadog/pprof copy; labels would never reach its samples, so they stay off.
 */
export function startWallProfilingWithAsyncContext(
  startWall: () => void,
  time: PprofTime | undefined
): boolean {
  if (!time) {
    startWall();
    return false;
  }
  const originalStart = time.start;
  let calledWithAsyncContext = false;
  let asyncContextError: unknown;
  time.start = (options) => {
    calledWithAsyncContext = true;
    return originalStart.call(time, { ...options, useCPED: true });
  };
  try {
    startWall();
  } catch (err) {
    asyncContextError = err;
  } finally {
    time.start = originalStart;
  }

  if (asyncContextError !== undefined) {
    console.warn(
      '[pyroscope] async-context profiling unavailable; profiling without route labels:',
      asyncContextError
    );
    startWall();
    return false;
  }
  if (!calledWithAsyncContext || !time.isStarted()) {
    console.warn(
      '[pyroscope] the SDK did not start this @datadog/pprof copy; profiling without route labels'
    );
    return false;
  }

  (globalThis as GlobalWithState)[STATE_KEY] = {
    run: (context, fn) => time.runWithContext(context, fn),
    contexts: new Map(),
  };
  return true;
}

/** Test-only: drop the armed state so cases do not leak into each other. */
export function __resetProfileRouteLabelsForTests(): void {
  delete (globalThis as GlobalWithState)[STATE_KEY];
}
