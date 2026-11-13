// SPOKE verifier for the main app (Path C). The shared revocation check used on the hub-session read path:
// `session-client.ts` injects `isRevoked` into `createSessionClient`, so a logged-out / banned token is
// rejected even on a `session:data2` cache hit (the cache holds the rich user, not the token's validity).
//
// The revocation check is the package registry's, so every app reads the same markers. When the read fails,
// the verdict comes from the markers this pod has already read (revocation-marker-cache.ts): a known
// revocation still holds, and a session with none known is allowed, so a sysRedis blip never 500s or signs
// out every authed request.
import {
  SESSION_REGISTRY_KEYS,
  createAuthVerifier,
  createSessionRegistry,
  type SessionRegistryRedis,
} from '@civitai/auth';
import type { SessionClaims } from '@civitai/auth';
import { sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { refuseModerationAccountSession } from './moderation-account';
import { createRevocationMarkerCache } from './revocation-marker-cache';
import { observeRevocationDegraded, observeSessionLeg } from './session-metrics';

// A token is valid for at most AUTH_SESSION_MAX_AGE (30d default) from signing, and the markers live 91d.
// An entry is kept for the shorter of the two after the read that last saw it; a marker older than that
// can only revoke tokens that have already expired.
const SESSION_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MARKER_TTL_MS = 91 * 24 * 60 * 60 * 1000;
// Entries are short strings (a key and an `invalid` or a timestamp), so this is a few MB at most. Only
// revoking token/family states and cut timestamps are held, and the least recently read go first.
const MARKER_CACHE_MAX_ENTRIES = 20_000;

const revocationMarkers = createRevocationMarkerCache({
  maxEntries: MARKER_CACHE_MAX_ENTRIES,
  ttlMs: Math.min(SESSION_TOKEN_MAX_AGE_MS, MARKER_TTL_MS),
});

// Read-only use: only isRevoked is called, so the write-side config is irrelevant here.
const registry = createSessionRegistry({
  redis: revocationMarkers.observe(sysRedis as unknown as SessionRegistryRedis),
  keys: SESSION_REGISTRY_KEYS,
});
// The same predicate over the markers seen so far. Its reads are in-memory and never touch sysRedis.
const seenMarkersRegistry = createSessionRegistry({
  redis: revocationMarkers.reader(),
  keys: SESSION_REGISTRY_KEYS,
});

async function isRevokedBySeenMarkers(claims: SessionClaims): Promise<boolean> {
  try {
    return await seenMarkersRegistry.isRevoked(claims);
  } catch {
    return false; // in-memory reads cannot fail; if they somehow do, keep the fail-open verdict
  }
}

export async function isRevoked(claims: SessionClaims): Promise<boolean> {
  if (refuseModerationAccountSession(claims.sub, 'session-token')) return true;
  const tokenId = claims.jti;
  if (!tokenId) return false; // can't check — fail open
  // Bound the revocation read with the shared wall-clock deadline (REDIS_SYS_READ_TIMEOUT_MS, default 2000ms):
  // the sys client carries NO socketTimeout (0, to dodge the reconnect-storm wedge on the single-replica
  // backend), so on a silent half-open these reads could park the whole authed request until OS TCP
  // keepalive (~minutes). withSysReadDeadline races them so a stall falls back fast — a revocation-check
  // timeout must never block login.
  const start = performance.now();
  try {
    const revoked = await withSysReadDeadline(registry.isRevoked(claims));
    observeSessionLeg('revocation', 'hit', (performance.now() - start) / 1000);
    return revoked;
  } catch (err) {
    // withSysReadDeadline rejects with a "…read timed out after Nms" Error on the deadline; anything else is a
    // real read error. Both fall back to the markers this pod has seen.
    const timedOut = err instanceof Error && /timed out/.test(err.message);
    observeSessionLeg(
      'revocation',
      timedOut ? 'timeout' : 'error',
      (performance.now() - start) / 1000
    );
    const revoked = await isRevokedBySeenMarkers(claims);
    observeRevocationDegraded(revoked ? 'deny_cached' : 'allow_unknown');
    logSysRedisFailOpen('read-degraded', 'session-verifier isRevoked', err, {
      tokenId,
      userId: claims.user?.id,
      verdict: revoked ? 'deny_cached' : 'allow_unknown',
    });
    // With no known marker this is today's fail-open: allowed, and counted above.
    return revoked;
  }
}

// Singleton — caches the remote JWKS keyset across requests.
export const sessionVerifier = createAuthVerifier({ isRevoked });
