import {
  MultiSelect,
  MultiSelectProps,
  SelectItem,
  ScrollArea,
  ScrollAreaProps,
  Divider,
  Box,
  Loader,
} from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import React, { useMemo, forwardRef } from 'react';

type SelectItemProps<T extends string | number> = Omit<SelectItem, 'value'> & {
  value: T;
};

type MultiSelectWrapperProps<T extends string | number> = Omit<
  MultiSelectProps,
  'data' | 'onChange' | 'value' | 'defaultValue'
> & {
  value?: T[];
  defaultValue?: T[];
  /** Select data used to renderer items in dropdown */
  data: (string | SelectItemProps<T>)[];
  /** Controlled input onChange handler */
  onChange?(value: T[]): void;
  loading?: boolean;
  parsePaste?: boolean;
};

export function MultiSelectWrapper<T extends string | number>({
  data = [],
  value,
  defaultValue,
  loading,
  onChange,
  parsePaste = false,
  ...props
}: MultiSelectWrapperProps<T>) {
  const initialType =
    !data.length || (typeof data[0] !== 'object' ? typeof data[0] : typeof data[0].value);

  const parsedData = data.map((x): string | SelectItem => {
    if (typeof x === 'string') return x;
    return {
      ...x,
      value: String(x.value),
    } as SelectItem;
  });

  const parsedValue = useMemo(() => (value ? value?.map(String) : undefined), [value]);
  const parsedDefaultValue = useMemo(
    () => (defaultValue ? defaultValue?.map(String) : undefined),
    [defaultValue]
  );

  const handleChange = (value: string[]) => {
    const returnValue = initialType === 'number' ? value.map(Number) : value;
    onChange?.(returnValue as T[]);
  };

  const handlePaste = (pastedText: string) => {
    // Split pasted text by comma or new line
    const pastedValues = pastedText.split(/[\n,]/).map((x) => x.trim());
    const newValue = new Set([...((value as string[]) ?? []), ...pastedValues]);
    handleChange([...newValue]);
  };

  return (
    <MultiSelectContext.Provider value={{ limit: props.limit }}>
      <MultiSelect
        data={parsedData as (string | SelectItem)[]}
        value={parsedValue}
        onChange={handleChange}
        onPaste={
          parsePaste
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                const pastedText = e.clipboardData.getData('text');
                handlePaste(pastedText);
              }
            : undefined
        }
        dropdownComponent={
          props.searchable && (!props.limit || props.limit > data.length)
            ? undefined
            : OverflowScrollArea
        }
        defaultValue={parsedDefaultValue}
        {...props}
        rightSection={loading ? <Loader size={16} /> : null}
      />
    </MultiSelectContext.Provider>
  );
}

export const OverflowScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ style, ...others }: ScrollAreaProps, ref) => {
    const { limit } = useMultiSelectContext();
    const itemCount = ((others.children as any)?.props?.children?.props.data ?? []).length; //eslint-disable-line
    return (
      <ScrollArea {...others} style={{ width: '100%', ...style }} viewportRef={ref}>
        {others.children}
        {itemCount == limit && (
          <Divider
            my="xs"
            variant="dashed"
            labelPosition="center"
            label={
              <>
                <IconSearch size={12} />
                <Box ml={5}>Search to show additional results</Box>
              </>
            }
          />
        )}
      </ScrollArea>
    );
  }
);

OverflowScrollArea.displayName = 'OverflowScrollArea';

export const MultiSelectContext = React.createContext<{ limit?: number }>({});
export const useMultiSelectContext = () => React.useContext(MultiSelectContext);
