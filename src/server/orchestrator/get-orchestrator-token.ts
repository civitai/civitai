import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { REDIS_KEYS, sysRedis } from '~/server/redis/client';
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
  // fallback path below by setting token=null on error.
  let token: string | null;
  try {
    token =
      TOKEN_STORE === 'redis'
        ? await sysRedis.hGet(REDIS_KEYS.GENERATION.TOKENS, redisKey).then((x) => x ?? null)
        : getEncryptedCookie(ctx, generationServiceCookie.name);
  } catch (err) {
    console.warn('[getOrchestratorToken] sysRedis hGet failed, minting fresh token:', err);
    token = null;
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
      await Promise.all([
        sysRedis.hSet(REDIS_KEYS.GENERATION.TOKENS, redisKey, token),
        sysRedis.hExpire(REDIS_KEYS.GENERATION.TOKENS, redisKey, generationServiceCookie.maxAge),
      ]).catch((err) => {
        console.warn('[getOrchestratorToken] sysRedis cache writeback failed:', err);
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
