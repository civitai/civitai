/**
 * S8 / PR-2 — the redirect decision for the RETIRED legacy per-app detail route
 * `/apps/[appBlockId]`.
 *
 * That page is superseded by the unified store detail `/apps/store-preview/<slug>`,
 * which covers its whole action set (Open app → the `open` branch, Open live → the
 * `visit` fallback, Edit manifest → the untouched sibling `/apps/[appBlockId]/edit*`
 * routes, independently reachable from my-submissions and the store card's owner
 * Edit). The legacy route is kept alive as a REDIRECT — not deleted — so a stale
 * bookmark, an external link, or one of the three in-repo callsites
 * (`AppBlockCard`, `ManifestEditForm`, `liveAppDetailHref`) simply hops.
 *
 * Pure + React-free + I/O-free on purpose: the branch is the whole point of the
 * change, so it must be assertable in the node-env `unit` project without booting
 * the page's Mantine/tRPC module graph. Same extraction precedent as
 * `resolveAppsPageAccess.ts`, `deploy-status.ts`, `sortInstallsForSlot.ts`.
 *
 * 🔴 TWO decided branches — do not add a third, and do not soften either:
 *
 *   1. An app WITH an approved `AppListing` → 302 to that listing's store detail.
 *
 *   2. An app with NO approved listing → the SITE-STANDARD 404 (`notFound`), NOT
 *      a redirect to `/apps`. On-site listings are created at APPROVAL, so a
 *      pending / rejected / never-approved app has no listing and therefore no
 *      store-preview target. The person most likely to open this URL is the app's
 *      OWNER following a link to their own pending app; bouncing them to a store
 *      that by construction does not list unapproved apps is a silent dead end —
 *      it reads as "my app vanished" with no signal why. A 404 is the honest
 *      answer ("there is no public detail page for this app"), it matches the
 *      posture `blocks.getAppDetail` already has (NOT_FOUND for a missing /
 *      unapproved app) and what `/apps/store-preview/<bogus>` already renders, and
 *      the owner's real surface is `/apps/my-submissions` with its status sections.
 *
 * `permanent: false` (302, not 301): the route's final disposition is a tracked
 * follow-up (delete the body once the redirect has soaked and inbound traffic has
 * dried up). A 301 is cached by browsers indefinitely and would make that
 * reversible decision irreversible in the field.
 *
 * The slug is `encodeURIComponent`-ed. It comes from our own DB column, but the
 * destination is a string built by concatenation, so encoding is what keeps a
 * `../`, a `//host`, or a `?`/`#` in a slug from steering the path off
 * `/apps/store-preview/` (an open redirect) or splicing a query/fragment onto it.
 */
export type LegacyAppRedirectResult =
  | { redirect: { destination: string; permanent: false } }
  | { notFound: true };

/** Path prefix of the unified store detail route. Exported so the test pins it. */
export const STORE_PREVIEW_PATH_PREFIX = '/apps/store-preview/';

export function resolveLegacyAppRedirect(args: {
  /**
   * The `AppListing.slug` of the APPROVED listing backing this app block, or
   * null/undefined when the app has none (pending / rejected / never-approved).
   * The caller is responsible for the approved-only lookup; this function only
   * decides what to do with the result.
   */
  slug?: string | null;
}): LegacyAppRedirectResult {
  const slug = typeof args?.slug === 'string' ? args.slug.trim() : '';
  // No approved listing (or a blank/whitespace slug, which is not addressable) →
  // the site-standard 404. Never a redirect to `/apps`.
  if (!slug) return { notFound: true };

  return {
    redirect: {
      destination: `${STORE_PREVIEW_PATH_PREFIX}${encodeURIComponent(slug)}`,
      permanent: false,
    },
  };
}
