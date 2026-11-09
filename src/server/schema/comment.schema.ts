import { usageLimits } from '~/shared/constants/usage-limits';

export { COMMENT_RATE_LIMIT_MIN_CREATOR_SCORE } from '~/shared/constants/usage-limits';

export const commentRateLimits = usageLimits('comments.hourly', 'comments.daily');
/** The bucket every comment surface counts against, and the usage-limits read reads. */
export const COMMENT_V3_RATE_LIMIT_KEY = 'commentv3:write';
