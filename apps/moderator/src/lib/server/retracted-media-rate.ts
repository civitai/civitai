import { checkFixedWindowWith, type FixedWindowCounter, prefixCacheKey } from '@civitai/redis';
import { RETRACTED_MEDIA_RATE_LIMIT, retractedMediaRateKey } from '@civitai/shared/retracted-media';
import { getRedis } from './redis';

/**
 * Counts one `/api/retracted-media` request for this moderator: the seconds to wait when over
 * `RETRACTED_MEDIA_RATE_LIMIT` a minute, otherwise null. The main app's route uses the same key, so
 * the two share one window where both apps use the same cache Redis and key namespace. A counter
 * that cannot be read refuses.
 */
export async function retractedMediaRetryAfter(
  moderatorId: number,
  redis: FixedWindowCounter = getRedis() as unknown as FixedWindowCounter
): Promise<number | null> {
  const key = prefixCacheKey(retractedMediaRateKey(moderatorId));
  const result = await checkFixedWindowWith(redis, key, RETRACTED_MEDIA_RATE_LIMIT, 60, {
    failOpen: false,
  });
  return result.allowed ? null : result.retryAfterSeconds;
}
