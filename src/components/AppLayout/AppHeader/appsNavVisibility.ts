import type { AppsStoreFeatureFlags } from '~/shared/utils/app-blocks-access';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';

/**
 * Pure visibility logic for the SINGLE App Blocks "Apps" entry in the user menu.
 *
 * Extracted out of `useGetMenuItems` (which is a heavy hook — router, session,
 * theme, tRPC) so the gating invariant is unit-testable in isolation. It returns
 * TWO booleans because the one menu entry makes two decisions from them:
 *
 *  - `getStarted` — the PUBLIC `/apps/get-started` landing page is reachable,
 *    i.e. the public `appBlocksGetStarted` flag is on (Flipt kill switch);
 *  - `marketplace` — the STORE is visible: {@link hasAppsStoreAccess}, i.e.
 *    `appListings || appBlocks || appListingsPublicExternal`. INDEPENDENT of the
 *    get-started flag.
 *
 * 🔴 BOTH ARE STILL LOAD-BEARING AFTER THE CONSOLIDATION. The menu used to carry
 * one entry per boolean ("Build apps" → `/apps/get-started` and "Apps" →
 * `/apps`); "Build apps" moved into the `/apps/*` sub-nav, so there is now one
 * entry whose VISIBILITY is `marketplace || getStarted` and whose HREF is `/apps`
 * when `marketplace` and `/apps/get-started` otherwise. Deleting `getStarted`
 * here would send the get-started-only cohort at `/apps`, which their flags
 * cannot load (`resolveAppsPageAccess` → `notFound`).
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
  /** PUBLIC get-started landing page (`/apps/get-started`). */
  getStarted: boolean;
  /** Store hub (`/apps`) — visible exactly when the store is. */
  marketplace: boolean;
};

/**
 * The store half of the parameter is `AppsStoreFeatureFlags`, which is DERIVED
 * from `FeatureAccess` rather than hand-written — deliberately, so a rename of
 * `appListings` upstream is a compile error here instead of a silent
 * degradation to `appBlocks`-only. See that type's doc.
 */
export function appsNavVisibility(
  features: { appBlocksGetStarted?: boolean } & NonNullable<AppsStoreFeatureFlags>
): AppsNavVisibility {
  return {
    getStarted: !!features.appBlocksGetStarted,
    marketplace: hasAppsStoreAccess(features),
  };
}
