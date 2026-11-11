import { REDIS_SYS_KEYS } from '~/server/redis/client';

/** UTC calendar day, e.g. '2026-06-02': the window every per-day block Buzz counter keys on. */
export function buzzCapWindowKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The per-user daily Buzz counter the per-user daily cap (`resolveUserAppCaps`) is enforced against. Per user,
 * not per app: all of a user's apps share one daily ceiling.
 */
export function buzzCapRedisKey(
  userId: number
): `${typeof REDIS_SYS_KEYS.BLOCKS.BUZZ_CAP}:${string}` {
  return `${REDIS_SYS_KEYS.BLOCKS.BUZZ_CAP}:${userId}:${buzzCapWindowKey()}`;
}

/**
 * Set for the UTC day once the viewer opts in to continue on their own Buzz past their plan's
 * daily cap. Same window as `buzzCapRedisKey`, so the two roll over together.
 */
export function buzzOptInRedisKey(
  userId: number
): `${typeof REDIS_SYS_KEYS.BLOCKS.BUZZ_CAP_OPT_IN}:${string}` {
  return `${REDIS_SYS_KEYS.BLOCKS.BUZZ_CAP_OPT_IN}:${userId}:${buzzCapWindowKey()}`;
}

/** Outlives the UTC day it names, like the cap counter; the day in the key is what expires it. */
export const BUZZ_OPT_IN_TTL_SECONDS = 25 * 60 * 60;
