/**
 * S8 / PR-2 — the redirect decision for the RETIRED legacy per-app detail route
 * `/apps/[appBlockId]`.
 *
 * That page is superseded by the unified store detail `/apps/store-preview/<slug>`:
 * Open app → the `open` branch, Open live → the `visit` fallback, Edit manifest →
 * the untouched sibling `/apps/[appBlockId]/edit*` routes (independently reachable
 * from my-submissions and the store card's owner Edit). The legacy route is kept
 * alive as a REDIRECT — not deleted — so a stale bookmark, an external link, or one
 * of the four in-repo callsites (`AppBlockCard`, `ManifestEditForm`,
 * `liveAppDetailHref`, and the editor's own "Back") simply hops.
 *
 * ⚠️ ONE affordance is NOT carried over: the legacy page's Install / Manage CTA.
 * `AppListingDetailBody` has no install surface at all, so a MODEL-SLOT app (one
 * that installs into a slot rather than opening a page) has nowhere on the store
 * detail to install from. That is vacuous today — every approved on-site listing
 * declares a page, so none takes that branch — but it is the real gap to close
 * before a model-slot app is approved, and it is the reason the follow-up should
 * RETARGET the `info`-mode CTA rather than simply delete this route.
 *
 * Sibling precedent: `listingEditNav.ts`'s `legacyEditRedirect` does the same
 * "legacy route → 302, missing id → notFound" job for the owner-edit routes. It
 * unwraps a `string[]` param where this module fails closed on any non-string;
 * for a non-catch-all `[appBlockId]` segment Next always yields a string, so the
 * two agree in practice and the stricter form is kept deliberately.
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
import type { StoreVisibilityScope } from '~/server/services/app-blocks-flag';
import type { AppsStoreFeatureFlags } from '~/shared/utils/app-blocks-access';

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
 * filtered by the further gates the destination applies.
 *
 * 🔴 THERE ARE **THREE** SUCH GATES, not two. `getListingDetail`
 * (`app-listing.service.ts`) rejects a row on any of:
 *
 *   1. STORE-SCOPE KIND — `scope === 'public-external' && row.kind !== 'offsite'`.
 *   2. DEPLOY — `row.kind === 'onsite' && appBlock.currentVersionDeployedAt == null`.
 *   3. MATURITY — `!redCapable && isMatureContentRating(row.contentRating)`.
 *
 * ## (1) IS NOW REPLICATED HERE. (2) and (3) ARE STILL OWED.
 *
 * 🔴 THE ALIGNMENT ARGUMENT THIS COMMENT USED TO REST ON IS GONE — DO NOT RESTORE
 * IT. It said gate (1) was unreachable "by an accident of flag alignment": the page
 * gate granted on `features.appListings || appBlocks`, `features.appListings` read
 * the same `app-listings` Flipt key that `resolveStoreVisibilityScope`'s axis 1
 * uses to return `full`, so every viewer past the page gate resolved `full` and
 * every viewer who would resolve `public-external` was already 404'd. That
 * coincidence ENDED when the page gate gained a third term
 * (`appListingsPublicExternal`) so the external-only cohort could reach `/apps`:
 * from then on a `public-external` viewer passes the page gate, and without a
 * scope check every `/apps/<appBlockId>` would 302 with an on-site listing's slug
 * in the `Location` header — disclosing both the slug and the existence of an
 * approved on-site listing to precisely the audience `public-external` exists to
 * hide on-site apps from. (The destination 404s for them, so the leak is the
 * header and the DB read, not the page.)
 *
 * So the guard is no longer an alignment coincidence — it is the explicit
 * `storeScope` check below, and it is what the no-disclosure property now rests
 * on. `storeScope` is a REQUIRED argument for that reason: a caller that forgets
 * it is a compile error, not a silent re-opening.
 *
 * It is an ALLOWLIST (`!== 'full'`), not a denylist on `public-external`. A
 * denylist fails OPEN the moment a fourth scope is added — and the scope union is
 * exactly the kind of thing that grows. `none` is rejected by the same line, which
 * also closes a case the page gate alone does not: during a Flipt OUTAGE a
 * moderator's `features.appListings` resolves true from its static
 * `availability: ['mod']` fallback while the server resolves scope `none`, so the
 * page gate grants where the data layer would serve nothing.
 *
 * STILL OWED (deliberately not done here — each needs another input threaded into
 * this SSR resolver, and neither is reachable today): a `currentVersionDeployedAt`
 * filter, and a `contentRating` filter keyed on the request's red-capability. Both
 * are 0-instance today and would each affect a handful of apps at most.
 *
 * ⚠️ A SIZING CLAIM THAT USED TO LIVE HERE WAS WRONG, and is corrected rather than
 * deleted so nobody re-derives it: this comment asserted that "EVERY listing that
 * carries an `appBlockId` is `kind='onsite'`", making the gap under
 * `public-external` exactly 100%. `schema.full.prisma` says otherwise — `appBlockId`
 * is set for on-site listings AND for the #2821 off-site backfilled rows, and it is
 * explicitly "NOT a kind discriminator: discriminate on `kind`, never on appBlockId
 * nullness." The guard below is unaffected (it rejects the scope outright rather
 * than reasoning about kinds), but the old blast-radius estimate was unreliable.
 * Tracked in issue #3932 with the other findings from #3928's audit.
 */
export async function resolveLegacyAppRoute(args: {
  // The SHARED flag type (derived from `FeatureAccess`), so a rename at GA is a
  // compile error here too — this resolver forwards straight into the store gate.
  features?: AppsStoreFeatureFlags;
  /**
   * The viewer's resolved store scope, from the SERVER helper
   * `resolveStoreVisibilityScope({ user })` — NOT re-derived from `features`.
   *
   * 🔴 Why the server helper and not the client feature object: they are two
   * evaluations of the same flags and they can disagree (a Flipt outage makes the
   * client fall back to each flag's static `availability` while the server has no
   * such fallback). This is a DISCLOSURE gate, so it must key off the same value
   * the DATA layer keys off — `getListingDetail`'s `scope` — or the gate and the
   * thing it is gating are answering different questions. This is an async SSR
   * resolver, so the server helper is simply available; there is no reason to
   * approximate it.
   *
   * REQUIRED, not optional-with-a-default: a default would let a new caller
   * silently re-open the disclosure.
   */
  storeScope: StoreVisibilityScope;
  appBlockId?: unknown;
  /** Approved-only slug lookup. Use `approvedListingSlugQuery` to build it. */
  findApprovedListingSlug: (appBlockId: string) => Promise<string | null | undefined>;
}): Promise<LegacyAppRedirectResult> {
  // 🔒 GATE FIRST — before the param is read, before anything is queried.
  const access = resolveAppsPageAccess({ features: args.features });
  if ('notFound' in access) return { notFound: true };

  // 🔒 STORE-SCOPE GATE, also before the param and the query. ALLOWLIST: only a
  // `full` viewer may resolve this route. `public-external` must not learn an
  // on-site listing's slug from a `Location` header, and `none` has no store at
  // all. See the block comment — this replaces an alignment coincidence that the
  // widened page gate ended.
  if (args.storeScope !== 'full') return { notFound: true };

  const appBlockId = typeof args.appBlockId === 'string' ? args.appBlockId.trim() : '';
  if (!appBlockId) return { notFound: true };

  const slug = await args.findApprovedListingSlug(appBlockId);
  return resolveLegacyAppRedirect({ slug });
}
