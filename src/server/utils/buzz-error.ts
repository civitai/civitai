import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';

/**
 * The HTTP status the buzz service actually returned. `buzzService`'s `mapError` collapses every
 * non-2xx into a TRPCError, and several statuses share one code and message — 400 and 409 both
 * arrive as BAD_REQUEST — so callers that need to tell them apart read the status here rather
 * than matching on the mapped prose.
 */
export function getBuzzApiStatus(error: unknown): number | undefined {
  return buzzApiError(error)?.status;
}

/**
 * The body the buzz service sent with a 4xx (parsed JSON, else raw text), through the same
 * TRPCError wrapping as the status. `unknown` on purpose: callers parse it with their own schema,
 * and undefined means none was sent, it could not be read, or this is not a buzz 4xx.
 */
export function getBuzzApiErrorBody(error: unknown): unknown {
  return buzzApiError(error)?.body;
}

function buzzApiError(error: unknown): BuzzApiError | undefined {
  if (error instanceof BuzzApiError) return error;
  if (error instanceof TRPCError && error.cause instanceof BuzzApiError) return error.cause;
  return undefined;
}
