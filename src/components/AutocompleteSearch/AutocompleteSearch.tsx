import {
  Anchor,
  AutocompleteItem,
  AutocompleteProps,
  Center,
  Code,
  HoverCard,
  Text,
  createStyles,
} from '@mantine/core';
import { getHotkeyHandler, useDebouncedValue, useHotkeys } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import type { Hit } from 'instantsearch.js';
import { useRouter } from 'next/router';
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Configure,
  InstantSearch,
  InstantSearchProps,
  SearchBoxProps,
  useHits,
  useSearchBox,
} from 'react-instantsearch';
import { ClearableAutoComplete } from '~/components/ClearableAutoComplete/ClearableAutoComplete';
import type { ModelSearchIndexRecord } from '~/server/search-index/models.search-index';
import { slugit } from '~/utils/string-helpers';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { env } from '~/env/client.mjs';
import { ModelSearchItem } from '~/components/AutocompleteSearch/renderItems/models';
import { ArticlesSearchItem } from '~/components/AutocompleteSearch/renderItems/articles';
import { UserSearchItem } from '~/components/AutocompleteSearch/renderItems/users';
import { ImagesSearchItem } from '~/components/AutocompleteSearch/renderItems/images';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import {
  applyUserPreferencesArticles,
  applyUserPreferencesImages,
  applyUserPreferencesModels,
  applyUserPreferencesUsers,
} from '~/components/Search/search.utils';
import { ArticleSearchIndexRecord } from '~/server/search-index/articles.search-index';
import { ImageSearchIndexRecord } from '~/server/search-index/images.search-index';
import { UserSearchIndexRecord } from '~/server/search-index/users.search-index';

const meilisearch = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id' }
);

type Props = Omit<AutocompleteProps, 'data'> & {
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
  dropdown: {
    marginTop: '-7px',
  },
}));

export const AutocompleteSearch = forwardRef<{ focus: () => void }, Props>(({ ...props }, ref) => {
  const router = useRouter();
  const targetIndex =
    /\/(model|article|image|user|post)s?\/?/.exec(router.pathname)?.[1] || 'model';
  let indexName = `${targetIndex}s`;

  if (indexName === 'posts') {
    indexName = 'images';
  }

  return (
    <InstantSearch searchClient={searchClient} indexName={indexName}>
      <AutocompleteSearchContent indexName={indexName} {...props} ref={ref} />
    </InstantSearch>
  );
});

AutocompleteSearch.displayName = 'AutocompleteSearch';

const AutocompleteSearchContent = forwardRef<{ focus: () => void }, Props & { indexName: string }>(
  ({ onClear, onSubmit, className, searchBoxProps, indexName, ...autocompleteProps }, ref) => {
    const { classes } = useStyles();
    const router = useRouter();
    const inputRef = useRef<HTMLInputElement>(null);

    const { query, refine: setQuery } = useSearchBox(searchBoxProps);
    // TODO: Needs to be refactored to support hit type based off of indexName
    const { hits, results } = useHits();

    const [selectedItem, setSelectedItem] = useState<AutocompleteItem | null>(null);
    const [search, setSearch] = useState(query);
    const [debouncedSearch] = useDebouncedValue(search, 300);

    const currentUser = useCurrentUser();
    const {
      models: hiddenModels,
      images: hiddenImages,
      tags: hiddenTags,
      users: hiddenUsers,
      isLoading: loadingPreferences,
    } = useHiddenPreferencesContext();

    // Prep items to display in dropdown
    const items = useMemo(() => {
      if (!results || !results.nbHits) return [];

      let filteredResults: (
        | ModelSearchIndexRecord
        | ArticleSearchIndexRecord
        | ImageSearchIndexRecord
        | UserSearchIndexRecord
      )[] = [];
      const opts = {
        currentUserId: currentUser?.id,
        hiddenImages: hiddenImages,
        hiddenTags: hiddenTags,
        hiddenUsers: hiddenUsers,
        hiddenModels,
      };

      if (indexName === 'models') {
        filteredResults = applyUserPreferencesModels({
          ...opts,
          items: hits as unknown as ModelSearchIndexRecord[],
        });
      } else if (indexName === 'articles') {
        filteredResults = applyUserPreferencesArticles({
          ...opts,
          items: hits as unknown as ArticleSearchIndexRecord[],
        });
      } else if (indexName === 'images') {
        filteredResults = applyUserPreferencesImages({
          ...opts,
          items: hits as unknown as ImageSearchIndexRecord[],
        });
      } else if (indexName === 'users') {
        filteredResults = applyUserPreferencesUsers({
          ...opts,
          items: hits as unknown as UserSearchIndexRecord[],
        });
      } else {
        filteredResults = [];
      }

      type Item = AutocompleteItem & { hit: any | null };
      const items: Item[] = filteredResults.map((hit) => {
        const anyHit = hit as any;

        return {
          // Value isn't really used, but better safe than sorry:
          value: anyHit?.name || anyHit?.title || anyHit?.username || anyHit?.id,
          hit,
        };
      });
      // If there are more results than the default limit,
      // then we add a "view more" option
      if (results.nbHits > DEFAULT_DROPDOWN_ITEM_LIMIT)
        items.push({ key: 'view-more', value: query, hit: null });

      return items;
    }, [hits, query, results]);

    const focusInput = () => inputRef.current?.focus();
    const blurInput = () => inputRef.current?.blur();

    useImperativeHandle(ref, () => ({
      focus: focusInput,
    }));

    const handleSubmit = () => {
      if (search) {
        router.push(`/search/${indexName}?query=${encodeURIComponent(search)}`, undefined, {
          shallow: false,
        });

        blurInput();
      }
      onSubmit?.();
    };

    const handleClear = () => {
      setSearch('');
      onClear?.();
    };

    useHotkeys([
      ['/', focusInput],
      ['mod+k', focusInput],
    ]);

    useEffect(() => {
      // Only set the query when the debounced search changes
      // and user didn't select from the list
      if (debouncedSearch !== query && !selectedItem) {
        setQuery(debouncedSearch);
        return;
      }
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
        <Configure hitsPerPage={DEFAULT_DROPDOWN_ITEM_LIMIT} />
        <ClearableAutoComplete
          ref={inputRef}
          className={className}
          classNames={classes}
          placeholder={`Search ${indexName}`}
          type="search"
          nothingFound={
            query && !hits.length ? (
              <TimeoutLoader delay={1500} renderTimeout={() => <Text>No results found</Text>} />
            ) : undefined
          }
          icon={<IconSearch />}
          limit={
            results && results.nbHits > DEFAULT_DROPDOWN_ITEM_LIMIT
              ? DEFAULT_DROPDOWN_ITEM_LIMIT + 1 // Allow one more to show more results option
              : DEFAULT_DROPDOWN_ITEM_LIMIT
          }
          defaultValue={query}
          value={search}
          data={items}
          onChange={setSearch}
          onClear={handleClear}
          onKeyDown={getHotkeyHandler([
            ['Escape', blurInput],
            ['Enter', handleSubmit],
          ])}
          onBlur={() => onClear?.()}
          onItemSubmit={(item) => {
            item.hit
              ? router.push(processHitUrl(item.hit)) // when a model is clicked
              : router.push(
                  `/search/${indexName}?query=${encodeURIComponent(item.value)}`,
                  undefined,
                  {
                    shallow: false,
                  }
                ); // when view more is clicked

            setSelectedItem(item);
            onSubmit?.();
          }}
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
          maxDropdownHeight={400}
          {...autocompleteProps}
        />
      </>
    );
  }
);

AutocompleteSearchContent.displayName = 'AutocompleteSearchContent';

const IndexRenderItem: Record<string, React.FC> = {
  models: ModelSearchItem,
  articles: ArticlesSearchItem,
  users: UserSearchItem,
  images: ImagesSearchItem,
};
