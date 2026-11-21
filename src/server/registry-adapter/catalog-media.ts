import type { ListingMediaImage } from '~/server/services/blocks/listing-media-audience';
import {
  gatedListingCoverUrl,
  gatedListingIconUrl,
  gatedListingScreenshots,
  listingRatingMediaCeiling,
} from '~/server/services/blocks/listing-media-audience';

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

/**
 * The cover and screenshots a listing entity publishes, under the same rule as
 * {@link registryIconUrl}: the listing's own media, each image gated at the listing's own rating,
 * the cover falling back to the first screenshot that passes. Never the store card's cover.
 */
export function registryListingMedia(row: {
  contentRating: string | null;
  cover: ListingMediaImage | null;
  screenshots: ReadonlyArray<{ caption: string | null; image: ListingMediaImage | null }>;
}): { coverUrl: string | null; screenshots: Array<{ url: string; caption: string | null }> } {
  const ceiling = listingRatingMediaCeiling(row.contentRating);
  return {
    coverUrl: gatedListingCoverUrl(row.cover, row.screenshots, ceiling),
    screenshots: gatedListingScreenshots(row.screenshots, ceiling),
  };
}
