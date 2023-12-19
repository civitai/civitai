import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { env } from '~/env/client.mjs';
import { AutocompleteItem, AutocompleteProps, createStyles, Group, Text } from '@mantine/core';
import React, { useEffect, useMemo, useState } from 'react';
import { Configure, InstantSearch, useHits, useSearchBox } from 'react-instantsearch';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useDebouncedValue } from '@mantine/hooks';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { UserSearchIndexRecord } from '~/server/search-index/users.search-index';
import { applyUserPreferencesUsers } from '~/components/Search/search.utils';
import { ClearableAutoComplete } from '~/components/ClearableAutoComplete/ClearableAutoComplete';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import { UserSearchItem } from '~/components/AutocompleteSearch/renderItems/users';
import { SearchPathToIndexMap } from '~/components/Search/useSearchState';
import { containerQuery } from '~/utils/mantine-css-helpers';

const meilisearch = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id' }
);

// TODO: These styles were taken from the original SearchBar component. We should probably migrate that searchbar to use this component.
const useStyles = createStyles((theme) => ({
  root: {
    flexGrow: 1,

    [containerQuery.smallerThan('md')]: {
      height: '100%',
      flexGrow: 1,
    },
  },
  wrapper: {
    [containerQuery.smallerThan('md')]: {
      height: '100%',
    },
  },
  input: {
    borderRadius: 0,

    [containerQuery.smallerThan('md')]: {
      height: '100%',
    },
  },
  dropdown: {
    [containerQuery.smallerThan('sm')]: {
      marginTop: '-7px',
    },
  },

  targetSelectorRoot: {
    width: '110px',

    [containerQuery.smallerThan('sm')]: {
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

    [containerQuery.smallerThan('md')]: {
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

    [containerQuery.smallerThan('md')]: {
      display: 'none',
    },
  },
}));

type QuickSearchDropdownProps = Omit<AutocompleteProps, 'data'> & {
  onItemSelected: (item: any) => void;
  dropdownItemLimit?: number;
};

export const UserSearchDropdown = ({
  dropdownItemLimit = 5,
  ...props
}: QuickSearchDropdownProps) => {
  return (
    <InstantSearch searchClient={meilisearch} indexName={SearchPathToIndexMap['users']}>
      <Configure hitsPerPage={dropdownItemLimit} />

      <UserSearchDropdownContent {...props} dropdownItemLimit={dropdownItemLimit} />
    </InstantSearch>
  );
};

type DataIndex = {
  users: UserSearchIndexRecord[];
};
type Boxed<Mapping> = { [K in keyof Mapping]: { key: K; value: Mapping[K] } }[keyof Mapping];
/**
 * boxes a key and corresponding value from a mapping and returns {key: , value: } structure
 * the type of return value is setup so that a switch over the key field will guard type of value
 * It is intentionally not checked that key and value actually correspond to each other so that
 * this can return a union of possible pairings, intended to be put in a switch statement over the key field.
 */
function paired<Mapping>(key: keyof Mapping, value: Mapping[keyof Mapping]) {
  return { key, value } as Boxed<Mapping>;
}

const UserSearchDropdownContent = ({
  onItemSelected,
  dropdownItemLimit = 5,
  ...autocompleteProps
}: QuickSearchDropdownProps) => {
  const currentUser = useCurrentUser();
  const { query, refine: setQuery } = useSearchBox();
  const { hits, results } = useHits<any>();
  const { classes } = useStyles();
  const [search, setSearch] = useState(query);
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const {
    models: hiddenModels,
    images: hiddenImages,
    tags: hiddenTags,
    users: hiddenUsers,
    isLoading: loadingPreferences,
  } = useHiddenPreferencesContext();

  const items = useMemo(() => {
    if (!results || !results.nbHits) return [];

    const getFilteredResults = () => {
      const opts = {
        currentUserId: currentUser?.id,
        hiddenImages: hiddenImages,
        hiddenTags: hiddenTags,
        hiddenUsers: hiddenUsers,
        hiddenModels,
      };

      const pair = paired<DataIndex>('users', hits);
      return applyUserPreferencesUsers({ ...opts, items: pair.value });
    };

    const filteredResults = getFilteredResults();

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

    return items;
  }, [hits, results, hiddenModels, hiddenImages, hiddenTags, hiddenUsers, currentUser?.id]);

  useEffect(() => {
    // Only set the query when the debounced search changes
    // and user didn't select from the list
    if (debouncedSearch === query) return;

    setQuery(debouncedSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, query]);

  return (
    <Group className={classes.wrapper} spacing={0} noWrap>
      <ClearableAutoComplete
        key="users"
        classNames={classes}
        placeholder="Search Users"
        type="search"
        maxDropdownHeight={300}
        nothingFound={
          !hits.length ? (
            <TimeoutLoader delay={1500} renderTimeout={() => <Text>No results found</Text>} />
          ) : undefined
        }
        limit={
          results && results.nbHits > dropdownItemLimit
            ? dropdownItemLimit + 1 // Allow one more to show more results option
            : dropdownItemLimit
        }
        defaultValue={query}
        value={search}
        data={items}
        onChange={setSearch}
        onClear={() => setSearch('')}
        // onBlur={() => (!isMobile ? onClear?.() : undefined)}
        onItemSubmit={(item) => {
          if (item.hit) {
            onItemSelected(item.hit);

            setSearch('');
          }
        }}
        itemComponent={UserSearchItem}
        // prevent default filtering behavior
        filter={() => true}
        clearable={query.length > 0}
        {...autocompleteProps}
      />
    </Group>
  );
};
