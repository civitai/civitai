import { getEdgeUrl } from '~/client-utils/edge-url';
import {
  classifyGatedImageForViewer,
  isLevelWithinCeiling,
} from '~/server/services/blocks/block-gated-images.logic';
import {
  LISTING_COVER_WIDTH,
  LISTING_ICON_WIDTH,
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
 * first-screenshot fallback, a sub-listing card's own item image and its parent-cover/icon
 * fallback, the post "Published with" chip, and the app chrome's "Recently run" icons (which read the detail's `iconUrl`) all
 * decide here whether an `Image` may be shown. None
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
 * the image. No SERVER cache holds media (the catalog cache holds ids only; media is hydrated
 * live). The one CLIENT copy that did — the "Recently opened" store in localStorage, which used
 * to persist each app's icon url and render it without a live card — no longer keeps icon urls
 * at all (`recentlyOpenedAppsStore.ts`), so a stored, ungated icon is never rendered.
 *
 * THE CEILING (see {@link listingMediaCeiling} and {@link redHostMediaCeiling}):
 *   - any host that is NOT red-capable: SFW ∩ the levels the listing's `content_rating` allows;
 *   - a red-capable host: exactly that non-red ceiling, UNION the levels the VIEWER has opted
 *     into (Blocked excluded). A red host never shows less SFW media than a non-red host does:
 *     an anonymous or non-opted-in viewer there sees what the non-red host shows, and an
 *     opted-in viewer additionally sees R/X/XXX media up to their own browsing level.
 * The visibility test itself is `classifyGatedImageForViewer`: moderation flags, a hard block and a
 * terminal scan refusal hide the image whatever its level, and an image nothing has rated yet is
 * `pending`, which here means NOT SHOWN. Every caller treats anything but `visible` as hidden.
 *
 * THE civitai.red ICON / COVER OVERRIDES (`ListingMediaView.red`). A listing may carry an icon
 * and a cover shown INSTEAD of its own on a red-capable host only. They are gated per image by
 * the SAME ceiling as the listing's own media, and fall back to it: a hidden icon override to
 * the listing's own icon, a hidden cover override to the listing's own cover, then to the first
 * screenshot this viewer may see. A view that is not red-capable never uses them, and the store
 * never reads them for one (`readListingRedMediaManyForRender`, red-capable reads only). They are
 * never a social-preview (`og:image`) candidate on any host: see {@link listingSocialImage}.
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

/**
 * A moderation flag read from an untyped or raw-SQL row counts as SET unless it is literally
 * `false` or absent — fail-closed, so a malformed value can only ever hide an image. The one rule
 * for every reader that builds a {@link ListingMediaImage} from such a row.
 */
export function isModerationFlagSet(value: unknown): boolean {
  return value != null && value !== false;
}

/** Who is looking, and from which host. */
export type ListingMediaAudience = {
  /** `isRedCapableHost(host)` — never `getRequestDomainColor`, which reads `.red` as blue. */
  redCapable: boolean;
  /**
   * The viewer's browsing level. Used on a red host only, where it can only ADD levels to the
   * non-red ceiling; absent / 0 adds nothing beyond the public floor (PG), which that ceiling
   * already holds.
   */
  viewerBrowsingLevel?: number | null;
};

/** The narrowest audience: a non-red host. What a caller that does not say gets. */
export const SFW_LISTING_MEDIA_AUDIENCE: ListingMediaAudience = { redCapable: false };

/**
 * 🔴 THE RED-HOST RULE, for every listing-media surface: on a red-capable host the ceiling is
 * `nonRedCeiling` (what a non-red host would apply to this same image on this same surface)
 * UNION the viewer's browsing level, Blocked excluded. Off a red host it is `nonRedCeiling`
 * unchanged. So a red host can only ever show MORE than a non-red host, never less, and only a
 * viewer who opted into a mature level sees anything above the non-red ceiling.
 *
 * Every surface computes its own `nonRedCeiling` (a store card: SFW ∩ the listing rating; a
 * sub-listing card: the viewer ∩ SFW ∩ that card's rating, for its item image and its parent
 * fallback alike) and lifts it through
 * here, so the red half of the rule exists exactly once.
 */
export function redHostMediaCeiling(audience: ListingMediaAudience, nonRedCeiling: number): number {
  if (!audience.redCapable) return nonRedCeiling;
  // `allBrowsingLevelsFlag` is PG..XXX (no Blocked bit), and `effectiveBrowsingCeiling` is the
  // shared domain ∩ viewer rule: an absent, non-finite or negative viewer level is the public
  // floor (PG), which adds nothing here. A `0` level is "no level" too, not "hide everything".
  const viewerLevels = effectiveBrowsingCeiling(
    allBrowsingLevelsFlag,
    audience.viewerBrowsingLevel || null
  );
  return (nonRedCeiling | viewerLevels) & allBrowsingLevelsFlag;
}

/**
 * The browsing-level ceiling one listing's media is held to for one request.
 *
 * Off a red-capable host: SFW ∩ the levels the listing's own `content_rating` allows, so a `g`
 * listing does not show a PG-13 screenshot. On a red-capable host: that same ceiling, lifted by
 * {@link redHostMediaCeiling} to include the viewer's opted-in levels — so a `pg13` listing's
 * PG-13 cover shows to an anonymous viewer there exactly as it does off a red host, and an R
 * screenshot shows only to a viewer who has opted into R.
 */
export function listingMediaCeiling(
  audience: ListingMediaAudience,
  contentRating: string | null | undefined
): number {
  const ratingMax = nsfwLevelFromContentRating(contentRating);
  const ratingLevels = flagifyBrowsingLevel(browsingLevels.filter((l) => l <= ratingMax));
  return redHostMediaCeiling(audience, sfwBrowsingLevelsFlag & ratingLevels);
}

/** The gate's level comparison, for labels that describe where an image shows. */
export { isLevelWithinCeiling };

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
 * The cover: the cover image if the viewer may see it, else `fallbackCover` (the listing's own
 * cover, when `cover` is a civitai.red override) if they may see it, else the first screenshot
 * they may see, else null. Every fallback is filtered by the SAME ceiling — an image the viewer
 * may not see can never become the cover.
 */
export function gatedListingCoverUrl(
  cover: ListingMediaImage | null | undefined,
  screenshots: readonly ScreenshotRow[],
  ceiling: number,
  fallbackCover?: ListingMediaImage | null
): string | null {
  const coverUrl = visibleUrl(cover, ceiling) ?? visibleUrl(fallbackCover, ceiling);
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
 * A listing's civitai.red icon / cover overrides as the store read them (each image with the
 * columns {@link isListingImageVisible} reads), or `null` for an empty slot.
 */
export type ListingRedOverrides = {
  icon: ListingMediaImage | null;
  cover: ListingMediaImage | null;
};

/**
 * How a projection should treat media: gated for a public `audience`, or shown as attached for a
 * moderator reviewing the listing.
 *
 * `red` carries the listing's civitai.red icon / cover overrides. They are honoured ONLY when
 * `audience.redCapable` — a non-red view ignores them even if a caller passed them, and the store
 * never reads them for one (`readListingRedMediaManyForRender` is called only on a red host).
 */
export type ListingMediaView =
  | { kind: 'public'; audience: ListingMediaAudience; red?: ListingRedOverrides | null }
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
  // 🔴 THE OVERRIDES EXIST ONLY ON A RED-CAPABLE HOST. Each is gated by the SAME ceiling as the
  // listing's own media and falls back to it when hidden, so a red host shows an override only to
  // a viewer the store rule lets see it, and otherwise exactly what it showed without one.
  const red = view.audience.redCapable ? view.red ?? null : null;
  return {
    iconUrl: gatedListingIconUrl(red?.icon, ceiling) ?? gatedListingIconUrl(row.icon, ceiling),
    coverUrl: red
      ? gatedListingCoverUrl(red.cover, row.screenshots, ceiling, row.cover)
      : gatedListingCoverUrl(row.cover, row.screenshots, ceiling),
    screenshots: gallery ? gatedListingScreenshots(row.screenshots, ceiling) : [],
  };
}

/** One listing image chosen for a social preview: its delivery url and its own level. */
export type ListingSocialImage = { url: string; nsfwLevel: number };

/**
 * The image a listing's page offers link unfurlers and crawlers (`og:image` / `twitter:image`)
 * on one host, or null for none.
 *
 * 🔴 HELD TO THE ANONYMOUS CEILING OF THE HOST, NEVER THE REQUESTER'S. An unfurler is not signed
 * in and sees no host gating of its own, and a page rendered for one viewer can be shared to
 * anyone, so the requester's browsing level is deliberately not an input. Off a red-capable host
 * that ceiling is SFW ∩ the listing's rating; on one it is the same (an anonymous viewer there
 * sees exactly what a non-red host shows) — so whichever host, a mature image is never chosen.
 *
 * 🔴 THE LISTING'S OWN MEDIA ONLY — A civitai.red ICON / COVER OVERRIDE IS NEVER A CANDIDATE, ON
 * ANY HOST (design invariant I6), even one at a level the anonymous ceiling would admit. The
 * override slots exist to carry media for civitai.red's own pages; a social preview leaves the
 * host, so it is not one of them. This takes no overrides, and its caller never reads them.
 *
 * Same choice order as the page's own cover, gated image by image: the listing's own cover, then
 * the first screenshot that passes, then the listing's own icon.
 *
 * The level travels with the url so the page's `Meta` can apply its own, host-independent
 * safe-level check as a second belt (`Meta`'s `imageNsfwLevel`).
 */
export function listingSocialImage(
  row: ListingMediaRow,
  host: Pick<ListingMediaAudience, 'redCapable'>
): ListingSocialImage | null {
  const ceiling = listingMediaCeiling({ redCapable: host.redCapable }, row.contentRating);
  const pick = (images: readonly (ListingMediaImage | null | undefined)[]) =>
    images.find(
      (image): image is ListingMediaImage & { url: string } =>
        !!image?.url && isListingImageVisible(image, ceiling)
    );
  const cover = pick([row.cover, ...row.screenshots.map((s) => s.image)]);
  if (cover) {
    return {
      url: getEdgeUrl(cover.url, { width: LISTING_COVER_WIDTH }),
      nsfwLevel: cover.nsfwLevel,
    };
  }
  const icon = pick([row.icon]);
  return icon
    ? { url: getEdgeUrl(icon.url, { width: LISTING_ICON_WIDTH }), nsfwLevel: icon.nsfwLevel }
    : null;
}
