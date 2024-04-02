import { Group, Loader, Select, SelectItem, SelectProps } from '@mantine/core';
import { useMemo, useState, useEffect } from 'react';
import { PresetOptions, Props as PresetOptionsProps } from './PresetOptions';

type SelectItemProps<T extends string | number> = Omit<SelectItem, 'value'> & {
  value: T;
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

  const parsedData = data.map((x): string | SelectItem => {
    if (typeof x === 'string') return x;
    return {
      ...x,
      value: String(x.value),
    } as SelectItem;
  });

  const parsedValue = useMemo(
    () => (value !== undefined && value !== null ? String(value) : undefined),
    [value]
  );

  const parsedDefaultValue = useMemo(
    () => (defaultValue ? String(defaultValue) : undefined),
    [defaultValue]
  );

  const handleChange = (value: string) => {
    const returnValue = initialType === 'number' && value != null ? Number(value) : value;
    setSelectedPreset(returnValue as string);
    onChange?.(returnValue as T);
  };

  const hasPresets = presets && presets.length > 0;

  return (
    <Select
      data={parsedData as (string | SelectItem)[]}
      value={parsedValue}
      onChange={handleChange}
      defaultValue={parsedDefaultValue}
      rightSection={loading ? <Loader size={16} /> : null}
      styles={{ label: hasPresets ? { width: '100%', marginBottom: 5 } : undefined }}
      disabled={disabled}
      label={
        hasPresets ? (
          <Group spacing={8} position="apart" noWrap>
            {label}
            <PresetOptions
              disabled={disabled}
              color="blue"
              options={presets}
              value={selectedPreset}
              onChange={(value) => {
                setSelectedPreset(value);
                onChange?.(value as T);
              }}
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
