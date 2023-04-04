import { CommentV2BadgeProps } from '~/components/CommentsV2/CommentsProvider';
import { Badge, BadgeProps } from '@mantine/core';

export function CommentBadge({ label, color, userId, ...props }: CommentV2BadgeProps & BadgeProps) {
  return (
    <Badge size="xs" color={color} {...props}>
      {label}
    </Badge>
  );
}
