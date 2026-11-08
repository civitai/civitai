import type { NextApiRequest } from 'next';
import { prefixCacheKey } from '@civitai/redis';
import { resolveClientIp } from '~/server/utils/client-ip';
import {
  checkFixedWindow,
  type PublicApiRateLimitResult,
} from '~/server/utils/public-api-rate-limit';

/**
 * Per-actor rate limit for the off-site visit redirect (`/apps/go/<listingId>`), keyed on the
 * signed-in user id, else the client IP, on the public REST limiter's fixed-window primitive.
 * FAILS OPEN on a Redis error: abuse control, not the authorization boundary.
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
