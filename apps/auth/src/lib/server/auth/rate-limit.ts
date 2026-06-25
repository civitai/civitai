import { getRedis } from '../redis';

// Redis fixed-window rate limiter, mirroring the main app's server/oauth/rate-limit.ts. Fail-OPEN
// (a redis blip must never lock users out of login). Rate-limit keys are dynamic per identifier,
// so cast past @civitai/redis's typed-key surface like the main app does.
export async function checkRateLimit(
  bucket: string,
  identifier: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  const key = `auth:rate-limit:${bucket}:${identifier}`;
  try {
    const r = redis as unknown as {
      incr(k: string): Promise<number>;
      expire(k: string, s: number): Promise<unknown>;
    };
    const current = await r.incr(key);
    if (current === 1) await r.expire(key, windowSeconds);
    return current <= limit;
  } catch {
    return true; // fail open
  }
}
