import type {
  MultiSelectProps,
  ComboboxItem,
  ScrollAreaProps,
  PillsInputProps,
} from '@mantine/core';
import {
  MultiSelect,
  ScrollArea,
  Divider,
  Box,
  Loader,
  Combobox,
  CheckIcon,
  Group,
  Pill,
  PillsInput,
  useCombobox,
  ActionIcon,
} from '@mantine/core';
import { IconSearch, IconX } from '@tabler/icons-react';
import React, { useMemo, forwardRef, useState } from 'react';

type SelectItemProps<T extends string | number> = Omit<ComboboxItem, 'value'> & {
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

  const parsedData = data.map((x): string | ComboboxItem => {
    if (typeof x === 'string') return x;
    return {
      ...x,
      value: String(x.value),
    } as ComboboxItem;
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
        data={parsedData as (string | ComboboxItem)[]}
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
        // dropdownComponent={
        //   props.searchable && (!props.limit || props.limit > data.length)
        //     ? undefined
        //     : OverflowScrollArea
        // }
        defaultValue={parsedDefaultValue}
        {...props}
        rightSection={loading ? <Loader size={16} /> : null}
      />
    </MultiSelectContext.Provider>
  );
}

// TODO: Mantine7: Consider removing this
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

type CreatableMultiSelectProps = Omit<PillsInputProps, 'onChange'> & {
  value?: string[];
  data?: string[];
  onChange?: (value: string[]) => void;
  loading?: boolean;
  parsePaste?: boolean;
  clearable?: boolean;
  maxValues?: number;
};

export function CreatableMultiSelect({
  value = [],
  data = [],
  onChange,
  placeholder,
  loading,
  clearable,
  parsePaste,
  maxValues = Infinity,
  ...props
}: CreatableMultiSelectProps) {
  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
    onDropdownOpen: () => combobox.updateSelectedOptionIndex('active'),
  });

  const [search, setSearch] = useState('');

  const exactOptionMatch = data.some((item) => item === search);

  const handleValueSelect = (val: string) => {
    if (value.length >= maxValues) return;

    setSearch('');
    combobox.closeDropdown();

    if (val === '$create') {
      const cleanedSearch = search
        .split(',')
        .slice(0, maxValues)
        .map((x) => x.trim())
        .filter(Boolean);
      const newValue = new Set([...value, ...cleanedSearch]);
      onChange?.([...newValue]);
    } else {
      onChange?.(value.includes(val) ? value.filter((v) => v !== val) : [...value, val]);
    }
  };

  const handleValueRemove = (val: string) => onChange?.(value.filter((item) => item !== val));

  const handlePaste = (pastedText: string) => {
    // Split pasted text by comma or new line
    const pastedValues = pastedText
      .split(/[\n,]/)
      .slice(0, maxValues)
      .map((x) => x.trim());
    const newValue = new Set([...((value as string[]) ?? []), ...pastedValues]);
    onChange?.([...newValue]);
  };

  const values = value.map((item) => (
    <Pill key={item} withRemoveButton onRemove={() => handleValueRemove(item)}>
      {item}
    </Pill>
  ));

  const options = data
    .filter((item) => item.toLowerCase().includes(search.trim().toLowerCase()))
    .map((item) => (
      <Combobox.Option value={item} key={item} active={value.includes(item)}>
        <Group gap="sm">
          {value.includes(item) ? <CheckIcon size={12} /> : null}
          <span>{item}</span>
        </Group>
      </Combobox.Option>
    ));

  const reachedMaxValues = value.length >= maxValues;

  return (
    <Combobox store={combobox} onOptionSubmit={handleValueSelect} withinPortal={false}>
      <Combobox.DropdownTarget>
        <PillsInput
          {...props}
          rightSection={
            loading ? (
              <Loader />
            ) : clearable && value.length ? (
              <ActionIcon variant="transparent" size="sm" onClick={() => onChange?.([])}>
                <IconX />
              </ActionIcon>
            ) : undefined
          }
          onClick={() => combobox.openDropdown()}
        >
          <Pill.Group>
            {values}

            {!reachedMaxValues && (
              <Combobox.EventsTarget>
                <PillsInput.Field
                  onFocus={() => combobox.openDropdown()}
                  onBlur={() => combobox.closeDropdown()}
                  value={search}
                  placeholder={placeholder ?? 'Search values'}
                  onChange={(event) => {
                    combobox.updateSelectedOptionIndex();
                    setSearch(event.currentTarget.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Backspace' && search.length === 0 && value.length > 0) {
                      event.preventDefault();
                      handleValueRemove(value[value.length - 1]);
                    }
                  }}
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
                />
              </Combobox.EventsTarget>
            )}
          </Pill.Group>
        </PillsInput>
      </Combobox.DropdownTarget>

      {!reachedMaxValues && (
        <Combobox.Dropdown>
          <Combobox.Options>
            <ScrollArea.Autosize mah={200}>
              {options}

              {!exactOptionMatch && search.trim().length > 0 && (
                <Combobox.Option value="$create">+ Create {search}</Combobox.Option>
              )}

              {exactOptionMatch && search.trim().length > 0 && options.length === 0 && (
                <Combobox.Empty>Nothing found</Combobox.Empty>
              )}
            </ScrollArea.Autosize>
          </Combobox.Options>
        </Combobox.Dropdown>
      )}
    </Combobox>
  );
}
