import { createStyles, Chip, ChipProps, ChipGroupProps } from '@mantine/core';

const useStyles = createStyles((theme) => ({
  label: {
    padding: 8,
    fontWeight: 590,
    lineHeight: 1,
    fontSize: 12,

    '&[data-checked]': {
      '&, &:hover': {
        color: theme.colorScheme === 'dark' ? theme.white : theme.black,
        border: `1px solid ${theme.colors[theme.primaryColor][theme.fn.primaryShade()]}`,
      },

      '&[data-variant="filled"]': {
        backgroundColor: theme.fn.rgba(
          theme.colors[theme.primaryColor][theme.fn.primaryShade()],
          0.2
        ),
      },
    },
  },
  iconWrapper: { display: 'none' },
}));

export function PresetOptions({ options, disabled, ...chipGroupProps }: Props) {
  const { classes } = useStyles();

  if (options.length === 0) return null;

  return (
    <Chip.Group {...chipGroupProps} multiple={false} spacing={4}>
      {options.map(({ label, ...chipProps }, index) => (
        <Chip
          {...chipProps}
          key={index}
          classNames={classes}
          radius="sm"
          variant="filled"
          disabled={disabled}
        >
          {label}
        </Chip>
      ))}
    </Chip.Group>
  );
}

export type Props = Omit<ChipGroupProps, 'children'> & {
  options: Array<Omit<ChipProps, 'children' | 'onChange'> & { label: string }>;
  disabled?: boolean;
};
