import type { ComboboxItem, ComboboxParsedItem, SelectProps } from '@mantine/core';
import {
  getParsedComboboxData,
  Input,
  InputBase,
  isOptionsGroup,
  Select,
  Text,
  TextInput,
} from '@mantine/core';
import { IconChevronDown, IconSearch } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { SheetOption } from '~/components/Drawer/SheetOption';
import { PopoverOrSheet } from '~/components/generation_v2/PopoverOrSheet';
import { useGeneratorLayout } from '~/hooks/useMobileGenerator';

export interface SheetSelectProps extends SelectProps {
  /** Heading of the sheet; defaults to `label`. For a select whose label sits on a wrapper. */
  sheetTitle?: ReactNode;
}

/**
 * A Mantine Select that opens its options in a bottom sheet in the mobile generator. Everywhere
 * else, the legacy generator on a phone included, it is the Select itself. The sheet never
 * deselects, and props that only shape Mantine's dropdown (`comboboxProps`, `clearable`) do nothing.
 */
export function SheetSelect({ sheetTitle, ...props }: SheetSelectProps) {
  const sheet = useGeneratorLayout() === 'mobile';
  if (!sheet) return <Select {...props} />;
  return <SelectInSheet {...props} sheetTitle={sheetTitle} />;
}

function SelectInSheet({
  sheetTitle,
  data,
  value,
  onChange,
  renderOption,
  searchable,
  label,
  description,
  error,
  placeholder,
  disabled,
  required,
  withAsterisk,
  className,
  style,
  size,
  id,
}: SheetSelectProps) {
  const [opened, setOpened] = useState(false);
  const [search, setSearch] = useState('');
  const parsed = getParsedComboboxData(data);
  const items = parsed.flatMap((item) => (isOptionsGroup(item) ? item.items : [item]));
  const selected = items.find((item) => item.value === value);

  const close = () => {
    setOpened(false);
    setSearch('');
  };
  const choose = (option: ComboboxItem) => {
    if (option.value !== value) onChange?.(option.value, option);
    close();
  };

  const query = search.trim().toLowerCase();
  const matches = (option: ComboboxItem) => !query || option.label.toLowerCase().includes(query);
  const visible: ComboboxParsedItem[] = parsed
    .map((item) => (isOptionsGroup(item) ? { ...item, items: item.items.filter(matches) } : item))
    .filter((item) => (isOptionsGroup(item) ? item.items.length > 0 : matches(item)));

  const row = (option: ComboboxItem) => {
    const checked = option.value === value;
    return (
      <SheetOption
        key={option.value}
        role="option"
        selected={checked}
        disabled={option.disabled}
        onClick={() => choose(option)}
      >
        {renderOption ? renderOption({ option, checked }) : option.label}
      </SheetOption>
    );
  };

  return (
    <PopoverOrSheet
      opened={opened}
      onClose={close}
      title={sheetTitle ?? label}
      tall={searchable}
      target={
        <InputBase
          component="button"
          type="button"
          id={id}
          pointer
          label={label}
          description={description}
          error={error}
          required={required}
          withAsterisk={withAsterisk}
          disabled={disabled}
          className={className}
          style={style}
          size={size}
          rightSection={<IconChevronDown size={16} />}
          rightSectionPointerEvents="none"
          aria-haspopup="dialog"
          onClick={() => setOpened(true)}
        >
          {selected ? (
            <span className="block truncate">{selected.label}</span>
          ) : (
            <Input.Placeholder>{placeholder}</Input.Placeholder>
          )}
        </InputBase>
      }
    >
      <div className="flex flex-col gap-2">
        {searchable && (
          <TextInput
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search"
            leftSection={<IconSearch size={16} />}
            aria-label="Search options"
          />
        )}
        <div role="listbox" aria-label={typeof label === 'string' ? label : undefined}>
          {visible.map((item) =>
            isOptionsGroup(item) ? (
              <div key={item.group} role="group" aria-label={item.group}>
                <Text size="xs" fw={600} c="dimmed" tt="uppercase" className="px-3 pb-1 pt-3">
                  {item.group}
                </Text>
                {item.items.map(row)}
              </div>
            ) : (
              row(item)
            )
          )}
          {visible.length === 0 && (
            <Text size="sm" c="dimmed" className="px-3 py-4">
              Nothing matches
            </Text>
          )}
        </div>
      </div>
    </PopoverOrSheet>
  );
}
