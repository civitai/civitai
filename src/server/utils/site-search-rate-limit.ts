import type { NextApiRequest } from 'next';
import { prefixCacheKey } from '@civitai/redis';
import { resolveClientIp } from '~/server/utils/client-ip';
import { checkFixedWindow } from '~/server/utils/public-api-rate-limit';

// Site search fires as the viewer types (a request per keystroke, plus facet counts), so a fast
// typist reaches a few requests a second in bursts. These ceilings sit well above that and stop a
// scraper walking the index. Anonymous traffic is bucketed per IP, which a campus or carrier NAT
// can share, so that ceiling is the higher one.
export const SITE_SEARCH_RATE_LIMIT_USER_MAX = 300;
export const SITE_SEARCH_RATE_LIMIT_IP_MAX = 600;
export const SITE_SEARCH_RATE_LIMIT_WINDOW_SECONDS = 60;

/** Fails open: a Redis incident must not take search down. */
export function checkSiteSearchRateLimit({
  req,
  userId,
}: {
  req: NextApiRequest;
  userId?: number;
}) {
  const authed = typeof userId === 'number';
  const bucket = authed ? `user:${userId}` : `ip:${resolveClientIp(req)}`;
  // A literal key, so the environment namespace is applied explicitly (see
  // `checkPublicApiRateLimit`): without it a non-production deployment spends production budgets.
  return checkFixedWindow(
    prefixCacheKey(`site-search:rate-limit:${bucket}`),
    authed ? SITE_SEARCH_RATE_LIMIT_USER_MAX : SITE_SEARCH_RATE_LIMIT_IP_MAX,
    SITE_SEARCH_RATE_LIMIT_WINDOW_SECONDS
  );
}
