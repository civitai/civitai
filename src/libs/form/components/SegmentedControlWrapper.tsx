import type { SegmentedControlProps, SegmentedControlItem } from '@mantine/core';
import { SegmentedControl } from '@mantine/core';
import { useMemo } from 'react';

type SegmentedControlItemProps<T> = Omit<SegmentedControlItem, 'value'> & { value: T };

type SegmentedControlWrapperProps<T> = {
  value?: T;
  defaultValue?: T;
  data: T[] | SegmentedControlItemProps<T>[];
  onChange?(value: T): void;
} & Omit<SegmentedControlProps, 'value' | 'defaultValue' | 'data' | 'onChange'>;

export function SegmentedControlWrapper<T extends string | number>({
  value,
  onChange,
  defaultValue,
  data,
  ...props
}: SegmentedControlWrapperProps<T>) {
  const initialType =
    !data.length || typeof data[0] !== 'object' ? typeof data[0] : typeof data[0].value;

  const parsedData = data.map((item) =>
    typeof item === 'object' ? { ...item, value: item.value.toString() } : item.toString()
  ) as string[] | SegmentedControlItem[];

  const parsedValue = useMemo(
    () => (value !== undefined && value !== null ? String(value) : undefined),
    [value]
  );

  const parsedDefaultValue = useMemo(
    () => (defaultValue ? String(defaultValue) : undefined),
    [defaultValue]
  );

  function handleChange(value: string) {
    if (value !== null && value !== undefined) {
      const returnValue = initialType === 'number' ? Number(value) : value;
      onChange?.(returnValue as T);
    }
  }

  return (
    <SegmentedControl
      value={parsedValue}
      defaultValue={parsedDefaultValue}
      data={parsedData}
      onChange={handleChange}
      {...props}
    />
  );
}
