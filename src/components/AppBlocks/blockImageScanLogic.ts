import type { BlockUploadedImageInfo } from './BlockImageUploadModal';

/**
 * App Blocks (Phase-2b) — pure classification for the ASYNC (non-blocking)
 * cosmetic-image scan verdict, extracted so the security-relevant
 * blocked-vs-error discriminant is unit-testable in the node vitest env (no
 * React / no tRPC — mirrors pageBlockHostLogic + block-image-upload.logic).
 *
 * Background: in async mode the host modal resolves EARLY (on persist, imageId
 * known) and a host-mounted poller streams the eventual scan verdict to the
 * block via the parent→block `IMAGE_SCAN_RESOLVED` push. The authoritative gate
 * is UNCHANGED — `blockImageUpload.gate` still returns a moderated projection
 * ONLY on Scanned + within-SFW-ceiling + unflagged, and THROWS a TRPCError on
 * every terminal / access / not-found case. This module only maps that
 * client-observed throw into the verdict the block receives.
 *
 * The blocked-vs-error split is SECURITY-relevant: a `blocked` verdict is a
 * TERMINAL moderation refusal (the block must not use the image and must not
 * retry), whereas an `error` verdict is a transient/host-side failure the block
 * MAY retry. Mislabelling a network blip as `blocked` would wrongly reject a
 * clean image; mislabelling a real moderation refusal as `error` would invite a
 * pointless retry loop but can NEVER cause an unscanned image to be served —
 * cross-user serving stays gated server-side on a `scanned` verdict.
 */

/**
 * The async scan verdict for a pending display upload (host→block). Mirrors the
 * SDK `BlockImageScanResult`:
 *   - `scanned` — clean + within the SFW ceiling + unflagged. Carries the
 *     moderated projection (imageId / nsfwLevel / contentRating / url).
 *   - `blocked` — TERMINAL non-clean (scan-blocked / above-SFW / flagged /
 *     import-failed). The gate raised a BAD_REQUEST TRPCError.
 *   - `error`  — transient/host-side error or poll-budget timeout. Retryable.
 */
export type BlockImageScanResult =
  | { status: 'scanned'; image: BlockUploadedImageInfo }
  | { status: 'blocked'; reason?: string }
  | { status: 'error'; message?: string };

/**
 * Best-effort extraction of a tRPC error code (`'BAD_REQUEST'` / `'NOT_FOUND'` /
 * `'FORBIDDEN'` / …) from a thrown value. A `TRPCClientError` exposes the code
 * at `.data.code` (and, defensively, `.shape.data.code`). Returns `undefined`
 * for a non-tRPC throw (a network `TypeError`, an aborted request, …) — which is
 * treated as a retryable `error`, NOT a moderation `blocked`.
 */
export function extractTrpcErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const data = (err as { data?: unknown }).data;
  if (data && typeof data === 'object') {
    const code = (data as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  const shape = (err as { shape?: unknown }).shape;
  if (shape && typeof shape === 'object') {
    const sdata = (shape as { data?: unknown }).data;
    if (sdata && typeof sdata === 'object') {
      const code = (sdata as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
  }
  return undefined;
}

/** Best-effort human message from a thrown value (the server message on a
 *  TRPCClientError). Conservative — the block is untrusted, so we never leak a
 *  stack trace; a non-string / empty message yields `undefined`. */
export function extractErrorMessage(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return undefined;
}

/**
 * Classify a THROWN gate error into the terminal verdict the block receives.
 * PURE + STRUCTURAL — the retryable-vs-terminal decision reads the tRPC error
 * CODE, never prose (rewording a server message can't change the outcome):
 *   - `BAD_REQUEST` → the pure scan classifier rejected the bytes (scan-blocked
 *     / above-SFW / flagged / import-failed) → `blocked` (do NOT retry). The
 *     server message becomes the display `reason`.
 *   - anything else (`NOT_FOUND` / `FORBIDDEN` / a network throw / an unknown
 *     code / a poll-budget timeout mapped by the caller) → `error` (retryable).
 *     A network blip is NEVER mislabelled `blocked`.
 */
export function classifyScanThrow(
  err: unknown
): { status: 'blocked'; reason?: string } | { status: 'error'; message?: string } {
  const code = extractTrpcErrorCode(err);
  const message = extractErrorMessage(err);
  if (code === 'BAD_REQUEST') {
    return { status: 'blocked', ...(message ? { reason: message } : {}) };
  }
  return { status: 'error', ...(message ? { message } : {}) };
}
