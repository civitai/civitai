import { AutocompleteProps, createStyles, Group, Select, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { IconChevronDown } from '@tabler/icons-react';
import React, { useEffect, useMemo, useState } from 'react';
import { Configure, InstantSearch, useSearchBox } from 'react-instantsearch';
import { ArticlesSearchItem } from '~/components/AutocompleteSearch/renderItems/articles';
import { BountiesSearchItem } from '~/components/AutocompleteSearch/renderItems/bounties';
import { CollectionsSearchItem } from '~/components/AutocompleteSearch/renderItems/collections';
import { ImagesSearchItem } from '~/components/AutocompleteSearch/renderItems/images';
import { ModelSearchItem } from '~/components/AutocompleteSearch/renderItems/models';
import { UserSearchItem } from '~/components/AutocompleteSearch/renderItems/users';
import { ClearableAutoComplete } from '~/components/ClearableAutoComplete/ClearableAutoComplete';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { SearchIndexEntityTypes } from '~/components/Search/parsers/base';
import {
  ReverseSearchIndexKey,
  reverseSearchIndexMap,
  SearchIndexKey,
  searchIndexMap,
} from '~/components/Search/search.types';

import { SearchIndexDataMap, useHitsTransformed } from '~/components/Search/search.utils2';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import { IndexToLabel } from '~/components/Search/useSearchState';
import { env } from '~/env/client.mjs';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { ShowcaseItemSchema } from '~/server/schema/user-profile.schema';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { paired } from '~/utils/type-guards';
import { searchClient } from '~/components/Search/search.client';
import { BrowsingLevelFilter } from './CustomSearchComponents';

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

export type QuickSearchDropdownProps = Omit<AutocompleteProps, 'data'> & {
  supportedIndexes?: SearchIndexKey[];
  onItemSelected: (
    item: ShowcaseItemSchema,
    data:
      | SearchIndexDataMap['models'][number]
      | SearchIndexDataMap['images'][number]
      | SearchIndexDataMap['articles'][number]
      | SearchIndexDataMap['users'][number]
      | SearchIndexDataMap['collections'][number]
      | SearchIndexDataMap['bounties'][number]
  ) => void;
  filters?: string;
  dropdownItemLimit?: number;
  clearable?: boolean;
  startingIndex?: SearchIndexKey;
  showIndexSelect?: boolean;
  placeholder?: string;
  disableInitialSearch?: boolean;
};

export const QuickSearchDropdown = ({
  filters,
  dropdownItemLimit = 5,
  startingIndex,
  disableInitialSearch,
  ...props
}: QuickSearchDropdownProps) => {
  const [targetIndex, setTargetIndex] = useState<SearchIndexKey>(startingIndex ?? 'models');
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
      searchClient={disableInitialSearch ? searchClient : meilisearch}
      indexName={searchIndexMap[targetIndex]}
      future={{ preserveSharedStateOnUnmount: true }}
    >
      <Configure hitsPerPage={dropdownItemLimit} filters={filters} />
      {indexSupportsNsfwLevel && <BrowsingLevelFilter attributeName="nsfwLevel" />}

      <QuickSearchDropdownContent
        {...props}
        indexName={targetIndex}
        onIndexNameChange={handleTargetChange}
        dropdownItemLimit={dropdownItemLimit}
      />
    </InstantSearch>
  );
};

function QuickSearchDropdownContent<TIndex extends SearchIndexKey>({
  indexName: indexNameProp,
  onIndexNameChange,
  onItemSelected,
  filters,
  supportedIndexes,
  dropdownItemLimit = 5,
  showIndexSelect = true,
  placeholder,
  ...autocompleteProps
}: QuickSearchDropdownProps & {
  indexName: TIndex;
  onIndexNameChange: (indexName: TIndex) => void;
}) {
  // const currentUser = useCurrentUser();
  const { query, refine: setQuery } = useSearchBox();
  const { hits, results } = useHitsTransformed<TIndex>();
  const { classes } = useStyles();
  const features = useFeatureFlags();
  const [search, setSearch] = useState(query);
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const availableIndexes = supportedIndexes ?? [];

  const indexName = results?.index
    ? reverseSearchIndexMap[results.index as ReverseSearchIndexKey]
    : indexNameProp;
  const { key, value } = useMemo(
    () => paired<SearchIndexDataMap>(indexName, hits as SearchIndexDataMap[TIndex]),
    [indexName, hits]
  );
  const { items: filtered } = useApplyHiddenPreferences({
    type: key,
    data: value,
  });

  const items = useMemo(() => {
    const items = filtered.map((hit) => ({ key: String(hit.id), hit, value: '' }));
    return items;
  }, [filtered]);

  useEffect(() => {
    // Only set the query when the debounced search changes
    // and user didn't select from the list
    if (debouncedSearch === query) return;

    setQuery(debouncedSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, query]);

  return (
    <Group className={classes.wrapper} spacing={0} noWrap>
      {!!showIndexSelect && (
        <Select
          classNames={{
            root: classes.targetSelectorRoot,
            input: classes.targetSelectorInput,
            rightSection: classes.targetSelectorRightSection,
          }}
          maxDropdownHeight={280}
          defaultValue={availableIndexes[0]}
          // Ensure we disable search targets if they are not enabled
          data={availableIndexes
            .filter((value) =>
              features.imageSearch ? true : searchIndexMap[value] !== IMAGES_SEARCH_INDEX
            )
            .map((index) => ({ label: IndexToLabel[searchIndexMap[index]], value: index }))}
          rightSection={<IconChevronDown size={16} color="currentColor" />}
          sx={{ flexShrink: 1 }}
          onChange={onIndexNameChange}
        />
      )}
      <ClearableAutoComplete
        key={indexName}
        classNames={classes}
        placeholder={placeholder ?? 'Search Civitai'}
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
            onItemSelected(
              {
                entityId: item.hit.id,
                entityType: SearchIndexEntityTypes[searchIndexMap[indexName]],
              },
              item.hit
            );

            setSearch('');
          }
        }}
        itemComponent={IndexRenderItem[indexName] ?? ModelSearchItem}
        // prevent default filtering behavior
        filter={() => true}
        clearable={query.length > 0}
        {...autocompleteProps}
      />
    </Group>
  );
}

const IndexRenderItem: Record<SearchIndexKey, React.FC> = {
  models: ModelSearchItem,
  articles: ArticlesSearchItem,
  users: UserSearchItem,
  images: ImagesSearchItem,
  collections: CollectionsSearchItem,
  bounties: BountiesSearchItem,
};
