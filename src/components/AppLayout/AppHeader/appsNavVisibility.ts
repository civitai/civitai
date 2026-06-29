/**
 * Pure visibility logic for the two App Blocks nav entries in the user menu.
 *
 * Extracted out of `useGetMenuItems` (which is a heavy hook — router, session,
 * theme, tRPC) so the gating invariant is unit-testable in isolation:
 *
 *  - the PUBLIC "Build apps" → `/apps/get-started` entry is visible whenever the
 *    public `appBlocksGetStarted` flag is on (everyone by default; Flipt kill
 *    switch);
 *  - the mod-only "Apps Marketplace" → `/apps` entry stays gated on `appBlocks`
 *    (mod-only today) — its visibility is INDEPENDENT of the get-started flag.
 *
 * This file imports no React/Mantine so it stays a pure unit.
 */
export type AppsNavVisibility = {
  /** PUBLIC get-started landing page (`/apps/get-started`). */
  getStarted: boolean;
  /** Mod-only marketplace hub (`/apps`). */
  marketplace: boolean;
};

export function appsNavVisibility(features: {
  appBlocksGetStarted?: boolean;
  appBlocks?: boolean;
}): AppsNavVisibility {
  return {
    getStarted: !!features.appBlocksGetStarted,
    marketplace: !!features.appBlocks,
  };
}
