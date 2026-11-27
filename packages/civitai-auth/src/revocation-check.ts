import { isReadonlyError } from '@civitai/redis';
import { createRevocationMarkerCache } from './revocation-marker-cache';
import { createSessionRegistry, type SessionRegistryRedis } from './session-registry';
import { SESSION_REGISTRY_KEYS } from './session-registry-keys';
import type { SessionClaims } from './types';

// The `isRevoked` every app hands to its verifier (the main app, the hub, and each spoke through
// createSpokeGuard): the same registry read everywhere, so a sign-out, ban or force-logout written anywhere
// ends the session everywhere. Reads are bounded by a deadline, so a slow or unavailable store never blocks a
// request.
//
// When the read fails (an error, the deadline, or the caller's breaker refusing it) the verdict comes from
// the revocation markers this check has already read (revocation-marker-cache.ts): a revocation seen here
// still denies, and a session with no known marker is allowed (signing everyone out during a store outage is
// not the policy). `markerCache: false` (each app maps its SESSION_REVOCATION_CACHE=off|0|false to it) turns
// the record off and restores the plain fail-open.
//
// A transient failure is retried once first (see `retry`), and elevated sessions are the exception to the
// fallback (see `confirmElevated`).

/**
 * The record's size bound, least recently used evicted first. There is no time-based expiry: a held marker
 * only ever revokes tokens signed before it (or the one token or family it names), so keeping it longer cannot
 * deny a session the store would allow, and a process restart empties the record.
 */
export const REVOCATION_MARKER_CACHE_MAX_ENTRIES = 20_000;

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
 * Why a revocation read failed: the read deadline passed (`timeout`), the caller's `bound` refused the read
 * without waiting because its breaker is open (`breaker-open`), or anything else (`error`).
 */
export type RevocationFailureReason = 'timeout' | 'breaker-open' | 'error';
export type RevocationOutcome = 'hit' | RevocationFailureReason;
/**
 * The verdict given when the read failed: `deny_cached` = a revocation marker this check had already read
 * applied; `allow_unknown` = none applied (or the record is off), so the session was allowed.
 */
export type RevocationDegradedVerdict = 'deny_cached' | 'allow_unknown';

export interface RevocationCheckConfig {
  /** The shared session store (`getSysRedis()`). A getter, so building the check never connects. */
  redis: () => SessionRegistryRedis;
  /**
   * Keep a record of the revocation markers read, and answer from it when a read fails (default true). Read
   * once when the check is built. `false` records nothing and every failed read allows, as before the record.
   * Apps map SESSION_REVOCATION_CACHE=off|0|false to `false`.
   */
  markerCache?: boolean;
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
  /**
   * Called when a read fails or times out, with the verdict the check then gave from the markers it had
   * already read.
   */
  onError?: (
    err: unknown,
    reason: RevocationFailureReason,
    claims: SessionClaims,
    verdict: RevocationDegradedVerdict
  ) => void;
  /** Called after every check with its outcome and wall time in seconds. Observability only. */
  onOutcome?: (outcome: RevocationOutcome, seconds: number) => void;
  /**
   * Retry a read that failed fast on a connection-level error once (default true). `false` falls back at
   * once: the hub, which must not add the backoff to every sign-in during an outage.
   */
  retry?: boolean;
  /** Backoff before the one retry after a fast error, in ms (default 200-500, random). */
  retryDelayMs?: () => number;
  /** How long to stop retrying after a retry fails, in ms (default REVOCATION_RETRY_COOLDOWN_MS). */
  retryCooldownMs?: number;
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

// Transient failures a second attempt on a fresh connection or the new primary can get past. A closed or
// refused connection is not one: it persists for the length of an outage. Deliberately narrower than
// @civitai/redis's cluster retry classifiers, which also take connect errors and timeouts.
const FAST_ERROR_CODES = new Set(['ECONNRESET', 'EPIPE']);
const FAILOVER_REPLY = /^(?:NOTMASTER|NOT-MASTER|LOADING|MASTERDOWN)\b/;
const RESET_TEXT = /ECONNRESET|EPIPE|connection reset|broken pipe/i;

/** How long a process stops retrying after a retry fails. */
export const REVOCATION_RETRY_COOLDOWN_MS = 10_000;

function isFastError(err: unknown): boolean {
  if (reasonOf(err) !== 'error') return false;
  const e = err as { code?: unknown; message?: unknown } | null;
  if (typeof e?.code === 'string' && FAST_ERROR_CODES.has(e.code)) return true;
  if (isReadonlyError(err)) return true;
  return (
    typeof e?.message === 'string' && (FAILOVER_REPLY.test(e.message) || RESET_TEXT.test(e.message))
  );
}

const defaultRetryDelayMs = () => 200 + Math.floor(Math.random() * 300);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const quietly = (fn: () => void) => {
  try {
    fn();
  } catch {
    // observability only
  }
};

/** Per-call options: `timeoutMs` replaces the configured deadline for this read only. */
export interface RevocationCheckCallOptions {
  timeoutMs?: number;
}

/**
 * `confirmElevated`'s answer: `ok` = this request's read answered; `unavailable` = it failed, or these claims
 * were never checked, so the session is unconfirmed.
 */
export type ElevatedRevocationVerdict = 'ok' | 'unavailable';

export type RevocationCheck = ((
  claims: SessionClaims,
  opts?: RevocationCheckCallOptions
) => Promise<boolean>) & {
  /**
   * For a session already checked on this request that turned out to be elevated (a moderator, or an
   * impersonation token): pass the same claims object the check was given. The session client refuses the
   * request on `unavailable` and leaves the session as it is.
   */
  confirmElevated: (claims: SessionClaims) => Promise<ElevatedRevocationVerdict>;
};

export function createRevocationCheck(config: RevocationCheckConfig): RevocationCheck {
  const cacheOn = config.markerCache ?? true;
  const markers = createRevocationMarkerCache({ maxEntries: REVOCATION_MARKER_CACHE_MAX_ENTRIES });
  // The same predicate over the markers seen so far. Its reads are in memory and never touch the store.
  const seenRegistry = createSessionRegistry({
    redis: markers.reader(),
    keys: SESSION_REGISTRY_KEYS,
  });
  let registry: ReturnType<typeof createSessionRegistry> | undefined;
  const registryOf = () => {
    if (registry) return registry;
    const store = config.redis();
    return (registry = createSessionRegistry({
      redis: cacheOn ? markers.observe(store) : store,
      keys: SESSION_REGISTRY_KEYS,
    }));
  };
  const timeoutOf = (): number => {
    const t = config.timeoutMs;
    if (typeof t === 'function') return t();
    return t ?? revocationReadTimeoutMs();
  };
  const bound = config.bound ?? raceDeadline;
  const retryOn = config.retry ?? true;
  const retryDelayMs = config.retryDelayMs ?? defaultRetryDelayMs;
  const retryCooldownMs = config.retryCooldownMs ?? REVOCATION_RETRY_COOLDOWN_MS;
  let retryPausedUntil = 0;
  // Claims whose read answered. Each verifyToken call returns its own claims object, so an entry covers that
  // one verification: another request's read of the same token never confirms this one.
  const answered = new WeakSet<SessionClaims>();

  const check = async (claims: SessionClaims, opts?: RevocationCheckCallOptions) => {
    const started = performance.now();
    const seconds = () => (performance.now() - started) / 1000;
    const read = () => bound(registryOf().isRevoked(claims), opts?.timeoutMs ?? timeoutOf());
    try {
      let revoked: boolean;
      try {
        revoked = await read();
      } catch (err) {
        if (!retryOn || !isFastError(err) || Date.now() < retryPausedUntil) throw err;
        await sleep(retryDelayMs());
        try {
          revoked = await read();
        } catch (retryErr) {
          retryPausedUntil = Date.now() + retryCooldownMs;
          throw retryErr;
        }
      }
      quietly(() => config.onOutcome?.('hit', seconds()));
      answered.add(claims);
      return revoked;
    } catch (err) {
      const reason = reasonOf(err);
      quietly(() => config.onOutcome?.(reason, seconds()));
      answered.delete(claims);
      // Whatever ended the read (error, deadline, open breaker), the verdict comes from the markers seen.
      // The record's reads are in-memory lookups and cannot fail.
      const revoked = cacheOn ? await seenRegistry.isRevoked(claims) : false;
      const verdict: RevocationDegradedVerdict = revoked ? 'deny_cached' : 'allow_unknown';
      quietly(() => config.onError?.(err, reason, claims, verdict));
      return revoked;
    }
  };

  const confirmElevated = async (claims: SessionClaims): Promise<ElevatedRevocationVerdict> =>
    answered.has(claims) ? 'ok' : 'unavailable';

  return Object.assign(check, { confirmElevated });
}
