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
      // Known partial-failure window: if hSet succeeds and hExpire fails
      // (narrow sysRedis flap between the two commands), the cached token
      // entry has no TTL and lingers past generationServiceCookie.maxAge.
      // Blast radius is bounded — the underlying API key from
      // getTemporaryUserApiKey has its own DB-side expiresAt, so requests
      // fall through to regen once the DB key expires. TODO: collapse
      // set+expire into a single atomic operation (HEXPIRE NX or Lua) to
      // close this window.
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
