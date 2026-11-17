import type { TRPCError } from '@trpc/server';
import { rateLimitMetaOf } from '~/server/utils/rate-limit-error';

/**
 * `Retry-After` for a response whose only call was refused with rate-limit meta. A batch shares
 * one set of headers across calls, so it gets none; its callers read `data.rateLimit`.
 */
export function retryAfterHeader({
  errors,
  info,
  paths,
}: {
  errors: readonly TRPCError[];
  info?: { calls: readonly unknown[] };
  paths?: readonly string[];
}) {
  const callCount = info?.calls.length ?? paths?.length ?? 0;
  if (callCount !== 1 || errors.length !== 1) return undefined;
  const rateLimit = rateLimitMetaOf(errors[0]);
  return rateLimit ? String(rateLimit.retryAfterSeconds) : undefined;
}
