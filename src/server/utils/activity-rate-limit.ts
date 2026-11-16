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
 * The provider sends at most one request per 10 s per tab (more only when a tab buffers over
 * `ACTIVITY_CLIENT_BATCH_SIZE` clicks in that window), about 6 a minute. 120 a minute leaves room
 * for many tabs, or many people sharing one address (offices, carrier NAT), while bounding one
 * address to 120 x `ACTIVITY_BATCH_MAX` rows a minute.
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
