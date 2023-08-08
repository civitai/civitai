import { AutocompleteItem, Code, HoverCard, Text, createStyles } from '@mantine/core';
import { getHotkeyHandler, useHotkeys } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import type { Hit } from 'instantsearch.js';
import { debounce } from 'lodash-es';
import { useRouter } from 'next/router';
import { forwardRef, useMemo, useRef } from 'react';
import { Highlight, SearchBoxProps, useHits, useSearchBox } from 'react-instantsearch-hooks-web';
import { ModelGetAll } from '~/types/router';
import { ClearableAutoComplete } from '../ClearableAutoComplete/ClearableAutoComplete';

type Props = SearchBoxProps & {
  className?: string;
};
type ModelGetAllItem = ModelGetAll['items'][number];

export function AutocompleteSearch({ className, ...searchBoxProps }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const { query, refine: setQuery } = useSearchBox(searchBoxProps);
  const { hits } = useHits<ModelGetAllItem>();
  const debouncedSetQuery = useMemo(() => debounce(setQuery, 300), [setQuery]);

  const focusInput = () => inputRef.current?.focus();
  const blurInput = () => inputRef.current?.blur();

  useHotkeys([
    ['/', focusInput],
    ['mod+k', focusInput],
  ]);

  return (
    <ClearableAutoComplete
      ref={inputRef}
      placeholder="Search models, users, images, tags, etc."
      type="search"
      nothingFound="No results found"
      icon={<IconSearch />}
      limit={10}
      defaultValue={query}
      data={hits.map((hit) => ({ value: hit.name, hit }))}
      onChange={debouncedSetQuery}
      onKeyDown={getHotkeyHandler([['Escape', blurInput]])}
      onClear={() => setQuery('')}
      onItemSubmit={(item) => router.push(`/search?q=${encodeURIComponent(item.value)}`)}
      itemComponent={SearchItem}
      rightSection={
        <HoverCard withArrow width={300} zIndex={10000} shadow="sm" openDelay={500}>
          <HoverCard.Target>
            <Text
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
              weight="bold"
            >
              /
            </Text>
          </HoverCard.Target>
          <HoverCard.Dropdown>
            <Text size="sm" color="yellow" weight={500}>
              Pro-tip: Quick search faster!
            </Text>
            <Text size="xs" lh={1.2}>
              Open the quick search without leaving your keyboard by tapping the <Code>/</Code> key
              from anywhere and just start typing.
            </Text>
          </HoverCard.Dropdown>
        </HoverCard>
      }
      // prevents default filtering behavior
      filter={() => true}
      clearable={query.length > 0}
    />
  );
}

type SearchItemProps = AutocompleteItem & { hit: Hit<ModelGetAllItem> };

const useSearchItemStyles = createStyles((theme) => ({
  highlighted: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.yellow[5] : theme.colors.yellow[2],
  },
}));

const SearchItem = forwardRef<HTMLDivElement, SearchItemProps>(({ value, hit, ...props }, ref) => {
  const { classes } = useSearchItemStyles();

  return (
    <div ref={ref} {...props}>
      <Text>
        <Highlight attribute="name" hit={hit} classNames={classes} />
      </Text>
    </div>
  );
});
SearchItem.displayName = 'SearchItem';
