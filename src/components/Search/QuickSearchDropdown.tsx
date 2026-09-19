import type { AutocompleteProps } from '@mantine/core';
import { Group, Select } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { withUserHydration } from '~/components/Search/userHydration';
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
import { createResilientSearchClient } from '~/components/Search/resilientSearchClient';
import {
  shouldRefineSearchQuery,
  useCarriedSearchText,
} from '~/components/Search/useCarriedSearchText';
import { BrowsingLevelFilter } from './CustomSearchComponents';
import { ToolSearchItem } from '~/components/AutocompleteSearch/renderItems/tools';
import { ComicsSearchItem } from '~/components/AutocompleteSearch/renderItems/comics';
import classes from './QuickSearchDropdown.module.scss';
import { truncate } from 'lodash-es';

// Wrapped so a Meili outage degrades this dropdown to an empty result set
// instead of an uncaught `MeiliSearchCommunicationError`. Fails quietly (no
// banner) — the header quick-search just shows nothing during a blip.
const meilisearch = withUserHydration(
  createResilientSearchClient(
    instantMeiliSearch(env.NEXT_PUBLIC_SEARCH_HOST as string, env.NEXT_PUBLIC_SEARCH_CLIENT_KEY, {
      primaryKey: 'id',
    })
  )
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
  /**
   * The ids currently on offer, whenever that set changes. OPTIONAL and inert by default.
   *
   * Exists so a caller whose selection GRANTS something can screen the candidates against the
   * server before offering them — a search hit is a cached document, so "search returned it"
   * is not a statement about the account's current state. Pass a STABLE callback (`useCallback`);
   * it fires on every hit change.
   */
  onHits?: (ids: number[]) => void;
};

export const QuickSearchDropdown = ({
  filters,
  dropdownItemLimit = 5,
  startingIndex,
  disableInitialSearch,
  showIndexSelect = true,
  ...props
}: QuickSearchDropdownProps) => {
  const features = useFeatureFlags();
  // The target is clamped to `supportedIndexes` — the set the CALLER declared, which is not
  // necessarily the set the selector offers: the offered list below narrows it further by feature
  // flag, and this fallback does not. A bare `models` fallback would leave the component searching
  // an index the caller never supported — a caller that passes `['users']` gets a users picker
  // whose hits are models.
  //
  // Every current caller either passes `startingIndex` or supports `models` first, so the
  // INITIAL value below is unchanged at every call site today. The reachable path is the
  // deselect one: Mantine's single-select is deselectable, so `onChange` can hand the change
  // handler `null`, and a bare `'models'` fallback would then move a `supportedIndexes={['users']}`
  // picker onto the models index.
  const fallbackIndex = startingIndex ?? props.supportedIndexes?.[0] ?? 'models';
  const [targetIndex, setTargetIndex] = useState<SearchIndexKey>(fallbackIndex);
  const handleTargetChange = (value: SearchIndexKey | null) => {
    setTargetIndex(value ?? fallbackIndex);
  };
  // Owned above the keyed search provider below, so it outlives the remount an index switch
  // causes.
  const carriedSearchText = useRef('');

  const indexName = searchIndexMap[targetIndex];

  // Ensure we disable search targets if they are not enabled. Hoisted because the selector's
  // value is clamped to this set as well as read from it — the two have to be the same list.
  const enabledTargets = (props.supportedIndexes ?? [])
    .filter(
      (value) =>
        (features.imageSearch ? true : searchIndexMap[value] !== IMAGES_SEARCH_INDEX) &&
        (features.toolSearch ? true : searchIndexMap[value] !== TOOLS_SEARCH_INDEX) &&
        (features.articles ? true : value !== 'articles')
    )
    .map((index) => ({ label: IndexToLabel[searchIndexMap[index]], value: index }));

  return (
    <Group className={classes.wrapper} gap={0} wrap="nowrap">
      {!!showIndexSelect && (
        /*
          ABOVE the keyed provider, and that placement is the point. `<InstantSearch>` returns
          `null` until its own effect has started the search, so a key change commits one render in
          which the whole subtree is gone. Inside it, the control the user just clicked would be
          destroyed and rebuilt by their own click — focus lands on `<body>`. It consumes nothing
          from the provider's context, so nothing is lost by lifting it out.
        */
        <Select
          className="shrink"
          classNames={{
            root: classes.targetSelectorRoot,
            input: classes.targetSelectorInput,
            section: classes.targetSelectorRightSection,
          }}
          maxDropdownHeight={280}
          // CONTROLLED, so the displayed label cannot drift from the index being searched.
          //
          // `null` rather than the target when the target is not an OFFERED option: Mantine leaves
          // a controlled value it cannot resolve showing the PREVIOUS option's label, which is a
          // lie about what is being searched. Blank is honest about "none of these".
          value={enabledTargets.some(({ value }) => value === targetIndex) ? targetIndex : null}
          data={enabledTargets}
          rightSection={<IconChevronDown size={16} color="currentColor" />}
          onChange={(value) => handleTargetChange(value as SearchIndexKey)}
        />
      )}
      <InstantSearch
        // Needs re-render, the same way `SearchLayout` does it. Otherwise the search fires with the
        // previous index's parameters: react-instantsearch sets the new index and searches in its
        // render body, before the children that own `filters` have re-rendered.
        key={indexName}
        searchClient={disableInitialSearch ? searchClient : meilisearch}
        indexName={indexName}
        future={{ preserveSharedStateOnUnmount: true }}
      >
        <BrowsingLevelFilter
          indexKey={targetIndex}
          filters={filters}
          hitsPerPage={dropdownItemLimit}
        />

        <QuickSearchDropdownContent
          {...props}
          indexName={targetIndex}
          dropdownItemLimit={dropdownItemLimit}
          carriedSearchText={carriedSearchText}
        />
      </InstantSearch>
    </Group>
  );
};

function QuickSearchDropdownContent<TIndex extends SearchIndexKey>({
  indexName: indexNameProp,
  onItemSelected,
  filters,
  supportedIndexes,
  dropdownItemLimit = 5,
  placeholder,
  onHits,
  carriedSearchText,
  ...autocompleteProps
}: QuickSearchDropdownProps & {
  indexName: TIndex;
  carriedSearchText: React.MutableRefObject<string>;
}) {
  // const currentUser = useCurrentUser();
  const { query, refine: setQuery, isSearchStalled } = useSearchBox();
  const { hits, results } = useHitsTransformed<TIndex>();
  const [search, setSearch] = useCarriedSearchText(carriedSearchText, query);
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const isSubmittingOptionRef = useRef(false);

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

  // Report what is on offer. Keyed on the joined id list rather than on `items`, whose identity
  // changes on every re-render of the memo's inputs — re-firing on an unchanged set would make a
  // caller that turns this into a query re-issue it forever.
  const hitIds = useMemo(
    () => items.map((item) => Number(item.value)).filter((id) => Number.isFinite(id)),
    [items]
  );
  const hitIdsKey = hitIds.join(',');
  useEffect(() => {
    if (!onHits) return;
    onHits(hitIdsKey.length ? hitIdsKey.split(',').map(Number) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hitIdsKey, onHits]);

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
    if (!shouldRefineSearchQuery(debouncedSearch, query)) return;

    setQuery(debouncedSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, query]);

  // Covers both halves of the wait: the 300ms debounce before the query is even sent, and the
  // request itself. `isSearchStalled` alone leaves the first 300ms looking like a dead input.
  const loading = search.length > 0 && (search !== query || isSearchStalled);

  return (
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
      loading={loading}
      {...autocompleteProps}
    />
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
