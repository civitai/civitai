import { Badge, Group, Radio, Stack, Text } from '@mantine/core';
import { offsiteContentRatingLabel } from '~/shared/constants/browsingLevel.constants';
import {
  LISTING_ASSET_AUDIENCE_LABEL,
  listingAssetAudience,
  resolveListingMediaSplitDecision,
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
import { useEffect } from 'react';
import { trpc } from '~/utils/trpc';

/**
 * The moderator's go-live choice for a listing whose media is partly above SFW: rate the listing
 * by all of its media, or split it — a SFW listing on civitai.com whose mature media shows only on
 * civitai.red. `value` is the resolved decision (`resolveListingMediaSplitDecision`); renders
 * nothing when that resolution says the choice is not shown.
 *
 * `appliesRating: false` is for an approve that records the decision but does not rate the
 * listing (an on-site media revision keeps the app's rating). The control then shows no projected
 * rating or per-image audience — the server applies none — and says the choice takes effect only
 * when the listing is next re-rated.
 */
export function ListingMediaSplitControl({
  assets,
  currentlySplit,
  value,
  onChange,
  disabled,
  appliesRating = true,
}: {
  assets: ListingRatingDisplayAsset[];
  currentlySplit: boolean;
  value: ListingMediaSplitDecision;
  onChange: (value: ListingMediaSplitDecision) => void;
  disabled?: boolean;
  appliesRating?: boolean;
}) {
  const summary = summarizeListingMediaSplit(assets);
  if (!resolveListingMediaSplitDecision({ assets, currentlySplit, choice: value }).shown)
    return null;
  const projected = value === 'split' ? summary.comMediaRating : summary.allMediaRating;

  return (
    <Stack gap={6} data-testid="apps-media-split">
      <Text size="sm" fw={600}>
        civitai.com / civitai.red media
      </Text>
      {appliesRating ? (
        <Group gap="md">
          <Text size="xs" data-testid="apps-media-split-all-rating">
            Rating with all media: <b>{offsiteContentRatingLabel(summary.allMediaRating)}</b>
          </Text>
          <Text size="xs" data-testid="apps-media-split-com-rating">
            Rating with {SFW_STORE_HOST} media only:{' '}
            <b>{offsiteContentRatingLabel(summary.comMediaRating)}</b>
          </Text>
        </Group>
      ) : (
        <Text size="xs" c="dimmed" data-testid="apps-media-split-later">
          Approving this revision keeps the app’s current rating — neither choice changes it now.
          The choice is recorded on the listing and decides which images its rating is floored by
          the next time it is re-rated (for example when a moderator re-rates one of its images).
        </Text>
      )}
      {currentlySplit && (
        <Text size="xs" c="dimmed" data-testid="apps-media-split-current">
          This listing is currently split. Choosing “Rate by all media” ends the split.
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
            label={
              appliesRating
                ? `Rate by all media (${offsiteContentRatingLabel(summary.allMediaRating)})`
                : 'Rate by all media'
            }
            data-testid="apps-media-split-rate-mature"
          />
          <Radio
            value="split"
            disabled={disabled || !summary.faceEligible}
            label={
              appliesRating
                ? `Split: list on ${SFW_STORE_HOST} as ${offsiteContentRatingLabel(
                    summary.comMediaRating
                  )}; images above that show only on ${MATURE_STORE_HOST}`
                : `Split: floor the rating by the ${SFW_STORE_HOST}-safe images only`
            }
            description={
              summary.faceEligible
                ? undefined
                : `Unavailable: the icon or cover is rated above ${offsiteContentRatingLabel(
                    'pg13'
                  )}, so ${SFW_STORE_HOST} would show a placeholder.`
            }
            data-testid="apps-media-split-split"
          />
        </Stack>
      </Radio.Group>
      {appliesRating && (
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
      )}
    </Stack>
  );
}

/**
 * {@link ListingMediaSplitControl} for a listing read by id (the on-site approve bar). Reports the
 * resolved decision through `onResolved`, since the default depends on the listing it reads, and
 * `null` until it has read it.
 */
export function ListingMediaSplitControlForListing({
  listingId,
  choice,
  onChoice,
  onResolved,
  disabled,
}: {
  listingId: string;
  choice: ListingMediaSplitDecision | null;
  onChoice: (value: ListingMediaSplitDecision) => void;
  /** `null` while the listing has not loaded (or failed to). */
  onResolved: (value: ListingMediaSplitDecision | null) => void;
  disabled?: boolean;
}) {
  const { data } = trpc.appListings.getAssets.useQuery(
    { listingId },
    { staleTime: 0, refetchOnMount: 'always', retry: false }
  );
  const assets = data ? listingRatingAssetsFromView(data as Partial<ListingAssetLevels>) : [];
  const currentlySplit = data?.mediaSplitApproved ?? false;
  const resolved = resolveListingMediaSplitDecision({ assets, currentlySplit, choice });
  const reported = data ? resolved.value : null;
  useEffect(() => onResolved(reported), [reported, onResolved]);
  if (!data) return null;
  return (
    <ListingMediaSplitControl
      assets={assets}
      currentlySplit={currentlySplit}
      value={resolved.value}
      onChange={onChoice}
      disabled={disabled}
    />
  );
}
