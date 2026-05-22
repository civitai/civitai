import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { REDIS_KEYS, sysRedis } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { getTemporaryUserApiKey } from '~/server/services/api-key.service';
import { getEncryptedCookie, setEncryptedCookie } from '~/server/utils/cookie-encryption';
import { generationServiceCookie } from '~/shared/constants/generation.constants';

type Context = {
  req: NextApiRequest;
  res: NextApiResponse;
};

const TOKEN_STORE: 'redis' | 'cookie' = false ? 'cookie' : 'redis';

export async function getOrchestratorToken(userId: number, ctx: Context) {
  const redisKey = userId.toString();
  // Fail open on sysRedis: fall through to the getTemporaryUserApiKey
  // fallback path below by setting token=null on error. Catch is scoped
  // to the redis branch so an exception from getEncryptedCookie (cookie
  // mode) isn't silently masked as a "sysRedis" issue.
  let token: string | null;
  if (TOKEN_STORE === 'redis') {
    try {
      token = await sysRedis
        .hGet(REDIS_KEYS.GENERATION.TOKENS, redisKey)
        .then((x) => x ?? null);
    } catch (err) {
      logSysRedisFailOpen(
        'token-mint-amplification',
        'getOrchestratorToken hGet',
        err,
        { userId, action: 'minting-fresh-token' }
      );
      token = null;
    }
  } else {
    token = getEncryptedCookie(ctx, generationServiceCookie.name);
  }

  if (env.ORCHESTRATOR_MODE === 'dev') token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!token) {
    token = await getTemporaryUserApiKey({
      name: generationServiceCookie.name,
      // make the db token live just slightly longer than the cookie token
      maxAge: generationServiceCookie.maxAge + 5,
      type: 'System',
      userId,
    });
    if (TOKEN_STORE === 'redis') {
      // Cache populate is best-effort: if sysRedis is down we still return
      // the freshly-minted token. Without this catch, the writeback would
      // 500 every call during a sysRedis outage — defeating the read-side
      // fail-open above.
      //
      // Partial-failure window is wider than "sysRedis flap between
      // commands". Promise.all fires hSet and hExpire concurrently as
      // independent commands (not a Redis MULTI), so:
      //   - If HEXPIRE arrives before HSET, the field doesn't exist yet
      //     → Redis returns 0 (no rejection), then HSET writes without
      //     TTL. Result: no-TTL key even on a healthy server.
      //   - If both succeed in either order, key has TTL.
      //   - If hSet succeeds and hExpire rejects, no-TTL key.
      //
      // Blast radius if the no-TTL state lands: NOT a transparent re-mint.
      // The underlying API key from getTemporaryUserApiKey has a DB-side
      // expiresAt (generationServiceCookie.maxAge + 5 ≈ 1h). After that
      // expires, the API key is dead at the orchestrator side, but the
      // cached no-TTL token stays in this hash. Subsequent calls hit the
      // hGet read path above → return the dead token → orchestrator
      // returns 401 → user-visible auth failure. There is no automatic
      // recovery; the cache entry has to be manually evicted or a full
      // session invalidation has to fire. TODO before HA cutover:
      // collapse set+expire into a single atomic operation (HEXPIRE NX
      // with prior HSET, or a Lua script). Same TODO applies to the 5
      // other hSet+hExpire pairs catalogued in PR #2286 round-8 audit.
      await Promise.all([
        sysRedis.hSet(REDIS_KEYS.GENERATION.TOKENS, redisKey, token),
        sysRedis.hExpire(REDIS_KEYS.GENERATION.TOKENS, redisKey, generationServiceCookie.maxAge),
      ]).catch((err) => {
        logSysRedisFailOpen(
          'write-degraded',
          'getOrchestratorToken cache writeback',
          err,
          { userId }
        );
      });
    } else
      setEncryptedCookie(ctx, {
        name: generationServiceCookie.name,
        maxAge: generationServiceCookie.maxAge,
        value: token,
      });
  }
  return token;
}
