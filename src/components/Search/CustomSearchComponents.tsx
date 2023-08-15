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
  createStyles,
  Group,
  MultiSelect,
  Select,
  Text,
  TextInput,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useDebouncedValue } from '@mantine/hooks';
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

  const data = (isFromSearch ? [...refinedItems, ...items] : items).map((item) => ({
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

export const CustomSearchBox = ({
  isMobile,
  onSearchDone,
  ...props
}: SearchBoxProps & RenderSearchComponentProps) => {
  const { query, refine } = useSearchBox({ ...props });
  const [search, setSearch] = useState(query);
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const { classes } = useSearchInputStyles();

  useEffect(() => {
    if (debouncedSearch !== query) {
      refine(debouncedSearch);
    }
  }, [debouncedSearch]);

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
    />
  );
};
