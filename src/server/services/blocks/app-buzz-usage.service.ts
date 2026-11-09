import { sysRedis } from '~/server/redis/client';
import { buzzCapRedisKey } from '~/server/services/blocks/block-buzz-cap';
import { resolveUserAppCaps } from '~/server/services/blocks/user-app-caps.service';
import { calendarWindow } from '~/server/services/usage-limit-counters';
import type { UsageLimit } from '~/server/services/usage-limits.service';

export const APP_BUZZ_DAILY_ID = 'apps.buzz-daily';

/**
 * Buzz the user has spent through apps today, read from the counter the per-user cap reserves
 * against, as a usage-limit row. Moderators are not exempt from that cap, so they get real counts.
 */
export async function getMyAppBuzzToday(userId: number): Promise<UsageLimit> {
  const [{ buzzPerDay }, raw] = await Promise.all([
    resolveUserAppCaps(userId),
    sysRedis.get(buzzCapRedisKey(userId)),
  ]);
  // A refund racing the key's first write can leave it below zero.
  const used = Math.max(0, Number(raw ?? 0) || 0);
  const remaining = Math.max(0, buzzPerDay - used);
  const resetAt = calendarWindow('utc-day', Date.now()).end.toISOString();
  return {
    id: APP_BUZZ_DAILY_ID,
    area: 'apps',
    label: 'Buzz spent in apps per day',
    limit: buzzPerDay,
    used,
    remaining,
    windowSeconds: null,
    window: 'utc-day',
    nextAt: remaining > 0 ? null : resetAt,
    resetAt,
  };
}
