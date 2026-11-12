import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { calendarWindow } from '~/server/services/usage-limit-counters';

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

/**
 * Seconds from now to the end of today's UTC-day window (at least 1). The same window end the
 * paused notice shows as `resetAt` (`calendarWindow('utc-day', …).end`), so the two cannot differ.
 */
export function secondsToUtcReset(now = Date.now()): number {
  const { end } = calendarWindow('utc-day', now);
  return Math.max(1, Math.ceil((end.getTime() - now) / 1000));
}

/**
 * Records that a reservation was refused at the viewer's daily cap `cap`, until the UTC reset or
 * the next daily-cap check that passes (`clearDailyCapRefusal`), whichever comes first: "paused"
 * means the LAST daily-cap check refused. The refusal itself is the signal: a refused spend is
 * refunded, so the counter stays below the cap and cannot say "paused" on its own. Best-effort: a
 * lost write only hides the notice. Never throws.
 */
export async function markDailyCapRefused(userId: number, cap: number): Promise<void> {
  try {
    await sysRedis.set(buzzCapRefusedRedisKey(userId), String(cap), { EX: secondsToUtcReset() });
  } catch {
    // the notice is an affordance, not a control: the refusal already happened
  }
}

/**
 * A daily-cap check passed: the last check no longer refused, so the app is not paused (a smaller
 * job fits where a bigger one did not). Best-effort, never throws: a lost delete leaves the
 * notice up until the next check or the reset.
 */
export async function clearDailyCapRefusal(userId: number): Promise<void> {
  try {
    await sysRedis.del(buzzCapRefusedRedisKey(userId));
  } catch {
    // an affordance, not a control
  }
}
