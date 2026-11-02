import { List, Stack, Text } from '@mantine/core';
import {
  creatorScoreGrowsWhen,
  creatorScorePenalty,
  creatorScoreSources,
} from '~/components/Account/creator-score-copy';
import { REMOVAL_SCORE_WINDOW_LABEL } from '~/shared/constants/creator-journey.constants';

export function CreatorScoreExplainer() {
  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        How Creator Score works
      </Text>
      <Text size="sm" c="dimmed">
        Your Creator Score measures how much the community values what you share. It grows when{' '}
        {creatorScoreGrowsWhen}.
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
      <Text size="sm">
        {creatorScorePenalty} If people unfollow you or remove a reaction, those points go too.
      </Text>
      <Text size="xs" c="dimmed">
        {`Your score updates once a day, so today's activity shows up tomorrow. A removed image stops counting against you after ${REMOVAL_SCORE_WINDOW_LABEL}, and some count for less depending on why they were removed. The rest of your score never resets or expires.`}
      </Text>
    </Stack>
  );
}
