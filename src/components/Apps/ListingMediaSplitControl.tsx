import { Badge, Group, Radio, Stack, Text } from '@mantine/core';
import { offsiteContentRatingLabel } from '~/shared/constants/browsingLevel.constants';
import {
  LISTING_ASSET_AUDIENCE_LABEL,
  listingAssetAudience,
  summarizeListingMediaSplit,
  type ListingMediaSplitDecision,
} from '~/shared/utils/listing-media-split';
import {
  listingRatingAssetLabel,
  listingRatingAssetsFromView,
  MATURE_STORE_HOST,
  SFW_STORE_HOST,
  type ListingAssetLevels,
  type ListingRatingDisplayAsset,
} from '~/shared/utils/listing-rating-display';
import { trpc } from '~/utils/trpc';

/**
 * The moderator's go-live choice for a listing whose media is partly above SFW: rate the listing
 * by all of its media (the default, and what an approve without a choice does), or split it — a
 * SFW listing on civitai.com whose mature media shows only on civitai.red. Renders nothing when
 * the choice would change nothing, unless the listing is already split.
 */
export function ListingMediaSplitControl({
  assets,
  currentlySplit,
  value,
  onChange,
  disabled,
}: {
  assets: ListingRatingDisplayAsset[];
  currentlySplit: boolean;
  value: ListingMediaSplitDecision;
  onChange: (value: ListingMediaSplitDecision) => void;
  disabled?: boolean;
}) {
  const summary = summarizeListingMediaSplit(assets);
  if (!summary.splitChangesFloor && !currentlySplit) return null;
  const projected = value === 'split' ? summary.comMediaRating : summary.allMediaRating;

  return (
    <Stack gap={6} data-testid="apps-media-split">
      <Text size="sm" fw={600}>
        civitai.com / civitai.red media
      </Text>
      <Group gap="md">
        <Text size="xs" data-testid="apps-media-split-all-rating">
          Rating with all media: <b>{offsiteContentRatingLabel(summary.allMediaRating)}</b>
        </Text>
        <Text size="xs" data-testid="apps-media-split-com-rating">
          Rating with {SFW_STORE_HOST} media only:{' '}
          <b>{offsiteContentRatingLabel(summary.comMediaRating)}</b>
        </Text>
      </Group>
      {currentlySplit && (
        <Text size="xs" c="dimmed" data-testid="apps-media-split-current">
          This listing is currently split. Approving without choosing the split again ends it.
        </Text>
      )}
      <Radio.Group
        value={value}
        onChange={(v) => onChange(v as ListingMediaSplitDecision)}
        data-testid="apps-media-split-choice"
      >
        <Stack gap={4}>
          <Radio
            value="rate-mature"
            disabled={disabled}
            label={`Rate by all media (${offsiteContentRatingLabel(summary.allMediaRating)})`}
            data-testid="apps-media-split-rate-mature"
          />
          <Radio
            value="split"
            disabled={disabled || !summary.faceEligible}
            label={`Split: list on ${SFW_STORE_HOST} as ${offsiteContentRatingLabel(
              summary.comMediaRating
            )}; images above that show only on ${MATURE_STORE_HOST}`}
            description={
              summary.faceEligible
                ? undefined
                : `Unavailable: the icon or cover is rated above PG-13, so ${SFW_STORE_HOST} would show a placeholder.`
            }
            data-testid="apps-media-split-split"
          />
        </Stack>
      </Radio.Group>
      <Stack gap={2} data-testid="apps-media-split-audiences">
        {assets.map((asset, i) => {
          const audience = listingAssetAudience(asset.nsfwLevel, projected);
          return (
            <Group key={`${asset.kind}-${asset.position ?? i}`} gap={6}>
              <Text size="xs">{listingRatingAssetLabel(asset)}</Text>
              <Badge
                size="xs"
                variant="light"
                color={audience === 'red-only' ? 'red' : audience === 'unrated' ? 'gray' : 'blue'}
                data-testid={`apps-media-split-audience-${asset.kind}-${asset.position ?? 0}`}
              >
                {LISTING_ASSET_AUDIENCE_LABEL[audience]}
              </Badge>
            </Group>
          );
        })}
      </Stack>
    </Stack>
  );
}

/** {@link ListingMediaSplitControl} for a listing read by id (the on-site approve bar). */
export function ListingMediaSplitControlForListing({
  listingId,
  value,
  onChange,
  disabled,
}: {
  listingId: string;
  value: ListingMediaSplitDecision;
  onChange: (value: ListingMediaSplitDecision) => void;
  disabled?: boolean;
}) {
  const { data } = trpc.appListings.getAssets.useQuery(
    { listingId },
    { staleTime: 0, refetchOnMount: 'always', retry: false }
  );
  if (!data) return null;
  return (
    <ListingMediaSplitControl
      assets={listingRatingAssetsFromView(data as Partial<ListingAssetLevels>)}
      currentlySplit={data.mediaSplitApproved}
      value={value}
      onChange={onChange}
      disabled={disabled}
    />
  );
}
