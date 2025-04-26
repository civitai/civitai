import { AutocompleteProps, Group, Select, Stack, Text } from '@mantine/core';
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
import { env } from '~/env/client';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { IMAGES_SEARCH_INDEX, TOOLS_SEARCH_INDEX } from '~/server/common/constants';
import { ShowcaseItemSchema } from '~/server/schema/user-profile.schema';
import { paired } from '~/utils/type-guards';
import { searchClient } from '~/components/Search/search.client';
import { BrowsingLevelFilter } from './CustomSearchComponents';
import { ToolSearchItem } from '~/components/AutocompleteSearch/renderItems/tools';
import { styles } from './QuickSearchDropdown.styles';

const meilisearch = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id' }
);

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

  const indexName = searchIndexMap[targetIndex];
  const indexSupportsNsfwLevel = useMemo(
    () =>
      [
        searchIndexMap.articles,
        searchIndexMap.bounties,
        searchIndexMap.models,
        searchIndexMap.images,
        searchIndexMap.collections,
      ].some((i) => i === indexName),
    [indexName]
  );

  return (
    <InstantSearch
      searchClient={disableInitialSearch ? searchClient : meilisearch}
      indexName={indexName}
      future={{ preserveSharedStateOnUnmount: true }}
    >
      <Configure index={indexName} hitsPerPage={dropdownItemLimit} filters={filters} />
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
  const { query, refine: setQuery } = useSearchBox();
  const { hits, results } = useHitsTransformed<TIndex>();
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
    <Group className={styles.wrapper} spacing={0} noWrap>
      {!!showIndexSelect && (
        <Select
          classNames={{
            root: styles.targetSelectorRoot,
            input: styles.targetSelectorInput,
            rightSection: styles.targetSelectorRightSection,
          }}
          maxDropdownHeight={280}
          defaultValue={availableIndexes[0]}
          // Ensure we disable search targets if they are not enabled
          data={availableIndexes
            .filter(
              (value) =>
                (features.imageSearch ? true : searchIndexMap[value] !== IMAGES_SEARCH_INDEX) &&
                (features.toolSearch ? true : searchIndexMap[value] !== TOOLS_SEARCH_INDEX) &&
                (features.articles ? true : value !== 'articles')
            )
            .map((index) => ({ label: IndexToLabel[searchIndexMap[index]], value: index }))}
          rightSection={<IconChevronDown size={16} color="currentColor" />}
          sx={{ flexShrink: 1 }}
          onChange={onIndexNameChange}
        />
      )}
      <ClearableAutoComplete
        classNames={{
          root: styles.root,
          input: styles.input,
          dropdown: styles.dropdown,
        }}
        placeholder={placeholder ?? 'Search...'}
        value={search}
        onChange={setSearch}
        data={items}
        onItemSubmit={(item) => {
          onItemSelected(
            {
              entityId: item.hit.id,
              entityType: SearchIndexEntityTypes[searchIndexMap[indexName]],
            },
            item.hit
          );
        }}
        itemComponent={getItemComponent(indexName)}
        nothingFound={
          <TimeoutLoader delay={1500} renderTimeout={() => <Text>No results found</Text>} />
        }
        {...autocompleteProps}
      />
    </Group>
  );
}

function getItemComponent(indexName: SearchIndexKey) {
  switch (indexName) {
    case 'models':
      return ModelSearchItem;
    case 'images':
      return ImagesSearchItem;
    case 'articles':
      return ArticlesSearchItem;
    case 'users':
      return UserSearchItem;
    case 'collections':
      return CollectionsSearchItem;
    case 'bounties':
      return BountiesSearchItem;
    case 'tools':
      return ToolSearchItem;
    default:
      return ModelSearchItem;
  }
}
