import type { NextApiRequest, NextApiResponse } from 'next';
import { redis } from '~/server/redis/client';

const RATE_LIMIT_PREFIX = 'oauth:rate-limit';

interface RateLimitConfig {
  /** Max requests allowed in the window */
  limit: number;
  /** Window size in seconds */
  windowSeconds: number;
}

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  token: { limit: 20, windowSeconds: 60 }, // 20 req/min per client
  authorize: { limit: 10, windowSeconds: 60 }, // 10 req/min per user
  revoke: { limit: 20, windowSeconds: 60 }, // 20 req/min per client
};

/**
 * Dynamic Client Registration (RFC 7591) is open + unauthenticated, so the
 * register endpoint gets a stricter, multi-window IP limit: 5/hour AND 20/day.
 * A request must pass BOTH windows. Tracked separately from RATE_LIMITS so the
 * single-window helper above stays simple for the existing endpoints.
 */
const REGISTER_RATE_LIMITS: RateLimitConfig[] = [
  { limit: 5, windowSeconds: 60 * 60 }, // 5 per hour per IP
  { limit: 20, windowSeconds: 24 * 60 * 60 }, // 20 per day per IP
];

/**
 * Multi-window sliding-window rate limiter for the open DCR /register endpoint.
 * Keyed by IP. Returns true if the request is allowed by ALL windows.
 * Sets X-RateLimit-* headers reflecting the most-constrained window and a
 * Retry-After when blocked. Fails open if Redis is unavailable.
 */
export async function checkRegisterRateLimit(res: NextApiResponse, ip: string): Promise<boolean> {
  const identifier = ip || 'unknown';

  try {
    let blocked = false;
    let tightestRemaining = Infinity;
    let blockedTtl = 0;
    let headerLimit = REGISTER_RATE_LIMITS[0].limit;

    for (const config of REGISTER_RATE_LIMITS) {
      const key = `${RATE_LIMIT_PREFIX}:register:${config.windowSeconds}:${identifier}`;
      const current = await (redis as any).incr(key);
      if (current === 1) {
        await (redis as any).expire(key, config.windowSeconds);
      }
      const remaining = config.limit - current;
      if (remaining < tightestRemaining) {
        tightestRemaining = remaining;
        headerLimit = config.limit;
      }
      if (current > config.limit) {
        const ttl = await (redis as any).ttl(key);
        blocked = true;
        blockedTtl = Math.max(blockedTtl, Math.max(0, ttl));
      }
    }

    res.setHeader('X-RateLimit-Limit', headerLimit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, tightestRemaining));

    if (blocked) {
      res.setHeader('Retry-After', blockedTtl);
      res.setHeader('X-RateLimit-Reset', Math.ceil(Date.now() / 1000) + blockedTtl);
      return false;
    }
    return true;
  } catch {
    // Fail open for rate limiting if Redis is unavailable.
    return true;
  }
}

/**
 * Simple sliding-window rate limiter for OAuth endpoints.
 * Returns true if the request should be allowed, false if rate limited.
 * Sets rate limit headers on the response.
 */
export async function checkOAuthRateLimit(
  req: NextApiRequest,
  res: NextApiResponse,
  endpoint: keyof typeof RATE_LIMITS,
  identifier: string
): Promise<boolean> {
  const config = RATE_LIMITS[endpoint];
  if (!config) return true;

  const key = `${RATE_LIMIT_PREFIX}:${endpoint}:${identifier}`;

  try {
    // Rate limit keys are dynamic (per client/user), cast to bypass typed key system
    const current = await (redis as any).incr(key);

    // Set expiry on first request in window
    if (current === 1) {
      await (redis as any).expire(key, config.windowSeconds);
    }

    // Set rate limit headers
    const ttl = await (redis as any).ttl(key);
    res.setHeader('X-RateLimit-Limit', config.limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, config.limit - current));
    res.setHeader('X-RateLimit-Reset', Math.ceil(Date.now() / 1000) + Math.max(0, ttl));

    if (current > config.limit) {
      res.setHeader('Retry-After', Math.max(0, ttl));
      return false;
    }

    return true;
  } catch {
    // If Redis fails, allow the request (fail open for rate limiting)
    return true;
  }
}

/**
 * Helper to send a 429 Too Many Requests response
 */
export function sendRateLimitResponse(res: NextApiResponse): void {
  res.status(429).json({
    error: 'rate_limit_exceeded',
    error_description: 'Too many requests. Please try again later.',
  });
}
