import { Badge } from '@mantine/core';
import {
  LISTING_ASSET_AUDIENCE_LABEL,
  listingDisplayAssetAudience,
  type ListingAssetAudience,
} from '~/shared/utils/listing-media-split';
import type { ListingRatingDisplayAsset } from '~/shared/utils/listing-rating-display';

/** Badge colour per audience: civitai.red only is the one a moderator must notice. */
const AUDIENCE_COLOR: Record<ListingAssetAudience, string> = {
  'com-and-red': 'blue',
  'red-only': 'red',
  unrated: 'gray',
};

/**
 * Where one listing image shows (`listingDisplayAssetAudience`), as a badge — the one spelling
 * shared by the split control's per-image list and the review media tiles. A civitai.red icon /
 * cover override (`redSlot`) reads civitai.red only whatever its level.
 */
export function ListingAudienceBadge({
  asset,
  rating,
  testId,
}: {
  asset: Pick<ListingRatingDisplayAsset, 'nsfwLevel' | 'redSlot'>;
  /** The listing rating the image is judged against. */
  rating: string | null | undefined;
  testId: string;
}) {
  const audience = listingDisplayAssetAudience(asset, rating);
  return (
    <Badge size="xs" variant="light" color={AUDIENCE_COLOR[audience]} data-testid={testId}>
      {LISTING_ASSET_AUDIENCE_LABEL[audience]}
    </Badge>
  );
}
