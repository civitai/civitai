import type { SegmentedControlProps, SegmentedControlItem } from '@mantine/core';
import { SegmentedControl } from '@mantine/core';
import { useMemo, forwardRef } from 'react';

type SegmentedControlItemProps<T> = Omit<SegmentedControlItem, 'value'> & { value: T };

type SegmentedControlWrapperProps<T> = {
  value?: T;
  defaultValue?: T;
  data: T[] | SegmentedControlItemProps<T>[];
  onChange?(value: T): void;
} & Omit<SegmentedControlProps, 'value' | 'defaultValue' | 'data' | 'onChange'>;

function SegmentedControlWrapperInner<T extends string | number>(
  { value, onChange, defaultValue, data, ...props }: SegmentedControlWrapperProps<T>,
  ref: React.ForwardedRef<HTMLDivElement>
) {
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
      key={parsedValue}
      ref={ref}
      value={parsedValue}
      defaultValue={parsedDefaultValue}
      data={parsedData}
      onChange={handleChange}
      {...props}
    />
  );
}

export const SegmentedControlWrapper = forwardRef(SegmentedControlWrapperInner) as <
  T extends string | number
>(
  props: SegmentedControlWrapperProps<T> & { ref?: React.ForwardedRef<HTMLDivElement> }
) => JSX.Element;
