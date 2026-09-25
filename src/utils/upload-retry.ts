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
 *
 * 🔴 `userAborted` MEANS "THE PERSON PRESSED CANCEL" — never "this upload's abort signal
 * has been tripped". The two are not the same thing and confusing them made this whole
 * predicate inert: the multipart worker tears its own upload down (cancelling the signal
 * and every in-flight part xhr) BEFORE the caller reaches this gate, so a caller passing
 * its abort signal here reports `true` on every failure, including the network-layer ones
 * this exists for. Pass a flag the internal teardown does not set.
 */
export function shouldRelayOnPartFailure(
  err: UploadPartError | null | undefined,
  opts: { type: string; backend?: string; fileSize: number; userAborted: boolean }
): boolean {
  if (!err || opts.userAborted) return false;
  if (!err.networkError || err.aborted) return false;
  if (opts.type !== 'image') return false;
  if (opts.backend !== 'backblaze') return false;
  return opts.fileSize <= RELAY_FALLBACK_MAX_BYTES;
}

/**
 * The terminal row state for an upload that gave up: did the PERSON stop it, or did it
 * fail?
 *
 * 🔴 `userAborted` is the same flag `shouldRelayOnPartFailure` takes and means the same
 * thing — the person pressed cancel — and passing an upload's abort signal is the same
 * mistake here, with a different symptom. Both clients tear their own upload down on a
 * fatal part failure, so a status line reading that signal reports EVERY failed upload as
 * a cancel: a user whose connection died gets the row they would have got by pressing
 * cancel themselves, and the failure disappears from anything counting errors.
 *
 * 🔴 `fatal.aborted` is checked as well, not instead: it catches the ordinary cancel,
 * where the cancelled part xhr rejects with `aborted`. `userAborted` catches the cancel
 * that RACES a failure — a non-retryable part error lands on the fatal slot immediately,
 * so a cancel in the same tick can never overwrite it.
 *
 * 🔴 This says nothing about the `/api/upload/abort` body, which keeps the real reason
 * via `describePartFailure`. The row answers "what did the person do"; the abort reason
 * answers "why did the transfer stop". Collapsing the second into the first would delete
 * the diagnostic signal that field exists to carry.
 *
 * 🔴 Lives HERE for the reason `isTerminalCompleteStatus` below gives: this is the second
 * predicate both upload clients need, it was open-coded in both, and the first one that
 * was open-coded in both went wrong in one of them. It is NOT called
 * `resolveTerminal*` — `isTerminalCompleteStatus` further down this file means a
 * different "terminal" (an HTTP status that must not be re-POSTed), and both clients
 * import the two of them two lines apart, which is exactly where a reader mis-binds.
 *
 * 🔴 The flag is NAMED rather than positional, matching `shouldRelayOnPartFailure`. Every
 * candidate expression at the call site is some `.signal.aborted` and they all typecheck,
 * so a bare boolean in argument position makes the documented mistake invisible exactly
 * where it gets made. `userAborted:` forces the author to say which one they mean.
 */
export function resolveUploadRowStatus(
  fatal: UploadPartError,
  opts: { userAborted: boolean }
): 'aborted' | 'error' {
  return fatal.aborted || opts.userAborted ? 'aborted' : 'error';
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
