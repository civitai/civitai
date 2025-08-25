import { Checkbox, Input, Stack } from '@mantine/core';
import { Flags } from '~/shared/utils/flags';
import {
  browsingLevelDescriptions,
  browsingLevels,
} from '~/shared/constants/browsingLevel.constants';

const flagOptions = {
  NsfwLevel: browsingLevels.map((level) => ({
    label: browsingLevelDescriptions[level],
    value: level,
  })),
} as const;

export function FlagInput({ flag, value = 0, spacing, label, mapLabel, onChange }: Props) {
  const handleChange = (checked: boolean, selected: number) => {
    if (onChange) {
      const newValue = checked ? Flags.addFlag(value, selected) : Flags.removeFlag(value, selected);
      onChange(newValue);
    }
  };

  const options = flagOptions[flag];

  return (
    <Stack gap={spacing}>
      {typeof label === 'string' ? <Input.Label>{label}</Input.Label> : label}
      {options.map((option) => {
        const checked = Flags.hasFlag(value, option.value);
        const label = mapLabel ? mapLabel(option) : option.label;

        return (
          <Checkbox
            key={option.value}
            label={label}
            value={option.value}
            checked={checked}
            onChange={(e) => handleChange(e.target.checked, option.value)}
          />
        );
      })}
    </Stack>
  );
}

type Props = {
  flag: keyof typeof flagOptions;
  label?: React.ReactNode;
  mapLabel?: (data: { value: number; label: string }) => React.ReactNode;
  onChange?: (value: number) => void;
  value?: number;
  spacing?: MantineSpacing;
};
