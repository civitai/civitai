import { Box, Group, Paper, Progress, Stack, Text, Title, Tooltip } from '@mantine/core';
import dayjs from '~/shared/utils/dayjs';
import {
  type SubscriptionProductMetadata,
  type SubscriptionMetadata,
  type PrepaidToken,
} from '~/server/schema/subscriptions.schema';
import styles from './PrepaidTimelineProgress.module.scss';
import type { Dayjs } from 'dayjs';
import { numberWithCommas } from '~/utils/number-helpers';
import { useNextBuzzDelivery } from '~/hooks/useNextBuzzDelivery';
import { getPrepaidTokens } from '~/shared/utils/subscription-tokens';

interface TimelineSegment {
  tier: string;
  days: number;
  color: string;
  startDate: Dayjs;
  endDate: Dayjs;
  isActive: boolean;
}

interface PrepaidTimelineProgressProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscription: any;
}

const TIER_COLORS = {
  gold: '#ffd43b',
  silver: '#868e96',
  bronze: '#fd7e14',
} as const;

export function PrepaidTimelineProgress({ subscription }: PrepaidTimelineProgressProps) {
  const metadata = subscription.metadata as SubscriptionMetadata | null;
  if (!metadata) return null;

  const tokens = getPrepaidTokens({ metadata });
  const currentTier = (subscription.product?.metadata as SubscriptionProductMetadata)?.tier;
  const proratedDays = metadata.proratedDays || {};

  // Always show the timeline for active Civitai memberships — at minimum it shows the current period
  const currentPeriodStart = dayjs(subscription.currentPeriodStart);
  const currentPeriodEnd = dayjs(subscription.currentPeriodEnd);
  const now = dayjs();

  const segments = calculateTimelineSegments({
    currentTier,
    currentPeriodStart,
    currentPeriodEnd,
    tokens,
    proratedDays,
    now,
  });

  if (segments.length === 0) return null;

  return (
    <PrepaidTimelineProgressSegments
      segments={segments}
      currentPeriodStart={currentPeriodStart}
      now={now}
    />
  );
}

function PrepaidTimelineProgressSegments({
  segments,
  currentPeriodStart,
  now,
}: {
  segments: TimelineSegment[];
  currentPeriodStart: Dayjs;
  now: Dayjs;
}) {
  const totalDays = segments.reduce((sum, segment) => sum + segment.days, 0);
  const daysPassed = Math.max(0, now.diff(currentPeriodStart, 'day'));
  const totalEndDate = segments[segments.length - 1].endDate;
  const daysRemaining = Math.max(0, totalEndDate.diff(now, 'day'));

  // Calculate next buzz delivery using reusable hook
  const { nextBuzzDelivery, buzzAmount, shouldShow } = useNextBuzzDelivery({
    totalEndDate,
  });

  return (
    <Paper withBorder className={styles.card}>
      <Stack>
        <Group justify="space-between">
          <Title order={3}>Prepaid Membership Timeline</Title>
          <Text size="sm" c="dimmed">
            {daysRemaining} days remaining
          </Text>
        </Group>

        {shouldShow && nextBuzzDelivery && buzzAmount && (
          <Group gap="xs" wrap="nowrap">
            <Text size="sm" c="dimmed">
              Next Token Unlock:
            </Text>
            <Text size="sm" fw={600}>
              {nextBuzzDelivery.format('MMM D, YYYY')}
            </Text>
            <Text size="xs" c="dimmed">
              ({numberWithCommas(buzzAmount)} Buzz)
            </Text>
          </Group>
        )}

        <TimelineProgressBar segments={segments} totalDays={totalDays} daysPassed={daysPassed} />

        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            {currentPeriodStart.format('MMM D, YYYY')}
          </Text>
          <Text size="xs" c="dimmed">
            {totalEndDate.format('MMM D, YYYY')}
          </Text>
        </Group>
      </Stack>
    </Paper>
  );
}

interface TimelineProgressBarProps {
  segments: TimelineSegment[];
  totalDays: number;
  daysPassed: number;
}

function TimelineProgressBar({ segments, totalDays, daysPassed }: TimelineProgressBarProps) {
  return (
    <Tooltip.Group openDelay={200} closeDelay={100}>
      <Group gap={0}>
        {segments.map((segment, index) => {
          const segmentPercent = (segment.days / totalDays) * 100;
          const segmentProgress = calculateSegmentProgress({
            segment,
            index,
            segments,
            daysPassed,
          });

          return (
            <SegmentTooltip key={index} segment={segment} segmentPercent={segmentPercent}>
              <Box style={{ width: `${segmentPercent}%` }}>
                <Progress
                  value={segmentProgress}
                  size="xl"
                  radius="md"
                  style={getSegmentStyle(segment, index, segments.length)}
                />
              </Box>
            </SegmentTooltip>
          );
        })}
      </Group>
    </Tooltip.Group>
  );
}

interface SegmentTooltipProps {
  segment: TimelineSegment;
  segmentPercent: number;
  children: React.ReactNode;
}

function SegmentTooltip({ segment, segmentPercent, children }: SegmentTooltipProps) {
  return (
    <Tooltip
      label={
        <Stack gap={4}>
          <Text size="sm" fw={500} tt="capitalize">
            {segment.tier} Membership
          </Text>
          <Text size="xs">
            {segment.startDate.format('MMM D, YYYY')} - {segment.endDate.format('MMM D, YYYY')}
          </Text>
          <Text size="xs">
            {segment.days} days ({Math.round(segmentPercent)}% of timeline)
          </Text>
          {segment.isActive && (
            <Text size="xs" c="green">
              Currently Active
            </Text>
          )}
        </Stack>
      }
      position="top"
      withArrow
    >
      {children}
    </Tooltip>
  );
}

interface CalculateTimelineSegmentsParams {
  currentTier: string;
  currentPeriodStart: Dayjs;
  currentPeriodEnd: Dayjs;
  tokens: PrepaidToken[];
  proratedDays: Record<string, number>;
  now: Dayjs;
}

function calculateTimelineSegments({
  currentTier,
  currentPeriodStart,
  currentPeriodEnd,
  tokens,
  proratedDays,
  now,
}: CalculateTimelineSegmentsParams): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let cumulativeDays = 0;

  const currentPeriodDays = currentPeriodEnd.diff(currentPeriodStart, 'day');

  // Add current active tier segment
  segments.push({
    tier: currentTier,
    days: currentPeriodDays,
    color: TIER_COLORS[currentTier as keyof typeof TIER_COLORS] || '#868e96',
    startDate: currentPeriodStart,
    endDate: currentPeriodEnd,
    isActive: now.isBetween(currentPeriodStart, currentPeriodEnd, 'day', '[]'),
  });

  cumulativeDays += currentPeriodDays;

  // Build future segments from tokens (excluding current tier's tokens since they're
  // consumed within the current period by the unlock job).
  // Group remaining locked tokens by tier, count months per tier.
  const futureTierMonths: Record<string, number> = {};
  for (const token of tokens) {
    if (token.status === 'claimed') continue; // Already used
    if (token.tier === currentTier) continue; // Part of current period
    futureTierMonths[token.tier] = (futureTierMonths[token.tier] ?? 0) + 1;
  }

  // Add future tier segments in priority order (gold > silver > bronze)
  const tierOrder = ['gold', 'silver', 'bronze'] as const;
  for (const tier of tierOrder) {
    const months = futureTierMonths[tier] ?? 0;
    const extraDays = proratedDays[tier] ?? 0;
    const totalDays = months * 30 + extraDays;

    if (totalDays > 0) {
      const startDate = currentPeriodStart.add(cumulativeDays, 'day');
      const endDate = startDate.add(totalDays, 'day');

      segments.push({
        tier,
        days: totalDays,
        color: TIER_COLORS[tier],
        startDate,
        endDate,
        isActive: now.isBetween(startDate, endDate, 'day', '[]'),
      });
      cumulativeDays += totalDays;
    }
  }

  return segments;
}

interface CalculateSegmentProgressParams {
  segment: TimelineSegment;
  index: number;
  segments: TimelineSegment[];
  daysPassed: number;
}

function calculateSegmentProgress({
  segment,
  index,
  segments,
  daysPassed,
}: CalculateSegmentProgressParams): number {
  if (segment.isActive) {
    const segmentStartDays = segments.slice(0, index).reduce((sum, s) => sum + s.days, 0);
    return Math.min(100, Math.max(0, ((daysPassed - segmentStartDays) / segment.days) * 100));
  }

  const segmentEndDays = segments.slice(0, index + 1).reduce((sum, s) => sum + s.days, 0);
  return daysPassed > segmentEndDays ? 100 : 0;
}

function getSegmentStyle(segment: TimelineSegment, index: number, totalSegments: number) {
  const getBorderRadius = () => {
    if (totalSegments === 1) return '8px';
    if (index === 0) return '8px 0 0 8px';
    if (index === totalSegments - 1) return '0 8px 8px 0';
    return '0';
  };

  return {
    backgroundColor: segment.color,
    opacity: segment.isActive ? 1 : 0.6,
    cursor: 'pointer',
    border: segment.isActive ? '1px solid rgba(255, 255, 255, 0.5)' : 'none',
    borderRadius: getBorderRadius(),
  };
}
