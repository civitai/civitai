import type { AutocompleteProps } from '@mantine/core';
import { Group, Select } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { IconChevronDown } from '@tabler/icons-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InstantSearch, useSearchBox } from 'react-instantsearch';
import { ArticlesSearchItem } from '~/components/AutocompleteSearch/renderItems/articles';
import { BountiesSearchItem } from '~/components/AutocompleteSearch/renderItems/bounties';
import { CollectionsSearchItem } from '~/components/AutocompleteSearch/renderItems/collections';
import { ImagesSearchItem } from '~/components/AutocompleteSearch/renderItems/images';
import { ModelSearchItem } from '~/components/AutocompleteSearch/renderItems/models';
import { UserSearchItem } from '~/components/AutocompleteSearch/renderItems/users';
import { ClearableAutoComplete } from '~/components/ClearableAutoComplete/ClearableAutoComplete';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { SearchIndexEntityTypes } from '~/components/Search/parsers/base';
import type { ReverseSearchIndexKey, SearchIndexKey } from '~/components/Search/search.types';
import { reverseSearchIndexMap, searchIndexMap } from '~/components/Search/search.types';

import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { useHitsTransformed } from '~/components/Search/search.utils2';
import { IndexToLabel } from '~/components/Search/useSearchState';
import { env } from '~/env/client';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { IMAGES_SEARCH_INDEX, TOOLS_SEARCH_INDEX } from '~/server/common/constants';
import type { ShowcaseItemSchema } from '~/server/schema/user-profile.schema';
import { paired } from '~/utils/type-guards';
import { searchClient } from '~/components/Search/search.client';
import { ApplyCustomFilter, BrowsingLevelFilter } from './CustomSearchComponents';
import { ToolSearchItem } from '~/components/AutocompleteSearch/renderItems/tools';
import { ComicsSearchItem } from '~/components/AutocompleteSearch/renderItems/comics';
import classes from './QuickSearchDropdown.module.scss';
import { truncate } from 'lodash-es';

const meilisearch = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id' }
);

// TODO: These styles were taken from the original SearchBar component. We should probably migrate that searchbar to use this component.
// const useStyles = createStyles((theme) => ({
//   root: {
//     flexGrow: 1,

//     [containerQuery.smallerThan('md')]: {
//       height: '100%',
//       flexGrow: 1,
//     },
//   },
//   wrapper: {
//     [containerQuery.smallerThan('md')]: {
//       height: '100%',
//     },
//   },
//   input: {
//     borderRadius: 0,

//     [containerQuery.smallerThan('md')]: {
//       height: '100%',
//     },
//   },
//   dropdown: {
//     [containerQuery.smallerThan('sm')]: {
//       marginTop: '-7px',
//     },
//   },

//   targetSelectorRoot: {
//     width: '110px',

//     [containerQuery.smallerThan('sm')]: {
//       width: '25%',
//     },
//   },

//   targetSelectorInput: {
//     borderTopRightRadius: 0,
//     borderBottomRightRadius: 0,
//     backgroundColor: theme.colorScheme === 'dark' ? theme.colors.gray[8] : theme.colors.gray[3],
//     paddingRight: '18px',

//     '&:not(:focus)': {
//       borderRightStyle: 'none',
//     },

//     [containerQuery.smallerThan('md')]: {
//       height: '100%',
//     },
//   },

//   targetSelectorRightSection: {
//     pointerEvents: 'none',
//   },

//   searchButton: {
//     borderTopLeftRadius: 0,
//     borderBottomLeftRadius: 0,
//     backgroundColor: theme.colorScheme === 'dark' ? theme.colors.gray[8] : theme.colors.gray[3],
//     color: theme.colorScheme === 'dark' ? theme.white : theme.black,

//     '&:hover': {
//       backgroundColor: theme.colorScheme === 'dark' ? theme.colors.gray[7] : theme.colors.gray[4],
//     },

//     [containerQuery.smallerThan('md')]: {
//       display: 'none',
//     },
//   },
// }));

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
  const handleTargetChange = (value: SearchIndexKey | null) => {
    setTargetIndex(value ?? 'models');
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
      {indexSupportsNsfwLevel ? (
        <BrowsingLevelFilter
          attributeName="nsfwLevel"
          filters={filters}
          hitsPerPage={dropdownItemLimit}
        />
      ) : (
        <ApplyCustomFilter hitsPerPage={dropdownItemLimit} filters={filters} />
      )}

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
  const features = useFeatureFlags();
  const [search, setSearch] = useState(query);
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const isSubmittingOptionRef = useRef(false);
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
    const items = filtered.map((hit) => ({
      // key: String(hit.id),
      hit,
      value: String(hit.id),
      label:
        'prompt' in hit
          ? truncate(hit.prompt, { length: 50 })
          : 'name' in hit
          ? hit.name
          : 'title' in hit
          ? hit.title
          : 'username' in hit
          ? hit.username
          : '',
    }));
    return items;
  }, [filtered]);

  const getItemFromValue = useCallback(
    (value: string) => {
      const item = items.find((item) => item.value === value);
      if (!item) return null;

      return item;
    },
    [items]
  );

  const renderOption = useCallback<NonNullable<AutocompleteProps['renderOption']>>(
    ({ option }) => {
      const item = getItemFromValue(option.value);
      if (!item) return null;

      const RenderItem = IndexRenderItem[indexName] ?? ModelSearchItem;
      return <RenderItem {...item} />;
    },
    [getItemFromValue, indexName]
  );

  useEffect(() => {
    // Only set the query when the debounced search changes
    // and user didn't select from the list
    if (debouncedSearch === query) return;

    setQuery(debouncedSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, query]);

  return (
    <Group className={classes.wrapper} gap={0} wrap="nowrap">
      {!!showIndexSelect && (
        <Select
          className="shrink"
          classNames={{
            root: classes.targetSelectorRoot,
            input: classes.targetSelectorInput,
            section: classes.targetSelectorRightSection,
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
          onChange={(value) => onIndexNameChange(value as TIndex)}
        />
      )}
      <ClearableAutoComplete
        key={indexName}
        classNames={classes}
        placeholder={placeholder ?? 'Search Civitai'}
        type="search"
        maxDropdownHeight={300}
        // TODO: Mantine7
        // nothingFound={
        //   !hits.length ? (
        //     <Stack gap={0} align="center">
        //       <TimeoutLoader delay={1500} renderTimeout={() => <Text>No results found</Text>} />
        //     </Stack>
        //   ) : undefined
        // }
        limit={
          results && results.nbHits > dropdownItemLimit
            ? dropdownItemLimit + 1 // Allow one more to show more results option
            : dropdownItemLimit
        }
        defaultValue={query}
        value={search}
        data={items}
        onChange={(value) => {
          // Ignore onChange events that happen during option submission
          if (isSubmittingOptionRef.current) {
            isSubmittingOptionRef.current = false;
            return;
          }
          setSearch(value);
        }}
        onClear={() => setSearch('')}
        // onBlur={() => (!isMobile ? onClear?.() : undefined)}
        onOptionSubmit={(value) => {
          const item = getItemFromValue(value);
          if (item) {
            // Set flag before calling onItemSelected to prevent onChange from overwriting
            isSubmittingOptionRef.current = true;

            onItemSelected(
              {
                entityId: item.hit.id,
                entityType: SearchIndexEntityTypes[searchIndexMap[indexName]],
              },
              item.hit as any
            );

            setSearch('');
          }
        }}
        renderOption={renderOption}
        // prevent default filtering behavior
        filter={({ options }) => options}
        clearable={query.length > 0}
        {...autocompleteProps}
      />
    </Group>
  );
}

const IndexRenderItem: Record<SearchIndexKey, React.ComponentType<any>> = {
  models: ModelSearchItem,
  articles: ArticlesSearchItem,
  users: UserSearchItem,
  images: ImagesSearchItem,
  collections: CollectionsSearchItem,
  bounties: BountiesSearchItem,
  tools: ToolSearchItem,
  comics: ComicsSearchItem,
};
