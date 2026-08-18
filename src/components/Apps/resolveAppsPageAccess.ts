/**
 * SSR access decision for the /apps marketplace (F-E E1). Pure, React-free, and
 * standalone so the GATING INVARIANT is unit-testable in the node-env unit
 * project without importing the page's React/Mantine module graph.
 *
 * 🔒 GATING INVARIANT (F-E E1 + W13 PR-W1a/D8 — do not violate):
 *   - The STORE-VISIBILITY flag gate is FIRST and is the ONLY access control.
 *     W13 repoints it onto the dedicated `appListings` flag with an OR-fallback
 *     to `appBlocks`. The boolean itself is NOT written here — it lives in the
 *     shared `hasAppsStoreAccess` predicate (`~/shared/utils/app-blocks-access`)
 *     that every store surface calls, so the SSR gate and the client-side gates
 *     cannot drift apart. Access =
 *     `features.appListings || features.appBlocks || features.appListingsPublicExternal`.
 *     A logged-out / non-mod user satisfies NONE of them today (the first two are
 *     mod-segmented, the third does not exist in Flipt), so access is false for them
 *     → notFound. The store stays dark for real anon/non-mod users until a segment
 *     is widened at launch.
 *   - The THIRD term is the EXTERNAL-ONLY cohort, and it exists so that cohort can
 *     REACH the store at all. Without it a viewer whose only qualification is
 *     `app-listings-public-external` gets `notFound` here while the SERVER
 *     (`resolveStoreVisibilityScope` → `public-external`) would happily serve them
 *     the offsite catalog — the gate and the data path disagreeing about the same
 *     flag. What they then SEE is still the server's call: offsite listings only,
 *     onsite hidden. This gate decides reachability, never scope.
 *   - WHY the OR-fallback: `appListings` (Flipt `app-listings`) does not exist at
 *     merge time, so `features.appListings` resolves via its `availability:['mod']`
 *     Flipt-down fallback (mods only) while `appBlocks` still carries the
 *     app-dev-testers cohort — the OR keeps the CURRENT mods+testers viewers in
 *     verbatim (ZERO behavior change today). A future true-public flip widens
 *     ONLY `app-listings` (this store gate) without flipping the held
 *     block-runtime `app-blocks-enabled` gate.
 *   - There is intentionally NO separate `session→login` redirect: behind the
 *     flag gate, a session-less request RENDERS the marketplace read-only
 *     instead of bouncing to /login. This is the "anon-capable but dark" read
 *     path — reachable by a real anon user ONLY once a flag grants access
 *     (mods-only today). (`deIndex` is kept ON in the page <Meta> so the page is
 *     not crawlable pre-launch.)
 */
import { hasAppsStoreAccess, type AppsStoreFeatureFlags } from '~/shared/utils/app-blocks-access';

export type AppsPageAccessResult = { notFound: true } | { props: Record<string, never> };

export function resolveAppsPageAccess(args: {
  // The SHARED flag type, derived from `FeatureAccess` — so renaming/removing
  // `appListings` at GA breaks HERE at compile time rather than silently
  // degrading this gate to `appBlocks`-only.
  features?: AppsStoreFeatureFlags;
}): AppsPageAccessResult {
  // Store-visibility gate FIRST and ONLY. No session check — the dark anon path
  // renders behind the flag. The predicate is SHARED (`hasAppsStoreAccess`) with
  // every other store surface, including the `/apps/*` sub-nav, so there is one
  // rule in one place and the gates cannot disagree.
  if (!hasAppsStoreAccess(args.features)) return { notFound: true };
  return { props: {} };
}
