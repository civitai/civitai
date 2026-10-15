import { ColorSwatch, Group, Progress, Stack, Text, Tooltip } from '@mantine/core';
import { scoreCategories } from '~/components/Account/UserScoreDisplay';
import type { CreatorScoreSplit } from '~/shared/utils/creator-score';

/** Shares only: the points must never reach the client. */
export function ScoreSplitBar({ split }: { split: CreatorScoreSplit }) {
  const shown = scoreCategories.filter(({ key }) => split[key] > 0);
  if (!shown.length) return null;

  return (
    <Stack gap="xs" data-testid="score-split">
      <Text size="xs" tt="uppercase" fw={700} c="dimmed" className="tracking-wider">
        Where this Creator Score comes from
      </Text>
      <Progress.Root size="lg" radius="xl" aria-hidden>
        {shown.map(({ key, color, label }) => (
          <Tooltip key={key} label={`${label}: ${split[key]}%`} withArrow>
            {/* Keeps a 1% share a visible sliver past the rounded end. */}
            <Progress.Section value={split[key]} color={color} style={{ minWidth: 12 }} />
          </Tooltip>
        ))}
      </Progress.Root>
      <Group gap="md" wrap="wrap">
        {shown.map(({ key, color, label, tooltip }) => (
          <Group key={key} gap={6} wrap="nowrap">
            <Tooltip label={tooltip} multiline w={220} withArrow>
              <ColorSwatch
                color={`var(--mantine-color-${color}-6)`}
                size={10}
                radius="xl"
                style={{ cursor: 'help' }}
              />
            </Tooltip>
            <Text size="sm">
              {label}{' '}
              <Text span size="sm" c="dimmed" className="tabular-nums">
                {split[key]}%
              </Text>
            </Text>
          </Group>
        ))}
      </Group>
    </Stack>
  );
}
