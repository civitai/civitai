/**
 * State for the `feedGoTransport` flag, kept out of `~/utils/trpc` so the provider that writes it
 * does not import the tRPC client module (component tests mock that module with a fixed export
 * list) — the same split as `~/utils/trpc-batch-window`.
 *
 * With the flag on, `shouldUseGoTransport` in `~/utils/trpc` sends the procedures below to
 * `GO_TRANSPORT_URL` instead of `/api/trpc`, so an exact-path route can hand a per-user cohort to
 * the Go port in `apps/feed-go`.
 */

/**
 * Procedures the flag moves. Each must also be in `NEVER_BATCH_PROCEDURES` (a batched request names
 * several procedures in one path and could not be routed by path at all) and have its own exact
 * rewrite in `next.config.mjs`. Tests pin both.
 */
export const GO_TRANSPORT_PROCEDURES: ReadonlySet<string> = new Set([
  'image.getImagesAsPostsInfinite',
]);

/**
 * The separate path. `next.config.mjs` rewrites `<this>/<procedure>` back to `/api/trpc/<procedure>`
 * for each procedure above (only those), so with no route in front of it the request still reaches
 * this app and is served: the flag can never strand a request. It can still MOVE one — edge rules
 * keyed on the `/api/trpc/` prefix do not match this path (see `feedGoTransport` in
 * feature-flags.service.ts).
 */
export const GO_TRANSPORT_URL = '/api/trpc-go';

/**
 * Module-scoped toggle, written by `FeatureFlagsProvider` from the `feedGoTransport` flag (default
 * OFF). Mutable module state for the same reason as the batching toggle: the terminating link is
 * built once and re-reads it per operation.
 */
let feedGoTransportEnabled = false;
export function setFeedGoTransportEnabled(enabled: boolean) {
  feedGoTransportEnabled = enabled;
}
export function getFeedGoTransportEnabled() {
  return feedGoTransportEnabled;
}
