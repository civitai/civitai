import { Badge, Text } from '@mantine/core';
import { IconClock } from '@tabler/icons-react';
import clsx from 'clsx';
import { Countdown } from '~/components/Countdown/Countdown';

type CrucibleTimerProps = {
  endAt: Date | null;
  /** If true, crucible has ended (Completed or Cancelled status) */
  hasEnded?: boolean;
  /** Compact mode uses short format (e.g., "2d 5h"), full mode uses long format (e.g., "2 days and 5 hours") */
  compact?: boolean;
  /** Additional className for the wrapper */
  className?: string;
};

/**
 * CrucibleTimer - Displays countdown timer for crucibles
 *
 * Usage:
 * - Cards: <CrucibleTimer endAt={crucible.endAt} hasEnded={status === 'Completed'} compact />
 * - Detail page: <CrucibleTimer endAt={crucible.endAt} hasEnded={false} />
 */
export function CrucibleTimer({ endAt, hasEnded, compact = false, className }: CrucibleTimerProps) {
  // If crucible has ended, show 'Ended' badge
  if (hasEnded || !endAt) {
    return (
      <Badge
        color="gray"
        variant="filled"
        radius="xl"
        size={compact ? 'sm' : 'md'}
        className={className}
      >
        Ended
      </Badge>
    );
  }

  // Check if the end time has passed
  const isPastEndTime = new Date(endAt) < new Date();

  if (isPastEndTime) {
    return (
      <Badge
        color="gray"
        variant="filled"
        radius="xl"
        size={compact ? 'sm' : 'md'}
        className={className}
      >
        Ended
      </Badge>
    );
  }

  // Show countdown timer
  if (compact) {
    // Compact mode: just the countdown text without icon
    return (
      <Text size="sm" className={clsx('whitespace-nowrap', className)}>
        <Countdown endTime={endAt} format="short" refreshIntervalMs={1000 * 60} />
      </Text>
    );
  }

  // Full mode: countdown with label
  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <IconClock size={18} className="text-dimmed" />
      <Text size="sm">
        <Countdown endTime={endAt} format="long" refreshIntervalMs={1000 * 60} />
      </Text>
    </div>
  );
}
