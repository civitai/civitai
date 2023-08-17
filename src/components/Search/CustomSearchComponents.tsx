import {
  RefinementListProps,
  SearchBoxProps,
  SortByProps,
  useClearRefinements,
  useConfigure,
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

const useStyles = createStyles((theme) => ({
  divider: {
    flex: 1,
    borderBottom: 0,
    border: '1px solid',
    borderColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[3],
  },
}));

const useSearchInputStyles = createStyles((theme) => ({
  root: {
    [theme.fn.smallerThan('md')]: {
      height: '100%',
    },
  },
  wrapper: {
    [theme.fn.smallerThan('md')]: {
      height: '100%',
    },
  },
  input: {
    [theme.fn.smallerThan('md')]: {
      height: '100%',
    },
  },
}));

export function SortBy({ title, ...props }: SortByProps & { title: string }) {
  const { classes } = useStyles();
  const { options, refine, currentRefinement, ...args } = useSortBy(props);

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
  const { items, refine, searchForItems, isFromSearch } = useRefinementList({ ...props });
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
            nothingFound="Nothing found"
          />
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

export function SearchableFilterList({
  title,
  comparisonOperator = '=',
  dividerOperator = 'OR',
  isNegative = false,
  ...props
}: RefinementListProps & {
  title: string;
  comparisonOperator?: '=' | '!=';
  dividerOperator?: 'AND' | 'OR';
  isNegative?: boolean;
}) {
  const { classes } = useStyles();
  const { refine } = useConfigure({});
  const { items, searchForItems, isFromSearch } = useRefinementList({ ...props });
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

      setRefinedItems([...refinedItems, item]);
    } else {
      // Remove the item that was removed:
      const removedItem = refinedItems.filter(
        (item) => !updatedSelectedItems.includes(item.value)
      )[0];

      if (!removedItem) {
        return;
      }

      setRefinedItems(refinedItems.filter((item) => item.value !== removedItem.value));
    }
  };

  useEffect(() => {
    if (props.searchable) {
      searchForItems(debouncedSearchValue);
    }
  }, [debouncedSearchValue]);

  useEffect(() => {
    const prepareFilter = (items: any[]) => {
      if (items.length === 0) {
        return '';
      }

      const filter = items.map((item) => {
        const itemFilter = `"${props.attribute}"${comparisonOperator}"${item.value}"`;

        if (isNegative) {
          return `NOT(${itemFilter})`;
        }

        return itemFilter;
      });

      return filter.join(` ${dividerOperator} `);
    };

    const updatedFilters = prepareFilter(refinedItems);

    refine({
      filters: updatedFilters,
    });
  }, [refinedItems]);

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
            nothingFound="Nothing found"
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
                {getDisplayName(item.label)}
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
