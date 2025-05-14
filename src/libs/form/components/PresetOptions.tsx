import { Chip, ChipProps, ChipGroupProps, Group } from '@mantine/core';
import styles from './PresetOptions.module.scss';

export function PresetOptions({ options, disabled, ...chipGroupProps }: Props) {
  if (options.length === 0) return null;

  return (
    <Chip.Group {...chipGroupProps} multiple={false}>
      <Group gap={4}>
        {options.map(({ label, ...chipProps }, index) => (
          <Chip
            {...chipProps}
            key={index}
            classNames={styles}
            radius="sm"
            variant="filled"
            disabled={disabled}
          >
            <span>{label}</span>
          </Chip>
        ))}
      </Group>
    </Chip.Group>
  );
}

export type Props = Omit<ChipGroupProps, 'children'> & {
  options: Array<Omit<ChipProps, 'children' | 'onChange'> & { label: string }>;
  disabled?: boolean;
};
