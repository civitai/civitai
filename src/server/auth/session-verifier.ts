// SPOKE verifier for the main app (Path C demonstration). Not yet wired into the request
// path — `getServerAuthSession` still uses next-auth directly. This shows how a spoke would
// verify the hub-issued JWT LOCALLY (JWKS, no per-request hop) with the existing redis
// revocation marker injected. The hub issues ES256; swap callers over to this when wiring the spoke path.
//
// The revocation check mirrors refreshToken()'s gate: TOKEN_STATE[tokenId] === 'invalid'
// (explicit logout/ban) or a global SESSION.ALL invalidation newer than the token. Reads
// fail OPEN — a sysRedis blip must not 500 every authed request.
import { createAuthVerifier } from '@civitai/auth';
import type { SessionClaims } from '@civitai/auth';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';

async function isRevoked(claims: SessionClaims): Promise<boolean> {
  const tokenId = claims.jti;
  if (!tokenId) return false; // can't check — fail open
  try {
    const [state, allStr] = await Promise.all([
      sysRedis.hGet(REDIS_SYS_KEYS.SESSION.TOKEN_STATE, tokenId),
      sysRedis.get(REDIS_SYS_KEYS.SESSION.ALL),
    ]);
    if (state === 'invalid') return true;
    if (allStr && claims.signedAt && new Date(allStr).getTime() > claims.signedAt) return true;
    return false;
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'session-verifier isRevoked', err, {
      tokenId,
      userId: claims.user?.id,
    });
    return false; // fail open
  }
}

// Singleton — caches the remote JWKS keyset across requests.
export const sessionVerifier = createAuthVerifier({ isRevoked });
