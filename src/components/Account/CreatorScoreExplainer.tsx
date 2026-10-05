import { Anchor, List, Stack, Text } from '@mantine/core';
import { NextLink } from '~/components/NextLink/NextLink';

export const CREATOR_SCORE_ANCHOR = 'creator-score';
export const CREATOR_SCORE_EXPLAINER_HREF = `/user/account#${CREATOR_SCORE_ANCHOR}`;

// Categories and activities only: no weights, no numbers, and no "counts more" ordering.
// Weights are tunable config and may change; anything stated here would go stale with them.
export const creatorScoreSources = {
  models: {
    label: 'Models',
    earnedBy: 'Downloads, generations, and positive reviews of published models',
  },
  images: { label: 'Images', earnedBy: 'Reactions and comments on images' },
  articles: { label: 'Articles', earnedBy: 'Views, reactions, and comments on articles' },
  users: { label: 'Followers', earnedBy: 'Follower count' },
  reportsActioned: {
    label: 'Helping moderation',
    earnedBy: 'Reports filed that moderators act on',
  },
} as const;

export const creatorScorePenalty = 'Content removed for breaking our rules takes points away.';

export function CreatorScoreExplainer({ journeyHref }: { journeyHref?: string }) {
  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        How Creator Score works
      </Text>
      <Text size="sm" c="dimmed">
        Your Creator Score measures how much the community values what you share. It grows when
        people use, react to, and follow your work.
      </Text>
      <List size="sm" spacing={4}>
        {Object.values(creatorScoreSources).map(({ label, earnedBy }) => (
          <List.Item key={label}>
            <Text span size="sm" fw={600}>
              {label}:
            </Text>{' '}
            {earnedBy}
          </List.Item>
        ))}
      </List>
      <Text size="sm" c="red">
        {creatorScorePenalty}
      </Text>
      <Text size="xs" c="dimmed">
        Your score updates once a day, so today&apos;s activity shows up tomorrow. It never resets
        or expires.
      </Text>
      {journeyHref && (
        <Anchor component={NextLink} href={journeyHref} size="sm">
          See your creator journey
        </Anchor>
      )}
    </Stack>
  );
}
