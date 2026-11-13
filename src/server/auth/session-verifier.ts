// SPOKE verifier for the main app (Path C). The shared revocation check used on the hub-session read path:
// `session-client.ts` injects `isRevoked` into `createSessionClient`, so a logged-out / banned token is
// rejected even on a `session:data2` cache hit (the cache holds the rich user, not the token's validity).
//
// The revocation check is the package registry's, so every app reads the same markers. Reads
// fail OPEN — a sysRedis blip must not 500 every authed request.
import {
  createAuthVerifier,
  createRevocationCheck,
  type SessionRegistryRedis,
} from '@civitai/auth';
import type { SessionClaims } from '@civitai/auth';
import { env } from '~/env/server';
import { sysRedis, withSysReadBreaker } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { refuseModerationAccountSession } from './moderation-account';
import { observeSessionLeg } from './session-metrics';

// The shared revocation check (the same one the hub and the spokes use), bounded by the sys read deadline
// (REDIS_SYS_READ_TIMEOUT_MS, default 1000ms): the sys client carries NO socketTimeout, so on a silent
// half-open this read could park the whole authed request until the client's backstop. It runs on every
// authenticated request, so it also goes through the read breaker: once the breaker has tripped (when
// enabled) a hung store costs this read ~0ms instead of a deadline per request. Fails OPEN (not revoked) on
// a timeout, an open breaker or an error — a revocation-check failure must never block login.
const checkRevocation = createRevocationCheck({
  redis: () => sysRedis as unknown as SessionRegistryRedis,
  timeoutMs: () => env.REDIS_SYS_READ_TIMEOUT_MS,
  bound: (read, ms) => withSysReadBreaker(read, ms),
  onOutcome: (outcome, seconds) => observeSessionLeg('revocation', outcome, seconds),
  onError: (err, _reason, claims) =>
    logSysRedisFailOpen('read-degraded', 'session-verifier isRevoked', err, {
      tokenId: claims.jti,
      userId: claims.user?.id,
    }),
});

export async function isRevoked(claims: SessionClaims): Promise<boolean> {
  if (refuseModerationAccountSession(claims.sub, 'session-token')) return true;
  if (!claims.jti) return false; // can't check — fail open
  return checkRevocation(claims);
}

// Singleton — caches the remote JWKS keyset across requests.
export const sessionVerifier = createAuthVerifier({ isRevoked });
