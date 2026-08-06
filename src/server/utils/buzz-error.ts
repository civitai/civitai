import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';

/**
 * The HTTP status the buzz service actually returned. `buzzService`'s `mapError` collapses every
 * non-2xx into a TRPCError, and several statuses share one code and message — 400 and 409 both
 * arrive as BAD_REQUEST — so callers that need to tell them apart read the status here rather
 * than matching on the mapped prose.
 */
export function getBuzzApiStatus(error: unknown): number | undefined {
  if (error instanceof BuzzApiError) return error.status;
  if (error instanceof TRPCError && error.cause instanceof BuzzApiError) return error.cause.status;
  return undefined;
}
