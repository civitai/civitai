import { BadgeProps, Badge } from '@mantine/core';

export function MediaCount({
  count,
  ...badgeProps
}: { count: number } & Omit<BadgeProps, 'children'>) {
  if (count <= 1) return null;
  return (
    <Badge
      variant="filled"
      color="gray"
      size="sm"
      sx={(theme) => ({
        position: 'absolute',
        top: theme.spacing.xs,
        right: theme.spacing.md,
        zIndex: 10,
      })}
      {...badgeProps}
    >
      {count}
    </Badge>
  );
}
