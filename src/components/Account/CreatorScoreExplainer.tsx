import { List, Stack, Text } from '@mantine/core';
import { creatorScorePenalty, creatorScoreSources } from '~/components/Account/creator-score-copy';

export function CreatorScoreExplainer() {
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
      <Text size="sm">{creatorScorePenalty}</Text>
      <Text size="xs" c="dimmed">
        Your score updates once a day, so today&apos;s activity shows up tomorrow. It never resets
        or expires.
      </Text>
    </Stack>
  );
}
