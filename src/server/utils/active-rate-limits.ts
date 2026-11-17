import { redis, REDIS_KEYS } from '~/server/redis/client';
import { hSetWithTTL } from '~/server/redis/atomic';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';

/**
 * Abuse limits a user is refused by right now, for the account page's "temporarily limited"
 * banner. Written only when `claimRateLimitAttempt` refuses an abuse rule for a signed-in user, so
 * admitted requests pay nothing; each field expires at its retry time, so the hash empties itself.
 *
 * The page sees a coarse area and a retry time, never the limiter key: which rule tripped, and
 * its numbers, are not something an abuse limit tells the caller.
 */
const activeLimitsKey = (userId: number) => `${REDIS_KEYS.TRPC.LIMIT.ACTIVE}:${userId}` as const;

/** The first segment of a limiter key (a tRPC router, or a sharedKey's prefix) → what the user did. */
const AREA_BY_PREFIX: Record<string, string> = {
  reaction: 'reactions',
  comment: 'comments',
  commentv2: 'comments',
  commentv3: 'comments',
  chat: 'chat',
  post: 'posting',
  postIntent: 'posting',
  article: 'articles',
  image: 'images',
  model: 'models',
  modelVersion: 'models',
  collection: 'collections',
  generation: 'generation',
  orchestrator: 'generation',
  training: 'training',
  buzz: 'Buzz',
  user: 'account changes',
};

export const FALLBACK_LIMITED_AREA = 'some actions';

export function limitedArea(keyName: string) {
  return AREA_BY_PREFIX[keyName.split(':')[0]] ?? FALLBACK_LIMITED_AREA;
}

export async function markActiveLimit({
  userId,
  keyName,
  retryAt,
  now = Date.now(),
}: {
  userId: number;
  keyName: string;
  retryAt: number;
  now?: number;
}) {
  const ttlMs = retryAt - now;
  if (ttlMs <= 0) return;
  try {
    await hSetWithTTL(redis, activeLimitsKey(userId), keyName, retryAt, ttlMs);
  } catch (error) {
    // The refusal still goes out; only the account-page banner misses it.
    logSysRedisFailOpen('write-degraded', 'active-rate-limits.markActiveLimit', error, { userId });
  }
}

export type ActiveLimit = { area: string; retryAt: string };

/** The caller's own active abuse limits, one per area (the latest retry wins), soonest first. */
export async function getActiveLimits(userId: number, now = Date.now()): Promise<ActiveLimit[]> {
  let fields: Record<string, string>;
  try {
    fields = await redis.hGetAll(activeLimitsKey(userId));
  } catch (error) {
    logSysRedisFailOpen('read-degraded', 'active-rate-limits.getActiveLimits', error, { userId });
    return [];
  }
  const byArea = new Map<string, number>();
  for (const [keyName, value] of Object.entries(fields ?? {})) {
    const retryAt = Number(value);
    // Field expiry is the cleanup; this only hides one that is due but not yet reaped.
    if (!Number.isFinite(retryAt) || retryAt <= now) continue;
    const area = limitedArea(keyName);
    byArea.set(area, Math.max(byArea.get(area) ?? 0, retryAt));
  }
  return [...byArea]
    .sort((a, b) => a[1] - b[1])
    .map(([area, retryAt]) => ({ area, retryAt: new Date(retryAt).toISOString() }));
}
