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
  let token: string | null =
    TOKEN_STORE === 'redis'
      ? await sysRedis.hGet(REDIS_KEYS.GENERATION.TOKENS, redisKey).then((x) => x ?? null)
      : getEncryptedCookie(ctx, generationServiceCookie.name);

  if (env.ORCHESTRATOR_MODE === 'dev') token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!token) {
    token = await getTemporaryUserApiKey({
      name: generationServiceCookie.name,
      // make the db token live just slightly longer than the cookie token
      maxAge: generationServiceCookie.maxAge + 5,
      scope: ['Generate'],
      type: 'System',
      userId,
    });
    if (TOKEN_STORE === 'redis') {
      await Promise.all([
        sysRedis.hSet(REDIS_KEYS.GENERATION.TOKENS, redisKey, token),
        sysRedis.hExpire(REDIS_KEYS.GENERATION.TOKENS, redisKey, generationServiceCookie.maxAge),
      ]);
    } else
      setEncryptedCookie(ctx, {
        name: generationServiceCookie.name,
        maxAge: generationServiceCookie.maxAge,
        value: token,
      });
  }
  return token;
}
