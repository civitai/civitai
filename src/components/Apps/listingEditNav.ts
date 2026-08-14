import type { NextRouter } from 'next/router';

import type { EditorTab } from '~/components/Apps/appListingEditorTabs';
import { listingEditHref, resolveEditorTab } from '~/components/Apps/appListingEditorTabs';

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
 * (`/apps/<id>/edit-manifest`, `/apps/<id>/listing`, and now `/apps/<id>/edit` itself).
 * Extracted so the redirect destination is unit-testable without the SSR machinery.
 * Missing / empty `appBlockId` → notFound.
 *
 * 🔴 TWO DESTINATIONS, chosen by whether the block HAS a listing yet:
 *
 *   - `appListingId` given → the CANONICAL listing-keyed page
 *     `/apps/listing/<appListingId>/edit?tab=<tab>`. This is the whole point of the
 *     re-key: the canonical authoring route serves BOTH store kinds, and an off-site
 *     listing has no block id to address.
 *   - `appListingId` absent/null → the pre-existing block-keyed
 *     `/apps/<appBlockId>/edit?tab=<tab>`, byte-identical to the old behaviour. This is
 *     NOT a fallback for convenience: an AppBlock whose first version is still pending
 *     approval genuinely has no `AppListing` row, so there is no canonical URL to send
 *     it to, and it has no seats either (nothing to seat anyone on).
 *
 * 🔴 EXTENDED rather than duplicated, deliberately. A second redirect helper is how the
 * two legacy routes and the new one drift into disagreeing about where `?tab=media`
 * lands — the destination is one rule and lives in one function.
 *
 * `?tab=` is PRESERVED across the hop in every case: the caller passes the tab it was
 * entered with, and it is re-emitted on the destination.
 */
export function legacyEditRedirect(
  rawAppBlockId: string | string[] | undefined,
  tab: EditorTab,
  appListingId?: string | null
): { redirect: { destination: string; permanent: false } } | { notFound: true } {
  const appBlockId = Array.isArray(rawAppBlockId) ? rawAppBlockId[0] : rawAppBlockId;
  if (!appBlockId) return { notFound: true };
  const destination = appListingId
    ? listingEditHref(appListingId, tab)
    : `/apps/${encodeURIComponent(appBlockId)}/edit?tab=${tab}`;
  return { redirect: { destination, permanent: false } };
}

/**
 * `getServerSideProps` result for the block-keyed `/apps/<appBlockId>/edit` page itself.
 *
 * 🔴 IT MUST NOT ALWAYS REDIRECT, or a block with no listing would 302 to itself forever.
 * With a listing it hands off to {@link legacyEditRedirect} (one hop, canonical URL, tab
 * preserved); without one it returns `{ props: {} }` and the legacy block-keyed page
 * renders as it always did.
 *
 * The tab is re-parsed here rather than trusted: the query is user-controlled, and the
 * legacy page only ever knew `manifest` / `media`, so an unknown value must resolve to a
 * real tab before it is written into the destination.
 */
export function canonicalEditRedirect(
  rawAppBlockId: string | string[] | undefined,
  rawTab: unknown,
  appListingId: string | null | undefined,
  allowedTabs: EditorTab[]
):
  | { redirect: { destination: string; permanent: false } }
  | { notFound: true }
  | { props: Record<string, never> } {
  const appBlockId = Array.isArray(rawAppBlockId) ? rawAppBlockId[0] : rawAppBlockId;
  if (!appBlockId) return { notFound: true };
  if (!appListingId) return { props: {} };
  return legacyEditRedirect(appBlockId, resolveEditorTab(rawTab, allowedTabs), appListingId);
}
