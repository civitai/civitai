import type { ChipProps } from '@mantine/core';
import { Chip, createStyles } from '@mantine/core';

export function FilterChip({ children, ...props }: ChipProps) {
  const { classes } = useStyles();
  return (
    <Chip classNames={classes} size="sm" radius="xl" variant="filled" {...props}>
      {children}
    </Chip>
  );
}

const useStyles = createStyles((theme) => ({
  label: {
    fontSize: 12,
    fontWeight: 600,

    '&[data-checked]': {
      '&, &:hover': {
        color: theme.colorScheme === 'dark' ? theme.white : theme.black,
        border: `1px solid ${theme.colors[theme.primaryColor][theme.fn.primaryShade()]}`,
      },

      '&[data-variant="filled"]': {
        backgroundColor: 'transparent',
      },
    },
  },
}));
