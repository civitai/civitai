import { Badge, BadgeProps } from '@mantine/core';
import { formatDuration } from '~/utils/number-helpers';

export function DurationBadge({ duration, ...badgeProps }: Props) {
  return (
    <Badge
      color="gray"
      radius="xl"
      className="text-white"
      style={{ flexShrink: 0, boxShadow: '1px 2px 3px -1px #25262B33' }}
      {...badgeProps}
    >
      {formatDuration(duration)}
    </Badge>
  );
}

type Props = Omit<BadgeProps, 'children'> & { duration: number };
