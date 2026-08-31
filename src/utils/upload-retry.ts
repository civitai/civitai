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

/**
 * Statuses from `/api/upload/complete` that are TERMINAL — re-POSTing the same parts
 * manifest cannot succeed, so the client must stop and (where it can) re-upload.
 *
 * 🔴 409 = the multipart session is already finalized or aborted. 422 = the upload
 * STATE is bad (a parts manifest the backend won't accept, or a completion whose
 * object could not be verified). Neither improves on a retry.
 *
 * 🔴 Retrying one of these is not merely wasteful, it CORRUPTS THE DIAGNOSIS: attempts
 * after the first hit a session the first attempt may already have consumed, so they
 * come back `NoSuchUpload` and the client acts on that branch's verdict instead of the
 * real one — a silent-loss event gets relabelled "already finalized or aborted".
 *
 * 🔴 Lives HERE, in the one module both upload clients already import, because it was
 * previously open-coded in `s3-upload.store.ts` and simply MISSING from
 * `useS3Upload.tsx` — where a terminal status was re-POSTed 4 times, 200 ms apart. One
 * predicate, one place: a second copy is how that divergence happened.
 */
export function isTerminalCompleteStatus(status: number) {
  return status === 409 || status === 422;
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
