/**
 * State for the `clientShadowCompare` flag, kept out of `~/utils/trpc` for the same reason as
 * `~/utils/trpc-go-transport`: `FeatureFlagsProvider` writes it, and component tests mock the tRPC
 * client module with a fixed export list.
 *
 * With the flag on, `shouldShadowCompare` in `~/utils/trpc` sends an allowlisted query down its
 * normal route AND to a candidate route at the same time, and `~/utils/faro/shadowCompare` beacons
 * whether the two raw responses were byte-identical. The app only ever sees the normal route's
 * response.
 */

let clientShadowCompareEnabled = false;
let comparesStarted = 0;

/**
 * Procedures that may be shadowed. Each must also be in `NEVER_BATCH_PROCEDURES` (`~/utils/trpc`):
 * the control leg is sent as its own unbatched GET, which is only what the app would have sent
 * anyway for a never-batched procedure. trpc-shadow-compare.test.ts pins both.
 */
export const SHADOW_COMPARE_PROCEDURES: ReadonlySet<string> = new Set([
  'image.getImagesAsPostsInfinite',
  'model.getAll',
  'image.getInfinite',
]);

/**
 * Most compares one page load may start. Every compare is one extra request on top of the user's
 * own, so this bounds the load a single shadowed client can add, independently of the flag's
 * rollout percentage.
 */
export const SHADOW_COMPARE_SESSION_CAP = 20;

/** `clientShadowCompare`. Written by `FeatureFlagsProvider`, browser only. */
export function setClientShadowCompareEnabled(enabled: boolean) {
  clientShadowCompareEnabled = enabled;
}

/** Whether a query for `path` may be shadowed now: browser, flag on, allowlisted, cap not spent. */
export function isShadowCompareEnabledFor(path: string): boolean {
  return (
    typeof window !== 'undefined' &&
    clientShadowCompareEnabled &&
    SHADOW_COMPARE_PROCEDURES.has(path) &&
    comparesStarted < SHADOW_COMPARE_SESSION_CAP
  );
}

/**
 * Takes one compare from this page load's cap; false once it is spent. Called when the request is
 * actually sent, not when the link is chosen, so concurrent queries cannot overshoot the cap.
 */
export function claimShadowCompareSlot(): boolean {
  if (comparesStarted >= SHADOW_COMPARE_SESSION_CAP) return false;
  comparesStarted += 1;
  return true;
}

/** Tests only: a fresh page load's cap. */
export function resetShadowCompareSession() {
  comparesStarted = 0;
}
