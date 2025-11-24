import type { JWT } from 'next-auth/jwt';
import { REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { User } from '~/shared/utils/prisma/models';
import { createLogger } from '~/utils/logging';
import { clearSessionCache } from './session-cache';

const DEFAULT_EXPIRATION = 60 * 60 * 24 * 30; // 30 days
const log = createLogger('token-tracking', 'green');

export async function trackToken(tokenId: string, userId: number) {
  try {
    const key = `${REDIS_KEYS.SESSION.USER_TOKENS}:${userId}`;

    // Use sysRedis which supports hExpire for individual field TTL
    await sysRedis.hSet(key as any, tokenId, Date.now());
    await sysRedis.hExpire(key as any, tokenId, DEFAULT_EXPIRATION);

    log(`Tracked token ${tokenId} for user ${userId}`);
  } catch (error) {
    log(`Error tracking token ${tokenId} for user ${userId}: ${(error as Error).message}`);
  }
}

export async function invalidateToken(token: JWT) {
  if (!token?.id || typeof token.id !== 'string') return;

  // await sysRedis
  //   .multi()
  //   .hSet(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, token.id, 'invalid')
  //   .hExpire(REDIS_SYS_KEYS.SESSION.INVALID_TOKENS, token.id, DEFAULT_EXPIRATION)
  //   .exec();

  await sysRedis.hSet(REDIS_SYS_KEYS.SESSION.TOKEN_STATE, token.id, 'invalid');
  await sysRedis.hExpire(REDIS_SYS_KEYS.SESSION.TOKEN_STATE, token.id, DEFAULT_EXPIRATION);

  // Remove from user's token hash
  if (!token.user) return;
  const user = token.user as User;
  await Promise.all([
    sysRedis.hDel(`${REDIS_KEYS.SESSION.USER_TOKENS}:${user.id}` as any, token.id),
    clearSessionCache(user.id),
  ]);

  log(`Invalidated token ${token.id}`);
}
