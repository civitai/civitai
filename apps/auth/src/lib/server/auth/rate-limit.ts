import { getRedis } from '../redis';

// Redis fixed-window rate limiter, mirroring the main app's server/oauth/rate-limit.ts. Fail-OPEN
// (a redis blip must never lock users out of login). Rate-limit keys are dynamic per identifier,
// so cast past @civitai/redis's typed-key surface like the main app does.
export async function checkRateLimit(
  bucket: string,
  identifier: string | null | undefined,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  // No per-client identifier (e.g. the real client IP couldn't be resolved behind the proxy) → do NOT
  // apply a shared global bucket. Per-client or not at all; skip the limit rather than throttle everyone.
  if (!identifier) return true;
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
