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
 * Throws the TOO_MANY_REQUESTS refusal carrying `meta` as `cause.rateLimit`, where the tRPC
 * error formatter and `handleEndpointError` lift it. `message` is the caller's prose.
 */
export function throwRateLimited(meta: RateLimitMeta, message: string): never {
  throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message, cause: { rateLimit: meta } });
}

const META_FIELDS = [
  'retryAfterSeconds',
  'retryAt',
  'id',
  'kind',
] as const satisfies readonly (keyof RateLimitMeta)[];
const PRODUCT_FIELDS = [
  'limit',
  'used',
  'remaining',
  'windowSeconds',
  'resetAt',
] as const satisfies readonly (keyof RateLimitMeta)[];

/**
 * The retry metadata a TOO_MANY_REQUESTS `TRPCError` carries, or `undefined`. Copies only the
 * `RateLimitMeta` fields, and the counts only for a product limit, so anything else a writer puts
 * on `cause.rateLimit` never reaches a client.
 */
export function rateLimitMetaOf(error: unknown): RateLimitMeta | undefined {
  if (!(error instanceof TRPCError) || error.code !== 'TOO_MANY_REQUESTS') return undefined;
  const rateLimit = (error.cause as { rateLimit?: unknown } | undefined)?.rateLimit;
  if (!rateLimit || typeof rateLimit !== 'object') return undefined;
  const source = rateLimit as Record<string, unknown>;
  const meta: Record<string, unknown> = {
    retryAfterSeconds: source.retryAfterSeconds,
    retryAt: source.retryAt,
  };
  // Counts of an abuse limit must never reach a client, whoever built the meta.
  const fields = source.kind === 'product' ? [...META_FIELDS, ...PRODUCT_FIELDS] : META_FIELDS;
  for (const field of fields) if (source[field] !== undefined) meta[field] = source[field];
  return meta as RateLimitMeta;
}
