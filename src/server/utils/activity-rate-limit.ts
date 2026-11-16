import { prefixCacheKey } from '@civitai/redis';
import {
  checkFixedWindow,
  type PublicApiRateLimitResult,
} from '~/server/utils/public-api-rate-limit';

/**
 * Per-IP rate limit for the click-activity beacon (`/api/internal/activity`), on the public REST
 * limiter's fixed-window primitive: INCR + EXPIRE on the `redis` cache cluster (never sysRedis),
 * under the environment cache-key prefix. FAILS OPEN on a Redis error: abuse control, not an
 * authorization boundary.
 *
 * 120 a minute is well above one tab's ~6 requests a minute, leaving room for many tabs or many
 * people behind one address, while capping one address at 120 × `ACTIVITY_BATCH_MAX` rows a minute.
 */
export const ACTIVITY_RATE_LIMIT_MAX = 120;
export const ACTIVITY_RATE_LIMIT_WINDOW_SECONDS = 60;

export function activityRateLimitKey(ip: string): string {
  return prefixCacheKey(`activity:rate-limit:ip:${ip}`);
}

export async function checkActivityRateLimit(ip: string): Promise<PublicApiRateLimitResult> {
  return checkFixedWindow(
    activityRateLimitKey(ip),
    ACTIVITY_RATE_LIMIT_MAX,
    ACTIVITY_RATE_LIMIT_WINDOW_SECONDS
  );
}
