import type { AppsStoreFeatureFlags } from '~/shared/utils/app-blocks-access';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';

/**
 * Pure visibility logic for the SINGLE App Blocks "Apps" entry in the user menu.
 *
 * Extracted out of `useGetMenuItems` (which is a heavy hook — router, session,
 * theme, tRPC) so the gating invariant is unit-testable in isolation.
 *
 * 🔴 IT RETURNED TWO BOOLEANS UNTIL THE `/apps/build` CONSOLIDATION, AND THE SECOND
 * ONE IS GONE RATHER THAN LEFT UNUSED. `getStarted` existed so the menu row could FALL
 * BACK to `/apps/get-started` for a viewer holding `appBlocksGetStarted` without store
 * access — a viewer who cannot load `/apps` at all. That page merged into `/apps/build`,
 * whose gate (`canAccessAppsBuild`, `~/shared/utils/app-blocks-access`) requires
 * `hasAppsStoreAccess` — so there is no longer ANY `/apps/*` route that cohort can load,
 * and a fallback would have pointed at a second 404. Keeping the boolean with no reader
 * would assert that a routing decision still hangs on it; it does not.
 *
 * `appBlocksGetStarted` has not stopped mattering — it still decides whether a
 * store-visible NON-author is shown the pitch on `/apps/build`. It just no longer decides
 * REACHABILITY of anything, which is the only question this helper answers.
 *
 * 🔴 THE MARKETPLACE ENTRY USED TO READ `appBlocks` ALONE, and that is what
 * issue #3907 was. Until the W13 decoupling, `appBlocks` WAS store visibility,
 * so gating the menu item on it was correct. Afterwards the store grants on
 * `appListings || appBlocks || appListingsPublicExternal` while this entry —
 * the ONLY in-product route to `/apps` (the `/apps/*` sub-nav's Marketplace tab
 * renders only once you are already on an `/apps/*` route) — still read
 * `appBlocks`. So the external-only tester cohort
 * (`{appListingsPublicExternal, NOT appBlocks, NOT appListings}`, created
 * 2026-08-14) could load a store it had no way to FIND: reachable by direct URL
 * only. Reachable is not findable.
 *
 * A viewer admitted by the catalog flags alone lands on a page that renders
 * fine — the store, scoped server-side to whatever catalog they may see (the
 * external-only cohort gets `kind='offsite'` listings and nothing else). The
 * block-RUNTIME surfaces behind it (`/apps/installed`, `/apps/run/<slug>`, …)
 * keep their own `appBlocks` gates, so showing this entry widens discovery, not
 * capability.
 *
 * 🔴 Do NOT re-inline the boolean here. This is the SEVENTH site routed through
 * the shared predicate and it is pinned by the call-site ledger
 * (`components/Apps/__tests__/appsStoreAccessCallSites.test.ts`) — a revert to
 * `!!features.appBlocks` fails that suite AND the external-only case in
 * `appsNavVisibility.test.ts`.
 *
 * This file imports no React/Mantine so it stays a pure unit.
 */
export type AppsNavVisibility = {
  /** Store hub (`/apps`) — visible exactly when the store is. */
  marketplace: boolean;
};

/**
 * The store half of the parameter is `AppsStoreFeatureFlags`, which is DERIVED
 * from `FeatureAccess` rather than hand-written — deliberately, so a rename of
 * `appListings` upstream is a compile error here instead of a silent
 * degradation to `appBlocks`-only. See that type's doc.
 */
export function appsNavVisibility(features: NonNullable<AppsStoreFeatureFlags>): AppsNavVisibility {
  return { marketplace: hasAppsStoreAccess(features) };
}
