export type UploadPartError = {
  status: number | null;
  retryAfter?: string | null;
  networkError?: boolean;
  aborted?: boolean;
};

export const MAX_PART_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 60_000;
const MIN_RETRY_AFTER_MS = 1000;

/** A presigned part URL that outlived its expiry — retrying the same URL can never succeed. */
export function isExpiredPartError(err: UploadPartError) {
  return err.status === 403 || err.status === 401;
}

export function shouldRetryPartError(err: UploadPartError) {
  if (err.aborted) return false;
  if (err.networkError) return true;
  if (err.status === 429) return true;
  if (err.status !== null && err.status >= 500) return true;
  return false;
}

export function getPartRetryDelay(err: UploadPartError, attempt: number) {
  if (err.retryAfter) {
    const seconds = Number(err.retryAfter);
    if (!isNaN(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    const dateMs = Date.parse(err.retryAfter);
    if (!isNaN(dateMs)) {
      // Floor to avoid hammering the server when client clock is skewed.
      const delta = Math.max(dateMs - Date.now(), MIN_RETRY_AFTER_MS);
      return Math.min(delta, MAX_BACKOFF_MS);
    }
  }
  // Exponential backoff with jitter: ~1s, 2s, 4s + up to 1s jitter
  const base = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  return base + Math.random() * 1000;
}
