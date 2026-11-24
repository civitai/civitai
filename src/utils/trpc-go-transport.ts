/**
 * State for the Go-transport flags (`feedGoTransport`, `feedGoTransportModelGetAll`,
 * `feedGoTransportInfinite`), kept out of
 * `~/utils/trpc` so the provider that writes them does not import the tRPC client module (component
 * tests mock that module with a fixed export list) — the same split as `~/utils/trpc-batch-window`.
 *
 * With a procedure's flag on, `shouldUseGoTransport` in `~/utils/trpc` sends that procedure to
 * `GO_TRANSPORT_URL` instead of `/api/trpc`, so an exact-path route can hand a per-user cohort to
 * a separate Go feed service.
 */

/**
 * Module-scoped toggles, one per procedure, written by `FeatureFlagsProvider` from each procedure's
 * own flag (default OFF). Mutable module state for the same reason as the batching toggle: the
 * terminating link is built once and re-reads them per operation.
 */
let feedGoTransportEnabled = false;
let feedGoTransportModelGetAllEnabled = false;
let feedGoTransportInfiniteEnabled = false;

/**
 * Procedure → whether its flag is on. Each procedure has its OWN flag, so one can be turned on (or
 * killed) without moving the other. Each must also be in `NEVER_BATCH_PROCEDURES` (a batched
 * request names several procedures in one path and could not be routed by path at all) and have its
 * own exact rewrite in `next.config.mjs`. Tests pin both.
 */
const GO_TRANSPORT_FLAGS: Readonly<Record<string, () => boolean>> = {
  'image.getImagesAsPostsInfinite': () => feedGoTransportEnabled,
  'model.getAll': () => feedGoTransportModelGetAllEnabled,
  'image.getInfinite': () => feedGoTransportInfiniteEnabled,
};

/** Procedures a Go-transport flag can move (whichever flag is on). */
export const GO_TRANSPORT_PROCEDURES: ReadonlySet<string> = new Set(
  Object.keys(GO_TRANSPORT_FLAGS)
);

/** Whether `path`'s own Go-transport flag is on (false for any other procedure). */
export function isGoTransportEnabledFor(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(GO_TRANSPORT_FLAGS, path)
    ? GO_TRANSPORT_FLAGS[path]()
    : false;
}

/**
 * The signed-out cohort's toggles, one per procedure, written by `FeatureFlagsProvider` from the
 * signed-out twin of each flag (`feedGoTransportSignedOut`, `…SignedOutModelGetAll`,
 * `…SignedOutInfinite`; default OFF). Read only for a signed-out browser, so turning one on never
 * moves a signed-in user, and the signed-in flags above never move a signed-out one.
 */
let feedGoTransportSignedOutEnabled = false;
let feedGoTransportSignedOutModelGetAllEnabled = false;
let feedGoTransportSignedOutInfiniteEnabled = false;

const SIGNED_OUT_GO_TRANSPORT_FLAGS: Readonly<Record<string, () => boolean>> = {
  'image.getImagesAsPostsInfinite': () => feedGoTransportSignedOutEnabled,
  'model.getAll': () => feedGoTransportSignedOutModelGetAllEnabled,
  'image.getInfinite': () => feedGoTransportSignedOutInfiniteEnabled,
};

/** Whether `path`'s own signed-out Go-transport flag is on (false for any other procedure). */
export function isSignedOutGoTransportEnabledFor(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(SIGNED_OUT_GO_TRANSPORT_FLAGS, path)
    ? SIGNED_OUT_GO_TRANSPORT_FLAGS[path]()
    : false;
}

/** `feedGoTransportSignedOut`: `image.getImagesAsPostsInfinite`, signed out. */
export function setFeedGoTransportSignedOutEnabled(enabled: boolean) {
  feedGoTransportSignedOutEnabled = enabled;
}

/** `feedGoTransportSignedOutModelGetAll`: `model.getAll`, signed out. */
export function setFeedGoTransportSignedOutModelGetAllEnabled(enabled: boolean) {
  feedGoTransportSignedOutModelGetAllEnabled = enabled;
}

/** `feedGoTransportSignedOutInfinite`: `image.getInfinite`, signed out. */
export function setFeedGoTransportSignedOutInfiniteEnabled(enabled: boolean) {
  feedGoTransportSignedOutInfiniteEnabled = enabled;
}

/**
 * The separate path. `next.config.mjs` rewrites `<this>/<procedure>` back to `/api/trpc/<procedure>`
 * for each procedure above (only those), so with no route in front of it the request still reaches
 * this app and is served: a flag can never strand a request. It can still MOVE one — edge rules
 * keyed on the `/api/trpc/` prefix do not match this path (see `feedGoTransport` in
 * feature-flags.service.ts).
 */
export const GO_TRANSPORT_URL = '/api/trpc-go';

/** `feedGoTransport`: `image.getImagesAsPostsInfinite`. */
export function setFeedGoTransportEnabled(enabled: boolean) {
  feedGoTransportEnabled = enabled;
}

/** `feedGoTransportModelGetAll`: `model.getAll`. */
export function setFeedGoTransportModelGetAllEnabled(enabled: boolean) {
  feedGoTransportModelGetAllEnabled = enabled;
}

/** `feedGoTransportInfinite`: `image.getInfinite`. */
export function setFeedGoTransportInfiniteEnabled(enabled: boolean) {
  feedGoTransportInfiniteEnabled = enabled;
}
