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

/** The per-(user, app, UTC-day) counter a viewer's own daily limit for one app is enforced against. */
export function consentBudgetRedisKey(
  userId: number,
  appBlockId: string
): `${typeof REDIS_SYS_KEYS.BLOCKS.CONSENT_BUDGET}:${string}` {
  return `${REDIS_SYS_KEYS.BLOCKS.CONSENT_BUDGET}:${userId}:${appBlockId}:${buzzCapWindowKey()}`;
}

/**
 * What the viewer has spent today against their own limit for this app. 0 when the counter is
 * absent or not a number. Throws on a Redis error: a caller that showed 0 instead would tell the
 * viewer they had spent nothing.
 */
export async function readConsentBudgetSpent(userId: number, appBlockId: string): Promise<number> {
  const raw = Number((await sysRedis.get(consentBudgetRedisKey(userId, appBlockId))) ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** A day's spend INCLUDING the cost under judgement exceeds the viewer's limit. */
export function consentCapExceeded(totalIncludingCost: number, cap: number): boolean {
  return totalIncludingCost > cap;
}

export const CONSENT_LIMIT_REFUSED_TTL_SECONDS = 5 * 60;

function consentLimitRefusedRedisKey(
  userId: number,
  appBlockId: string
): `${typeof REDIS_SYS_KEYS.BLOCKS.CONSENT_LIMIT_REFUSED}:${string}` {
  return `${REDIS_SYS_KEYS.BLOCKS.CONSENT_LIMIT_REFUSED}:${userId}:${appBlockId}`;
}

/**
 * Records that a spend was just refused at the viewer's own limit for this app, so the host may
 * offer the raise dialog when the app asks for it. Best-effort, never throws: a lost write only
 * means the app's request does not open the dialog.
 */
export async function markConsentLimitRefused(userId: number, appBlockId: string): Promise<void> {
  try {
    await sysRedis.set(consentLimitRefusedRedisKey(userId, appBlockId), '1', {
      EX: CONSENT_LIMIT_REFUSED_TTL_SECONDS,
    });
  } catch {
    // an affordance, not a control
  }
}

/** Fails closed: a Redis error reads as "not refused", which only keeps the dialog shut. */
export async function wasConsentLimitRefusedRecently(
  userId: number,
  appBlockId: string
): Promise<boolean> {
  try {
    return (await sysRedis.get(consentLimitRefusedRedisKey(userId, appBlockId))) != null;
  } catch {
    return false;
  }
}
