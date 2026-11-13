import { isEnvSwitchOff } from '@civitai/shared/env-switch';
import { createRevocationMarkerCache } from './revocation-marker-cache';
import {
  createSessionRegistry,
  DEFAULT_MARKER_TTL,
  type SessionRegistryRedis,
} from './session-registry';
import { SESSION_REGISTRY_KEYS } from './session-registry-keys';
import type { SessionClaims } from './types';

// The `isRevoked` every app hands to its verifier (the main app, the hub, and each spoke through
// createSpokeGuard): the same registry read everywhere, so a sign-out, ban or force-logout written anywhere
// ends the session everywhere. Reads are bounded by a deadline, so a slow or unavailable store never blocks a
// request.
//
// When the read fails (an error, the deadline, or the caller's breaker refusing it) the verdict comes from
// the revocation markers this check has already read (revocation-marker-cache.ts): a revocation seen here
// still denies, and a session with no known marker is allowed, as before. Signing everyone out during a
// store outage is not the policy. SESSION_REVOCATION_CACHE=off (or 0/false) turns the record off and restores
// the plain fail-open.

/**
 * The record's size bound. Entries are short strings (a key and `invalid` or a timestamp), so this is a few
 * MB at most; only revoking token/family states and cut timestamps are held.
 */
export const REVOCATION_MARKER_CACHE_MAX_ENTRIES = 20_000;
/** A session token's lifetime: the AUTH_SESSION_MAX_AGE default (30d). */
const SESSION_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How long an entry is kept after the read that last saw it: the shorter of a token's lifetime and a
 * marker's. A marker not read for that long can only revoke tokens that have already expired.
 */
export const REVOCATION_MARKER_CACHE_TTL_MS = Math.min(
  SESSION_TOKEN_LIFETIME_MS,
  DEFAULT_MARKER_TTL * 1000
);

/**
 * Whether the record of seen revocation markers is on. Read per call from SESSION_REVOCATION_CACHE: on by
 * default, and `off`, `0` or `false` turns it off (`@civitai/shared/env-switch`).
 */
export function revocationCacheEnabled(): boolean {
  return !isEnvSwitchOff(process.env.SESSION_REVOCATION_CACHE);
}

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

export function createRevocationCheck(
  config: RevocationCheckConfig
): (claims: SessionClaims) => Promise<boolean> {
  let store: SessionRegistryRedis | undefined;
  let plainRegistry: ReturnType<typeof createSessionRegistry> | undefined;
  let observedRegistry: ReturnType<typeof createSessionRegistry> | undefined;
  const markers = createRevocationMarkerCache({
    maxEntries: REVOCATION_MARKER_CACHE_MAX_ENTRIES,
    ttlMs: REVOCATION_MARKER_CACHE_TTL_MS,
  });
  // The same predicate over the markers seen so far. Its reads are in memory and never touch the store.
  const seenRegistry = createSessionRegistry({
    redis: markers.reader(),
    keys: SESSION_REGISTRY_KEYS,
  });
  const registryFor = (cacheOn: boolean) => {
    store ??= config.redis();
    if (!cacheOn) {
      plainRegistry ??= createSessionRegistry({ redis: store, keys: SESSION_REGISTRY_KEYS });
      return plainRegistry;
    }
    observedRegistry ??= createSessionRegistry({
      redis: markers.observe(store),
      keys: SESSION_REGISTRY_KEYS,
    });
    return observedRegistry;
  };
  const timeoutOf = (): number => {
    const t = config.timeoutMs;
    if (typeof t === 'function') return t();
    return t ?? revocationReadTimeoutMs();
  };
  const bound = config.bound ?? raceDeadline;

  return async (claims) => {
    const started = performance.now();
    const seconds = () => (performance.now() - started) / 1000;
    const cacheOn = revocationCacheEnabled();
    try {
      const revoked = await bound(registryFor(cacheOn).isRevoked(claims), timeoutOf());
      quietly(() => config.onOutcome?.('hit', seconds()));
      return revoked;
    } catch (err) {
      const reason = reasonOf(err);
      quietly(() => config.onOutcome?.(reason, seconds()));
      // Whatever ended the read (error, deadline, open breaker), the verdict comes from the markers seen.
      // The record's reads are in-memory lookups and cannot fail.
      const revoked = cacheOn ? await seenRegistry.isRevoked(claims) : false;
      const verdict: RevocationDegradedVerdict = revoked ? 'deny_cached' : 'allow_unknown';
      quietly(() => config.onError?.(err, reason, claims, verdict));
      return revoked;
    }
  };
}
