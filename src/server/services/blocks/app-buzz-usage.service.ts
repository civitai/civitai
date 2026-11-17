import { TRPCError } from '@trpc/server';
import { sysRedis } from '~/server/redis/client';
import {
  isAppBlocksEnabled,
  isAppLimitsUpgradePromptEnabled,
} from '~/server/services/app-blocks-flag';
import {
  BUZZ_OPT_IN_TTL_SECONDS,
  buzzCapRedisKey,
  buzzCapRefusedRedisKey,
  buzzOptInRedisKey,
  clearDailyCapRefusal,
} from '~/server/services/blocks/block-buzz-cap';
import { resolveUserAppCaps } from '~/server/services/blocks/user-app-caps.service';
import { calendarWindow } from '~/server/services/usage-limit-counters';
import type { UsageLimit } from '~/server/services/usage-limits.service';
import type { SessionUser } from '~/types/session';

export const APP_BUZZ_DAILY_ID = 'apps.buzz-daily';

/** Today's figure on the counter the per-user cap reserves against; never below zero. */
async function readUsedToday(userId: number): Promise<number> {
  // A refund racing the key's first write can leave it below zero.
  return Math.max(0, Number((await sysRedis.get(buzzCapRedisKey(userId))) ?? 0) || 0);
}

/** The cap today's daily-cap refusal was at (`markDailyCapRefused`), or null for none. */
async function readRefusedCap(userId: number): Promise<number | null> {
  const raw = await sysRedis.get(buzzCapRefusedRedisKey(userId));
  const cap = raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isFinite(cap) ? cap : null;
}

const resetAtIso = () => calendarWindow('utc-day', Date.now()).end.toISOString();

/**
 * Buzz the user has spent through apps today, read from the counter the per-user cap reserves
 * against, as a usage-limit row; `null` where apps are off. Moderators are not exempt from that
 * cap, so they get real counts. Private and review runs reserve against their own caps and are
 * not in this figure.
 */
export async function getMyAppBuzzToday(user: SessionUser): Promise<UsageLimit | null> {
  if (!(await isAppBlocksEnabled({ user }))) return null;
  const userId = user.id;
  const [{ buzzPerDay }, used] = await Promise.all([
    resolveUserAppCaps(userId),
    readUsedToday(userId),
  ]);
  const remaining = Math.max(0, buzzPerDay - used);
  const resetAt = resetAtIso();
  return {
    id: APP_BUZZ_DAILY_ID,
    area: 'apps',
    label: 'Daily Buzz cap across apps',
    limit: buzzPerDay,
    used,
    remaining,
    windowSeconds: null,
    window: 'utc-day',
    nextAt: remaining > 0 ? null : resetAt,
    resetAt,
  };
}

export type MyAppBuzzCap = {
  /** Spent through apps today. */
  used: number;
  /** The cap enforced now. */
  limit: number;
  /** The plan's cap, and what opting in raises it to. */
  planLimit: number;
  optInLimit: number;
  optedIn: boolean;
  /**
   * The last daily-cap check refused, at the cap enforced now: the running app is paused until
   * the reset, an upgrade, an opt-in, or a smaller spend that fits. From the refusal record, not
   * the counter (a refused spend is refunded, so the counter stays below the cap).
   */
  paused: boolean;
  /** Not opted in yet today: the opt-in is offered. */
  canOptIn: boolean;
  resetAt: string;
};

/**
 * The running app's view of the daily app Buzz cap, for the paused notice: `null` where apps are
 * off or the upgrade-prompt flag is off for this viewer, so with the flag off nothing is read.
 * Every number is `resolveUserAppCaps`'s, the cap the reservation enforces.
 */
export async function getMyAppBuzzCap(user: SessionUser): Promise<MyAppBuzzCap | null> {
  if (!(await isAppBlocksEnabled({ user }))) return null;
  if (!(await isAppLimitsUpgradePromptEnabled({ user }))) return null;
  const [caps, used, refusedAt] = await Promise.all([
    resolveUserAppCaps(user.id),
    readUsedToday(user.id),
    readRefusedCap(user.id),
  ]);
  return {
    used,
    limit: caps.buzzPerDay,
    planLimit: caps.planBuzzPerDay,
    optInLimit: caps.optInBuzzPerDay,
    optedIn: caps.optedIn,
    // Paused only while the cap that refused is still the one enforced: an upgrade or an opt-in
    // changes it, and unpauses at once.
    paused: refusedAt === caps.buzzPerDay,
    canOptIn: !caps.optedIn,
    resetAt: resetAtIso(),
  };
}

/**
 * The viewer opts in to continue on their OWN Buzz past their plan's daily app cap, for the rest
 * of the UTC day. It records one per-user flag and moves no Buzz: every spend after it is still
 * charged to the viewer, as every app spend is, and still reserved against the per-user counter
 * (now under `optInBuzzPerDay`), the per-app consent budget the viewer set, and the per-app cap.
 * Nothing here names or reaches an app or its owner, so an owner is never billed for it.
 *
 * Refused where the flag is off for this viewer (FORBIDDEN). Idempotent within the day.
 */
export async function optInAppBuzzToday(user: SessionUser): Promise<MyAppBuzzCap> {
  if (!(await isAppBlocksEnabled({ user })) || !(await isAppLimitsUpgradePromptEnabled({ user }))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'not available' });
  }
  await sysRedis.set(buzzOptInRedisKey(user.id), '1', { EX: BUZZ_OPT_IN_TTL_SECONDS });
  // The refusal that paused the app was at the plan cap; the raised cap has not refused anything.
  // Best-effort is enough: a record left behind is at the plan cap, which no longer equals the
  // raised cap, so the notice reads as not paused either way.
  await clearDailyCapRefusal(user.id);
  const status = await getMyAppBuzzCap(user);
  if (!status) throw new TRPCError({ code: 'FORBIDDEN', message: 'not available' });
  return status;
}
