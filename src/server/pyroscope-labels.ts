// Request-scoped Pyroscope profile labels: samples taken while a request runs carry the route it
// serves (`route="trpc:image.getInfinite"`), so a profile ranks per route instead of per process.
// Dark unless PYROSCOPE_ENABLED='true': only `registerPyroscope` arms them.
//
// Why not the SDK's `wrapWithLabels`: it sets a process-global label, runs `fn` synchronously and
// restores it, so everything after the first `await` is unlabelled (and a bare `setLabels`
// misattributes interleaved requests). @datadog/pprof's async-context mode (`useCPED`) keys the
// sample context on an AsyncLocalStorage and `time.runWithContext` scopes it across `await`. The
// SDK neither enables nor exposes that mode, so `startWallProfilingWithAsyncContext` injects
// `useCPED: true` into the SDK's one `time.start` call; the SDK already turns `context.labels`
// into sample labels.
//
// Samples outside a labelled scope (Next's routing, GC between continuations) carry no `route`.
// Each kind (`trpc:`, `api:`) has its own per-process budget (ROUTE_BUDGET); past it, new routes
// share `<kind>:<overflow>`, so an API route sweep cannot push tRPC procedures into overflow.
//
// 🔴 State lives on globalThis: Turbopack inlines a server module into many runtime modules, so
// the copy `registerPyroscope` arms is not the copy the request wrappers call. A `Symbol.for`
// key resolves to one slot for every copy. Imports only a constants module, so any server
// module can reach it.

import { ROUTE_BUDGET, type RouteKind } from '~/server/route-label-budget';

/** The Pyroscope arm flag, read once at module load. The one definition; pyroscope.ts re-exports it. */
export const pyroscopeArmed = process.env.PYROSCOPE_ENABLED === 'true';

export const PROFILE_ROUTE_LABEL = 'route';
export const overflowRoute = (kind: RouteKind) => `${kind}:<overflow>`;
const kindOf = (route: string): RouteKind => (route.startsWith('api:') ? 'api' : 'trpc');

const STANDARD_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
/** Method bucket for anything outside STANDARD_METHODS, so a method sweep is one value per route. */
export const OTHER_METHOD = 'OTHER';

/**
 * The `api:` label for a `reconstructApiRoute` string (`<METHOD> /api/...`): a non-standard
 * method is bucketed into OTHER_METHOD.
 */
export function apiProfileRoute(reconstructed: string): string {
  const space = reconstructed.indexOf(' ');
  const method = space === -1 ? reconstructed : reconstructed.slice(0, space);
  const rest = space === -1 ? '' : reconstructed.slice(space);
  return `api:${STANDARD_METHODS.has(method) ? method : OTHER_METHOD}${rest}`;
}

type SampleContext = { labels: Record<string, string> };
type ContextRunner = <R>(context: SampleContext, fn: () => R) => R;
type LabelState = {
  run: ContextRunner;
  contexts: Map<string, SampleContext>;
  counts: Record<RouteKind, number>;
};

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
  const kind = kindOf(route);
  if (state.counts[kind] >= ROUTE_BUDGET[kind]) {
    const overflow = overflowRoute(kind);
    let context = state.contexts.get(overflow);
    if (!context) {
      // Cached outside the budget count, so each kind's overflow context is built once.
      context = newContext(overflow);
      state.contexts.set(overflow, context);
    }
    return context;
  }
  const context = newContext(route);
  state.contexts.set(route, context);
  state.counts[kind]++;
  return context;
}

// One frozen label object per route, reused across requests. pprof's runWithContext still
// allocates a native context holder and an async-storage frame per call; only this object is shared.
const newContext = (route: string): SampleContext =>
  Object.freeze({ labels: Object.freeze({ [PROFILE_ROUTE_LABEL]: route }) });

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
    counts: { trpc: 0, api: 0 },
  };
  return true;
}

/** Test-only: drop the armed state so cases do not leak into each other. */
export function __resetProfileRouteLabelsForTests(): void {
  delete (globalThis as GlobalWithState)[STATE_KEY];
}
