import { env } from '~/env/server';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import {
  clusterCacheBreakerTransitionCounter,
  clusterCacheFailOpenCounter,
} from '~/server/prom/cluster-cache-guard.metrics';

/**
 * Fast-fail for request-path calls to the CLUSTER (cache) Redis client.
 *
 * The cluster client's own backstop is a 15s per-command deadline (REDIS_CLUSTER_COMMAND_TIMEOUT_MS)
 * plus an offline queue, so while the cluster is unreachable or half-open every cache read a request
 * makes waits up to 15s before its caller's fail-open branch runs — and several reads chained on one
 * request wait N × 15s. A cache read is worth a few milliseconds when it hits; it is not worth more
 * than a miss costs. This module bounds the wait and, optionally, stops paying it at all:
 *
 * 1. DEADLINE (on by default; REDIS_CACHE_READ_DEADLINE_MS, `0` turns it off). Each guarded call
 *    races a wall-clock timer, so a command that was written and never answered — the case node-redis's
 *    own command timeout does not cover once the command is on the wire — releases the caller after
 *    `ms`. The abandoned command is not cancelled; Promise.race keeps a handler on it so its late
 *    rejection is never an unhandledRejection.
 *
 * 2. BREAKER (dark; REDIS_CACHE_BREAKER_ENABLED). One per process (globalThis, because the server
 *    evaluates this module once per bundler module graph). After REDIS_CACHE_BREAKER_THRESHOLD
 *    consecutive failures it OPENS: guarded calls fail immediately without touching the client, so
 *    an outage costs ~0ms per call. After REDIS_CACHE_BREAKER_COOLDOWN_MS one call is let through as
 *    a probe (HALF-OPEN; every other call still fails fast); the probe's success closes the breaker,
 *    its failure re-opens it for another cooldown. A cache MISS (null) is a success.
 *
 * Callers choose what a failure means. `readOr` turns it into the caller's fallback (a miss, usually);
 * `writeBestEffort` swallows it; `call` throws a ClusterCacheUnavailableError for callers that need
 * to branch (the rate limiter falls back to a per-pod limit, the blocklist to its last-known copy).
 *
 * Every failure is counted (`cluster_cache_guard_failopen_total{fn,reason}`); timeouts and errors are
 * also logged through the fail-open logger. Breaker short-circuits are counted only — logging each
 * one would emit a line per request for the whole outage.
 */

export type ClusterCacheFailureReason = 'timeout' | 'error' | 'breaker-open';

export class ClusterCacheUnavailableError extends Error {
  readonly fn: string;
  readonly reason: ClusterCacheFailureReason;
  constructor(fn: string, reason: ClusterCacheFailureReason, cause?: unknown) {
    super(`cluster cache unavailable (${reason}) in ${fn}`, { cause });
    this.name = 'ClusterCacheUnavailableError';
    this.fn = fn;
    this.reason = reason;
  }
}

export type BreakerState = 'closed' | 'open' | 'half-open';

export type BreakerConfig = { threshold: number; cooldownMs: number };

export type CircuitBreaker = {
  /**
   * Admit a call, or refuse it (null). An admitted call gets a TICKET — the breaker's generation at
   * admission — which it hands back with its outcome. In half-open, exactly one probe is admitted.
   */
  allow(cfg: BreakerConfig, now: number): number | null;
  onSuccess(ticket: number): void;
  onFailure(cfg: BreakerConfig, now: number, ticket: number): void;
  state(): BreakerState;
  reset(): void;
};

/**
 * Every state change starts a new GENERATION, and an outcome is applied only if its ticket is from
 * the current one. Without that, a call admitted while closed that settles after the breaker
 * tripped would close the open breaker on a late success, or clear a half-open probe slot with a
 * late failure — an outcome describing the store as it was before the trip.
 */
export function createCircuitBreaker(onTransition?: (to: BreakerState) => void): CircuitBreaker {
  let state: BreakerState = 'closed';
  let generation = 0;
  let consecutiveFailures = 0;
  let openedAt = 0;
  let probeInFlight = false;

  const moveTo = (to: BreakerState) => {
    if (state === to) return;
    state = to;
    generation += 1;
    try {
      onTransition?.(to);
    } catch {
      // Observability only.
    }
  };

  return {
    allow(cfg, now) {
      if (state === 'closed') return generation;
      if (state === 'open') {
        if (now - openedAt < cfg.cooldownMs) return null;
        moveTo('half-open');
        probeInFlight = true;
        return generation;
      }
      // half-open: one probe at a time.
      if (probeInFlight) return null;
      probeInFlight = true;
      return generation;
    },
    onSuccess(ticket) {
      if (ticket !== generation) return;
      consecutiveFailures = 0;
      probeInFlight = false;
      moveTo('closed');
    },
    onFailure(cfg, now, ticket) {
      if (ticket !== generation) return;
      probeInFlight = false;
      if (state === 'half-open') {
        openedAt = now;
        moveTo('open');
        return;
      }
      consecutiveFailures += 1;
      if (state === 'closed' && consecutiveFailures >= Math.max(1, cfg.threshold)) {
        openedAt = now;
        consecutiveFailures = 0;
        moveTo('open');
      }
    },
    state: () => state,
    reset() {
      state = 'closed';
      generation += 1;
      consecutiveFailures = 0;
      openedAt = 0;
      probeInFlight = false;
    },
  };
}

export type ClusterCacheGuardConfig = {
  /** Wall-clock bound per call; `<= 0` disables the deadline. */
  deadlineMs: number;
  breakerEnabled: boolean;
  breaker: BreakerConfig;
};

export type ClusterCacheGuardDeps = {
  config: () => ClusterCacheGuardConfig;
  breaker: CircuitBreaker;
  now?: () => number;
  onFailure?: (
    fn: string,
    reason: ClusterCacheFailureReason,
    err: unknown,
    kind: 'read' | 'write',
    logExtra?: Record<string, unknown>
  ) => void;
};

/** Per-call override of the configured deadline (`<= 0` disables it for this call). */
export type CallOptions = {
  deadlineMs?: number;
  /** Extra fields for the fail-open log line (bounded, non-secret values only). */
  logExtra?: Record<string, unknown>;
};

function raceDeadline<T>(p: Promise<T>, ms: number, fn: string): Promise<T> {
  if (!ms || ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ClusterCacheUnavailableError(fn, 'timeout')), ms);
  });
  return Promise.race([p, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function createClusterCacheGuard(deps: ClusterCacheGuardDeps) {
  const now = deps.now ?? Date.now;

  const report = (
    fn: string,
    reason: ClusterCacheFailureReason,
    err: unknown,
    kind: 'read' | 'write',
    opts?: CallOptions
  ) => {
    if (!deps.onFailure) return;
    if (opts?.logExtra) deps.onFailure(fn, reason, err, kind, opts.logExtra);
    else deps.onFailure(fn, reason, err, kind);
  };

  async function run<T>(
    fn: string,
    op: () => Promise<T>,
    kind: 'read' | 'write',
    opts?: CallOptions
  ): Promise<T> {
    const cfg = deps.config();
    const deadlineMs = opts?.deadlineMs ?? cfg.deadlineMs;
    const useBreaker = cfg.breakerEnabled;
    const ticket = useBreaker ? deps.breaker.allow(cfg.breaker, now()) : null;
    if (useBreaker && ticket === null) {
      const err = new ClusterCacheUnavailableError(fn, 'breaker-open');
      report(fn, 'breaker-open', err, kind, opts);
      throw err;
    }
    try {
      // Promise.resolve().then so a synchronous throw from `op` is a rejection like any other.
      const value = await raceDeadline(Promise.resolve().then(op), deadlineMs, fn);
      if (ticket !== null) deps.breaker.onSuccess(ticket);
      return value;
    } catch (err) {
      if (ticket !== null) deps.breaker.onFailure(cfg.breaker, now(), ticket);
      const reason: ClusterCacheFailureReason =
        err instanceof ClusterCacheUnavailableError ? err.reason : 'error';
      report(fn, reason, err, kind, opts);
      throw err instanceof ClusterCacheUnavailableError
        ? err
        : new ClusterCacheUnavailableError(fn, reason, err);
    }
  }

  return {
    /** Run `op` under the deadline and breaker; throws ClusterCacheUnavailableError on any failure. */
    call: <T>(fn: string, op: () => Promise<T>, opts?: CallOptions) => run(fn, op, 'read', opts),
    /** Run a cache read; any failure (error, timeout, open breaker) returns `fallback` instead. */
    async readOr<T, F>(
      fn: string,
      op: () => Promise<T>,
      fallback: F,
      opts?: CallOptions
    ): Promise<T | F> {
      try {
        return await run(fn, op, 'read', opts);
      } catch {
        return fallback;
      }
    },
    /** Run a best-effort cache write; any failure is swallowed. Resolves true when it landed. */
    async writeBestEffort(
      fn: string,
      op: () => Promise<unknown>,
      opts?: CallOptions
    ): Promise<boolean> {
      try {
        await run(fn, op, 'write', opts);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type ClusterCacheGuard = ReturnType<typeof createClusterCacheGuard>;

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var __civitaiClusterCacheBreaker: CircuitBreaker | undefined;
}

/** The process-wide breaker behind `clusterCacheGuard`. */
export const clusterCacheBreaker: CircuitBreaker = (globalThis.__civitaiClusterCacheBreaker ??=
  createCircuitBreaker((to) => clusterCacheBreakerTransitionCounter.inc({ to })));

/** Read per call, so a changed env (or a test's setEnv) applies without rebuilding the guard. */
export function clusterCacheGuardConfigFromEnv(): ClusterCacheGuardConfig {
  return {
    deadlineMs: env.REDIS_CACHE_READ_DEADLINE_MS,
    breakerEnabled: env.REDIS_CACHE_BREAKER_ENABLED,
    breaker: {
      threshold: env.REDIS_CACHE_BREAKER_THRESHOLD,
      cooldownMs: env.REDIS_CACHE_BREAKER_COOLDOWN_MS,
    },
  };
}

export const clusterCacheGuard: ClusterCacheGuard = createClusterCacheGuard({
  config: clusterCacheGuardConfigFromEnv,
  breaker: clusterCacheBreaker,
  onFailure: (fn, reason, err, kind, logExtra) => {
    try {
      clusterCacheFailOpenCounter.inc({ fn, reason, kind });
    } catch {
      // Observability only.
    }
    if (reason === 'breaker-open') return;
    logSysRedisFailOpen(kind === 'write' ? 'write-degraded' : 'read-degraded', fn, err, {
      ...logExtra,
      client: 'cluster',
      reason,
    });
  },
});
