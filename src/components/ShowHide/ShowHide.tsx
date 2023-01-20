import { Badge } from '@mantine/core';

export function ShowHide({ status = 'show', position = 'absolute', ...props }: Props) {
  return (
    <Badge
      {...props}
      color="red"
      variant="filled"
      size="sm"
      sx={(theme) => ({
        cursor: 'pointer',
        userSelect: 'none',
        ...(position === 'absolute'
          ? {
              position: 'absolute',
              top: theme.spacing.xs,
              left: theme.spacing.xs,
              zIndex: 10,
            }
          : {}),
      })}
    >
      {status}
    </Badge>
  );
}

export type Props = {
  status?: 'show' | 'hide';
  position?: 'absolute' | 'none';
  onClick?: () => void;
};
