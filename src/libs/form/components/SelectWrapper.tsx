import type { ComboboxItem, ComboboxItemGroup, SelectProps } from '@mantine/core';
import { Group, Loader, Select } from '@mantine/core';
import { useMemo, useState, useEffect } from 'react';
import type { Props as PresetOptionsProps } from './PresetOptions';
import { PresetOptions } from './PresetOptions';

type SelectItemProps<T extends string | number> = Omit<ComboboxItem, 'value'> & {
  value: T;
  group?: string;
};

type SelectWrapperProps<T extends string | number> = Omit<
  SelectProps,
  'data' | 'onChange' | 'value' | 'defaultValue'
> & {
  value?: T;
  defaultValue?: T;
  data: (string | SelectItemProps<T>)[];
  onChange?(value: T): void;
  loading?: boolean;
  presets?: PresetOptionsProps['options'];
};

export function SelectWrapper<T extends string | number>({
  data = [],
  value,
  defaultValue,
  loading,
  onChange,
  presets,
  label,
  disabled,
  ...props
}: SelectWrapperProps<T>) {
  const initialType =
    !data.length || typeof data[0] !== 'object' ? typeof data[0] : typeof data[0].value;

  const [selectedPreset, setSelectedPreset] = useState<string | undefined>(value?.toString());

  useEffect(() => {
    // Set the right selectedPreset when value changes
    if (value?.toString() !== selectedPreset) setSelectedPreset(value?.toString());
  }, [value]);

  const parsedData = data.reduce<Array<string | ComboboxItem | ComboboxItemGroup>>((acc, x) => {
    if (typeof x === 'string') {
      acc.push(x);
    } else if (x.group) {
      let group = acc.find(
        (item): item is { group: string; items: { label: string; value: string }[] } =>
          typeof item !== 'string' && 'group' in item && item.group === x.group
      );
      if (!group) {
        group = { group: x.group, items: [] };
        acc.push(group);
      }
      group.items.push({ label: x.label, value: String(x.value) });
    } else {
      acc.push({ ...x, value: String(x.value) });
    }

    return acc;
  }, []);

  const parsedValue = useMemo(
    () => (value !== undefined && value !== null ? String(value) : null),
    [value]
  );

  const parsedDefaultValue = useMemo(
    () => (defaultValue ? String(defaultValue) : undefined),
    [defaultValue]
  );

  const handleChange = (value: string | null) => {
    const returnValue = initialType === 'number' && value != null ? Number(value) : value;
    setSelectedPreset(returnValue as string);
    onChange?.(returnValue as T);
  };

  const hasPresets = presets && presets.length > 0;

  return (
    <Select
      data={parsedData as (string | ComboboxItem)[]}
      value={parsedValue}
      onChange={handleChange}
      defaultValue={parsedDefaultValue}
      rightSection={loading ? <Loader size={16} /> : null}
      styles={{ label: hasPresets ? { width: '100%', marginBottom: 5 } : undefined }}
      disabled={disabled}
      label={
        hasPresets ? (
          <Group gap={8} justify="space-between" wrap="nowrap">
            {label}
            <PresetOptions
              disabled={disabled}
              options={presets}
              value={selectedPreset}
              onChange={(value) => {
                setSelectedPreset(value);
                onChange?.(value as T);
              }}
              chipPropsOverrides={{ color: 'blue' }}
            />
          </Group>
        ) : (
          label
        )
      }
      {...props}
    />
  );
}
