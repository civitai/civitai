import { Chip, ChipProps, ChipGroupProps } from '@mantine/core';
import classes from './PresetOptions.module.scss';

export function PresetOptions({ options, disabled, ...chipGroupProps }: Props) {
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
          <span>{label}</span>
        </Chip>
      ))}
    </Chip.Group>
  );
}

export type Props = Omit<ChipGroupProps, 'children'> & {
  options: Array<Omit<ChipProps, 'children' | 'onChange'> & { label: string }>;
  disabled?: boolean;
};

