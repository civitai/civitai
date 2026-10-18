/**
 * App Store Listings — the render-safe reader for a listing's ICON, keyed by slug.
 *
 * 🔴 WHO NEEDS THIS AND WHY IT IS ITS OWN MODULE. The `/apps/run/<slug>` page records an
 * entry in the client-side "recently opened apps" store on every mount, and that store
 * backs the app chrome's "Recently run" list. Every OTHER writer of that store goes
 * through `toRecentAppFromListing`, which carries the listing's `iconUrl`; the run page
 * could not, because nothing on its SSR path had ever read `app_listings` for media. So
 * the one writer that means *"the viewer actually RAN this app"* was the one writing
 * entries with no icon, and the chrome fell back to a generic glyph for exactly the apps
 * the viewer uses most.
 *
 * 🔴 IT IS **NOT** FOLDED INTO THE BETA READ THAT ALREADY RUNS ON THAT PAGE, THOUGH THAT
 * WOULD BE ONE FEWER QUERY. `readListingBetaBySlug` selects manual-apply columns and
 * collapses to `BETA_UNAVAILABLE` on a missing-column error (P2022 / 42703). Adding the
 * icon to that `select` would couple the two: during the manual-apply window for ANY
 * future beta-adjacent column, the icon would silently vanish along with the badge — a
 * failure with no relationship to the icon's own columns, and one nobody would think to
 * look for. `icon_id` is a base-schema column with none of that fragility, so it gets its
 * own read with its own failure mode.
 *
 * 🔴 THE COST IS A CONCURRENT QUERY, NOT A SERIAL ONE, AND THAT IS THE WHOLE REASON THIS
 * IS ACCEPTABLE ON THE LAUNCH PATH. The run page issues it inside the SAME `Promise.all`
 * as the block resolve and the beta read, keyed on the slug it already has, so the page
 * waits for the slowest of three rather than the sum of three. `AppListing.slug` is
 * `@unique`, so it is one indexed single-row lookup plus the `Image` join.
 *
 * 🔴 IT FAILS OPEN, FOR THE SAME REASON THE BETA READ DOES. `/apps/run/<slug>` is the app
 * LAUNCH path and `createServerSideProps` has no try/catch above it, so a rejection here
 * would be an SSR **500 on the page that runs the app**. Trading "the app is unusable" for
 * "the recents entry has a generic icon instead of the real one" is not a close call. The
 * failure is logged rather than swallowed silently, so an `app_listings` outage is still
 * findable instead of presenting only as icons that quietly stopped appearing.
 */
import { logToAxiom } from '~/server/logging/client';
import {
  gatedListingIconUrl,
  listingMediaCeiling,
  listingMediaImageSelect,
  SFW_LISTING_MEDIA_AUDIENCE,
  type ListingMediaAudience,
  type ListingMediaImage,
} from '~/server/services/blocks/listing-media-audience';

/**
 * The narrow client shape this reader needs.
 *
 * Declared structurally rather than as `PrismaClient` so a unit test can hand in a plain
 * object — including a THROWING fake, which is the only way to exercise the degraded
 * branch without a database that is actually unwell. Mirrors `BetaReadClient`.
 */
export type ListingIconReadClient = {
  appListing: {
    findUnique: (args: {
      where: { slug: string };
      select: { contentRating: true; icon: { select: typeof listingMediaImageSelect } };
    }) => Promise<{ contentRating: string | null; icon: ListingMediaImage | null } | null>;
  };
};

/**
 * Log a degraded icon read. Deliberately its own event name rather than reusing the beta
 * one: these are different columns with different failure modes, and a shared name would
 * make an `app_listings` media problem indistinguishable from a beta-column problem in
 * the one place someone would go looking.
 *
 * `logToAxiom` returns a promise that can reject, so the `.catch` is required — an
 * unhandled rejection from a fail-open path would defeat the point of failing open.
 */
function noteDegradedIconRead(err: unknown): void {
  logToAxiom({
    name: 'app-listing-icon-read-degraded',
    type: 'error',
    message: err instanceof Error ? err.message : String(err),
    code: (err as { code?: unknown })?.code ?? null,
  }).catch(() => null);
}

/**
 * The listing icon's CDN URL for `slug`, or `null`.
 *
 * `null` covers every "no icon to show" case without distinguishing them, because no
 * caller can act on the difference: no such listing, a listing with no icon assigned, an
 * icon row whose `url` is null, or a read that failed. Consumers render their own
 * fallback for all four.
 *
 * The URL comes from the SHARED listing-media gate (`listing-media-audience`) with the same
 * `audience` the store card uses, so this icon is the one the store renders for the same app
 * and viewer — which is the point. An icon that differed between the store and the chrome would
 * undermine the chrome's job of telling the viewer which app they are actually looking at; an icon
 * the store would HIDE for this viewer must not appear here either, so a hidden icon is `null`.
 * `audience` defaults to the narrowest (non-red host) view.
 */
export async function readListingIconBySlugForRender(
  slug: string,
  db: ListingIconReadClient,
  audience: ListingMediaAudience = SFW_LISTING_MEDIA_AUDIENCE
): Promise<string | null> {
  if (!slug) return null;
  try {
    const row = await db.appListing.findUnique({
      where: { slug },
      select: { contentRating: true, icon: { select: listingMediaImageSelect } },
    });
    if (!row) return null;
    return gatedListingIconUrl(row.icon, listingMediaCeiling(audience, row.contentRating));
  } catch (err) {
    noteDegradedIconRead(err);
    return null;
  }
}
