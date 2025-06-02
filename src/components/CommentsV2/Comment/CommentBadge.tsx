import type { CommentV2BadgeProps } from '~/components/CommentsV2/CommentsProvider';
import type { BadgeProps } from '@mantine/core';
import { Badge } from '@mantine/core';

export function CommentBadge({ label, color, userId, ...props }: CommentV2BadgeProps & BadgeProps) {
  return (
    <Badge size="xs" color={color} {...props}>
      {label}
    </Badge>
  );
}
