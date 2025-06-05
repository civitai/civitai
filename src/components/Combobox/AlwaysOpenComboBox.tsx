import { Combobox, ComboboxInput, ComboboxOptions, ComboboxOption } from '@headlessui/react';
import { Divider, Input, Loader, ScrollArea, Text } from '@mantine/core';
import type { Key } from 'react';
import React, { useState } from 'react';
import type { ComboboxOption as ComboboxOptionProps } from '~/components/Combobox/combobox.types';

type Props<T extends Key, TOption extends ComboboxOptionProps> = {
  value?: T[];
  onChange?: (value: T[]) => void;
  maxScrollHeight?: number;
  options?: TOption[];
  renderOption?: (
    props: { active: boolean; selected: boolean; disabled: boolean } & TOption
  ) => React.ReactNode;
  footer?: React.ReactNode;
  showSelected?: boolean;
  loading?: boolean;
};

export function AlwaysOpenCombobox<T extends Key, TOption extends ComboboxOptionProps>({
  value,
  onChange,
  maxScrollHeight = 250,
  options = [],
  renderOption,
  footer,
  showSelected,
  loading,
}: Props<T, TOption>) {
  const [search, setSearch] = useState('');

  const filtered = search.length
    ? options.filter((x) => {
        const match = x.label.toLowerCase().includes(search);
        if (showSelected) return match || value?.includes(x.value as T);
        return match;
      })
    : options;

  const grouped = filtered.reduce<Record<string, TOption[]>>((acc, option) => {
    const { group = 'undefined' } = option;
    if (!acc[group]) acc[group] = [];
    acc[group].push(option);
    return acc;
  }, {});

  const tupleOptions = Object.entries(grouped);
  const nothingFound = !tupleOptions.length;

  return (
    <div className="flex flex-col">
      <Combobox
        value={value}
        onChange={onChange}
        // @ts-ignore eslint-disable-next-line
        multiple
      >
        <ComboboxInput
          as={Input}
          onChange={(e) => setSearch(e.target.value.toLowerCase())}
          displayValue={() => search}
          // @ts-ignore eslint-disable-next-line
          placeholder="search..."
          className="m-2"
          radius="xl"
        />
        <Divider />
        <ScrollArea.Autosize
          mah={maxScrollHeight}
          type="always"
          offsetScrollbars
          styles={{
            // TODO: Mantine7: move this to css module
            scrollbar: { '&[data-orientation="horizontal"]': { display: 'none' } },
            viewport: { paddingBottom: 0 },
          }}
        >
          {loading ? (
            <div className="flex justify-center p-3">
              <Loader />
            </div>
          ) : nothingFound ? (
            <Text align="center" className="p-2" c="dimmed">
              Nothing found
            </Text>
          ) : (
            <div className="p-2 pr-0">
              <ComboboxOptions static>
                {tupleOptions.map(([key, options]) => (
                  <React.Fragment key={key}>
                    {!!options.length && key !== 'undefined' && (
                      <Divider
                        label={
                          <Text
                            component="li"
                            c="dimmed"
                            className="px-2 py-1 text-sm font-semibold"
                          >
                            {key}
                          </Text>
                        }
                      />
                    )}
                    {options.map((option) => (
                      <ComboboxOption
                        key={option.value}
                        value={option.value}
                        className={({ active }) =>
                          `flex justify-between items-center gap-3 py-1 px-2 cursor-pointer rounded ${
                            active ? 'bg-gray-1 dark:bg-dark-5' : ''
                          }`
                        }
                      >
                        {(props) => <>{renderOption?.({ ...props, ...option }) ?? option.label}</>}
                      </ComboboxOption>
                    ))}
                  </React.Fragment>
                ))}
              </ComboboxOptions>
            </div>
          )}
        </ScrollArea.Autosize>
      </Combobox>
      {footer}
    </div>
  );
}
