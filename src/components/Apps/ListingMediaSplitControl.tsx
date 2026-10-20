import { Group, Radio, Stack, Text } from '@mantine/core';
import { offsiteContentRatingLabel } from '~/shared/constants/browsingLevel.constants';
import { ListingAudienceBadge } from '~/components/Apps/ListingAudienceBadge';
import {
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
 * Shown in place of the choice when the server reports the split as unreadable
 * (`mediaSplitApproved: null`): the app cannot read the record on this environment. Approve stays
 * available and sends NO split decision. The server then writes nothing to the record and reads
 * the listing as unsplit, so the approve leaves it with a rating covering all of its media, as before
 * the split existed; a split stamped earlier stays in the record but is not applied. Any explicit decision would be
 * refused, so none is offered.
 */
export const MEDIA_SPLIT_UNREADABLE_COPY =
  'This environment cannot read whether this listing’s media is split between civitai.com and civitai.red. Approving approves the listing with its rating covering all of its media, as before media splits existed. Any split recorded earlier is kept on file but not applied while this environment cannot read it. Split choices are unavailable until the database grant for the media-split record is fixed.';

/**
 * {@link MEDIA_SPLIT_UNREADABLE_COPY} for an on-site media revision, whose approve is assets-only
 * and does not rewrite the rating: the listing reads as unsplit, so its next re-rate floors the
 * rating by all of its media.
 */
export const MEDIA_SPLIT_UNREADABLE_REVISION_COPY =
  'This environment cannot read whether this listing’s media is split between civitai.com and civitai.red. Approving this revision keeps the app’s current rating and records no split decision. Any split recorded earlier is kept on file but not applied while this environment cannot read it, so the next time the listing is re-rated its rating is floored by all of its media. Split choices are unavailable until the database grant for the media-split record is fixed.';

/**
 * Reported by {@link ListingMediaSplitControlForListing} when the listing has loaded but its split
 * cannot be read: approve may proceed, sending no split decision.
 */
export const MEDIA_SPLIT_NO_DECISION = 'no-decision' as const;
export type ListingMediaSplitResolution =
  | ListingMediaSplitDecision
  | typeof MEDIA_SPLIT_NO_DECISION;

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
          {assets.map((asset, i) => (
            <Group key={`${asset.kind}-${asset.position ?? i}`} gap={6}>
              <Text size="xs">{listingRatingAssetLabel(asset)}</Text>
              <ListingAudienceBadge
                asset={asset}
                rating={projected}
                testId={`apps-media-split-audience-${asset.kind}-${asset.position ?? 0}`}
              />
            </Group>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * {@link ListingMediaSplitControl} for a listing read by id (the on-site approve bar). Reports the
 * resolved decision through `onResolved`, since the default depends on the listing it reads:
 * `null` until it has read it (approve held), {@link MEDIA_SPLIT_NO_DECISION} when it has but the
 * split cannot be read (approve proceeds without a decision).
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
  /**
   * `null` while the listing has not loaded (or failed to); {@link MEDIA_SPLIT_NO_DECISION} when it
   * has but its split cannot be read.
   */
  onResolved: (value: ListingMediaSplitResolution | null) => void;
  disabled?: boolean;
}) {
  const { data } = trpc.appListings.getAssets.useQuery(
    { listingId },
    { staleTime: 0, refetchOnMount: 'always', retry: false }
  );
  const assets = data ? listingRatingAssetsFromView(data as Partial<ListingAssetLevels>) : [];
  const currentlySplit = data?.mediaSplitApproved === true;
  // A `null` split is unreadable on this environment: approve proceeds, sending no decision.
  const unreadable = data?.mediaSplitApproved === null;
  const resolved = resolveListingMediaSplitDecision({ assets, currentlySplit, choice });
  const reported: ListingMediaSplitResolution | null = !data
    ? null
    : unreadable
    ? MEDIA_SPLIT_NO_DECISION
    : resolved.value;
  useEffect(() => onResolved(reported), [reported, onResolved]);
  if (!data) return null;
  if (unreadable)
    return (
      <Text size="xs" c="dimmed" data-testid="apps-media-split-unreadable">
        {MEDIA_SPLIT_UNREADABLE_COPY}
      </Text>
    );
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
