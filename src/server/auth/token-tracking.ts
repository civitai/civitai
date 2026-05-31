import type { JWT } from 'next-auth/jwt';
import { REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { hSetWithTTL } from '~/server/redis/atomic';
import type { User } from '~/shared/utils/prisma/models';
import { createLogger } from '~/utils/logging';
import { clearSessionCache } from './session-cache';

const DEFAULT_EXPIRATION = 60 * 60 * 24 * 30; // 30 days
const log = createLogger('token-tracking', 'green');

export async function trackToken(tokenId: string, userId: number) {
  try {
    const key = `${REDIS_KEYS.SESSION.USER_TOKENS}:${userId}`;

    // Atomic single-EVAL set+TTL — closes the race window where a process
    // kill or sysRedis flap between the two awaits leaves a no-TTL field.
    await hSetWithTTL(
      sysRedis,
      key,
      tokenId,
      Date.now(),
      DEFAULT_EXPIRATION * 1000
    );

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

  // Atomic single-EVAL set+TTL — closes the race window where a process kill
  // or sysRedis flap between the two awaits leaves a no-TTL field. Important
  // here because TOKEN_STATE='invalid' must reliably expire — if it sticks
  // forever a re-issued tokenId could be permanently rejected.
  await hSetWithTTL(
    sysRedis,
    REDIS_SYS_KEYS.SESSION.TOKEN_STATE,
    token.id,
    'invalid',
    DEFAULT_EXPIRATION * 1000
  );

  // Remove from user's token hash
  if (!token.user) return;
  const user = token.user as User;
  await Promise.all([
    sysRedis.hDel(`${REDIS_KEYS.SESSION.USER_TOKENS}:${user.id}` as any, token.id),
    clearSessionCache(user.id),
  ]);

  log(`Invalidated token ${token.id}`);
}
