/**
 * S8 / PR-2 — the redirect decision for the RETIRED legacy per-app detail route
 * `/apps/[appBlockId]`.
 *
 * That page is superseded by the unified store detail `/apps/store-preview/<slug>`,
 * which covers its whole action set (Open app → the `open` branch, Open live → the
 * `visit` fallback, Edit manifest → the untouched sibling `/apps/[appBlockId]/edit*`
 * routes, independently reachable from my-submissions and the store card's owner
 * Edit). The legacy route is kept alive as a REDIRECT — not deleted — so a stale
 * bookmark, an external link, or one of the four in-repo callsites
 * (`AppBlockCard`, `ManifestEditForm`, `liveAppDetailHref`, and the editor's own
 * "Back") simply hops.
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
import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';

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

/**
 * The Prisma `findFirst` args that resolve an app block's store slug.
 *
 * 🔴 Built here rather than inline in the page so the APPROVED-ONLY precondition
 * is pinned by a test. This filter is the entire difference between "redirect to
 * the app's store detail" and "redirect any pending or rejected app to a store
 * URL that refuses to serve it" — dropping `status: 'approved'` is a silent,
 * behaviour-inverting one-word edit that the decision tests above cannot see,
 * because by then the slug has already been handed over.
 *
 * `revisionOfId: null` is defense-in-depth. A shadow revision is a draft (so the
 * status filter already excludes it) and cannot carry an `appBlockId` while its
 * parent holds that UNIQUE value — but this is a public read, so never let it
 * reach one.
 */
export function approvedListingSlugQuery(appBlockId: string) {
  return {
    where: { appBlockId, status: 'approved', revisionOfId: null },
    select: { slug: true },
  };
}

/**
 * The WHOLE server-side decision for the retired route, with the database read
 * injected.
 *
 * 🔴 The injection is the point. The security-relevant half of this change is not
 * the string concat — it is the ORDERING: the store-visibility gate must run
 * before the route param is read and before any query is issued. A test that only
 * exercises `resolveLegacyAppRedirect` cannot see that ordering at all. With the
 * lookup injected, a test can assert that it was never even CALLED for an
 * ungranted viewer, which turns the invariant into something that actually fails
 * when someone reorders it.
 *
 * ⚠️ Scope of that claim, stated precisely so nobody over-trusts it: gate-first
 * means a viewer WITHOUT store visibility learns nothing — identical `notFound`,
 * no `Location` header, no query. It does NOT mean the route discloses nothing to
 * a viewer WITH store visibility. For them 302-vs-404 is a new HTTP-level signal
 * that the old page did not emit (it answered 200 either way), and it is not
 * filtered by the two further gates the destination applies — a maturity gate and
 * an on-site "never deployed" gate. So an app caught by either would have its
 * slug disclosed one hop before the destination refuses to serve it. Those
 * viewers can already enumerate approved listings from the store grid, and no
 * live app is in either state, so this is a disclosed residual rather than a
 * hole — but replicating those two gates here is the fix if we want it airtight
 * before the store widens past its current audience.
 */
export async function resolveLegacyAppRoute(args: {
  features?: { appBlocks?: boolean; appListings?: boolean } | null;
  appBlockId?: unknown;
  /** Approved-only slug lookup. Use `approvedListingSlugQuery` to build it. */
  findApprovedListingSlug: (appBlockId: string) => Promise<string | null | undefined>;
}): Promise<LegacyAppRedirectResult> {
  // 🔒 GATE FIRST — before the param is read, before anything is queried.
  const access = resolveAppsPageAccess({ features: args.features });
  if ('notFound' in access) return { notFound: true };

  const appBlockId = typeof args.appBlockId === 'string' ? args.appBlockId.trim() : '';
  if (!appBlockId) return { notFound: true };

  const slug = await args.findApprovedListingSlug(appBlockId);
  return resolveLegacyAppRedirect({ slug });
}
