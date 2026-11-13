import type { ListingMediaImage } from '~/server/services/blocks/listing-media-audience';
import {
  gatedListingIconUrl,
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
