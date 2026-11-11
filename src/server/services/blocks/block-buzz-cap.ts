import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

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

/** Set for the UTC day once a spend is refused at the viewer's daily cap (`markDailyCapRefused`). */
export function buzzCapRefusedRedisKey(
  userId: number
): `${typeof REDIS_SYS_KEYS.BLOCKS.BUZZ_CAP_REFUSED}:${string}` {
  return `${REDIS_SYS_KEYS.BLOCKS.BUZZ_CAP_REFUSED}:${userId}:${buzzCapWindowKey()}`;
}

/** Seconds from now to the next UTC midnight (at least 1): when today's daily window resets. */
export function secondsToUtcReset(now = Date.now()): number {
  const d = new Date(now);
  const reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((reset - now) / 1000));
}

/**
 * Records that a reservation was refused at the viewer's daily cap `cap`, for the rest of the UTC
 * day. The refusal itself is the signal: a refused spend is refunded, so the counter stays below
 * the cap and cannot say "paused" on its own. Best-effort: a lost write only hides the notice.
 * Never throws.
 */
export async function markDailyCapRefused(userId: number, cap: number): Promise<void> {
  try {
    await sysRedis.set(buzzCapRefusedRedisKey(userId), String(cap), { EX: secondsToUtcReset() });
  } catch {
    // the notice is an affordance, not a control: the refusal already happened
  }
}
