import type { StoreSubListingRow } from '~/server/services/blocks/app-sub-listing-store.service';
import type { ListingMediaImage } from '~/server/services/blocks/listing-media-audience';
import {
  gatedListingIconUrl,
  isListingImageVisible,
  isModerationFlagSet,
  listingRatingMediaCeiling,
} from '~/server/services/blocks/listing-media-audience';
import type { ListingRedMediaImages } from '~/server/services/blocks/listing-media-split.service';
import {
  LISTING_COVER_WIDTH,
  LISTING_SCREENSHOT_WIDTH,
  listingCoverUrl,
  listingIconUrl,
  listingMediaEdgeUrl,
} from '~/server/services/blocks/listing-media-url';
import {
  effectiveSubListingRating,
  subListingExternalHref,
  subListingRunHref,
} from '~/shared/constants/app-sub-listing.constants';
import type { ImageRating } from '~/shared/constants/browsingLevel.constants';
import {
  allBrowsingLevelsFlag,
  imageRatingOfNsfwLevel,
} from '~/shared/constants/browsingLevel.constants';

/**
 * The icon an app entity publishes: the listing's OWN icon, gated per image at the listing's own
 * content rating, or null. The catalog is read with every rating admitted, which on a red-capable
 * host would also lift the media ceiling to every level and prefer the civitai.red icon override;
 * an entity tagged with its listing's rating must carry nothing rated above that tag, so the
 * adapter never uses the store card's icon and never reads the overrides.
 */
export function registryIconUrl(row: {
  contentRating: string | null;
  icon: ListingMediaImage | null;
}): string | null {
  return gatedListingIconUrl(row.icon, listingRatingMediaCeiling(row.contentRating));
}

/** A media item's own rating: the image rating ladder (`IMAGE_RATING_LADDER`), XXX distinct. */
export type MediaRating = ImageRating;

/**
 * One image of a store listing, rated on its own (`store-listing@v1` `media`). The stream carries
 * every image the store could show on any host to any viewer, so the read model can apply the
 * store's per-request ceiling (`listingMediaCeiling`, `projectListingMedia`):
 *   - `host: 'red'` is a civitai.red override (`app_listing_red_media`), shown only on a
 *     red-capable host, preferred there over the own image of its slot and falling back to it;
 *   - `nsfwLevel` / `rating` are the image's own, which the ceiling is compared with;
 *   - a screenshot also carries `coverUrl`, its rendition as the cover fallback.
 * A subscription is sent the items whose own `rating` its audience admits under the app-rating
 * rule (`readableBy`), coarser than the store's ceiling, which the read model applies per request.
 */
export type ListingMediaItem = {
  slot: 'icon' | 'cover' | 'screenshot';
  host: 'any' | 'red';
  url: string;
  nsfwLevel: number;
  rating: MediaRating;
  caption?: string | null;
  coverUrl?: string;
};

/**
 * The image's rating, when it passes the store's per-image moderation check at every level
 * (`isListingImageVisible`: scanned, not flagged, not restricted, not Blocked); null otherwise,
 * so the image is never published.
 */
function publishableRating(image: ListingMediaImage | null | undefined): MediaRating | null {
  if (!image?.url || !isListingImageVisible(image, allBrowsingLevelsFlag)) return null;
  return imageRatingOfNsfwLevel(image.nsfwLevel);
}

/**
 * Every image a listing entity publishes, in the order the store reads them: the own icon, the own
 * cover, the screenshots in stored order, then the civitai.red icon and cover overrides. Unlike
 * {@link registryIconUrl} these are not capped at the listing's rating: each item carries its own
 * rating and is narrowed per subscription. Mirrors what `projectListingMedia` can show.
 */
export function registryListingMedia(row: {
  icon: ListingMediaImage | null;
  cover: ListingMediaImage | null;
  screenshots: ReadonlyArray<{ caption: string | null; image: ListingMediaImage | null }>;
  red: ListingRedMediaImages | null;
}): ListingMediaItem[] {
  const out: ListingMediaItem[] = [];
  const push = (
    image: ListingMediaImage | null | undefined,
    item: (url: string) => Omit<ListingMediaItem, 'nsfwLevel' | 'rating'>
  ) => {
    const rating = publishableRating(image);
    if (image?.url && rating) out.push({ ...item(image.url), nsfwLevel: image.nsfwLevel, rating });
  };
  const icon = (host: 'any' | 'red') => (url: string) => ({
    slot: 'icon' as const,
    host,
    url: listingIconUrl({ url }) as string,
  });
  const cover = (host: 'any' | 'red') => (url: string) => ({
    slot: 'cover' as const,
    host,
    url: listingCoverUrl({ url }, null) as string,
  });
  push(row.icon, icon('any'));
  push(row.cover, cover('any'));
  for (const s of row.screenshots) {
    push(s.image, (url) => ({
      slot: 'screenshot',
      host: 'any',
      url: listingMediaEdgeUrl(url, LISTING_SCREENSHOT_WIDTH),
      caption: s.caption ?? null,
      coverUrl: listingMediaEdgeUrl(url, LISTING_COVER_WIDTH),
    }));
  }
  push(row.red?.icon, icon('red'));
  push(row.red?.cover, cover('red'));
  return out;
}

/**
 * One sub-listing of a store listing (`store-listing@v1` `subListings`): an item the store grid
 * shows as its own card beside its parent (`SubListingCard`, `projectSubListingCard`). Every field
 * is the card's own value, or what the store gates the card on, so the read model needs nothing of
 * the item beyond it:
 *   - `contentRating` is the item's own rating, which the store's mature filter reads
 *     (`subListingMatureFilter`, `s.content_rating`); `cardContentRating` is the card's rating, the
 *     stricter of parent and item (`effectiveSubListingRating`), which the card shows and caps its
 *     images at (`subListingImageCeiling`);
 *   - `runHref` and `external` are the card's link, built here exactly as the card builds it
 *     (`subListingRunHref` under the parent's run route, `subListingExternalHref` from an off-site
 *     parent's link template);
 *   - `sortTime` is the item's `newest` key (`COALESCE(approved_at, created_at)`);
 *   - `image` is the item's own image at cover width, rated on its own, only when it is in a public
 *     post and passes the store's per-image moderation check at every level (as a listing's media
 *     items); the read model gates it per request, and falls back to the parent's own cover.
 * The parent's cover and icon fallbacks are the listing's own `media` items (host `any`).
 */
export type ListingSubListingItem = {
  id: string;
  title: string;
  tagline: string | null;
  contentRating: string | null;
  cardContentRating: string | null;
  author: { id: number; username: string | null; image: string | null };
  sortTime: string;
  runHref: string;
  external: boolean;
  image: { url: string; nsfwLevel: number; rating: MediaRating } | null;
};

/**
 * The most sub-listing items one listing's body carries. A listing has no cap of its own on its
 * items (only `maxPerAuthor`), and the store grid pages through all of them, so its page size bounds
 * nothing here. The bound is the registry stream: a body travels as one stream line, and
 * app-index-go's registry client reads lines of at most 1 MiB (`MaxLine`, `internal/registry`); a
 * longer line ends the stream `unavailable` and replays it from the same cursor forever.
 *
 * Measured from the item's bounds (`APP_SUB_LISTING_*_MAX`, the link template's 300, the id, the
 * URLs): one item is about 0.6 KB of JSON with short ASCII text and at most about 1.9 KB (a title
 * and tagline at their bounds in three-byte characters, a 300-character link template, long avatar
 * and image URLs). 200 items are then at most about 0.36 MiB (pinned by `listing-stream.test.ts`),
 * which leaves more than half of the line for the rest of the body and the event around it.
 */
export const MAX_STREAM_SUB_LISTINGS = 200;

/**
 * `items` (in id order) capped at `max`: the most recently approved are kept (the `newest` order,
 * `sortTime` then id, both descending), the rest left out and counted, so the same catalog always
 * keeps the same items. The kept items stay in id order.
 */
export function capSubListings(
  items: readonly ListingSubListingItem[],
  max: number = MAX_STREAM_SUB_LISTINGS
): { items: ListingSubListingItem[]; omitted: number } {
  if (items.length <= max) return { items: [...items], omitted: 0 };
  const newest = [...items].sort((a, b) =>
    a.sortTime !== b.sortTime ? (a.sortTime < b.sortTime ? 1 : -1) : a.id < b.id ? 1 : -1
  );
  const kept = new Set(newest.slice(0, max).map((item) => item.id));
  return {
    items: items.filter((item) => kept.has(item.id)),
    omitted: items.length - kept.size,
  };
}

/**
 * The stream item of one sub-listing row (`readStoreSubListingsOfParents`), or null when the card
 * would have nowhere valid to link to, which `projectSubListingCard` drops too.
 */
export function registrySubListing(row: StoreSubListingRow): ListingSubListingItem | null {
  const externalHref =
    row.parent_kind === 'offsite'
      ? subListingExternalHref(row.parent_link_template, row.sub_path)
      : null;
  if (row.parent_kind === 'offsite' && !externalHref) return null;
  let image: ListingSubListingItem['image'] = null;
  if (row.image_url && row.image_ingestion != null && row.image_public) {
    const rating = publishableRating({
      url: row.image_url,
      ingestion: row.image_ingestion,
      nsfwLevel: row.image_nsfw_level ?? 0,
      needsReview: row.image_needs_review,
      poi: isModerationFlagSet(row.image_poi),
      minor: isModerationFlagSet(row.image_minor),
      tosViolation: isModerationFlagSet(row.image_tos_violation),
      acceptableMinor: isModerationFlagSet(row.image_acceptable_minor),
      blockedFor: row.image_blocked_for,
      modelRestricted: row.image_model_restricted !== false,
    });
    if (rating) {
      image = {
        url: listingMediaEdgeUrl(row.image_url, LISTING_COVER_WIDTH),
        nsfwLevel: row.image_nsfw_level ?? 0,
        rating,
      };
    }
  }
  return {
    id: row.id,
    title: row.title,
    tagline: row.tagline,
    contentRating: row.content_rating,
    cardContentRating: effectiveSubListingRating(row.parent_content_rating, row.content_rating),
    author: {
      id: row.author_user_id,
      username: row.author_username,
      image: row.author_image,
    },
    sortTime: row.sort_time,
    runHref: externalHref ?? subListingRunHref(row.parent_slug, row.sub_path, row.id),
    external: externalHref !== null,
    image,
  };
}
