import { env } from '~/env/server';
import {
  sysReadBreakerTransitionCounter,
  sysReadGuardFailOpenCounter,
} from '~/server/prom/sys-read-guard.metrics';

/**
 * Fast-fail for request-path reads from the SYSTEM Redis client, behind `withSysReadDeadline`.
 *
 * The deadline (REDIS_SYS_READ_TIMEOUT_MS) bounds one read. While the system Redis is hung, every
 * read still waits out that deadline before its caller's fail-open branch runs, so a request that
 * makes several reads waits several deadlines. The breaker stops paying the wait once the client
 * has shown it is not answering:
 *
 * BREAKER (dark; REDIS_SYS_READ_BREAKER_ENABLED). One per process (globalThis, because the server
 * evaluates this module once per bundler module graph). After REDIS_SYS_READ_BREAKER_THRESHOLD
 * consecutive failed reads (timeout or error) it OPENS: reads reject at once with a
 * SysReadUnavailableError('breaker-open'), so the caller's fail-open runs in ~0ms. After
 * REDIS_SYS_READ_BREAKER_COOLDOWN_MS one read is let through as a probe (HALF-OPEN; every other read
 * still fails fast); the probe's success closes the breaker, its failure re-opens it for another
 * cooldown. A probe that has not settled within one cooldown (only possible with the deadline off)
 * is abandoned and the next read probes instead, so a hung probe cannot hold the breaker half-open.
 * A null reply is a success.
 *
 * What an open breaker skips depends on what the call site passes:
 * - a THUNK (`() => sysRedis.get(k)`) is never invoked, so the client is not touched at all;
 * - a PROMISE (`sysRedis.get(k)`, what every existing call site passes) was created before the guard
 *   ran, so the command is already queued on the client; the guard stops the caller WAITING for it.
 *   The command still settles in the background, bounded by the client's command queue cap. Existing
 *   call sites stay in promise form on purpose: the client's self-heal watchdog detects a wedge from
 *   commands piling up and timing out on the client, and a breaker that stopped issuing them would
 *   hide the wedge from the thing that repairs it.
 *
 * Reads only. A call with a side effect (a write, a MULTI that writes, an EVAL, a destructive pop) or
 * a read whose failure decides a security/authz or moderation outcome must use `withSysDeadline`,
 * which bounds the wait and never consults the breaker, so a healthy write is never refused during
 * the breaker's cooldown.
 *
 * Mirrors the cluster-cache guard's breaker (same states, defaults and env shape) so the two can be
 * unified later; it lives in its own module until then.
 */

export type SysReadFailureReason = 'timeout' | 'error' | 'breaker-open';

export class SysReadUnavailableError extends Error {
  readonly reason: SysReadFailureReason;
  constructor(message: string, reason: SysReadFailureReason, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SysReadUnavailableError';
    this.reason = reason;
  }
}

export type BreakerState = 'closed' | 'open' | 'half-open';

export type BreakerConfig = { threshold: number; cooldownMs: number };

export type CircuitBreaker = {
  /** Whether a call may go to the client now. In half-open, true for exactly one probe at a time. */
  allow(cfg: BreakerConfig, now: number): boolean;
  onSuccess(): void;
  onFailure(cfg: BreakerConfig, now: number): void;
  state(): BreakerState;
  reset(): void;
};

export function createCircuitBreaker(onTransition?: (to: BreakerState) => void): CircuitBreaker {
  let state: BreakerState = 'closed';
  let consecutiveFailures = 0;
  let openedAt = 0;
  let probeInFlight = false;
  let probeStartedAt = 0;

  const moveTo = (to: BreakerState) => {
    if (state === to) return;
    state = to;
    try {
      onTransition?.(to);
    } catch {
      // Observability only.
    }
  };

  const startProbe = (now: number) => {
    probeInFlight = true;
    probeStartedAt = now;
  };

  return {
    allow(cfg, now) {
      if (state === 'closed') return true;
      if (state === 'open') {
        if (now - openedAt < cfg.cooldownMs) return false;
        moveTo('half-open');
        startProbe(now);
        return true;
      }
      // half-open: one probe at a time, unless the probe in flight has outlived a cooldown.
      if (probeInFlight && now - probeStartedAt < cfg.cooldownMs) return false;
      startProbe(now);
      return true;
    },
    onSuccess() {
      consecutiveFailures = 0;
      probeInFlight = false;
      moveTo('closed');
    },
    onFailure(cfg, now) {
      probeInFlight = false;
      if (state === 'half-open') {
        openedAt = now;
        moveTo('open');
        return;
      }
      consecutiveFailures += 1;
      if (state === 'closed' && consecutiveFailures >= Math.max(1, cfg.threshold)) {
        openedAt = now;
        moveTo('open');
      }
    },
    state: () => state,
    reset() {
      state = 'closed';
      consecutiveFailures = 0;
      openedAt = 0;
      probeInFlight = false;
      probeStartedAt = 0;
    },
  };
}

export type SysReadGuardConfig = {
  breakerEnabled: boolean;
  breaker: BreakerConfig;
};

export type SysReadGuardDeps = {
  config: () => SysReadGuardConfig;
  breaker: CircuitBreaker;
  now?: () => number;
  onFailure?: (reason: SysReadFailureReason) => void;
};

/** What a guarded read takes: the command's promise, or a thunk that issues it. */
export type SysReadOp<T> = Promise<T> | (() => Promise<T>);

/**
 * Race `p` against a rejecting timer. `ms <= 0` returns `p` unchanged. The timer is always cleared,
 * and Promise.race keeps a handler on `p`, so a late rejection of the abandoned command never
 * surfaces as an unhandledRejection. It does not cancel `p`.
 */
export function raceSysDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms || ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SysReadUnavailableError(`sysRedis read timed out after ${ms}ms`, 'timeout')),
      ms
    );
  });
  return Promise.race([p, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function start<T>(op: SysReadOp<T>): Promise<T> {
  if (typeof op !== 'function') return op;
  // Promise.resolve().then so a synchronous throw from the thunk is a rejection like any other.
  return Promise.resolve().then(op);
}

export function createSysReadGuard(deps: SysReadGuardDeps) {
  const now = deps.now ?? Date.now;

  const report = (reason: SysReadFailureReason) => {
    try {
      deps.onFailure?.(reason);
    } catch {
      // Observability only.
    }
  };

  return function guardedRead<T>(op: SysReadOp<T>, ms: number): Promise<T> {
    const cfg = deps.config();

    if (!cfg.breakerEnabled) {
      // Dark: exactly the deadline the call sites have always had. `ms <= 0` hands back the
      // caller's own promise.
      const p = start(op);
      if (!ms || ms <= 0) return p;
      return raceSysDeadline(p, ms).catch((err) => {
        report(err instanceof SysReadUnavailableError ? err.reason : 'error');
        throw err;
      });
    }

    if (!deps.breaker.allow(cfg.breaker, now())) {
      // A promise-form command is already on the client; keep a handler on it so its eventual
      // rejection is not an unhandledRejection. A thunk is simply never called.
      if (typeof op !== 'function') op.catch(() => undefined);
      report('breaker-open');
      return Promise.reject(
        new SysReadUnavailableError('sysRedis read skipped: breaker open', 'breaker-open')
      );
    }

    return raceSysDeadline(start(op), ms).then(
      (value) => {
        deps.breaker.onSuccess();
        return value;
      },
      (err) => {
        deps.breaker.onFailure(cfg.breaker, now());
        report(err instanceof SysReadUnavailableError ? err.reason : 'error');
        throw err;
      }
    );
  };
}

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var __civitaiSysReadBreaker: CircuitBreaker | undefined;
}

/** The process-wide breaker behind `withSysReadDeadline`. */
export const sysReadBreaker: CircuitBreaker = (globalThis.__civitaiSysReadBreaker ??=
  createCircuitBreaker((to) => sysReadBreakerTransitionCounter.inc({ to })));

/** Read per call, so a changed env (or a test's setEnv) applies without rebuilding the guard. */
export function sysReadGuardConfigFromEnv(): SysReadGuardConfig {
  return {
    breakerEnabled: env.REDIS_SYS_READ_BREAKER_ENABLED === true,
    breaker: {
      threshold: env.REDIS_SYS_READ_BREAKER_THRESHOLD,
      cooldownMs: env.REDIS_SYS_READ_BREAKER_COOLDOWN_MS,
    },
  };
}

export const sysReadGuard = createSysReadGuard({
  config: sysReadGuardConfigFromEnv,
  breaker: sysReadBreaker,
  onFailure: (reason) => sysReadGuardFailOpenCounter.inc({ reason }),
});
