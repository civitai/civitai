import type { RateLimitMeta } from '~/shared/utils/rate-limit-meta';
import { getRateLimit } from '~/utils/rate-limit';

/**
 * The `rateLimit` field of a bridge error reply: `{ rateLimit }` when `err` is a refusal carrying
 * the standard retry meta (`data.rateLimit` on a `TRPCClientError`), otherwise `{}`. Spread it
 * into every error reply built from a caught server error, so an app can read the limit, its
 * counts and the retry time whichever limiter refused the call.
 */
export function rateLimitReplyFields(err: unknown): { rateLimit?: RateLimitMeta } {
  const rateLimit = getRateLimit(err);
  return rateLimit ? { rateLimit } : {};
}
