import { ErrorReply } from 'redis';

/**
 * Fast-fail for the hot request-path reads from the SYSTEM Redis client.
 *
 * `withSysReadDeadline` bounds one read (REDIS_SYS_READ_TIMEOUT_MS). While the system Redis is hung,
 * every read still waits out that deadline before its caller's fail-open branch runs, and the reads
 * that run on every request pay it on every request. `withSysReadBreaker` adds a breaker for those
 * reads only:
 *
 * BREAKER (dark; REDIS_SYS_READ_BREAKER_ENABLED). One per process (globalThis, because the server
 * evaluates this module once per bundler module graph), shared by every opted-in read. After
 * REDIS_SYS_READ_BREAKER_THRESHOLD consecutive failed reads (a timeout or a client/connection error;
 * an error reply from the store is not a failure, see storeAnswered) it OPENS: opted-in reads
 * reject at once with a SysReadUnavailableError('breaker-open'), so the caller's fail-open runs in
 * ~0ms. After REDIS_SYS_READ_BREAKER_COOLDOWN_MS one read is let through as a probe (HALF-OPEN; every
 * other read still fails fast); the probe's success closes the breaker, its failure re-opens it for
 * another cooldown. A probe that has not settled within one cooldown (only possible with the deadline
 * off) is abandoned and the next read probes instead, so a hung probe cannot hold the breaker
 * half-open. A null reply is a success, and so is an error reply (the store answered).
 *
 * This module is the mechanism only. The process-wide instance lives, unexported, in
 * ./sys-read-deadline.ts, so `withSysReadBreaker` is the only way in (the call-site ledger pins its
 * callers).
 *
 * The caller passes the command's promise, so while the breaker is open the command has already been
 * issued; the breaker stops the caller WAITING for it, and it settles in the background, bounded by the
 * client's command queue cap. That is deliberate: the client's self-heal watchdog detects a wedge from
 * commands piling up and timing out on the client, and a breaker that stopped issuing them would hide
 * the wedge from the thing that repairs it.
 *
 * OPT-IN, for reads that fail open and run on every request. Never for a write, and never for a read
 * whose failure must fail closed. Every other sys read keeps the plain deadline, which never consults
 * or feeds the breaker.
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

/**
 * Whether a rejected read still got an answer from the store: an error reply (ErrorReply, and its
 * SimpleError / BlobError / MultiErrorReply subclasses). Everything else (the guard's own deadline, a
 * closed or offline client, a dropped socket, a reconnect failure, an unknown error) counts against the
 * breaker. Listing the one class that proves health, rather than every class that disproves it, keeps an
 * unlisted connection error from silently never opening the breaker during an outage.
 */
const storeAnswered = (err: unknown): boolean => err instanceof ErrorReply;

export function createSysReadGuard(deps: SysReadGuardDeps) {
  const now = deps.now ?? Date.now;

  const report = (reason: SysReadFailureReason) => {
    try {
      deps.onFailure?.(reason);
    } catch {
      // Observability only.
    }
  };
  const reasonOf = (err: unknown): SysReadFailureReason =>
    err instanceof SysReadUnavailableError ? err.reason : 'error';

  /** The deadline alone. Never consults or feeds the breaker. `ms <= 0` hands back `p` itself. */
  function deadline<T>(p: Promise<T>, ms: number): Promise<T> {
    if (!ms || ms <= 0) return p;
    return raceSysDeadline(p, ms).catch((err) => {
      report(reasonOf(err));
      throw err;
    });
  }

  /**
   * The deadline plus the breaker. While the breaker is disabled this is `deadline` exactly. While it
   * is open it rejects at once; the caller's command was already issued (it is a promise), so it still
   * reaches the client and settles in the background.
   */
  function withBreaker<T>(p: Promise<T>, ms: number): Promise<T> {
    const cfg = deps.config();
    if (!cfg.breakerEnabled) return deadline(p, ms);

    if (!deps.breaker.allow(cfg.breaker, now())) {
      // Keep a handler on the abandoned command so its eventual rejection is not unhandled.
      p.catch(() => undefined);
      report('breaker-open');
      return Promise.reject(
        new SysReadUnavailableError('sysRedis read skipped: breaker open', 'breaker-open')
      );
    }

    return raceSysDeadline(p, ms).then(
      (value) => {
        deps.breaker.onSuccess();
        return value;
      },
      (err) => {
        // An error reply (WRONGTYPE on one bad key, say) proves the store answered: it is healthy as far as
        // the breaker is concerned, while the caller still gets the rejection. Counting it would let one bad
        // key on one opted-in read open the breaker for every other opted-in read.
        if (storeAnswered(err)) deps.breaker.onSuccess();
        else deps.breaker.onFailure(cfg.breaker, now());
        report(reasonOf(err));
        throw err;
      }
    );
  }

  return { deadline, withBreaker };
}
