import {
  ActionIcon,
  AutocompleteItem,
  AutocompleteProps,
  Code,
  Group,
  HoverCard,
  Select,
  Stack,
  Text,
  createStyles,
} from '@mantine/core';
import { getHotkeyHandler, useDebouncedValue, useHotkeys } from '@mantine/hooks';
import { IconChevronDown, IconSearch } from '@tabler/icons-react';
import type { Hit } from 'instantsearch.js';
import { useRouter } from 'next/router';
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  Fragment,
} from 'react';
import {
  Configure,
  InstantSearch,
  InstantSearchProps,
  SearchBoxProps,
  useInstantSearch,
  useSearchBox,
} from 'react-instantsearch';
import { ClearableAutoComplete } from '~/components/ClearableAutoComplete/ClearableAutoComplete';
import { slugit } from '~/utils/string-helpers';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { env } from '~/env/client.mjs';
import { ModelSearchItem } from '~/components/AutocompleteSearch/renderItems/models';
import { ArticlesSearchItem } from '~/components/AutocompleteSearch/renderItems/articles';
import { UserSearchItem } from '~/components/AutocompleteSearch/renderItems/users';
import { ImagesSearchItem } from '~/components/AutocompleteSearch/renderItems/images';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import { CollectionsSearchItem } from '~/components/AutocompleteSearch/renderItems/collections';
import { BountiesSearchItem } from '~/components/AutocompleteSearch/renderItems/bounties';
import { useTrackEvent } from '../TrackView/track.utils';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { SearchIndexDataMap, useHitsTransformed } from '~/components/Search/search.utils2';
import {
  ReverseSearchIndexKey,
  SearchIndexKey,
  reverseSearchIndexMap,
  searchIndexMap,
} from '~/components/Search/search.types';
import { paired } from '~/utils/type-guards';
import { BrowsingLevelFilter } from '../Search/CustomSearchComponents';
import { QS } from '~/utils/qs';

const meilisearch = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id' }
);

type Props = Omit<AutocompleteProps, 'data' | 'onSubmit'> & {
  onClear?: VoidFunction;
  onSubmit?: VoidFunction;
  searchBoxProps?: SearchBoxProps;
};

const searchClient: InstantSearchProps['searchClient'] = {
  ...meilisearch,
  search(requests) {
    // Prevent making a request if there is no query
    // @see https://www.algolia.com/doc/guides/building-search-ui/going-further/conditional-requests/react/#detecting-empty-search-requests
    // @see https://github.com/algolia/react-instantsearch/issues/1111#issuecomment-496132977
    if (requests.every(({ params }) => !params?.query)) {
      return Promise.resolve({
        results: requests.map(() => ({
          hits: [],
          nbHits: 0,
          nbPages: 0,
          page: 0,
          processingTimeMS: 0,
          hitsPerPage: 0,
          exhaustiveNbHits: false,
          query: '',
          params: '',
        })),
      });
    }

    return meilisearch.search(requests);
  },
};

const DEFAULT_DROPDOWN_ITEM_LIMIT = 6;
const useStyles = createStyles((theme) => ({
  root: {
    flexGrow: 1,

    [theme.fn.smallerThan('md')]: {
      height: '100%',
      flexGrow: 1,
    },
  },
  wrapper: {
    [theme.fn.smallerThan('md')]: {
      height: '100%',
    },
  },
  input: {
    borderRadius: 0,

    [theme.fn.smallerThan('md')]: {
      height: '100%',
    },
  },
  dropdown: {
    [theme.fn.smallerThan('sm')]: {
      marginTop: '-7px',
    },
  },

  targetSelectorRoot: {
    width: '110px',

    [theme.fn.smallerThan('md')]: {
      display: 'none', // TODO.search: Remove this once we figure out a way to prevent hiding the whole bar when selecting a target
      height: '100%',

      '&, & > [role="combobox"], & > [role="combobox"] *': {
        height: '100%',
      },
    },

    [theme.fn.smallerThan('sm')]: {
      width: '25%',
    },
  },

  targetSelectorInput: {
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.gray[8] : theme.colors.gray[3],
    paddingRight: '18px',

    '&:not(:focus)': {
      borderRightStyle: 'none',
    },

    [theme.fn.smallerThan('md')]: {
      height: '100%',
    },
  },

  targetSelectorRightSection: {
    pointerEvents: 'none',
  },

  searchButton: {
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.gray[8] : theme.colors.gray[3],
    color: theme.colorScheme === 'dark' ? theme.white : theme.black,

    '&:hover': {
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.gray[7] : theme.colors.gray[4],
    },

    [theme.fn.smallerThan('md')]: {
      display: 'none',
    },
  },
}));

const targetData = [
  { value: 'models', label: 'Models' },
  { value: 'images', label: 'Images' },
  { value: 'articles', label: 'Articles' },
  { value: 'users', label: 'Users' },
  { value: 'collections', label: 'Collections' },
  { value: 'bounties', label: 'Bounties' },
] as const;

export const AutocompleteSearch = forwardRef<{ focus: () => void }, Props>(({ ...props }, ref) => {
  const [targetIndex, setTargetIndex] = useState<SearchIndexKey>('models');
  const handleTargetChange = (value: SearchIndexKey) => {
    setTargetIndex(value);
  };

  const indexSupportsNsfwLevel = useMemo(
    () =>
      [
        searchIndexMap.articles,
        searchIndexMap.bounties,
        searchIndexMap.models,
        searchIndexMap.images,
        searchIndexMap.collections,
      ].some((i) => i === searchIndexMap[targetIndex]),
    [targetIndex]
  );

  return (
    <InstantSearch
      searchClient={searchClient}
      indexName={searchIndexMap[targetIndex as keyof typeof searchIndexMap]}
      future={{ preserveSharedStateOnUnmount: false }}
    >
      {indexSupportsNsfwLevel && (
        <BrowsingLevelFilter attributeName={indexSupportsNsfwLevel ? 'nsfwLevel' : ''} />
      )}
      <AutocompleteSearchContent
        {...props}
        indexName={targetIndex}
        ref={ref}
        onTargetChange={handleTargetChange}
      />
    </InstantSearch>
  );
});

AutocompleteSearch.displayName = 'AutocompleteSearch';

type AutocompleteSearchProps<T extends SearchIndexKey> = Props & {
  indexName: T;
  onTargetChange: (target: T) => void;
};

function AutocompleteSearchContentInner<TKey extends SearchIndexKey>(
  {
    onClear,
    onSubmit,
    className,
    searchBoxProps,
    indexName: indexNameProp,
    onTargetChange,
    ...autocompleteProps
  }: AutocompleteSearchProps<TKey>,
  ref: React.ForwardedRef<{ focus: () => void }>
) {
  // const currentUser = useCurrentUser();
  const { classes } = useStyles();
  const router = useRouter();
  const isMobile = useIsMobile();
  const features = useFeatureFlags();
  const inputRef = useRef<HTMLInputElement>(null);

  const { status } = useInstantSearch({
    catchError: true,
  });

  const { query, refine: setQuery } = useSearchBox(searchBoxProps);
  const { hits, results } = useHitsTransformed<TKey>();
  const indexName = results?.index
    ? reverseSearchIndexMap[results.index as ReverseSearchIndexKey]
    : indexNameProp;

  const [selectedItem, setSelectedItem] = useState<AutocompleteItem | null>(null);
  const [search, setSearch] = useState(query);
  const [filters, setFilters] = useState('');
  const [searchPageQuery, setSearchPageQuery] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const { trackSearch } = useTrackEvent();
  const searchErrorState = status === 'error';

  const { key, value } = paired<SearchIndexDataMap>(indexName, hits as SearchIndexDataMap[TKey]);
  const { items: filtered } = useApplyHiddenPreferences({
    type: key,
    data: value,
  });

  const items = useMemo(() => {
    if (status === 'stalled') {
      return []; // Wait it out
    }
    const items = filtered.map((hit) => ({ key: String(hit.id), hit, value: '' }));
    if (!!results?.nbHits && results.nbHits > DEFAULT_DROPDOWN_ITEM_LIMIT)
      items.push({ key: 'view-more', value: query, hit: null as any });
    return items;
  }, [status, filtered, results?.nbHits, query]);

  const focusInput = () => inputRef.current?.focus();
  const blurInput = () => inputRef.current?.blur();

  useImperativeHandle(ref, () => ({
    focus: focusInput,
  }));

  const handleSubmit = () => {
    if (search) {
      const { query: cleanedSearch, searchPageQuery: currSearchPageQuery } = parseQuery(
        indexName,
        search
      );
      const queryString = QS.stringify({
        query: cleanedSearch.trim(), // Search should be more accurate than query as it was the latest written.
        ...QS.parse(currSearchPageQuery),
      });

      router.push(`/search/${indexName}?${queryString}`, undefined, { shallow: false });

      blurInput();
    }

    onSubmit?.();
  };

  const handleClear = () => {
    setSearch('');
    onClear?.();
  };

  const handleItemClick = (item: AutocompleteItem) => {
    if (item.hit) {
      // when an item is clicked
      router.push(processHitUrl(item.hit));
      trackSearch({ query: search, index: searchIndexMap[indexName] }).catch(() => null);
    } else {
      // when view more is clicked
      router.push(`/search/${indexName}?query=${encodeURIComponent(item.value)}`, undefined, {
        shallow: false,
      });
    }

    setSelectedItem(item);
    onSubmit?.();
  };

  useHotkeys([
    ['/', focusInput],
    ['mod+k', focusInput],
  ]);

  useEffect(() => {
    // Only set the query when the debounced search changes
    // and user didn't select from the list
    if (debouncedSearch === query || selectedItem || searchErrorState) return;

    // Check if the query is an AIR
    const air = checkAIR(indexName, debouncedSearch);
    if (air) {
      // If it is, redirect to the appropriate page
      router.push(air);
      return;
    }

    const {
      query: cleanedSearch,
      filters,
      searchPageQuery,
    } = parseQuery(indexName, debouncedSearch);

    setQuery(cleanedSearch);
    setFilters(filters);
    setSearchPageQuery(searchPageQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, query]);

  // Clear selected item after search changes
  useEffect(() => {
    setSelectedItem(null);
  }, [debouncedSearch]);

  const processHitUrl = (hit: Hit) => {
    switch (indexName) {
      case 'articles':
        return `/${indexName}/${hit.id}/${slugit(hit.title)}`;
      case 'images':
        return `/${indexName}/${hit.id}`;
      case 'users':
        return `/user/${hit.username}`;
      case 'models':
      default:
        return `/${indexName}/${hit.id}/${slugit(hit.name)}`;
    }
  };

  return (
    <>
      <Configure hitsPerPage={DEFAULT_DROPDOWN_ITEM_LIMIT} filters={filters} />
      <Group className={classes.wrapper} spacing={0} noWrap>
        <Select
          classNames={{
            root: classes.targetSelectorRoot,
            input: classes.targetSelectorInput,
            rightSection: classes.targetSelectorRightSection,
          }}
          maxDropdownHeight={280}
          defaultValue={targetData[0].value}
          // Ensure we disable search targets if they are not enabled
          data={targetData
            .filter((value) => (features.imageSearch ? true : value.value !== 'images'))
            .filter((value) => (features.bounties ? true : value.value !== 'bounties'))}
          rightSection={<IconChevronDown size={16} color="currentColor" />}
          sx={{ flexShrink: 1 }}
          onChange={onTargetChange}
          autoComplete="off"
          withinPortal
        />
        <ClearableAutoComplete
          ref={inputRef}
          key={indexName}
          className={className}
          classNames={classes}
          placeholder="Search Civitai"
          type="search"
          nothingFound={
            searchErrorState ? (
              <Stack spacing={0} align="center">
                <Text>There was an error while performing your request&hellip;</Text>
                <Text size="xs">Please try again later</Text>
              </Stack>
            ) : query && !hits.length ? (
              <Stack spacing={0} align="center">
                <TimeoutLoader delay={1500} renderTimeout={() => <Text>No results found</Text>} />
              </Stack>
            ) : undefined
          }
          limit={
            results && results.nbHits > DEFAULT_DROPDOWN_ITEM_LIMIT
              ? DEFAULT_DROPDOWN_ITEM_LIMIT + 1 // Allow one more to show more results option
              : DEFAULT_DROPDOWN_ITEM_LIMIT
          }
          defaultValue={query}
          value={search}
          data={items}
          onChange={setSearch}
          onBlur={handleClear}
          onClear={handleClear}
          onKeyDown={getHotkeyHandler([
            ['Escape', blurInput],
            ['Enter', handleSubmit],
          ])}
          onItemSubmit={handleItemClick}
          itemComponent={IndexRenderItem[indexName] ?? ModelSearchItem}
          rightSection={
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
                    color:
                      theme.colorScheme === 'dark' ? theme.colors.gray[5] : theme.colors.gray[6],
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
          }
          // prevent default filtering behavior
          filter={() => true}
          clearable={query.length > 0}
          maxDropdownHeight={isMobile ? 'calc(90vh - var(--mantine-header-height))' : undefined}
          {...autocompleteProps}
        />
        <ActionIcon
          className={classes.searchButton}
          variant="filled"
          size={36}
          onMouseDown={handleSubmit}
        >
          <IconSearch size={18} />
        </ActionIcon>
      </Group>
    </>
  );
}

const AutocompleteSearchContent = React.forwardRef(AutocompleteSearchContentInner);

const IndexRenderItem: Record<SearchIndexKey, React.FC> = {
  models: ModelSearchItem,
  articles: ArticlesSearchItem,
  users: UserSearchItem,
  images: ImagesSearchItem,
  collections: CollectionsSearchItem,
  bounties: BountiesSearchItem,
};

const queryFilters: Record<
  string,
  { AIR?: RegExp; filters: Record<string, RegExp>; searchPageMap: Record<string, string> }
> = {
  models: {
    AIR: /^civitai:(?<modelId>\d+)@(?<modelVersionId>\d+)/g,
    filters: {
      'tags.name': /(^|\s+)(?<not>!|-)?#(?<value>\w+)/g,
      'user.username': /(^|\s+)(?<not>!|-)?@(?<value>\w+)/g,
      'versions.hashes': /(^|\s+)(?<not>!|-)?hash:(?<value>[A-Za-z0-9_.-]+)/g,
    },
    searchPageMap: {
      'user.username': 'users',
      'tags.name': 'tags',
    },
  },
};

function checkAIR(index: string, query: string) {
  const filterAttributes = queryFilters[index] ?? {};

  if (!filterAttributes?.AIR) {
    return null;
  }

  const { AIR } = filterAttributes;
  const [match] = query.matchAll(AIR);

  if (!match) return null;

  if (index === 'models') {
    const modelId = match?.groups?.modelId;
    const modelVersionId = match?.groups?.modelVersionId;

    if (!modelId || !modelVersionId) return null;

    return `/models/${modelId}?modelVersionId=${modelVersionId}`;
  }

  return null;
}

function parseQuery(index: string, query: string) {
  const filterAttributes = queryFilters[index];
  const filters = [];
  const searchPageQuery = [];

  if (filterAttributes) {
    for (const [attribute, regex] of Object.entries(filterAttributes.filters)) {
      for (const match of query.matchAll(regex)) {
        const cleanedMatch = match?.groups?.value?.trim();
        const not = match?.groups?.not !== undefined;
        filters.push(`${not ? 'NOT ' : ''}${attribute} = ${cleanedMatch}`);
        searchPageQuery.push(
          `${filterAttributes.searchPageMap[attribute] ?? attribute}=${encodeURIComponent(
            cleanedMatch ?? ''
          )}`
        );
      }

      query = query.replace(regex, '');
      if (query.length === 0 && filters.length !== 0) query = ' ';
    }
  }

  return { query, filters: filters.join(' AND '), searchPageQuery: searchPageQuery.join('&') };
}
