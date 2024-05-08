import { Combobox } from '@headlessui/react';
import { Divider, Input, ScrollArea, Text, createStyles } from '@mantine/core';
import React, { Key, useState } from 'react';
import { ComboboxOption } from '~/components/Combobox/combobox.types';

type Props<T extends Key, TOption extends ComboboxOption> = {
  value?: T[];
  onChange?: (value: T[]) => void;
  maxScrollHeight?: number;
  options?: TOption[];
  renderOption?: (
    props: { active: boolean; selected: boolean; disabled: boolean } & TOption
  ) => React.ReactNode;
  footer?: React.ReactNode;
};

export function AlwaysOpenCombobox<T extends Key, TOption extends ComboboxOption>({
  value,
  onChange,
  maxScrollHeight = 250,
  options = [],
  renderOption,
  footer,
}: Props<T, TOption>) {
  const { classes } = useStyles();
  const [search, setSearch] = useState('');

  const filtered = search.length
    ? options.filter((x) => x.label.toLowerCase().includes(search))
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
        <Combobox.Input
          as={Input}
          onChange={(e) => setSearch(e.target.value.toLowerCase())}
          displayValue={() => search}
          // @ts-ignore eslint-disable-next-line
          placeholder="search..."
          className="m-2"
          radius="xl"
          auto
        />
        <Divider />
        <ScrollArea.Autosize
          maxHeight={maxScrollHeight}
          type="always"
          offsetScrollbars
          classNames={classes}
        >
          {nothingFound ? (
            <Text align="center" className="p-2" color="dimmed">
              Nothing found
            </Text>
          ) : (
            <div className="p-2 pr-0">
              <Combobox.Options static>
                {tupleOptions.map(([key, options]) => (
                  <React.Fragment key={key}>
                    {!!options.length && key !== 'undefined' && (
                      <Divider
                        label={
                          <Text
                            component="li"
                            color="dimmed"
                            className="py-1 px-2 font-semibold text-sm"
                          >
                            {key}
                          </Text>
                        }
                      />
                    )}
                    {options.map((option) => (
                      <Combobox.Option
                        key={option.value}
                        value={option.value}
                        className={({ active }) =>
                          `flex justify-between items-center gap-3 py-1 px-2 cursor-pointer rounded ${
                            active ? 'bg-gray-1 dark:bg-dark-5' : ''
                          }`
                        }
                      >
                        {(props) => <>{renderOption?.({ ...props, ...option }) ?? option.label}</>}
                      </Combobox.Option>
                    ))}
                  </React.Fragment>
                ))}
              </Combobox.Options>
            </div>
          )}
        </ScrollArea.Autosize>
      </Combobox>
      {footer}
    </div>
  );
}

const useStyles = createStyles(() => ({
  viewport: { paddingBottom: 0 },
  scrollbar: {
    '&[data-orientation="horizontal"]': { display: 'none' },
  },
}));
