import { describe, expect, it } from 'vitest';
import { appsNavVisibility } from '~/components/AppLayout/AppHeader/appsNavVisibility';

// Scope-A invariant: the PUBLIC "Build apps" → /apps/get-started nav entry is
// visible whenever the public `appBlocksGetStarted` flag is on, INDEPENDENTLY of
// the store flags.
//
// #3907 invariant: the "Apps" → /apps entry is visible exactly when the STORE is
// visible (`hasAppsStoreAccess` = appListings || appBlocks ||
// appListingsPublicExternal). It is the ONLY in-product route to `/apps`, so a
// cohort that can load the store but not see this entry has a store it cannot
// find. It used to read `appBlocks` alone.
describe('appsNavVisibility — public get-started vs store-gated marketplace', () => {
  it('shows the public get-started entry when appBlocksGetStarted is on', () => {
    const nav = appsNavVisibility({ appBlocksGetStarted: true, appBlocks: false });
    expect(nav.getStarted).toBe(true);
  });

  it('keeps the marketplace entry hidden for a viewer with NO store flag', () => {
    // The public get-started flag alone grants no store access, so the entry that
    // links to the store stays hidden.
    const nav = appsNavVisibility({ appBlocksGetStarted: true, appBlocks: false });
    expect(nav.getStarted).toBe(true);
    expect(nav.marketplace).toBe(false);
  });

  it('shows BOTH entries for a moderator (both flags on) — distinct labels, no collision', () => {
    const nav = appsNavVisibility({ appBlocksGetStarted: true, appBlocks: true });
    expect(nav.getStarted).toBe(true);
    expect(nav.marketplace).toBe(true);
  });

  it('hides the get-started entry when the public flag is off (kill switch)', () => {
    const nav = appsNavVisibility({ appBlocksGetStarted: false, appBlocks: true });
    expect(nav.getStarted).toBe(false);
    // The marketplace entry is unaffected by the get-started kill switch.
    expect(nav.marketplace).toBe(true);
  });

  it('hides both entries when both flags are off', () => {
    const nav = appsNavVisibility({ appBlocksGetStarted: false, appBlocks: false });
    expect(nav.getStarted).toBe(false);
    expect(nav.marketplace).toBe(false);
  });

  it('treats undefined flags as off (default-deny on missing flags)', () => {
    const nav = appsNavVisibility({});
    expect(nav.getStarted).toBe(false);
    expect(nav.marketplace).toBe(false);
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
        appBlocksGetStarted: true,
        appBlocks: false,
        appListings: false,
        appListingsPublicExternal: true,
      });
      expect(nav.marketplace).toBe(true);
    });

    it('CATALOG-ONLY cohort (appListings alone) sees the entry', () => {
      const nav = appsNavVisibility({
        appBlocksGetStarted: false,
        appBlocks: false,
        appListings: true,
      });
      expect(nav.marketplace).toBe(true);
      // …and the get-started kill switch still governs its own entry.
      expect(nav.getStarted).toBe(false);
    });

    it('a viewer with EVERY store flag off does not see it (the gate is not `true`)', () => {
      // The negative control for the two above: without it, a mutation that made
      // `marketplace` unconditionally true would pass both.
      const nav = appsNavVisibility({
        appBlocksGetStarted: true,
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
