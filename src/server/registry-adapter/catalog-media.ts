import { NsfwLevel } from '~/server/common/enums';
import type { ListingMediaImage } from '~/server/services/blocks/listing-media-audience';
import {
  gatedListingIconUrl,
  isListingImageVisible,
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
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

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

export type MediaRating = 'pg' | 'pg13' | 'r' | 'x' | 'xxx';

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

const RATING_OF_LEVEL: ReadonlyMap<number, MediaRating> = new Map([
  [NsfwLevel.PG, 'pg'],
  [NsfwLevel.PG13, 'pg13'],
  [NsfwLevel.R, 'r'],
  [NsfwLevel.X, 'x'],
  [NsfwLevel.XXX, 'xxx'],
]);

/**
 * The image's rating, when it passes the store's per-image moderation check at every level
 * (`isListingImageVisible`: scanned, not flagged, not restricted, not Blocked); null otherwise,
 * so the image is never published.
 */
function publishableRating(image: ListingMediaImage | null | undefined): MediaRating | null {
  if (!image?.url || !isListingImageVisible(image, allBrowsingLevelsFlag)) return null;
  return RATING_OF_LEVEL.get(image.nsfwLevel) ?? null;
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
