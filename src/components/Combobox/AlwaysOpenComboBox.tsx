import { Combobox, ComboboxInput, ComboboxOptions, ComboboxOption } from '@headlessui/react';
import { Divider, Input, Loader, ScrollArea, Text } from '@mantine/core';
import React, { Key, useState } from 'react';
import { ComboboxOption as ComboboxOptionProps } from '~/components/Combobox/combobox.types';
import classes from './AlwaysOpenComboBox.module.scss';

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
    <div className={classes.root}>
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
          className={classes.input}
        />
        <Divider />
        <ScrollArea.Autosize
          maxHeight={maxScrollHeight}
          type="always"
          offsetScrollbars
          classNames={classes}
        >
          {loading ? (
            <div className={classes.loadingContainer}>
              <Loader />
            </div>
          ) : nothingFound ? (
            <Text align="center" className="p-2" color="dimmed">
              Nothing found
            </Text>
          ) : (
            <div className={classes.optionsContainer}>
              <ComboboxOptions static>
                {tupleOptions.map(([key, options]) => (
                  <React.Fragment key={key}>
                    {!!options.length && key !== 'undefined' && (
                      <Divider
                        label={
                          <Text component="li" color="dimmed" className={classes.groupLabel}>
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
                          `${classes.option} ${active ? classes.optionActive : ''}`
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

