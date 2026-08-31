/**
 * The ONE error-envelope contract for the public `/api/v1/*` REST surface.
 *
 * Motivated by civitai#3845: `GET /api/v1/apps/{slug}` emitted three different
 * non-2xx body shapes (`{error: <object>}` on 400, `{error: <string>}` on 404,
 * `{message, error}` on 500, and `{message, …}` on 429 from the rate limiter),
 * so a client could not branch on body shape alone. This module is the single
 * place that decides what a non-2xx body looks like.
 *
 * ## The contract — ADDITIVE, so it does not break shipped consumers
 * Every non-2xx body carries all three of:
 *   - `code`    — stable, machine-readable discriminator (never on a 2xx)
 *   - `message` — human-readable summary, ALWAYS a string
 *   - `error`   — RETAINED legacy field. Its KEY and its TYPE are unchanged at
 *     every status; its VALUE is unchanged at every status EXCEPT a genericized
 *     5xx, where it stops being the driver-derived text and becomes
 *     {@link GENERIC_SERVER_ERROR_MESSAGE}. That single value change IS the
 *     #3845 fix — the shipped CLI renders `error` in preference to `message`, so
 *     leaving it verbatim would have left the disclosure fully visible.
 *
 * Nothing is removed or retyped, so both shipped consumers keep working:
 *   - the Go CLI (`civitai app view`) decodes `error` as a `json.RawMessage`
 *     (tolerant of string OR object) and `message` as a plain `string`, and
 *     ignores keys it does not know — so `code` is inert for it today and
 *     available the moment it wants to stop substring-matching error text.
 *     🔴 Two things would break it, and neither is done here: making `message`
 *     a non-string (fails the whole envelope unmarshal), and changing the 400's
 *     `error` away from the zod `.flatten()` object (the CLI special-cases that
 *     exact shape to render per-field errors).
 *   - `@civitai/app-sdk` parses error bodies as opaque `unknown`.
 *
 * ## Why `code` and not `errorCode`/`type`/`kind`
 * `{ error, code }` is the existing house shape — see `/api/v1/images`,
 * `/api/v1/blocks/images` and `/api/v1/users`, the last of which names it "the
 * /api/v1/images error shape" in its own comment. The VALUES are tRPC error-code
 * strings for the same reason: those three sites take theirs straight off
 * `TRPCError.code`, so the two surfaces agree instead of inventing a second
 * vocabulary.
 */

/**
 * Only codes an emitter in this repo actually uses. Deliberately NOT the full
 * tRPC vocabulary: an unused member is an unverified claim about the wire (the
 * 401s on this surface are still bare `{ error: 'Unauthorized' }` from the shared
 * endpoint wrappers, not this envelope). Add one WITH its emitter.
 */
export const REST_ERROR_CODE = {
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  TIMEOUT: 'TIMEOUT',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
} as const;

export type RestErrorCode = (typeof REST_ERROR_CODE)[keyof typeof REST_ERROR_CODE];

/**
 * The generic server-fault text. Deliberately content-free: it is the ONLY thing
 * a genericized 5xx is allowed to put on the wire, on BOTH of
 * `handleEndpointError`'s 500-producing branches (the `TRPCError` one — which is
 * where a `throwDbError`-wrapped driver error arrives — and the else-branch). See
 * `isRestServerFault` for which statuses that covers and why 503 is excluded.
 */
export const GENERIC_SERVER_ERROR_MESSAGE = 'An unexpected error occurred';

/**
 * Replacement text for a **4xx** whose message turned out to be a database
 * driver's own prose (civitai#3845 investigation 3 — see
 * `isDriverAuthoredMessage`). The STATUS is kept, so the caller still learns what
 * kind of failure this is; only the driver's query/schema text is dropped.
 *
 * 🔴 These strings must disclose nothing an attacker could not already infer from
 * the status code itself — that is the entire point. They are deliberately less
 * informative than the driver text they replace: the driver text was never written
 * for a caller, and (unlike a 503 hint) it is NOT the only copy — genericizing a
 * 4xx here also promotes it into the fault log, exactly as a 5xx does.
 *
 * Keyed by HTTP status because that is what `handleEndpointError` has in hand.
 *
 * 🔴 **The key set is a CLOSED LEDGER, and a test enforces it.** These four are
 * exactly the 4xx statuses `prismaErrorToTrpcCode` can produce (400, 404, 408,
 * 409). A status with no entry is left alone — i.e. unchanged from today — so the
 * safety of this design rests entirely on the ledger staying complete. That is why
 * `rest-error-envelope-ledger.test.ts` derives the reachable set from
 * `prismaErrorToTrpcCode` itself and fails when this map's keys and that set
 * disagree in EITHER direction: adding `P2031: 'FORBIDDEN'` upstream turns the
 * test red instead of silently reopening the leak at 403.
 */
export const GENERIC_CLIENT_ERROR_BY_STATUS: Record<
  number,
  { code: RestErrorCode; message: string }
> = {
  400: { code: 'BAD_REQUEST', message: 'The request could not be processed' },
  404: { code: 'NOT_FOUND', message: 'Not found' },
  408: { code: 'TIMEOUT', message: 'The request timed out' },
  409: { code: 'CONFLICT', message: 'The request conflicts with the current state' },
};

export type RestErrorBody = {
  error: unknown;
  message: string;
  code: RestErrorCode;
};

/**
 * Build a conformant non-2xx body.
 *
 * @param code    the stable discriminator
 * @param message human-readable summary — MUST stay a string (CLI decoder)
 * @param error   the legacy `error` value for this status; defaults to
 *                `message` so string-valued cases stay byte-identical to what
 *                they emitted before.
 */
export function restErrorBody(
  code: RestErrorCode,
  message: string,
  error: unknown = message
): RestErrorBody {
  return { error, message, code };
}
