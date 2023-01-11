import { Badge } from '@mantine/core';

export function ShowHide({ status }: { status: 'show' | 'hide' }) {
  return (
    <Badge
      color="red"
      variant="filled"
      size="sm"
      sx={(theme) => ({
        cursor: 'pointer',
        userSelect: 'none',
        position: 'absolute',
        top: theme.spacing.xs,
        left: theme.spacing.xs,
        zIndex: 10,
      })}
    >
      {status}
    </Badge>
  );
}
