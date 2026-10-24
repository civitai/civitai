import { TRPCError } from '@trpc/server';
import type { RateLimitMeta } from '~/shared/utils/rate-limit-meta';

/** The house retry metadata for a refusal that may be retried in `retryAfterSeconds`. */
export function rateLimitMetaFor(retryAfterSeconds: number): RateLimitMeta {
  return {
    retryAfterSeconds,
    retryAt: new Date(Date.now() + retryAfterSeconds * 1000).toISOString(),
  };
}

/**
 * Throws the TOO_MANY_REQUESTS refusal for a shared-storage write, carrying the retry
 * metadata as `cause.rateLimit`, with `retryAt` derived here as now + `retryAfterSeconds`.
 * The tRPC error formatter lifts it onto `data.rateLimit` and `handleEndpointError` onto the
 * REST body + `Retry-After`; `message` is the caller's prose.
 */
export function throwSharedRateLimited(rl: { retryAfterSeconds: number }, message: string): never {
  const rateLimit = rateLimitMetaFor(rl.retryAfterSeconds);
  throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message, cause: { rateLimit } });
}

/**
 * The retry metadata a TOO_MANY_REQUESTS `TRPCError` carries, or `undefined`. Copies only the
 * two known fields, so anything else a writer puts on `cause.rateLimit` never reaches a client.
 */
export function rateLimitMetaOf(error: unknown): RateLimitMeta | undefined {
  if (!(error instanceof TRPCError) || error.code !== 'TOO_MANY_REQUESTS') return undefined;
  const rateLimit = (error.cause as { rateLimit?: unknown } | undefined)?.rateLimit;
  if (!rateLimit || typeof rateLimit !== 'object') return undefined;
  const { retryAfterSeconds, retryAt } = rateLimit as RateLimitMeta;
  return { retryAfterSeconds, retryAt };
}
