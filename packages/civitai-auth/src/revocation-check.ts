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
// Elevated sessions (a moderator, or an impersonation token) are the exception: once the user is resolved the
// session client asks `confirmElevated`, which refuses the request when that session's last read failed. The
// session itself is untouched, so the next request after the store recovers is answered normally.

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

/** Per-call options: `timeoutMs` replaces the configured deadline for this read only. */
export interface RevocationCheckCallOptions {
  timeoutMs?: number;
}

/**
 * `confirmElevated`'s answer: `ok` = the session's last read answered (or it has none on record); `revoked` = the
 * retry found the session revoked; `unavailable` = the read failed and could not be confirmed.
 */
export type ElevatedRevocationVerdict = 'ok' | 'revoked' | 'unavailable';

export type RevocationCheck = ((
  claims: SessionClaims,
  opts?: RevocationCheckCallOptions
) => Promise<boolean>) & {
  /**
   * For a session already checked on this request that turned out to be elevated. A read that ended in a fast
   * error is retried once; one that hit the deadline or the open breaker is not, since a retry would wait again.
   */
  confirmElevated: (claims: SessionClaims) => Promise<ElevatedRevocationVerdict>;
};

/** Bound on the sessions whose last read failed, oldest dropped first. */
const FAILED_READS_MAX_ENTRIES = 20_000;

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
  // jti → why its most recent read failed; cleared by its next answered read.
  const failedReads = new Map<string, RevocationFailureReason>();
  const recordFailure = (jti: string, reason: RevocationFailureReason) => {
    failedReads.delete(jti);
    failedReads.set(jti, reason);
    if (failedReads.size > FAILED_READS_MAX_ENTRIES) {
      failedReads.delete(failedReads.keys().next().value as string);
    }
  };

  const check = async (claims: SessionClaims, opts?: RevocationCheckCallOptions) => {
    const started = performance.now();
    const seconds = () => (performance.now() - started) / 1000;
    try {
      const revoked = await bound(registryOf().isRevoked(claims), opts?.timeoutMs ?? timeoutOf());
      quietly(() => config.onOutcome?.('hit', seconds()));
      if (claims.jti) failedReads.delete(claims.jti);
      return revoked;
    } catch (err) {
      const reason = reasonOf(err);
      quietly(() => config.onOutcome?.(reason, seconds()));
      if (claims.jti) recordFailure(claims.jti, reason);
      // Whatever ended the read (error, deadline, open breaker), the verdict comes from the markers seen.
      // The record's reads are in-memory lookups and cannot fail.
      const revoked = cacheOn ? await seenRegistry.isRevoked(claims) : false;
      const verdict: RevocationDegradedVerdict = revoked ? 'deny_cached' : 'allow_unknown';
      quietly(() => config.onError?.(err, reason, claims, verdict));
      return revoked;
    }
  };

  const confirmElevated = async (claims: SessionClaims): Promise<ElevatedRevocationVerdict> => {
    const jti = claims.jti;
    const reason = jti ? failedReads.get(jti) : undefined;
    if (!jti || !reason) return 'ok';
    if (reason !== 'error') return 'unavailable';
    if (await check(claims)) return 'revoked';
    // A failed retry is recorded again; only an answered read clears the record.
    return failedReads.has(jti) ? 'unavailable' : 'ok';
  };

  return Object.assign(check, { confirmElevated });
}
