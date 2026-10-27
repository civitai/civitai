// SPOKE verifier for the main app (Path C). The shared revocation check used on the hub-session read path:
// `session-client.ts` injects `isRevoked` into `createSessionClient`, so a logged-out / banned token is
// rejected even on a `session:data2` cache hit (the cache holds the rich user, not the token's validity).
//
// The revocation check is the package registry's, so every app reads the same markers. Reads
// fail OPEN — a sysRedis blip must not 500 every authed request.
import {
  SESSION_REGISTRY_KEYS,
  createAuthVerifier,
  createSessionRegistry,
  type SessionRegistryRedis,
} from '@civitai/auth';
import type { SessionClaims } from '@civitai/auth';
import { sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { observeSessionLeg } from './session-metrics';

// Read-only use: only isRevoked is called, so the write-side config is irrelevant here.
const registry = createSessionRegistry({
  redis: sysRedis as unknown as SessionRegistryRedis,
  keys: SESSION_REGISTRY_KEYS,
});

export async function isRevoked(claims: SessionClaims): Promise<boolean> {
  const tokenId = claims.jti;
  if (!tokenId) return false; // can't check — fail open
  // Bound the revocation read with the shared wall-clock deadline (REDIS_SYS_READ_TIMEOUT_MS, default 2000ms):
  // the sys client carries NO socketTimeout (0, to dodge the reconnect-storm wedge on the single-replica
  // backend), so on a silent half-open these reads could park the whole authed request until OS TCP
  // keepalive (~minutes). withSysReadDeadline races them so a stall FAILS OPEN fast — a revocation-check
  // timeout must never block login (matches the existing catch → return false posture, just bounded now).
  const start = performance.now();
  try {
    const revoked = await withSysReadDeadline(registry.isRevoked(claims));
    observeSessionLeg('revocation', 'hit', (performance.now() - start) / 1000);
    return revoked;
  } catch (err) {
    // withSysReadDeadline rejects with a "…read timed out after Nms" Error on the deadline; anything else is a
    // real read error. Both fail OPEN (return false) — the timeout is just the bounded, observable variant.
    const timedOut = err instanceof Error && /timed out/.test(err.message);
    observeSessionLeg(
      'revocation',
      timedOut ? 'timeout' : 'error',
      (performance.now() - start) / 1000
    );
    logSysRedisFailOpen('read-degraded', 'session-verifier isRevoked', err, {
      tokenId,
      userId: claims.user?.id,
    });
    return false; // fail open
  }
}

// Singleton — caches the remote JWKS keyset across requests.
export const sessionVerifier = createAuthVerifier({ isRevoked });
