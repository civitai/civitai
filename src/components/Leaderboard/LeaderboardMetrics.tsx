import {
  Anchor,
  Grid,
  Group,
  MantineTheme,
  Paper,
  Rating,
  Stack,
  Text,
  ThemeIcon,
  Box,
  BoxProps,
  Card,
  Tooltip,
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
  IconChartBar,
  IconShare,
} from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useRouter } from 'next/router';
import { useEffect, useMemo } from 'react';
import { IconBadge } from '~/components/IconBadge/IconBadge';

import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { UserStatBadges } from '~/components/UserStatBadges/UserStatBadges';
import { LeaderboardGetModel } from '~/types/router';
import { abbreviateNumber, numberWithCommas } from '~/utils/number-helpers';
import { isDefined } from '~/utils/type-guards';
import React, { forwardRef } from 'react';
import styles from './LeaderboardMetrics.module.scss';
import { MetricType } from '~/types/metrics';
import { LeaderboardMetric } from '~/types/leaderboard';

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

interface LeaderboardMetricsProps {
  metrics: LeaderboardMetric[];
  score: number;
  delta?: number;
}

export function LeaderboardMetrics({ metrics, score, delta }: LeaderboardMetricsProps) {
  const displayMetrics = useMemo(() => {
    return metrics.filter(
      (metric) => metric.value !== undefined && metric.value !== null && metric.display !== false
    );
  }, [metrics]);

  return (
    <div className={styles.metrics}>
      <div className={styles.scoreContainer}>
        <span className={styles.score}>{score}</span>
        {delta !== undefined && (
          <span className={delta >= 0 ? styles.deltaPositive : styles.deltaNegative}>
            {delta >= 0 ? '+' : ''}
            {delta}
          </span>
        )}
      </div>
      {displayMetrics.map((metric, index) => (
        <Tooltip key={index} label={metric.description || metric.name}>
          <div className={styles.metricItem}>
            <span>{metric.name}</span>
            {metric.value !== undefined && <span>{metric.value}</span>}
          </div>
        </Tooltip>
      ))}
    </div>
  );
}

export interface LeaderboardMetricsCardProps extends LeaderboardMetricsProps {
  active?: boolean;
  onClick?: () => void;
}

export function LeaderboardMetricsCard({ active, onClick, ...props }: LeaderboardMetricsCardProps) {
  return (
    <Card
      withBorder
      p="md"
      radius="md"
      className={styles.metrics}
      onClick={onClick}
      sx={(theme) => ({
        cursor: onClick ? 'pointer' : 'default',
        backgroundColor: active ? theme.colors.blue[theme.fn.primaryShade()] : undefined,
        color: active ? theme.white : undefined,
        '&:hover': {
          backgroundColor: onClick
            ? active
              ? theme.colors.blue[theme.fn.primaryShade()]
              : theme.colorScheme === 'dark'
              ? theme.colors.dark[6]
              : theme.colors.gray[0]
            : undefined,
        },
      })}
    >
      <LeaderboardMetrics {...props} />
    </Card>
  );
}


