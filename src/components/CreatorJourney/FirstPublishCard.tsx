import { Anchor, Card, Group, Stack, Text } from '@mantine/core';
import { IconConfetti } from '@tabler/icons-react';
import { FEATURE_NOTICES } from '~/components/Alerts/notice-registry';
import { useFeatureNotice } from '~/components/Alerts/useFeatureNotice';
import { creatorScoreActivities } from '~/components/Account/creator-score-copy';
import { NextLink } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  CREATOR_JOURNEY_HREF,
  FIRST_PUBLISH_CARD_DAYS,
} from '~/shared/constants/creator-journey.constants';
import { creatorAggregateScoreFromMeta, creatorScoreFromMeta } from '~/shared/utils/creator-score';
import type { CreatorScoreTier, CreatorScoreUnlock } from '~/shared/utils/creator-score-unlocks';
import {
  buildCreatorScoreLadder,
  currentCreatorScoreTier,
  describeCreatorScoreUnlocks,
  nextCreatorScoreRung,
  pendingCreatorScoreUnlocks,
} from '~/shared/utils/creator-score-unlocks';
import { numberWithCommas } from '~/utils/number-helpers';
import { capitalize } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

type Entity = 'model' | 'article';

const countsToward = (activities: string) =>
  `${capitalize(activities)} on it now count toward your Creator Score.`;

const copy: Record<Entity, { title: string; counts: string }> = {
  model: {
    title: 'Your first model is live',
    counts: countsToward(creatorScoreActivities.models),
  },
  article: {
    title: 'Your first article is live',
    counts: countsToward(creatorScoreActivities.articles),
  },
};

const notices = {
  model: FEATURE_NOTICES.firstModelPublished,
  article: FEATURE_NOTICES.firstArticlePublished,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export function FirstPublishCard({
  entityType,
  entityId,
  ownerId,
  publishedAt,
}: {
  entityType: Entity;
  entityId: number;
  ownerId: number | undefined;
  publishedAt: Date | string | null | undefined;
}) {
  const currentUser = useCurrentUser();
  const isOwner = !!currentUser && ownerId != null && currentUser.id === ownerId;
  // Without the window the card is never dismissed for anyone it never shows to, so the query would
  // run on every owner view of every page they own.
  const isRecent =
    !!publishedAt &&
    Date.now() - new Date(publishedAt).getTime() < FIRST_PUBLISH_CARD_DAYS * DAY_MS;
  const { isDismissed, hasSettings, isInAudience, dismiss } = useFeatureNotice(
    notices[entityType],
    { enabled: isOwner && isRecent }
  );
  const enabled = isOwner && isRecent && hasSettings && !isDismissed && isInAudience;

  const { data } = trpc.creatorJourney.getFirstPublishCard.useQuery(
    { entityType, id: entityId },
    { enabled, staleTime: Infinity }
  );
  const { data: ladder } = trpc.creatorJourney.getLadder.useQuery(undefined, {
    enabled: enabled && !!data?.show,
    staleTime: Infinity,
  });

  if (!enabled || !data?.show || !ladder) return null;

  return (
    <FirstPublishCardView
      entityType={entityType}
      total={creatorScoreFromMeta(currentUser?.meta)}
      aggregate={creatorAggregateScoreFromMeta(currentUser?.meta)}
      ladder={ladder}
      onClose={dismiss}
    />
  );
}

export function FirstPublishCardView({
  entityType,
  total,
  aggregate,
  ladder,
  onClose,
}: {
  entityType: Entity;
  total: number;
  aggregate?: number;
  ladder: { unlocks: CreatorScoreUnlock[]; tiers: CreatorScoreTier[] };
  onClose: () => void;
}) {
  const rungs = buildCreatorScoreLadder(ladder.unlocks, ladder.tiers);
  const next = nextCreatorScoreRung(rungs, total);
  const pending = next ? pendingCreatorScoreUnlocks(next, { total, aggregate }) : [];
  const { title, counts } = copy[entityType];

  return (
    <Card withBorder p="sm">
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <IconConfetti size={20} className="mt-0.5 shrink-0 text-yellow-6" />
        <Stack gap={2} className="min-w-0 flex-1">
          <Text fw={600} size="sm">
            {title}
          </Text>
          <Text size="sm" c="dimmed">
            {counts}
            {next && (next.tier || pending.length > 0) && (
              <>
                {' '}
                Your {currentCreatorScoreTier(rungs, total) ? 'next' : 'first'} goal is{' '}
                {next.tier ? `${next.tier.name} at ` : 'a score of '}
                {numberWithCommas(next.minScore)}
                {pending.length > 0 && <>, which unlocks: {describeCreatorScoreUnlocks(pending)}</>}
                .
              </>
            )}
          </Text>
          <Text size="sm">
            <Anchor component={NextLink} href={CREATOR_JOURNEY_HREF} inherit>
              See your journey
            </Anchor>{' '}
            ·{' '}
            <Anchor component="button" type="button" inherit onClick={onClose}>
              Close
            </Anchor>
          </Text>
        </Stack>
      </Group>
    </Card>
  );
}
