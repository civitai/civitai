import { prefixCacheKey } from '@civitai/redis';
import { RETRACTED_MEDIA_RATE_LIMIT, retractedMediaRateKey } from '@civitai/shared/retracted-media';
import { getRedis } from './redis';

const WINDOW_SECONDS = 60;

type Counter = {
  incrBy(key: never, by: number): Promise<number>;
  expire(key: never, seconds: number): Promise<unknown>;
  ttl(key: never): Promise<number>;
};

/**
 * Counts one `/api/retracted-media` request for this moderator: the seconds to wait when over
 * `RETRACTED_MEDIA_RATE_LIMIT` a minute, otherwise null. The main app's route uses the same key, so
 * the two share one window where both apps use the same cache Redis and key namespace. A counter
 * that cannot be read refuses.
 */
export async function retractedMediaRetryAfter(
  moderatorId: number,
  redis: Counter = getRedis() as unknown as Counter
): Promise<number | null> {
  const key = prefixCacheKey(retractedMediaRateKey(moderatorId)) as never;
  try {
    const count = await redis.incrBy(key, 1);
    // Re-asserts a lost TTL, which would otherwise lock the moderator out for good.
    if (count === 1 || (await redis.ttl(key)) < 0) await redis.expire(key, WINDOW_SECONDS);
    if (count <= RETRACTED_MEDIA_RATE_LIMIT) return null;
    const ttl = await redis.ttl(key);
    return Number.isFinite(ttl) && ttl > 0 ? ttl : WINDOW_SECONDS;
  } catch {
    return WINDOW_SECONDS;
  }
}
