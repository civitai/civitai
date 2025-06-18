import type { MantineTheme } from '@mantine/core';
import { Group, Rating, Stack, Text, ThemeIcon, useComputedColorScheme, useMantineTheme } from '@mantine/core';
import {
  IconArrowsHorizontal,
  IconBadges,
  IconBolt,
  IconBookmark,
  IconBox,
  IconBrush,
  IconBulb,
  IconCheck,
  IconChecks,
  IconDownload,
  IconEye,
  IconFileStar,
  IconHeart,
  IconHexagonFilled,
  IconMoodSmile,
  IconPhoto,
  IconReport,
  IconShieldChevron,
  IconStar,
  IconTarget,
  IconTargetArrow,
  IconTargetOff,
  IconThumbUp,
  IconTrophy,
  IconX,
} from '@tabler/icons-react';
import { IconBadge } from '~/components/IconBadge/IconBadge';

import { abbreviateNumber, numberWithCommas } from '~/utils/number-helpers';

type MetricDisplayOptions = {
  icon: React.ReactNode;
  tooltip?: string;
  value?: string | number;
  hideEmpty?: boolean;
};

const iconProps = {
  size: 18,
  strokeWidth: 2,
};
const metricTypes: Record<
  string,
  (
    metrics: { type: string; value: number }[],
    theme: MantineTheme,
    colorScheme: 'light' | 'dark'
  ) => MetricDisplayOptions
> = {
  ratingCount: (metrics, theme, colorScheme) => ({
    icon: (
      <Rating
        size="xs"
        value={metrics.find((x) => x.type === 'rating')?.value ?? 0}
        readOnly
        emptySymbol={
          colorScheme === 'dark' ? (
            <IconStar {...iconProps} fill="rgba(255,255,255,.3)" color="transparent" />
          ) : undefined
        }
      />
    ),
    tooltip: 'Average Rating',
  }),
  thumbsUpCount: () => ({
    tooltip: 'Likes',
    icon: <IconThumbUp {...iconProps} />,
  }),
  generationCount: () => ({
    tooltip: 'Generations',
    icon: <IconBrush {...iconProps} />,
  }),
  heart: () => ({
    icon: <IconHeart {...iconProps} />,
  }),
  hearts: () => ({
    tooltip: 'Hearts given',
    icon: <IconHeart {...iconProps} />,
  }),
  downloadCount: () => ({
    icon: <IconDownload {...iconProps} />,
    tooltip: 'Downloads',
  }),
  answerCount: () => ({
    tooltip: 'Answers Given',
    icon: <IconBulb {...iconProps} />,
    hideEmpty: true,
  }),
  answerAcceptCount: (_, theme) => ({
    tooltip: 'Answers Accepted',
    icon: <IconCheck {...iconProps} color={theme.colors.green[5]} strokeWidth={4} />,
    hideEmpty: true,
  }),
  shots: () => ({
    tooltip: 'Shots',
    icon: <IconTarget {...iconProps} />,
  }),
  hit: () => ({
    tooltip: 'Hits',
    icon: <IconTargetArrow {...iconProps} />,
  }),
  miss: () => ({
    tooltip: 'Misses',
    icon: <IconTargetOff {...iconProps} />,
  }),
  firstResponder: () => ({
    tooltip: 'First Responder',
    icon: <IconShieldChevron {...iconProps} />,
  }),
  viewCount: () => ({
    tooltip: 'Views',
    icon: <IconEye {...iconProps} />,
  }),
  level: () => ({
    tooltip: 'Level',
    icon: <IconStar {...iconProps} />,
  }),
  strikes: () => ({
    tooltip: 'Strikes',
    icon: <IconX {...iconProps} />,
  }),
  streak: () => ({
    tooltip: 'Longest Streak',
    icon: <IconArrowsHorizontal {...iconProps} />,
  }),
  bookmark: () => ({
    tooltip: 'Bookmarks',
    icon: <IconBookmark {...iconProps} />,
  }),
  lifetime: () => ({
    tooltip: 'Lifetime Buzz',
    icon: <IconBolt {...iconProps} />,
  }),
  reactionCount: () => ({
    tooltip: 'Reactions',
    icon: <IconMoodSmile {...iconProps} />,
  }),
  laughs: () => ({
    tooltip: 'Laughs',
    icon: <IconMoodSmile {...iconProps} />,
  }),
  imageCount: () => ({
    tooltip: 'Images',
    icon: <IconPhoto {...iconProps} />,
  }),
  reviews: () => ({
    tooltip: 'Reviews',
    icon: <IconFileStar {...iconProps} />,
  }),
  reports: () => ({
    tooltip: 'Report Processed',
    icon: <IconReport {...iconProps} />,
  }),
  entries: () => ({
    tooltip: 'Entries',
    icon: <IconBox {...iconProps} />,
  }),
  cosmetics: () => ({
    tooltip: 'Cosmetics',
    icon: <IconHexagonFilled {...iconProps} />,
  }),
  diamond: () => ({
    tooltip: 'Diamond Days',
    icon: (
      <ThemeIcon color="blue" variant="outline" style={{ border: 'none' }}>
        <IconHexagonFilled {...iconProps} />
      </ThemeIcon>
    ),
  }),
  gold: () => ({
    tooltip: 'Gold Days',
    icon: (
      <ThemeIcon color="yellow" variant="outline" style={{ border: 'none' }}>
        <IconHexagonFilled {...iconProps} />
      </ThemeIcon>
    ),
  }),
  silver: () => ({
    tooltip: 'Silver Days',
    icon: (
      <ThemeIcon color="gray" variant="outline" style={{ border: 'none' }}>
        <IconHexagonFilled {...iconProps} />
      </ThemeIcon>
    ),
  }),
  bronze: () => ({
    tooltip: 'Bronze Days',
    icon: (
      <ThemeIcon color="orange" variant="outline" style={{ border: 'none' }}>
        <IconHexagonFilled {...iconProps} />
      </ThemeIcon>
    ),
  }),
  correctJudgments: () => ({
    tooltip: 'Correct Judgments',
    icon: <IconChecks {...iconProps} />,
  }),
  allJudgments: () => ({
    tooltip: 'All Judgments',
    icon: <IconBadges {...iconProps} />,
  }),
};

export function LeaderboardMetrics({
  metrics,
  score,
  delta,
}: {
  metrics: { type: string; value: number }[];
  score: number;
  delta?: number;
}) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  return (
    <Group gap={4}>
      <IconBadge
        size="lg"
        color="gray"
        variant={colorScheme === 'dark' ? 'filled' : 'light'}
        icon={<IconTrophy {...iconProps} />}
        tooltip={
          <Stack gap={0} align="center">
            {delta && delta !== 0 ? (
              <Text size="xs" color={delta > 0 ? 'green' : 'red'}>
                {delta > 0 ? '+' : ''}
                {numberWithCommas(delta)}
              </Text>
            ) : null}
            <>Score</>
          </Stack>
        }
      >
        {numberWithCommas(score)}
      </IconBadge>
      {metrics.map(({ type, value }) => {
        const typeProcessor = metricTypes[type];
        if (!typeProcessor) return null;

        const badge = typeProcessor(metrics, theme, colorScheme);
        if (value === 0 && badge.hideEmpty) return null;

        return (
          <IconBadge
            size="lg"
            color="gray"
            variant={colorScheme === 'dark' ? 'filled' : 'light'}
            key={type}
            icon={badge.icon}
            tooltip={badge.tooltip}
          >
            {badge.value ?? abbreviateNumber(value)}
          </IconBadge>
        );
      })}
    </Group>
  );
}
