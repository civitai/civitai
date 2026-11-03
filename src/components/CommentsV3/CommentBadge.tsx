import type { BadgeProps } from '@mantine/core';
import { Badge } from '@mantine/core';
import type { CommentV3Badge } from './types';

export function CommentBadge({ label, color, userId, ...props }: CommentV3Badge & BadgeProps) {
  return (
    <Badge size="xs" color={color} {...props}>
      {label}
    </Badge>
  );
}
