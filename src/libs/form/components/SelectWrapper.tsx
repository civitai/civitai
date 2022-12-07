import { Loader, Select, SelectItem, SelectProps } from '@mantine/core';
import { useMemo } from 'react';

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
};

export function SelectWrapper<T extends string | number>({
  data = [],
  value,
  defaultValue,
  loading,
  onChange,
  ...props
}: SelectWrapperProps<T>) {
  const initialType =
    !data.length || typeof data[0] !== 'object' ? typeof data[0] : typeof data[0].value;

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
    const returnValue = initialType === 'number' ? Number(value) : value;
    onChange?.(returnValue as T);
  };

  return (
    <Select
      data={parsedData as (string | SelectItem)[]}
      value={parsedValue}
      onChange={handleChange}
      defaultValue={parsedDefaultValue}
      rightSection={loading ? <Loader size={16} /> : null}
      {...props}
    />
  );
}
