import { Badge, Button, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { getHighestBrowsingLevelBit } from '@civitai/shared';
import {
  ratingReviewEntityLabels,
  ratingReviewLevelLabel,
  type RatingReviewEntityType,
} from '@civitai/shared/rating-review';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { openRatingReviewModal } from '~/components/Dialog/triggers/rating-review';
import { ownerRatingButtonState } from '~/components/RatingReview/owner-rating-state';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ratingDisputeFeature } from '~/server/schema/rating-review.schema';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

export function OwnerRatingControls({
  entityType,
  entityId,
  isOwner,
}: {
  entityType: RatingReviewEntityType;
  entityId: number;
  isOwner: boolean;
}) {
  const features = useFeatureFlags();
  const enabled = isOwner && !!features[ratingDisputeFeature(entityType)];
  const { data } = trpc.ratingReview.getMine.useQuery(
    { entityType, entityId },
    { enabled, staleTime: 60_000 }
  );
  if (!enabled || !data?.canDispute) return null;

  const { currentLevel, scanReason, staleOverride } = data;
  const state = ownerRatingButtonState(data.review, data.canResubmit);
  const open = (initialSuggestedLevel?: number) =>
    openRatingReviewModal({
      entityType,
      entityId,
      currentLevel,
      scanReason,
      initialSuggestedLevel,
    });

  // A text-only article can derive 0, which has no label and is not a valid suggestion. A bitmask
  // (Post, Bounty, BountyEntry) is offered as its highest level, the one the owner can pick.
  const staleLevel =
    staleOverride?.derivedRatingDroppedBelowOverride &&
    state.kind === 'open' &&
    (staleOverride.derivedLevel ?? 0) >= 1
      ? getHighestBrowsingLevelBit(staleOverride.derivedLevel ?? 0)
      : null;

  let button: ReactNode;
  if (state.kind === 'pending') {
    button = (
      <Tooltip
        label={
          <span>
            Submitted <DaysFromNow date={new Date(state.createdAt)} />
          </span>
        }
        withArrow
      >
        <Button variant="default" size="xs" disabled>
          Dispute pending
        </Button>
      </Tooltip>
    );
  } else if (state.kind === 'resolved') {
    const btn = (
      <Button variant="default" size="xs" disabled>
        Last dispute {state.label}
        {state.resolvedAt ? ` on ${formatDate(new Date(state.resolvedAt))}` : ''}
      </Button>
    );
    button = state.modComment ? (
      <Tooltip label={state.modComment} withArrow multiline w={260}>
        {btn}
      </Tooltip>
    ) : (
      btn
    );
  } else {
    button = (
      <Button variant="default" size="xs" onClick={() => open()}>
        Dispute rating
      </Button>
    );
  }

  return (
    <Stack gap="xs">
      {staleLevel != null && (
        <AlertWithIcon icon={<IconAlertCircle size={20} />} color="yellow" iconColor="yellow">
          <Stack gap="xs">
            <Text size="sm">
              Your recent edits brought this {ratingReviewEntityLabels[entityType].toLowerCase()}
              &apos;s content down to{' '}
              <Text component="span" fw={600}>
                {ratingReviewLevelLabel(entityType, staleLevel)}
              </Text>
              , but a previous moderator decision pinned the rating at{' '}
              <Text component="span" fw={600}>
                {ratingReviewLevelLabel(entityType, currentLevel)}
              </Text>
              . Dispute the rating and our system (or a moderator) will update it.
            </Text>
            <Group>
              <Button size="xs" color="yellow" variant="filled" onClick={() => open(staleLevel)}>
                Dispute rating
              </Button>
            </Group>
          </Stack>
        </AlertWithIcon>
      )}
      <Group gap="xs" align="center">
        <Text size="sm" c="dimmed">
          Rating:
        </Text>
        <Badge size="md" variant="filled" color="gray">
          {ratingReviewLevelLabel(entityType, currentLevel)}
        </Badge>
        {staleLevel != null ? null : button}
      </Group>
      {scanReason && state.kind === 'open' && (
        <Text size="xs" c="dimmed">
          Our text scan said: {scanReason}
        </Text>
      )}
    </Stack>
  );
}
