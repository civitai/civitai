import { describe, expect, it } from 'vitest';
import { appsNavVisibility } from '~/components/AppLayout/AppHeader/appsNavVisibility';

// #3907 invariant: `marketplace` is true exactly when the STORE is visible
// (`hasAppsStoreAccess` = appListings || appBlocks || appListingsPublicExternal).
// It used to read `appBlocks` alone, which hid the store from cohorts that could
// load it.
//
// 🔴 THE SECOND BOOLEAN (`getStarted`) IS GONE, AND ITS CASES ARE NOT MERELY DELETED —
// they are re-expressed below as the assertion that the get-started flag has NO effect
// on this helper. The menu used to carry one row per boolean ("Build apps" →
// /apps/get-started and "Apps" → /apps), then one row with a conditional href falling
// back to /apps/get-started. That route was consolidated into /apps/build, whose gate
// requires store access — so a get-started-only viewer has no /apps/* destination at all
// and the fallback would have pointed at a second 404. Deleting the assertions outright
// would leave "the flag is irrelevant here" as an unpinned claim; asserting irrelevance
// keeps it a fact, and would fail if someone re-introduced a get-started term.
//
// The menu WIRING is pinned separately, against the real `hooks.tsx` source, in
// `appsMenuEntry.test.ts`; this file remains the behavioural cover for the PREDICATE.
describe('appsNavVisibility — the store-gated marketplace entry', () => {
  it('keeps the marketplace entry hidden for a viewer with NO store flag', () => {
    expect(appsNavVisibility({ appBlocks: false }).marketplace).toBe(false);
  });

  it('shows it for a moderator (store flag on)', () => {
    expect(appsNavVisibility({ appBlocks: true }).marketplace).toBe(true);
  });

  it('treats undefined flags as off (default-deny on missing flags)', () => {
    expect(appsNavVisibility({}).marketplace).toBe(false);
  });

  /**
   * 🔴 THE GET-STARTED FLAG IS IRRELEVANT TO THIS HELPER, ASSERTED RATHER THAN ASSUMED.
   *
   * It used to produce a second boolean that drove a second href. After the /apps/build
   * consolidation it decides only WHAT a store-visible non-author is shown ON that page,
   * never whether any route is reachable — so this helper must ignore it entirely. Held
   * as an equality across the flag's two values so a re-introduced term fails here, in
   * BOTH directions, rather than only when someone happens to test the right cohort.
   */
  it('🔴 appBlocksGetStarted changes NOTHING about this helper', () => {
    for (const store of [false, true]) {
      const off = appsNavVisibility({ appBlocks: store, appBlocksGetStarted: false } as never);
      const on = appsNavVisibility({ appBlocks: store, appBlocksGetStarted: true } as never);
      expect(on, `store=${store}`).toEqual(off);
      // …and the value it agrees on is the STORE answer, not a constant. Without this the
      // equality above would hold for a helper that returned `{ marketplace: false }`
      // unconditionally.
      expect(on.marketplace).toBe(store);
    }
  });

  /**
   * 🔴 THE THREE CASES THAT KILL A REVERT TO `!!features.appBlocks`.
   *
   * Each is a cohort that HAS store access without `appBlocks`. Under the old
   * gate every one of them resolved `marketplace: false` — a store rendered by
   * the SSR resolver with no in-product link to it. These are not hypothetical
   * shapes: the external-only one is the live tester cohort as of 2026-08-14
   * (Flipt `app-listings-public-external`, base off, rollout `[testers]`), and
   * the catalog-only one is the documented shape of the public store launch.
   */
  describe('🔴 #3907 — the entry follows STORE visibility, not the block runtime', () => {
    it('EXTERNAL-ONLY cohort (appListingsPublicExternal alone) sees the entry', () => {
      const nav = appsNavVisibility({
        appBlocks: false,
        appListings: false,
        appListingsPublicExternal: true,
      });
      expect(nav.marketplace).toBe(true);
    });

    it('CATALOG-ONLY cohort (appListings alone) sees the entry', () => {
      const nav = appsNavVisibility({ appBlocks: false, appListings: true });
      expect(nav.marketplace).toBe(true);
    });

    it('a viewer with EVERY store flag off does not see it (the gate is not `true`)', () => {
      // The negative control for the two above: without it, a mutation that made
      // `marketplace` unconditionally true would pass both.
      const nav = appsNavVisibility({
        appBlocks: false,
        appListings: false,
        appListingsPublicExternal: false,
      });
      expect(nav.marketplace).toBe(false);
    });
  });

  /**
   * The entry widens DISCOVERY, not capability: it is a link, and every surface
   * behind `/apps` keeps its own gate. Pinned as a relationship so the two
   * cannot silently converge — the block-RUNTIME flag is not consulted for the
   * catalog-only cohort, and the catalog flags are not consulted by the runtime
   * surfaces (which live in their own modules and gate on `appBlocks` alone).
   */
  it('the marketplace entry is decided WITHOUT requiring the block runtime', () => {
    const catalogOnly = appsNavVisibility({ appListings: true, appBlocks: false });
    const runtimeOnly = appsNavVisibility({ appListings: false, appBlocks: true });
    expect(catalogOnly.marketplace).toBe(true);
    expect(runtimeOnly.marketplace).toBe(true);
  });
});
