export type UploadPartError = {
  status: number | null;
  retryAfter?: string | null;
  networkError?: boolean;
  aborted?: boolean;
  partNumber?: number;
};

export const MAX_PART_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 60_000;
const MIN_RETRY_AFTER_MS = 1000;

/** The relay route's body cap (Next's 10 MB truncation point) mirrored client-side. */
export const RELAY_FALLBACK_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The bounded, serializable reason a multipart upload gave up, carried in the
 * `/api/upload/abort` body so the server-side `s3-upload-abort` event can say WHY the
 * client stopped — the field whose absence forced the 2026-09 image-upload investigation
 * to ask users for devtools screenshots. Caller-shaped input is sanitized again
 * server-side (see `sanitizeClientFailure` in `src/pages/api/upload/abort.ts`); this
 * side only ever produces the three shapes below.
 *
 * A user cancel maps to `client-aborted` ahead of every other reading: the cancel trips
 * the workers, which can race a status-0 `loadend` onto the same fatal slot, and user
 * churn must not read as upload failures in the abort stream.
 */
export type PartFailureReason =
  | { kind: 'client-aborted' }
  | { kind: 'network-error'; partNumber?: number }
  | { kind: 'part-status'; partNumber?: number; status: number };

export function describePartFailure(
  err: UploadPartError | null | undefined
): PartFailureReason | undefined {
  if (!err) return undefined;
  if (err.aborted) return { kind: 'client-aborted' };
  if (err.networkError) {
    return err.partNumber === undefined
      ? { kind: 'network-error' }
      : { kind: 'network-error', partNumber: err.partNumber };
  }
  if (err.status !== null) {
    return err.partNumber === undefined
      ? { kind: 'part-status', status: err.status }
      : { kind: 'part-status', partNumber: err.partNumber, status: err.status };
  }
  return undefined;
}

/**
 * Whether a fatal part failure qualifies for the relay fallback — re-sending the whole
 * file through our own origin when the direct PUT cannot reach the storage host at all.
 *
 * 🔴 ONLY a network-layer failure qualifies. A status failure means the backend was
 * REACHED and rejected us; replaying the bytes through a second route would mask a real
 * fault rather than route around an unreachable host (the same rule the single-PUT
 * relay fallback in `useCFImageUpload` follows). The other gates: the relay writes to
 * the image bucket, so only image-type uploads on the image backend qualify; the file
 * must fit the relay's body cap; and a cancelled upload has an owner, not a fallback.
 */
export function shouldRelayOnPartFailure(
  err: UploadPartError | null | undefined,
  opts: { type: string; backend?: string; fileSize: number; signalAborted: boolean }
): boolean {
  if (!err || opts.signalAborted) return false;
  if (!err.networkError || err.aborted) return false;
  if (opts.type !== 'image') return false;
  if (opts.backend !== 'backblaze') return false;
  return opts.fileSize <= RELAY_FALLBACK_MAX_BYTES;
}

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
