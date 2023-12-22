import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { env } from '~/env/client.mjs';
import {
  AutocompleteItem,
  AutocompleteProps,
  createStyles,
  Group,
  Select,
  Text,
} from '@mantine/core';
import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';
import { ShowcaseItemSchema } from '~/server/schema/user-profile.schema';
import React, { useEffect, useMemo, useState } from 'react';
import { Configure, InstantSearch, useHits, useSearchBox } from 'react-instantsearch';
import { SearchIndex, SearchIndexEntityTypes } from '~/components/Search/parsers/base';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useDebouncedValue } from '@mantine/hooks';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { ModelSearchIndexRecord } from '~/server/search-index/models.search-index';
import { ArticleSearchIndexRecord } from '~/server/search-index/articles.search-index';
import { ImageSearchIndexRecord } from '~/server/search-index/images.search-index';
import { UserSearchIndexRecord } from '~/server/search-index/users.search-index';
import { CollectionSearchIndexRecord } from '~/server/search-index/collections.search-index';
import { BountySearchIndexRecord } from '~/server/search-index/bounties.search-index';
import {
  applyUserPreferencesArticles,
  applyUserPreferencesBounties,
  applyUserPreferencesCollections,
  applyUserPreferencesImages,
  applyUserPreferencesModels,
  applyUserPreferencesUsers,
} from '~/components/Search/search.utils';
import { IconChevronDown } from '@tabler/icons-react';
import { ClearableAutoComplete } from '~/components/ClearableAutoComplete/ClearableAutoComplete';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import { ModelSearchItem } from '~/components/AutocompleteSearch/renderItems/models';
import { ArticlesSearchItem } from '~/components/AutocompleteSearch/renderItems/articles';
import { UserSearchItem } from '~/components/AutocompleteSearch/renderItems/users';
import { ImagesSearchItem } from '~/components/AutocompleteSearch/renderItems/images';
import { CollectionsSearchItem } from '~/components/AutocompleteSearch/renderItems/collections';
import { BountiesSearchItem } from '~/components/AutocompleteSearch/renderItems/bounties';
import { IndexToLabel, SearchPathToIndexMap } from '~/components/Search/useSearchState';
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

// const SUPPORTED_USERNAME_INDEXES = [
//   { value: MODELS_SEARCH_INDEX, label: 'Models' },
//   { value: IMAGES_SEARCH_INDEX, label: 'Images' },
//   { value: BOUNTIES_SEARCH_INDEX, label: 'Bounties' },
//   { value: ARTICLES_SEARCH_INDEX, label: 'Articles' },
//   { value: USERS_SEARCH_INDEX, label: 'Users' },
//   { value: COLLECTIONS_SEARCH_INDEX, label: 'Collections' },
// ] as const;

export type QuickSearchDropdownProps = Omit<AutocompleteProps, 'data'> & {
  supportedIndexes?: TargetIndex[];
  onItemSelected: (
    item: ShowcaseItemSchema,
    data:
      | ModelSearchIndexRecord
      | ArticleSearchIndexRecord
      | ImageSearchIndexRecord
      | UserSearchIndexRecord
      | CollectionSearchIndexRecord
      | BountySearchIndexRecord
  ) => void;
  filters?: string;
  dropdownItemLimit?: number;
  clearable?: boolean;
};

export const QuickSearchDropdown = ({
  filters,
  dropdownItemLimit = 5,
  ...props
}: QuickSearchDropdownProps) => {
  const [targetIndex, setTargetIndex] = useState<TargetIndex>('models');
  const handleTargetChange = (value: TargetIndex) => {
    setTargetIndex(value);
  };

  return (
    <InstantSearch searchClient={meilisearch} indexName={SearchPathToIndexMap[targetIndex]}>
      <Configure hitsPerPage={dropdownItemLimit} filters={filters} />

      <QuickSearchDropdownContent
        {...props}
        indexName={targetIndex}
        onIndexNameChange={handleTargetChange}
        dropdownItemLimit={dropdownItemLimit}
      />
    </InstantSearch>
  );
};

type TargetIndex = keyof DataIndex;
type DataIndex = {
  models: ModelSearchIndexRecord[];
  images: ImageSearchIndexRecord[];
  articles: ArticleSearchIndexRecord[];
  users: UserSearchIndexRecord[];
  collections: CollectionSearchIndexRecord[];
  bounties: BountySearchIndexRecord[];
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

const QuickSearchDropdownContent = ({
  indexName,
  onIndexNameChange,
  onItemSelected,
  filters,
  supportedIndexes,
  dropdownItemLimit = 5,
  ...autocompleteProps
}: QuickSearchDropdownProps & {
  indexName: TargetIndex;
  onIndexNameChange: (indexName: TargetIndex) => void;
}) => {
  const currentUser = useCurrentUser();
  const { query, refine: setQuery } = useSearchBox();
  const { hits, results } = useHits<any>();
  const { classes } = useStyles();
  const features = useFeatureFlags();
  const [search, setSearch] = useState(query);
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const availableIndexes = supportedIndexes ?? [];
  // TODO - revisit this
  // const availableIndexes = useMemo(() => {
  //   if (!supportedIndexes) return SUPPORTED_USERNAME_INDEXES;

  //   return SUPPORTED_USERNAME_INDEXES.filter((index) => supportedIndexes.includes(index.value));
  // }, [supportedIndexes]);

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

      const pair = paired<DataIndex>(indexName, hits);
      switch (pair.key) {
        case 'models':
          return applyUserPreferencesModels({ ...opts, items: pair.value });
        case 'images':
          return applyUserPreferencesImages({ ...opts, items: pair.value });
        case 'articles':
          return applyUserPreferencesArticles({ ...opts, items: pair.value });
        case 'bounties':
          return applyUserPreferencesBounties({ ...opts, items: pair.value });
        case 'collections':
          return applyUserPreferencesCollections({ ...opts, items: pair.value });
        case 'users':
          return applyUserPreferencesUsers({ ...opts, items: pair.value });
        default:
          return [];
      }
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
  }, [
    hits,
    results,
    hiddenModels,
    hiddenImages,
    hiddenTags,
    hiddenUsers,
    indexName,
    currentUser?.id,
  ]);

  useEffect(() => {
    // Only set the query when the debounced search changes
    // and user didn't select from the list
    if (debouncedSearch === query) return;

    setQuery(debouncedSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, query]);

  return (
    <Group className={classes.wrapper} spacing={0} noWrap>
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
            features.imageSearch ? true : SearchPathToIndexMap[value] !== IMAGES_SEARCH_INDEX
          )
          .map((index) => ({ label: IndexToLabel[SearchPathToIndexMap[index]], value: index }))}
        rightSection={<IconChevronDown size={16} color="currentColor" />}
        sx={{ flexShrink: 1 }}
        onChange={onIndexNameChange}
      />
      <ClearableAutoComplete
        key={indexName}
        classNames={classes}
        placeholder="Search Civitai"
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
                entityType: SearchIndexEntityTypes[SearchPathToIndexMap[indexName]],
              },
              item.hit
            );

            setSearch('');
          }
        }}
        itemComponent={IndexRenderItem[SearchPathToIndexMap[indexName]] ?? ModelSearchItem}
        // prevent default filtering behavior
        filter={() => true}
        clearable={query.length > 0}
        {...autocompleteProps}
      />
    </Group>
  );
};

const IndexRenderItem: Record<string, React.FC> = {
  [MODELS_SEARCH_INDEX]: ModelSearchItem,
  [ARTICLES_SEARCH_INDEX]: ArticlesSearchItem,
  [USERS_SEARCH_INDEX]: UserSearchItem,
  [IMAGES_SEARCH_INDEX]: ImagesSearchItem,
  [COLLECTIONS_SEARCH_INDEX]: CollectionsSearchItem,
  [BOUNTIES_SEARCH_INDEX]: BountiesSearchItem,
};
