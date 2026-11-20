import { createHash } from 'crypto';
import { getRedis } from '../redis';

// Redis fixed-window rate limiter, mirroring the main app's server/oauth/rate-limit.ts. Fail-OPEN
// (a redis blip must never lock users out of login). Rate-limit keys are dynamic per identifier,
// so cast past @civitai/redis's typed-key surface like the main app does.

// INCR, and set the window on the first hit or on a key that lost its expiry (which would otherwise lock
// the identifier out for good). Returns {count, ttl seconds}.
const CONSUME_SCRIPT = `local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if count == 1 or ttl == -1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}`;
const CONSUME_SHA = createHash('sha1').update(CONSUME_SCRIPT).digest('hex');

type ScriptOptions = { keys: string[]; arguments: string[] };
type ScriptClient = {
  evalSha(sha: string, options: ScriptOptions): Promise<unknown>;
  eval(script: string, options: ScriptOptions): Promise<unknown>;
};

export type RateLimitResult = { ok: true } | { ok: false; retryAfter: number };

/** Count one request against `bucket`; when over `limit`, the seconds until its window ends (at least 1). */
export async function consumeRateLimit(
  bucket: string,
  identifier: string | null | undefined,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  // No per-client identifier (e.g. the real client IP couldn't be resolved behind the proxy) → do NOT
  // apply a shared global bucket. Per-client or not at all; skip the limit rather than throttle everyone.
  if (!identifier) return { ok: true };
  const redis = getRedis() as unknown as ScriptClient | null;
  if (!redis) return { ok: true };
  const options = {
    keys: [`auth:rate-limit:${bucket}:${identifier}`],
    arguments: [String(windowSeconds)],
  };
  try {
    // EVALSHA so the body is not resent per request; the first call on a node that lacks it loads it.
    const reply = await redis.evalSha(CONSUME_SHA, options).catch((err: unknown) => {
      if (String((err as Error)?.message ?? err).includes('NOSCRIPT')) {
        return redis.eval(CONSUME_SCRIPT, options);
      }
      throw err;
    });
    const [count, ttl] = (reply as [number, number]).map(Number);
    if (count <= limit) return { ok: true };
    return { ok: false, retryAfter: Math.max(1, Number.isFinite(ttl) ? ttl : windowSeconds) };
  } catch {
    return { ok: true }; // fail open
  }
}

export async function checkRateLimit(
  bucket: string,
  identifier: string | null | undefined,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  return (await consumeRateLimit(bucket, identifier, limit, windowSeconds)).ok;
}

// Repairs a key that lost its expiry, which would otherwise hold a peek-only bucket over its limit for good.
const TTL_SCRIPT = `local ttl = redis.call('TTL', KEYS[1])
if ttl == -1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return ttl`;

/** Seconds left in `identifier`'s current window; null with no window or no redis. */
export async function rateLimitTtl(
  bucket: string,
  identifier: string | null | undefined,
  windowSeconds: number
): Promise<number | null> {
  if (!identifier) return null;
  const redis = getRedis() as unknown as ScriptClient | null;
  if (!redis) return null;
  try {
    const ttl = Number(
      await redis.eval(TTL_SCRIPT, {
        keys: [`auth:rate-limit:${bucket}:${identifier}`],
        arguments: [String(windowSeconds)],
      })
    );
    return ttl > 0 ? ttl : null;
  } catch {
    return null;
  }
}

/**
 * Whether `identifier` has already used up `limit` in the current window, WITHOUT counting this request.
 * For a bucket charged only on some outcomes (checkRateLimit counts every call). Fail-open like it.
 */
export async function isRateLimited(
  bucket: string,
  identifier: string | null | undefined,
  limit: number
): Promise<boolean> {
  if (!identifier) return false;
  const redis = getRedis();
  if (!redis) return false;
  try {
    const r = redis as unknown as { get(k: string): Promise<string | null> };
    return Number((await r.get(`auth:rate-limit:${bucket}:${identifier}`)) ?? 0) >= limit;
  } catch {
    return false;
  }
}
