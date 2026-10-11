import { TRPCError } from '@trpc/server';
import type { RateLimitMeta } from '~/shared/utils/rate-limit-meta';

/**
 * Throws the TOO_MANY_REQUESTS refusal for a shared-storage write, carrying the retry
 * metadata as `cause.rateLimit`, with `retryAt` derived here as now + `retryAfterSeconds`.
 * The tRPC error formatter lifts it onto `data.rateLimit` and `handleEndpointError` onto the
 * REST body + `Retry-After`; `message` is the caller's prose.
 */
export function throwSharedRateLimited(rl: { retryAfterSeconds: number }, message: string): never {
  const rateLimit: RateLimitMeta = {
    retryAfterSeconds: rl.retryAfterSeconds,
    retryAt: new Date(Date.now() + rl.retryAfterSeconds * 1000).toISOString(),
  };
  throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message, cause: { rateLimit } });
}

/**
 * The retry metadata a TOO_MANY_REQUESTS `TRPCError` carries, or `undefined`. Forwarded
 * unvalidated: `throwSharedRateLimited` must stay the only writer of `cause.rateLimit`.
 */
export function rateLimitMetaOf(error: unknown): RateLimitMeta | undefined {
  if (!(error instanceof TRPCError) || error.code !== 'TOO_MANY_REQUESTS') return undefined;
  const rateLimit = (error.cause as { rateLimit?: unknown } | undefined)?.rateLimit;
  if (!rateLimit || typeof rateLimit !== 'object') return undefined;
  return rateLimit as RateLimitMeta;
}
