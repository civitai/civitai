import {
  Anchor,
  createStyles,
  Grid,
  Group,
  MantineTheme,
  Paper,
  Rating,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import {
  IconArrowsHorizontal,
  IconBolt,
  IconBookmark,
  IconBox,
  IconBrush,
  IconBulb,
  IconCheck,
  IconChecks,
  IconCrown,
  IconDownload,
  IconEye,
  IconFileStar,
  IconHeart,
  IconHexagonFilled,
  IconMessageCircle2,
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
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo } from 'react';
import { IconBadge } from '~/components/IconBadge/IconBadge';

import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { UserStatBadges } from '~/components/UserStatBadges/UserStatBadges';
import { LeaderboardGetModel } from '~/types/router';
import { abbreviateNumber, numberWithCommas } from '~/utils/number-helpers';
import { isDefined } from '~/utils/type-guards';

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
  (metrics: { type: string; value: number }[], theme: MantineTheme) => MetricDisplayOptions
> = {
  ratingCount: (metrics, theme) => ({
    icon: (
      <Rating
        size="xs"
        value={metrics.find((x) => x.type === 'rating')?.value ?? 0}
        readOnly
        emptySymbol={
          theme.colorScheme === 'dark' ? (
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
      <ThemeIcon color="blue" variant="outline" sx={{ border: 'none' }}>
        <IconHexagonFilled {...iconProps} />
      </ThemeIcon>
    ),
  }),
  gold: () => ({
    tooltip: 'Gold Days',
    icon: (
      <ThemeIcon color="yellow" variant="outline" sx={{ border: 'none' }}>
        <IconHexagonFilled {...iconProps} />
      </ThemeIcon>
    ),
  }),
  silver: () => ({
    tooltip: 'Silver Days',
    icon: (
      <ThemeIcon color="gray" variant="outline" sx={{ border: 'none' }}>
        <IconHexagonFilled {...iconProps} />
      </ThemeIcon>
    ),
  }),
  bronze: () => ({
    tooltip: 'Bronze Days',
    icon: (
      <ThemeIcon color="orange" variant="outline" sx={{ border: 'none' }}>
        <IconHexagonFilled {...iconProps} />
      </ThemeIcon>
    ),
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
  const { theme } = useStyles();

  return (
    <Group spacing={4}>
      <IconBadge
        size="lg"
        color="gray"
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        icon={<IconTrophy {...iconProps} />}
        tooltip={
          <Stack spacing={0} align="center">
            {delta && delta != 0 && (
              <Text size="xs" color={delta > 0 ? 'green' : 'red'}>
                {delta > 0 ? '+' : ''}
                {numberWithCommas(delta)}
              </Text>
            )}
            <>Score</>
          </Stack>
        }
      >
        {numberWithCommas(score)}
      </IconBadge>
      {metrics.map(({ type, value }) => {
        const typeProcessor = metricTypes[type];
        if (!typeProcessor) return null;

        const badge = typeProcessor(metrics, theme);
        if (value === 0 && badge.hideEmpty) return null;

        return (
          <IconBadge
            size="lg"
            color="gray"
            variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
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

const useStyles = createStyles((theme) => ({
  creatorCard: {
    '&.active': {
      borderColor: theme.colors.blue[8],
      boxShadow: `0 0 10px ${theme.colors.blue[8]}`,
    },
    '&:hover': {
      backgroundColor:
        theme.colorScheme === 'dark' ? 'rgba(255,255,255, 0.03)' : 'rgba(0,0,0, 0.01)',
    },
  },
}));
