import type { NextApiRequest } from 'next';
import { prefixCacheKey } from '@civitai/redis';
import { resolveClientIp } from '~/server/utils/client-ip';
import {
  checkFixedWindow,
  type PublicApiRateLimitResult,
} from '~/server/utils/public-api-rate-limit';

/**
 * Per-actor rate limit for the off-site visit redirect (`/apps/go/<listingId>`): 60 requests per
 * 60 s, the window the store's tRPC reads (`appListings.getAppDetail` & co.) carry. Keyed on the
 * signed-in user id, else the client IP (shared predicate), on the same fixed-window primitive as
 * the public REST limiter — and, like it, FAILS OPEN on a Redis error: this is abuse control, not
 * the authorization boundary (the listing visibility gate is).
 */
export const APP_VISIT_RATE_LIMIT_MAX = 60;
export const APP_VISIT_RATE_LIMIT_WINDOW_SECONDS = 60;

export function appVisitRateLimitKey(userId: number | null | undefined, ip: string): string {
  const bucket = userId != null ? `user:${userId}` : `ip:${ip}`;
  return prefixCacheKey(`app-visit:rate-limit:${bucket}`);
}

export async function checkAppVisitRateLimit({
  req,
  userId,
}: {
  req: NextApiRequest;
  userId?: number | null;
}): Promise<PublicApiRateLimitResult> {
  return checkFixedWindow(
    appVisitRateLimitKey(userId, resolveClientIp(req)),
    APP_VISIT_RATE_LIMIT_MAX,
    APP_VISIT_RATE_LIMIT_WINDOW_SECONDS
  );
}
