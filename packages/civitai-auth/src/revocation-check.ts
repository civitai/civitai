import { createSessionRegistry, type SessionRegistryRedis } from './session-registry';
import { SESSION_REGISTRY_KEYS } from './session-registry-keys';
import type { SessionClaims } from './types';

// The `isRevoked` every app hands to its verifier (the main app, the hub, and each spoke through
// createSpokeGuard): the same registry read everywhere, so a sign-out, ban or force-logout written anywhere
// ends the session everywhere. Reads fail OPEN, and are bounded by a deadline, so a slow or unavailable store
// never blocks a request or signs anyone out.

/**
 * The deadline when REDIS_SYS_READ_TIMEOUT_MS is unset: the same default as the main app's system-Redis read
 * deadline, which reads the same setting.
 */
export const DEFAULT_REVOCATION_READ_TIMEOUT_MS = 1000;

/**
 * The revocation read deadline from REDIS_SYS_READ_TIMEOUT_MS, read per call. Unset, blank or not a number
 * falls back to the default; `<= 0` turns the deadline off. Read directly rather than through the package env
 * schema, so an unrelated invalid auth variable can never turn every revocation check into a fail-open.
 */
export function revocationReadTimeoutMs(): number {
  const raw = process.env.REDIS_SYS_READ_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_REVOCATION_READ_TIMEOUT_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) ? ms : DEFAULT_REVOCATION_READ_TIMEOUT_MS;
}

/**
 * Why a check failed open: the read deadline passed (`timeout`), the caller's `bound` refused the read
 * without waiting because its breaker is open (`breaker-open`), or anything else (`error`).
 */
export type RevocationFailureReason = 'timeout' | 'breaker-open' | 'error';
export type RevocationOutcome = 'hit' | RevocationFailureReason;

export interface RevocationCheckConfig {
  /** The shared session store (`getSysRedis()`). A getter, so building the check never connects. */
  redis: () => SessionRegistryRedis;
  /**
   * Read deadline in ms, or a getter read on every check. Defaults to `revocationReadTimeoutMs()`
   * (REDIS_SYS_READ_TIMEOUT_MS, else 1000). `<= 0` turns the deadline off.
   */
  timeoutMs?: number | (() => number);
  /**
   * Bounds the read in place of the built-in deadline race, given the read and the deadline. For a caller
   * that already has its own bounded-read helper (the main app's, which adds a read breaker). An error it
   * rejects with that carries `reason: 'timeout'` or `reason: 'breaker-open'` is reported with that reason.
   */
  bound?: (read: Promise<boolean>, timeoutMs: number) => Promise<boolean>;
  /** Called when a read fails or times out and the check fails open. */
  onError?: (err: unknown, reason: RevocationFailureReason, claims: SessionClaims) => void;
  /** Called after every check with its outcome and wall time in seconds. Observability only. */
  onOutcome?: (outcome: RevocationOutcome, seconds: number) => void;
}

class RevocationReadTimeout extends Error {
  readonly reason = 'timeout' as const;
  constructor(ms: number) {
    super(`revocation read timed out after ${ms}ms`);
    this.name = 'RevocationReadTimeout';
  }
}

function raceDeadline(read: Promise<boolean>, ms: number): Promise<boolean> {
  if (!ms || ms <= 0) return read;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RevocationReadTimeout(ms)), ms);
  });
  // Promise.race keeps a handler on `read`, so its late rejection is never an unhandledRejection.
  return Promise.race([read, deadline]).finally(() => clearTimeout(timer));
}

const reasonOf = (err: unknown): RevocationFailureReason => {
  const reason = (err as { reason?: unknown } | null)?.reason;
  return reason === 'timeout' || reason === 'breaker-open' ? reason : 'error';
};

const quietly = (fn: () => void) => {
  try {
    fn();
  } catch {
    // observability only
  }
};

export function createRevocationCheck(
  config: RevocationCheckConfig
): (claims: SessionClaims) => Promise<boolean> {
  let registry: ReturnType<typeof createSessionRegistry> | undefined;
  const timeoutOf = (): number => {
    const t = config.timeoutMs;
    if (typeof t === 'function') return t();
    return t ?? revocationReadTimeoutMs();
  };
  const bound = config.bound ?? raceDeadline;

  return async (claims) => {
    const started = performance.now();
    const seconds = () => (performance.now() - started) / 1000;
    try {
      registry ??= createSessionRegistry({ redis: config.redis(), keys: SESSION_REGISTRY_KEYS });
      const revoked = await bound(registry.isRevoked(claims), timeoutOf());
      quietly(() => config.onOutcome?.('hit', seconds()));
      return revoked;
    } catch (err) {
      const reason = reasonOf(err);
      quietly(() => config.onOutcome?.(reason, seconds()));
      quietly(() => config.onError?.(err, reason, claims));
      return false;
    }
  };
}
