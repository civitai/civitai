import type { RateLimitMeta } from '~/shared/utils/rate-limit-meta';
import { getRateLimit } from '~/utils/rate-limit';

/**
 * Reduce a thrown storage error to one short string the block can surface. A
 * `TRPCClientError`'s `.message` is already the server's message; anything else gets a
 * generic fallback, so the untrusted iframe never sees a stack trace.
 */
export function storageErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'storage request failed';
}

/** The error fields of a `SHARED_*_RESULT` reply; `rateLimit` only when the refusal carries it. */
export function sharedStorageErrorReply(err: unknown): {
  error: string;
  rateLimit?: RateLimitMeta;
} {
  const rateLimit = getRateLimit(err);
  return { error: storageErrorMessage(err), ...(rateLimit ? { rateLimit } : {}) };
}
