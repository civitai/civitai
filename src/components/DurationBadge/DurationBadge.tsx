import type { BadgeProps } from '@mantine/core';
import { Badge } from '@mantine/core';
import clsx from 'clsx';
import { formatDuration } from '~/utils/number-helpers';

export function DurationBadge({ duration, className, ...badgeProps }: Props) {
  return (
    <Badge
      color="gray"
      radius="xl"
      className={clsx('bg-gray-0 text-gray-500 dark:bg-dark-8/20 dark:text-white', className)}
      style={{ flexShrink: 0, boxShadow: '1px 2px 3px -1px #25262B33' }}
      {...badgeProps}
    >
      {formatDuration(duration)}
    </Badge>
  );
}

type Props = Omit<BadgeProps, 'children'> & { duration: number };
