import { TRPCError } from '@trpc/server';
import { usageLimitDefsById, usageLimitReportsCounts } from '~/shared/constants/usage-limits';
import type { RateLimitMeta } from '~/shared/utils/rate-limit-meta';

/** The house retry metadata for a refusal that may be retried in `retryAfterSeconds`. */
export function rateLimitMetaFor(retryAfterSeconds: number): RateLimitMeta {
  return {
    retryAfterSeconds,
    retryAt: new Date(Date.now() + retryAfterSeconds * 1000).toISOString(),
  };
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
 * Whether a refusal's meta may carry counts: a product limit's, or an abuse limit the registry
 * marks `reportsCounts` (`usageLimitReportsCounts`). Decided from the registry for a registry id,
 * so a writer cannot publish an abuse limit's numbers by labelling its meta `product`.
 */
function metaReportsCounts(source: Record<string, unknown>): boolean {
  const def = typeof source.id === 'string' ? usageLimitDefsById.get(source.id) : undefined;
  if (def) return usageLimitReportsCounts(def);
  return source.kind === 'product';
}

/**
 * The retry metadata a TOO_MANY_REQUESTS `TRPCError` carries, or `undefined`. Copies only the
 * `RateLimitMeta` fields, and the counts only for a limit that reports them (a product limit, or
 * an abuse limit the registry marks `reportsCounts`), so anything else a writer puts on
 * `cause.rateLimit` never reaches a client.
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
  // Counts of an abuse limit must never reach a client, whoever built the meta, unless the
  // registry says that limit reports them.
  const fields = metaReportsCounts(source) ? [...META_FIELDS, ...PRODUCT_FIELDS] : META_FIELDS;
  for (const field of fields) if (source[field] !== undefined) meta[field] = source[field];
  return meta as RateLimitMeta;
}
