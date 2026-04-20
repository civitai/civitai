import { Box, Card, Group, Progress, Stack, Text, Title, Tooltip } from '@mantine/core';
import type { Dayjs } from 'dayjs';
import dayjs from '~/shared/utils/dayjs';

type ReferralGrant = {
  activeTier: string;
  currentPeriodStart: string | Date;
  currentPeriodEnd: string | Date;
  queue: { tier: string; durationDays: number }[];
};

const TIER_COLORS: Record<string, string> = {
  gold: '#ffd43b',
  silver: '#c0c7d0',
  bronze: '#fd7e14',
};

type Segment = {
  tier: string;
  days: number;
  startDate: Dayjs;
  endDate: Dayjs;
  isActive: boolean;
};

function buildSegments(grant: ReferralGrant, now: Dayjs): Segment[] {
  const start = dayjs(grant.currentPeriodStart);
  const end = dayjs(grant.currentPeriodEnd);
  const activeDays = Math.max(0, end.diff(start, 'day'));

  const segments: Segment[] = [];
  if (activeDays > 0) {
    segments.push({
      tier: grant.activeTier,
      days: activeDays,
      startDate: start,
      endDate: end,
      isActive: now.isBetween(start, end, 'day', '[]'),
    });
  }

  let cursor = end;
  for (const entry of grant.queue) {
    const segStart = cursor;
    const segEnd = cursor.add(entry.durationDays, 'day');
    segments.push({
      tier: entry.tier,
      days: entry.durationDays,
      startDate: segStart,
      endDate: segEnd,
      isActive: false,
    });
    cursor = segEnd;
  }
  return segments;
}

export function ReferralTimelineProgress({ grant }: { grant: ReferralGrant | null }) {
  if (!grant) return null;
  const now = dayjs();
  const segments = buildSegments(grant, now);
  if (segments.length === 0) return null;

  const totalDays = segments.reduce((sum, s) => sum + s.days, 0);
  const daysPassed = Math.max(0, now.diff(segments[0].startDate, 'day'));
  const totalEndDate = segments[segments.length - 1].endDate;
  const daysRemaining = Math.max(0, totalEndDate.diff(now, 'day'));

  return (
    <Card withBorder p="lg" radius="md">
      <Stack gap="md">
        <Group justify="space-between">
          <Title order={4}>Your Membership Timeline</Title>
          <Text size="sm" c="dimmed">
            {daysRemaining} day{daysRemaining === 1 ? '' : 's'} of perks remaining
          </Text>
        </Group>
        <Text size="xs" c="dimmed">
          Chunks activate highest tier first. When the active chunk ends, the next queued tier takes
          over automatically.
        </Text>

        <Tooltip.Group openDelay={200} closeDelay={100}>
          <Group gap={0}>
            {segments.map((segment, index) => {
              const segmentPercent = (segment.days / totalDays) * 100;
              const segmentStartDays = segments.slice(0, index).reduce((sum, s) => sum + s.days, 0);
              const segmentProgress = segment.isActive
                ? Math.min(100, ((daysPassed - segmentStartDays) / segment.days) * 100)
                : daysPassed > segmentStartDays + segment.days
                ? 100
                : 0;

              return (
                <Tooltip
                  key={`${segment.tier}-${index}`}
                  label={
                    <Stack gap={4}>
                      <Text size="sm" fw={500} tt="capitalize">
                        {segment.tier} perks
                      </Text>
                      <Text size="xs">
                        {segment.startDate.format('MMM D, YYYY')} —{' '}
                        {segment.endDate.format('MMM D, YYYY')}
                      </Text>
                      <Text size="xs">
                        {segment.days} day{segment.days === 1 ? '' : 's'} (
                        {Math.round(segmentPercent)}% of timeline)
                      </Text>
                      {segment.isActive && (
                        <Text size="xs" c="green">
                          Currently active
                        </Text>
                      )}
                    </Stack>
                  }
                  position="top"
                  withArrow
                >
                  <Box style={{ width: `${segmentPercent}%` }}>
                    <Progress
                      value={segmentProgress}
                      size="xl"
                      radius="md"
                      style={{
                        backgroundColor: TIER_COLORS[segment.tier] ?? '#868e96',
                        opacity: segment.isActive ? 1 : 0.55,
                        border: segment.isActive ? '1px solid rgba(255,255,255,0.5)' : 'none',
                        borderRadius:
                          segments.length === 1
                            ? '8px'
                            : index === 0
                            ? '8px 0 0 8px'
                            : index === segments.length - 1
                            ? '0 8px 8px 0'
                            : '0',
                      }}
                    />
                  </Box>
                </Tooltip>
              );
            })}
          </Group>
        </Tooltip.Group>

        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            {segments[0].startDate.format('MMM D, YYYY')}
          </Text>
          <Text size="xs" c="dimmed">
            {totalEndDate.format('MMM D, YYYY')}
          </Text>
        </Group>
      </Stack>
    </Card>
  );
}
