import {
  Configure,
  ConfigureProps,
  RangeInputProps,
  RefinementListProps,
  SearchBoxProps,
  SortByProps,
  useClearRefinements,
  useConfigure,
  useRange,
  useRefinementList,
  useSearchBox,
  useSortBy,
} from 'react-instantsearch';
import {
  Accordion,
  Box,
  Button,
  ButtonProps,
  Chip,
  Code,
  createStyles,
  Group,
  HoverCard,
  MultiSelect,
  Select,
  Text,
  TextInput,
} from '@mantine/core';
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { getHotkeyHandler, useDebouncedValue, useHotkeys } from '@mantine/hooks';
import { IconSearch, IconTrash } from '@tabler/icons-react';
import { getDisplayName } from '~/utils/string-helpers';
import { RenderSearchComponentProps } from '~/components/AppLayout/AppHeader';
import { uniqBy } from 'lodash-es';
import { DatePicker } from '@mantine/dates';
import dayjs from 'dayjs';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { TimeoutLoader } from './TimeoutLoader';
import { useBrowsingLevelDebounced } from '../BrowsingLevel/BrowsingLevelProvider';
import { Flags } from '~/shared/utils';

const useStyles = createStyles((theme) => ({
  divider: {
    flex: 1,
    borderBottom: 0,
    border: '1px solid',
    borderColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[3],
  },
}));

const useSearchInputStyles = createStyles(() => ({
  root: {
    [containerQuery.smallerThan('md')]: {
      height: '100%',
    },
  },
  wrapper: {
    [containerQuery.smallerThan('md')]: {
      height: '100%',
    },
  },
  input: {
    [containerQuery.smallerThan('md')]: {
      height: '100%',
    },
  },
}));

export function SortBy({ title, ...props }: SortByProps & { title: string }) {
  const { classes } = useStyles();
  const { options, refine, currentRefinement } = useSortBy(props);

  if (options.length === 0) {
    return null;
  }

  return (
    <Accordion defaultValue={title} variant="filled">
      <Accordion.Item value={title}>
        <Accordion.Control>
          <Group>
            <Text size="md" weight={500}>
              {title}
            </Text>
            <Box className={classes.divider} />
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <Select
            name="sort"
            data={options}
            value={currentRefinement}
            onChange={(value) => refine(value || options[0].value)}
          />
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

export function SearchableMultiSelectRefinementList({
  title,
  ...props
}: RefinementListProps & { title: string }) {
  const { classes } = useStyles();
  const { items, refine, searchForItems } = useRefinementList({ ...props });
  const [searchValue, setSearchValue] = useState('');
  const [debouncedSearchValue] = useDebouncedValue(searchValue, 300);
  // We need to keep the state of the select here because the items may dissapear while searching.
  const [refinedItems, setRefinedItems] = useState<typeof items>(
    (items ?? []).filter((item) => item.isRefined) ?? []
  );

  const onUpdateSelection = (updatedSelectedItems: string[]) => {
    const addedItems = updatedSelectedItems.length > refinedItems.length;
    if (addedItems) {
      // Get the last item:
      const lastAddedValue = updatedSelectedItems[updatedSelectedItems.length - 1];
      const item = items.find((item) => item.value === lastAddedValue);

      if (!item) {
        return;
      }

      refine(item.value);
      setRefinedItems([...refinedItems, item]);
    } else {
      // Remove the item that was removed:
      const removedItem = refinedItems.filter(
        (item) => !updatedSelectedItems.includes(item.value)
      )[0];

      if (!removedItem) {
        return;
      }

      refine(removedItem.value);
      setRefinedItems(refinedItems.filter((item) => item.value !== removedItem.value));
    }
  };

  useEffect(() => {
    if (props.searchable) {
      searchForItems(debouncedSearchValue);
    }
  }, [debouncedSearchValue]);

  useEffect(() => {
    const itemsAreRefined = items.filter((item) => item.isRefined);

    if (refinedItems.length === 0 && itemsAreRefined.length > 0) {
      // On initial render refine items
      setRefinedItems(itemsAreRefined);
    }
  }, [items, refinedItems]);

  const data = uniqBy([...refinedItems, ...items], 'value').map((item) => ({
    label: item.label,
    value: item.value,
  }));

  return (
    <Accordion defaultValue={props.attribute} variant="filled">
      <Accordion.Item value={props.attribute}>
        <Accordion.Control>
          <Group>
            <Text size="md" weight={500}>
              {title}
            </Text>
            <Box className={classes.divider} />
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <MultiSelect
            data={data}
            value={refinedItems.map((item) => item.value)}
            onChange={onUpdateSelection}
            searchable
            searchValue={searchValue}
            onSearchChange={setSearchValue}
            placeholder={`Search ${title}`}
            nothingFound={<TimeoutLoader renderTimeout={() => <span>Nothing found</span>} />}
          />
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

export function ChipRefinementList({ title, ...props }: RefinementListProps & { title: string }) {
  const { classes } = useStyles();
  const { items, refine } = useRefinementList({ ...props });

  if (!items.length) {
    return null;
  }

  return (
    <Accordion defaultValue={props.attribute} variant="filled">
      <Accordion.Item value={props.attribute}>
        <Accordion.Control>
          <Group>
            <Text size="md" weight={500}>
              {title}
            </Text>{' '}
            <Box className={classes.divider} />
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <Group spacing="xs">
            {items.map((item) => (
              <Chip
                size="sm"
                key={item.value}
                checked={item.isRefined}
                onClick={() => refine(item.value)}
              >
                {getDisplayName(item.label, { splitNumbers: false })}
              </Chip>
            ))}
          </Group>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

export const ClearRefinements = ({ ...props }: ButtonProps) => {
  const { refine, canRefine } = useClearRefinements();

  if (!canRefine) {
    return null;
  }

  return (
    <Button
      rightIcon={<IconTrash size={16} />}
      color="gray"
      variant="filled"
      size="md"
      sx={{ flexShrink: 0 }}
      {...props}
      onClick={refine}
    >
      Reset all filters
    </Button>
  );
};

export const BrowsingLevelFilter = ({
  attributeName,
  ...props
}: { attributeName: string } & ConfigureProps) => {
  const browsingLevel = useBrowsingLevelDebounced();
  const browsingLevelArray = Flags.instanceToArray(browsingLevel);
  const { refine } = useConfigure({
    ...props,
    filters: attributeName
      ? browsingLevelArray.map((value) => `${attributeName}=${value}`).join(' OR ')
      : undefined,
  });

  return null;
};

export const CustomSearchBox = forwardRef<
  { focus: () => void },
  SearchBoxProps & RenderSearchComponentProps
>(({ isMobile, onSearchDone, ...props }, ref) => {
  const { query, refine } = useSearchBox({ ...props });
  const [search, setSearch] = useState(query);
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const { classes } = useSearchInputStyles();
  const inputRef = useRef<HTMLInputElement>(null);

  const blurInput = () => inputRef.current?.blur();
  const focusInput = () => inputRef.current?.focus();

  useImperativeHandle(ref, () => ({
    focus: focusInput,
  }));

  useEffect(() => {
    if (debouncedSearch !== query) {
      refine(debouncedSearch);
    }
  }, [debouncedSearch]);

  useEffect(() => {
    // If another search box is active somewhere, ensures we keep these 2 the same.
    if (query !== search) {
      setSearch(query);
    }
  }, [query]);

  useHotkeys([
    ['/', focusInput],
    ['mod+k', focusInput],
  ]);

  return (
    <TextInput
      {...props}
      classNames={classes}
      variant={isMobile ? 'filled' : undefined}
      icon={<IconSearch size={20} />}
      onChange={(e) => setSearch(e.target.value)}
      value={search}
      placeholder="Search..."
      onBlur={onSearchDone}
      onSubmit={onSearchDone}
      ref={inputRef}
      onKeyDown={getHotkeyHandler([['Escape', blurInput]])}
      rightSection={
        !isMobile && (
          <HoverCard withArrow width={300} shadow="sm" openDelay={500}>
            <HoverCard.Target>
              <Text
                weight="bold"
                sx={(theme) => ({
                  border: `1px solid ${
                    theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
                  }`,
                  borderRadius: theme.radius.sm,
                  backgroundColor:
                    theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[0],
                  color: theme.colorScheme === 'dark' ? theme.colors.gray[5] : theme.colors.gray[6],
                  textAlign: 'center',
                  width: 24,
                  userSelect: 'none',
                })}
              >
                /
              </Text>
            </HoverCard.Target>
            <HoverCard.Dropdown>
              <Text size="sm" color="yellow" weight={500}>
                Pro-tip: Quick search faster!
              </Text>
              <Text size="xs" lh={1.2}>
                Open the quick search without leaving your keyboard by tapping the <Code>/</Code>{' '}
                key from anywhere and just start typing.
              </Text>
            </HoverCard.Dropdown>
          </HoverCard>
        )
      }
    />
  );
});

CustomSearchBox.displayName = 'CustomSearchBox';

export function DateRangeRefinement({ title, ...props }: RangeInputProps & { title: string }) {
  const { classes } = useStyles();
  const { start: active, range, refine } = useRange({ ...props });

  const startDate = active[0] && active[0] !== -Infinity ? new Date(active[0]) : null;
  const endDate = active[1] && active[1] !== Infinity ? new Date(active[1]) : null;
  const maxDate = range.max ? new Date(range.max) : undefined;
  const minDate = range.min ? new Date(range.min) : undefined;

  const onSetDate = (type: 'start' | 'end', date?: Date | null) => {
    if (type === 'start') {
      // Seems tricky, but for some reason, if you don't specify the end here, it breaks :shrug:
      // looks like a bug in the algolia react-instantsearch library.
      const end = active[1] === Infinity ? range.max : active[1];
      refine([date ? Math.max(date.getTime(), range.min ?? -Infinity) : undefined, end]);
    } else {
      const start = active[0] === -Infinity ? range.min : active[0];
      refine([start, date ? Math.min(date.getTime(), range.max ?? Infinity) : undefined]);
    }
  };

  return (
    <Accordion defaultValue={props.attribute} variant="filled">
      <Accordion.Item value={props.attribute}>
        <Accordion.Control>
          <Group>
            <Text size="md" weight={500}>
              {title}
            </Text>
            <Box className={classes.divider} />
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <DatePicker
            label="From"
            name="start"
            placeholder="Start date"
            value={startDate}
            onChange={(date) => {
              onSetDate('start', date);
            }}
            minDate={minDate}
            maxDate={endDate ? dayjs(endDate).subtract(1, 'day').toDate() : maxDate}
            clearButtonLabel="Clear start date"
          />
          <DatePicker
            label="To"
            name="end"
            placeholder="End date"
            value={endDate}
            onChange={(date) => {
              onSetDate('end', date);
            }}
            minDate={startDate ? dayjs(startDate).add(1, 'day').toDate() : minDate}
            clearButtonLabel="Clear end date"
            maxDate={maxDate}
          />
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
