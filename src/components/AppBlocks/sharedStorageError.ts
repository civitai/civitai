import { parseRateLimitMeta, type RateLimitMeta } from '~/shared/utils/rate-limit-meta';

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

/** The retry metadata a rate-limited `TRPCClientError` carries in `data.rateLimit`, if valid. */
export function storageErrorRateLimit(err: unknown): RateLimitMeta | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  return parseRateLimitMeta((data as { rateLimit?: unknown }).rateLimit);
}

/** The error fields of a `SHARED_*_RESULT` reply; `rateLimit` only when the refusal carries it. */
export function sharedStorageErrorReply(err: unknown): {
  error: string;
  rateLimit?: RateLimitMeta;
} {
  const rateLimit = storageErrorRateLimit(err);
  return { error: storageErrorMessage(err), ...(rateLimit ? { rateLimit } : {}) };
}
