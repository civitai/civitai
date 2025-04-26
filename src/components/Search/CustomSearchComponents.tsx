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
import { RenderSearchComponentProps } from '~/components/AppLayout/AppHeader/AppHeader';
import { uniqBy } from 'lodash-es';
import { DatePicker } from '@mantine/dates';
import dayjs from 'dayjs';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { TimeoutLoader } from './TimeoutLoader';
import { useBrowsingLevelDebounced } from '../BrowsingLevel/BrowsingLevelProvider';
import { Flags } from '~/shared/utils';
import styles from './CustomSearchComponents.module.scss';

export function SortBy({ title, ...props }: SortByProps & { title: string }) {
  const { options, refine, currentRefinement } = useSortBy(props);

  return (
    <Select
      label={title}
      value={currentRefinement}
      onChange={(value) => refine(value || '')}
      data={options.map((option) => ({
        value: option.value,
        label: option.label,
      }))}
      className={styles.divider}
    />
  );
}

export function RefinementList({ title, ...props }: RefinementListProps & { title: string }) {
  const { items, refine, searchForItems } = useRefinementList({ ...props });
  const [searchValue, setSearchValue] = useState('');

  return (
    <Box>
      <TextInput
        placeholder={`Search ${title.toLowerCase()}`}
        value={searchValue}
        onChange={(e) => {
          setSearchValue(e.currentTarget.value);
          searchForItems(e.currentTarget.value);
        }}
        className={styles.divider}
      />
      <Accordion>
        {items.map((item) => (
          <Accordion.Item key={item.label} value={item.label}>
            <Accordion.Control>
              <Group position="apart">
                <Text>{item.label}</Text>
                <Text color="dimmed">({item.count})</Text>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <Button
                variant="subtle"
                color={item.isRefined ? 'blue' : 'gray'}
                onClick={() => refine(item.value)}
                fullWidth
              >
                {item.label} ({item.count})
              </Button>
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>
    </Box>
  );
}

export function ChipRefinementList({ title, ...props }: RefinementListProps & { title: string }) {
  const { items, refine } = useRefinementList({ ...props });

  return (
    <Box>
      <Text weight={500} size="sm" mb="xs">
        {title}
      </Text>
      <Chip.Group>
        {items.map((item) => (
          <Chip
            key={item.label}
            value={item.value}
            checked={item.isRefined}
            onChange={() => refine(item.value)}
          >
            {item.label} ({item.count})
          </Chip>
        ))}
      </Chip.Group>
    </Box>
  );
}

export function SearchBox({ ...props }: SearchBoxProps) {
  const { query, refine } = useSearchBox(props);
  const [search, setSearch] = useState(query);
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    refine(debouncedSearch);
  }, [debouncedSearch]);

  return (
    <TextInput
      ref={inputRef}
      placeholder="Search..."
      value={search}
      onChange={(e) => setSearch(e.currentTarget.value)}
      classNames={{
        root: styles.searchRoot,
        wrapper: styles.searchWrapper,
        input: styles.searchInput,
      }}
    />
  );
}

export function DateRangeRefinement({ title, ...props }: RangeInputProps & { title: string }) {
  const { start: active, range, refine } = useRange({ ...props });

  const handleDateChange = (date: Date | null) => {
    if (date) {
      const timestamp = date.getTime();
      refine([timestamp, timestamp]);
    } else {
      refine([-Infinity, Infinity]);
    }
  };

  const currentDate =
    active[0] !== -Infinity && active[0] !== undefined ? new Date(active[0]) : null;

  return (
    <Box>
      <Text weight={500} size="sm" mb="xs">
        {title}
      </Text>
      <DatePicker value={currentDate} onChange={handleDateChange} className={styles.divider} />
    </Box>
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
  const { classes } = styles;
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

export const ApplyCustomFilter = ({ filters, ...props }: { filters: string } & ConfigureProps) => {
  const { refine } = useConfigure({
    ...props,
    filters: filters,
  });

  useEffect(() => {
    refine(filters);
  }, [filters]);

  return null;
};
