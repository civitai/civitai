import { CacheTTL } from '~/server/common/constants';
import type { RateLimit } from '~/server/middleware.trpc';

export const COMMENT_RATE_LIMIT_MIN_CREATOR_SCORE = 1000;

export const commentRateLimits: RateLimit[] = [
  { limit: 10, period: CacheTTL.hour },
  { limit: 4 * 10, period: CacheTTL.day },
  {
    limit: 60,
    period: CacheTTL.hour,
    userReq: (user) => (user.meta?.scores?.total ?? 0) >= COMMENT_RATE_LIMIT_MIN_CREATOR_SCORE,
  },
  {
    limit: 8 * 60,
    period: CacheTTL.day,
    userReq: (user) => (user.meta?.scores?.total ?? 0) >= COMMENT_RATE_LIMIT_MIN_CREATOR_SCORE,
  },
];
