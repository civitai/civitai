import { getEdgeUrl } from '~/client-utils/edge-url';
import { classifyGatedImageForViewer } from '~/server/services/blocks/block-gated-images.logic';
import {
  LISTING_COVER_WIDTH,
  LISTING_SCREENSHOT_WIDTH,
  listingCoverUrl,
  listingIconUrl,
} from '~/server/services/blocks/listing-media-url';
import {
  allBrowsingLevelsFlag,
  browsingLevels,
  effectiveBrowsingCeiling,
  flagifyBrowsingLevel,
  nsfwLevelFromContentRating,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

/**
 * App Store listing media — the PER-IMAGE, PER-REQUEST visibility rule for every PUBLIC surface
 * that renders a listing's icon, cover or screenshots.
 *
 * 🔴 ONE RULE, ONE PLACE. The store card, the detail page and its gallery, the cover's
 * first-screenshot fallback, a sub-listing card's parent-cover/icon fallback, the run-page chrome
 * icon and the post "Published with" chip all decide here whether an `Image` may be shown. None
 * of them reads `nsfwLevel` itself. `listing-media-audience.ledger.test.ts` pins the set of
 * modules that project listing media, so a new public surface cannot hydrate a listing image and
 * render it raw without being added to that list on purpose.
 *
 * WHY THIS EXISTS. A listing's `content_rating` is checked at go-live, but an image's level can
 * move afterwards without the rating following it: an on-site media revision is applied without
 * re-flooring the rating, and only a moderator's re-rate re-derives it (a community-consensus or
 * scanner re-rate does not). Before this module no public projection read `Image.nsfwLevel` at
 * all, so in both cases a mature image rendered on a SFW card. Gating each image when it is
 * rendered closes both without touching the rating: the next render after a level change drops
 * the image, with no cache to bust (the catalog cache holds ids only; media is hydrated live).
 *
 * THE CEILING (see {@link listingMediaCeiling}):
 *   - any host that is NOT red-capable: SFW ∩ the levels the listing's `content_rating` allows;
 *   - a red-capable host: every rated level (Blocked excluded) ∩ the VIEWER's browsing level, so
 *     an anonymous viewer there sees PG media only.
 * The visibility test itself is `classifyGatedImageForViewer`: moderation flags, a hard block and a
 * terminal scan refusal hide the image whatever its level, and an image nothing has rated yet is
 * `pending`, which here means NOT SHOWN. Every caller treats anything but `visible` as hidden.
 *
 * WHAT A HIDDEN ASSET BECOMES. A hidden icon is `null` (every renderer already draws its own
 * placeholder for that). A hidden cover falls back to the first screenshot THIS viewer may see,
 * then to `null`. A hidden screenshot is dropped from the gallery and order is preserved. Nothing
 * is ever replaced by an asset the viewer may not see.
 *
 * NOT FOR AUTHORS OR MODERATORS. An owner's own "My apps" row and the moderator review surfaces
 * must show what is actually attached, so they keep using the raw builders in
 * `listing-media-url.ts`. The moderator preview reaches this module only through
 * {@link MODERATOR_REVIEW_MEDIA}, which says so at the call site.
 *
 * The image columns needed for the decision ({@link listingMediaImageSelect}) are read on the
 * server only; no public DTO carries a level or a moderation flag.
 */

/**
 * The `Image` columns the visibility decision reads, plus `url`. All are long-standing base
 * columns of `Image`, so selecting them adds no dependency on a manual-apply migration.
 */
export const listingMediaImageSelect = {
  url: true,
  nsfwLevel: true,
  ingestion: true,
  needsReview: true,
  poi: true,
  minor: true,
  tosViolation: true,
  acceptableMinor: true,
  blockedFor: true,
} as const;

/** One listing image as {@link listingMediaImageSelect} reads it. */
export type ListingMediaImage = {
  url: string | null;
  nsfwLevel: number;
  ingestion: string;
  needsReview: string | null;
  poi: boolean;
  minor: boolean;
  tosViolation: boolean;
  acceptableMinor: boolean;
  blockedFor: string | null;
};

/** Who is looking, and from which host. */
export type ListingMediaAudience = {
  /** `isRedCapableHost(host)` — never `getRequestDomainColor`, which reads `.red` as blue. */
  redCapable: boolean;
  /** The viewer's browsing level. Absent / 0 ⇒ the public floor (PG). Used on a red host only. */
  viewerBrowsingLevel?: number | null;
};

/** The narrowest audience: a non-red host. What a caller that does not say gets. */
export const SFW_LISTING_MEDIA_AUDIENCE: ListingMediaAudience = { redCapable: false };

/**
 * The browsing-level ceiling one listing's media is held to for one request.
 *
 * Off a red-capable host the listing's own `content_rating` caps it as well as SFW, so a `g`
 * listing does not show a PG-13 screenshot. On a red-capable host the cap is the viewer's level
 * (any rated level up to XXX, never Blocked), so a listing may show media above its `.com`
 * rating there — but only to a viewer who has opted into that level.
 */
export function listingMediaCeiling(
  audience: ListingMediaAudience,
  contentRating: string | null | undefined
): number {
  if (audience.redCapable) {
    // `allBrowsingLevelsFlag` is PG..XXX (no Blocked bit), and `effectiveBrowsingCeiling` is the
    // shared domain ∩ viewer rule: an absent, non-finite or negative viewer level is the public
    // floor. A `0` level is "no level" here too, not "hide everything".
    return effectiveBrowsingCeiling(allBrowsingLevelsFlag, audience.viewerBrowsingLevel || null);
  }
  const ratingMax = nsfwLevelFromContentRating(contentRating);
  const ratingLevels = flagifyBrowsingLevel(browsingLevels.filter((l) => l <= ratingMax));
  return sfwBrowsingLevelsFlag & ratingLevels;
}

/** The fields `classifyGatedImageForViewer` reads. */
type GatedFields = Parameters<typeof classifyGatedImageForViewer>[0];

/**
 * True only when `image` is `visible` under `ceiling`. The single predicate every listing-media
 * surface uses; `pending` (not yet rated) is a refusal, the same as `hidden`.
 */
export function isListingImageVisible(
  image: GatedFields | null | undefined,
  ceiling: number
): boolean {
  if (!image) return false;
  if (classifyGatedImageForViewer(image, ceiling).status !== 'visible') return false;
  return true;
}

/** A visible image's url, or null. */
function visibleUrl(
  image: (GatedFields & { url: string | null }) | null | undefined,
  ceiling: number
): string | null {
  if (!image?.url) return null;
  return isListingImageVisible(image, ceiling) ? image.url : null;
}

/** The icon's CDN url when the viewer may see it, else null (the renderer's placeholder). */
export function gatedListingIconUrl(
  icon: ListingMediaImage | null | undefined,
  ceiling: number
): string | null {
  const url = visibleUrl(icon, ceiling);
  return url ? listingIconUrl({ url }) : null;
}

type ScreenshotRow = { caption?: string | null; image: ListingMediaImage | null };

/** The screenshots this viewer may see, in stored order, as gallery entries. */
export function gatedListingScreenshots(
  screenshots: readonly ScreenshotRow[],
  ceiling: number
): { url: string; caption: string | null }[] {
  const out: { url: string; caption: string | null }[] = [];
  for (const s of screenshots) {
    // A row whose Image was deleted (imageId → null) never renders as a blank tile.
    const url = visibleUrl(s.image, ceiling);
    if (!url) continue;
    out.push({
      url: getEdgeUrl(url, { width: LISTING_SCREENSHOT_WIDTH }),
      caption: s.caption ?? null,
    });
  }
  return out;
}

/**
 * The cover: the cover image if the viewer may see it, else the first screenshot they may see,
 * else null. The fallback is filtered by the SAME ceiling — a screenshot the viewer may not see
 * can never become the cover.
 */
export function gatedListingCoverUrl(
  cover: ListingMediaImage | null | undefined,
  screenshots: readonly ScreenshotRow[],
  ceiling: number
): string | null {
  const coverUrl = visibleUrl(cover, ceiling);
  if (coverUrl) return listingCoverUrl({ url: coverUrl }, null);
  for (const s of screenshots) {
    const url = visibleUrl(s.image, ceiling);
    if (url) return getEdgeUrl(url, { width: LISTING_COVER_WIDTH });
  }
  return null;
}

/** The media a listing row carries, as `listingHydrateSelect` reads it. */
export type ListingMediaRow = {
  contentRating: string | null;
  icon: ListingMediaImage | null;
  cover: ListingMediaImage | null;
  screenshots: readonly ScreenshotRow[];
};

/**
 * How a projection should treat media: gated for a public `audience`, or shown as attached for a
 * moderator reviewing the listing.
 */
export type ListingMediaView =
  | { kind: 'public'; audience: ListingMediaAudience }
  | { kind: 'moderator-review' };

/**
 * The moderator review preview shows what the listing actually carries, so the reviewer can see
 * — and reject — media that would not be shown publicly. Only `getListingPreviewForReview`
 * (behind `moderatorProcedure`) passes this.
 */
export const MODERATOR_REVIEW_MEDIA: ListingMediaView = { kind: 'moderator-review' };

/** The narrowest public view. The default for a projection whose caller does not say. */
export const SFW_PUBLIC_MEDIA: ListingMediaView = {
  kind: 'public',
  audience: SFW_LISTING_MEDIA_AUDIENCE,
};

/**
 * Project a listing row's media for one view. `gallery: false` skips the screenshot list for a
 * caller that only renders the icon and cover (the store card); the cover fallback still reads
 * the screenshots.
 */
export function projectListingMedia(
  row: ListingMediaRow,
  view: ListingMediaView,
  opts: { gallery?: boolean } = {}
): {
  iconUrl: string | null;
  coverUrl: string | null;
  screenshots: { url: string; caption: string | null }[];
} {
  const gallery = opts.gallery !== false;
  if (view.kind === 'moderator-review') {
    const firstShot = row.screenshots.find((s) => s.image?.url)?.image?.url ?? null;
    const screenshots: { url: string; caption: string | null }[] = [];
    if (gallery) {
      for (const s of row.screenshots) {
        if (!s.image?.url) continue;
        screenshots.push({
          url: getEdgeUrl(s.image.url, { width: LISTING_SCREENSHOT_WIDTH }),
          caption: s.caption ?? null,
        });
      }
    }
    return {
      iconUrl: listingIconUrl(row.icon),
      coverUrl: listingCoverUrl(
        row.cover,
        firstShot ? getEdgeUrl(firstShot, { width: LISTING_COVER_WIDTH }) : null
      ),
      screenshots,
    };
  }
  const ceiling = listingMediaCeiling(view.audience, row.contentRating);
  return {
    iconUrl: gatedListingIconUrl(row.icon, ceiling),
    coverUrl: gatedListingCoverUrl(row.cover, row.screenshots, ceiling),
    screenshots: gallery ? gatedListingScreenshots(row.screenshots, ceiling) : [],
  };
}
