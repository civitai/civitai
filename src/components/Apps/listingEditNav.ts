import type { NextRouter } from 'next/router';

/**
 * App Store Listings — history-aware "back" for the owner edit surfaces (Item 3).
 *
 * PURE-ish (only reads `window.history.length`): navigate BACK when there's real
 * history to pop, else fall back to an explicit href. Replaces the hardcoded
 * `<Anchor href={/apps/${appBlockId}}>` so a deep/cold link (no history) still lands
 * somewhere sensible instead of silently doing nothing.
 *
 *   - `history.length > 1`  → `router.back()` (return to wherever the user came from).
 *   - `history.length <= 1` → `router.push(fallbackHref)` (cold entry / deep link).
 *
 * SSR-safe: with no `window` (server) it takes the fallback.
 */
export function goBackOrFallback(
  router: Pick<NextRouter, 'back' | 'push'>,
  fallbackHref: string
): void {
  if (typeof window !== 'undefined' && window.history.length > 1) {
    router.back();
    return;
  }
  void router.push(fallbackHref);
}

/**
 * Pure `getServerSideProps` result builder for the LEGACY owner-edit routes
 * (`/apps/<id>/edit-manifest`, `/apps/<id>/listing`) — both now redirect into the
 * unified `/apps/<id>/edit?tab=<tab>` page. Extracted so the redirect destination is
 * unit-testable without the SSR machinery. Missing / empty `appBlockId` → notFound.
 */
export function legacyEditRedirect(
  rawAppBlockId: string | string[] | undefined,
  tab: 'manifest' | 'media'
): { redirect: { destination: string; permanent: false } } | { notFound: true } {
  const appBlockId = Array.isArray(rawAppBlockId) ? rawAppBlockId[0] : rawAppBlockId;
  if (!appBlockId) return { notFound: true };
  return {
    redirect: {
      destination: `/apps/${encodeURIComponent(appBlockId)}/edit?tab=${tab}`,
      permanent: false,
    },
  };
}
