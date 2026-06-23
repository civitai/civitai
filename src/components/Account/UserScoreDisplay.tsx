import { ColorSwatch, Divider, Group, Paper, Progress, Stack, Text, Tooltip } from '@mantine/core';
import { IconFlag, IconInfoCircle, IconShieldCheck } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { abbreviateNumber } from '~/utils/number-helpers';

type Scores = {
  total?: number;
  models?: number;
  images?: number;
  articles?: number;
  users?: number;
  reportsActioned?: number;
  reportsAgainst?: number;
};

const scoreCategories = [
  {
    key: 'models' as const,
    label: 'Models',
    color: 'blue',
    tooltip: 'Based on reviews, downloads, and generations across published models',
  },
  {
    key: 'images' as const,
    label: 'Images',
    color: 'teal',
    tooltip: 'Based on reactions and comments images receive',
  },
  {
    key: 'articles' as const,
    label: 'Articles',
    color: 'orange',
    tooltip: 'Based on views, comments, and reactions on articles',
  },
  {
    key: 'users' as const,
    label: 'Users',
    color: 'grape',
    tooltip: 'Based on follower count',
  },
];

const reportCategories = [
  {
    key: 'reportsAgainst' as const,
    label: 'Against',
    color: 'red',
    icon: IconFlag,
    tooltip: 'Points deducted for content this user posted that was removed for Terms of Service violations',
  },
  {
    key: 'reportsActioned' as const,
    label: 'Actioned',
    color: 'green',
    icon: IconShieldCheck,
    tooltip: 'Points earned for reports this user filed that moderators actioned',
  },
];

export function UserScoreDisplay({
  scores,
  showReports = false,
}: {
  scores: Scores | null | undefined;
  showReports?: boolean;
}) {
  if (!scores) {
    return (
      <Paper withBorder p="md" radius="md">
        <Text size="sm" c="dimmed" ta="center">
          Score not yet available
        </Text>
      </Paper>
    );
  }

  // Only positive contributions compose the bar; each segment is that category's
  // share of the combined positive score pool, so the sections fill to 100%.
  const categoryValues = scoreCategories.map(({ key }) => Math.max(scores[key] ?? 0, 0));
  const categoryPool = categoryValues.reduce((sum, value) => sum + value, 0);

  // `total` can be negative: reportsAgainst is stored as points (violations × a
  // negative multiplier) and can outweigh the positive categories. That value is
  // what pulls the score below zero, so it's the thing the user needs to see.
  const total = scores.total ?? 0;
  const reportsAgainstScore = scores.reportsAgainst ?? 0;

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="md">
        <Stack gap={4} align="center">
          <Tooltip label={`${Math.round(total).toLocaleString()} points`} withArrow>
            <Text
              size="2rem"
              fw={700}
              c={total < 0 ? 'red' : 'green'}
              lh={1.2}
              style={{ cursor: 'help' }}
            >
              {abbreviateNumber(total, { decimals: 1 })}
            </Text>
          </Tooltip>
          <Text size="sm" c="dimmed">
            Creator Score
          </Text>
          {/* Spell out that this is a reputation axis (content earned minus content
              removed), distinct from the strike-based Account Standing badge above —
              the two can legitimately disagree (negative score, no active strikes). */}
          <Text size="xs" c="dimmed" ta="center" maw={260}>
            Reputation from your content, minus content removed for violations
          </Text>
        </Stack>

        <Divider />

        <Stack gap="sm">
          {categoryPool > 0 ? (
            <>
              {/* Section hover → the category amount + share. */}
              <Progress.Root size="xl" radius="xl">
                {scoreCategories.map(({ key, label, color }, index) => {
                  const value = categoryValues[index];
                  if (value <= 0) return null;
                  const percentage = (value / categoryPool) * 100;
                  return (
                    <Tooltip
                      key={key}
                      label={`${label}: ${Math.round(value).toLocaleString()} (${formatPercentage(
                        value,
                        percentage
                      )})`}
                      withArrow
                    >
                      {/* minWidth keeps a real-but-tiny category (e.g. <1%) a visible sliver;
                          must clear the radius="xl" rounded corner (~8-10px) to show. */}
                      <Progress.Section value={percentage} color={color} style={{ minWidth: 12 }} />
                    </Tooltip>
                  );
                })}
              </Progress.Root>

              {/* macOS-storage-style legend: dot + label, dot hover → description. Only
                  categories the user actually has (value > 0) appear, matching the bar —
                  no orphan dot for a category with no segment. */}
              <Group gap="md" wrap="wrap">
                {scoreCategories.map(({ key, label, color, tooltip }, index) => {
                  if (categoryValues[index] <= 0) return null;
                  return (
                    <Group key={key} gap={6} wrap="nowrap">
                      <Tooltip label={tooltip} multiline w={220} withArrow>
                        <ColorSwatch
                          color={`var(--mantine-color-${color}-6)`}
                          size={10}
                          radius="xl"
                          style={{ cursor: 'help' }}
                        />
                      </Tooltip>
                      <Text size="sm">{label}</Text>
                    </Group>
                  );
                })}
              </Group>
            </>
          ) : (
            <Text size="sm" c="dimmed" ta="center">
              No positive score contributions yet
            </Text>
          )}
        </Stack>

        {/* Non-moderators don't get the full Reports block, but a negative score
            still needs a cause — surface the deduction as a distinct tinted penalty
            callout (not a plain list row) so it reads as the thing pulling the score
            down rather than another contributing category. */}
        {!showReports && reportsAgainstScore < 0 && (
          <Group
            justify="space-between"
            wrap="nowrap"
            gap="sm"
            px="sm"
            py={8}
            style={{
              backgroundColor: 'var(--mantine-color-red-light)',
              borderRadius: 'var(--mantine-radius-md)',
            }}
          >
            <Group gap={8} wrap="nowrap">
              <IconFlag size={16} color="var(--mantine-color-red-6)" style={{ flexShrink: 0 }} />
              <Text size="sm">Reports against</Text>
              <Tooltip
                label="Content you posted that was reported and removed for Terms of Service violations reduces your score."
                multiline
                w={240}
                withArrow
              >
                <IconInfoCircle
                  size={14}
                  style={{ flexShrink: 0, cursor: 'help' }}
                  color="var(--mantine-color-dimmed)"
                />
              </Tooltip>
            </Group>
            {/* Abbreviated to match the headline's scale; exact value in the tooltip. */}
            <Tooltip label={`${Math.round(reportsAgainstScore).toLocaleString()} points`} withArrow>
              <Text size="sm" fw={700} c="red" style={{ whiteSpace: 'nowrap', cursor: 'help' }}>
                {abbreviateNumber(reportsAgainstScore, { decimals: 1 })} pts
              </Text>
            </Tooltip>
          </Group>
        )}

        {showReports && (
          <>
            <Divider label="Reports" labelPosition="left" />
            <Stack gap="sm">
              {reportCategories.map(({ key, label, color, icon: Icon, tooltip }) => {
                const value = scores[key] ?? 0;
                return (
                  <ScoreRow key={key} icon={<Icon size={16} />} label={label} tooltip={tooltip}>
                    <Text size="sm" fw={600} c={color}>
                      {Math.round(value).toLocaleString()} pts
                    </Text>
                  </ScoreRow>
                );
              })}
            </Stack>
          </>
        )}
      </Stack>
    </Paper>
  );
}

// A real (non-zero) category whose share rounds to 0% shows "<1%" instead, so a
// tiny-but-present category never reads as zero.
function formatPercentage(value: number, percentage: number) {
  if (value > 0 && percentage < 1) return '<1%';
  return `${Math.round(percentage)}%`;
}

function ScoreRow({
  icon,
  label,
  tooltip,
  children,
}: {
  icon: ReactNode;
  label: string;
  tooltip: string;
  children: ReactNode;
}) {
  return (
    <Group gap="sm" wrap="nowrap">
      <div style={{ flexShrink: 0 }}>{icon}</div>
      <Text size="sm" w={70}>
        {label}
      </Text>
      <Tooltip label={tooltip} multiline w={220} withArrow>
        <IconInfoCircle
          size={14}
          style={{ flexShrink: 0, cursor: 'help' }}
          color="var(--mantine-color-dimmed)"
        />
      </Tooltip>
      {children}
    </Group>
  );
}
