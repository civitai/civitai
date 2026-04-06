import { Divider, Group, Paper, Progress, Stack, Text, Tooltip } from '@mantine/core';
import {
  IconArticle,
  IconCube,
  IconFlag,
  IconInfoCircle,
  IconPhoto,
  IconShieldCheck,
  IconUsers,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';

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
    icon: IconCube,
    tooltip: 'Based on reviews, downloads, and generations across published models',
  },
  {
    key: 'images' as const,
    label: 'Images',
    color: 'teal',
    icon: IconPhoto,
    tooltip: 'Based on reactions and comments images receive',
  },
  {
    key: 'articles' as const,
    label: 'Articles',
    color: 'orange',
    icon: IconArticle,
    tooltip: 'Based on views, comments, and reactions on articles',
  },
  {
    key: 'users' as const,
    label: 'Users',
    color: 'grape',
    icon: IconUsers,
    tooltip: 'Based on follower count',
  },
];

const reportCategories = [
  {
    key: 'reportsAgainst' as const,
    label: 'Against',
    color: 'red',
    icon: IconFlag,
    tooltip: 'Number of reports filed against this user',
  },
  {
    key: 'reportsActioned' as const,
    label: 'Actioned',
    color: 'green',
    icon: IconShieldCheck,
    tooltip: 'Number of reports this user filed that were actioned',
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

  const categoryValues = scoreCategories.map(({ key }) => Math.abs(scores[key] ?? 0));
  const maxCategoryValue = Math.max(...categoryValues, 1);

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="md">
        <Stack gap={4} align="center">
          <Text size="2rem" fw={700} c="green" lh={1.2}>
            {Math.round(scores.total ?? 0).toLocaleString()}
          </Text>
          <Text size="sm" c="dimmed">
            User Score
          </Text>
        </Stack>

        <Divider />

        <Stack gap="sm">
          {scoreCategories.map(({ key, label, color, icon: Icon, tooltip }) => {
            const value = scores[key] ?? 0;
            const percentage = (Math.abs(value) / maxCategoryValue) * 100;
            return (
              <ScoreRow key={key} icon={<Icon size={16} />} label={label} tooltip={tooltip}>
                <Progress
                  value={percentage}
                  color={color}
                  size="sm"
                  style={{ flex: 1 }}
                  radius="xl"
                />
                <Text size="sm" fw={600} w={50} ta="right">
                  {Math.round(value)}
                </Text>
              </ScoreRow>
            );
          })}
        </Stack>

        {showReports && (
          <>
            <Divider label="Reports" labelPosition="left" />
            <Stack gap="sm">
              {reportCategories.map(({ key, label, color, icon: Icon, tooltip }) => {
                const value = scores[key] ?? 0;
                return (
                  <ScoreRow key={key} icon={<Icon size={16} />} label={label} tooltip={tooltip}>
                    <Text size="sm" fw={600} c={color}>
                      {Math.round(value)}
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
