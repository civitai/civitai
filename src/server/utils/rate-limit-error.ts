import { TRPCError } from '@trpc/server';
import { parseRateLimitMeta, type RateLimitMeta } from '~/shared/utils/rate-limit-meta';

/**
 * Throws the TOO_MANY_REQUESTS refusal for a shared-storage write, carrying the retry
 * metadata as `cause.rateLimit`. The tRPC error formatter lifts it onto `data.rateLimit` and
 * `handleEndpointError` onto the REST body + `Retry-After`; `message` is the caller's prose.
 */
export function throwSharedRateLimited(
  rl: { retryAfterSeconds: number; retryAt: string },
  message: string
): never {
  const rateLimit: RateLimitMeta = {
    code: 'RATE_LIMITED',
    retryAfterSeconds: rl.retryAfterSeconds,
    retryAt: rl.retryAt,
  };
  throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message, cause: { rateLimit } });
}

/** The retry metadata a TOO_MANY_REQUESTS `TRPCError` carries, or `undefined`. */
export function rateLimitMetaOf(error: unknown): RateLimitMeta | undefined {
  if (!(error instanceof TRPCError) || error.code !== 'TOO_MANY_REQUESTS') return undefined;
  return parseRateLimitMeta((error.cause as { rateLimit?: unknown } | undefined)?.rateLimit);
}
