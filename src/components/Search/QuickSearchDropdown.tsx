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

const meilisearch = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id' }
);

// TODO: These styles were taken from the original SearchBar component. We should probably migrate that searchbar to use this component.
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

const SUPPORTED_USERNAME_INDEXES = [
  { value: MODELS_SEARCH_INDEX, label: 'Models' },
  { value: IMAGES_SEARCH_INDEX, label: 'Images' },
  { value: BOUNTIES_SEARCH_INDEX, label: 'Bounties' },
  { value: ARTICLES_SEARCH_INDEX, label: 'Articles' },
  { value: USERS_SEARCH_INDEX, label: 'Users' },
  { value: COLLECTIONS_SEARCH_INDEX, label: 'Collections' },
] as const;

const DEFAULT_DROPDOWN_ITEM_LIMIT = 5;

type SupportedSearchIndex = (typeof SUPPORTED_USERNAME_INDEXES)[number]['value'];

type QuickSearchDropdownProps = Omit<AutocompleteProps, 'data'> & {
  supportedIndexes?: SupportedSearchIndex[];
  onItemSelected: (item: ShowcaseItemSchema) => void;
  filters?: string;
};

export const QuickSearchDropdown = ({ filters, ...props }: QuickSearchDropdownProps) => {
  const [targetIndex, setTargetIndex] = useState<SupportedSearchIndex>(MODELS_SEARCH_INDEX);
  const handleTargetChange = (value: SupportedSearchIndex) => {
    setTargetIndex(value);
  };

  return (
    <InstantSearch searchClient={meilisearch} indexName={targetIndex}>
      <Configure hitsPerPage={DEFAULT_DROPDOWN_ITEM_LIMIT} filters={filters} />

      <QuickSearchDropdownContent
        {...props}
        indexName={targetIndex}
        onIndexNameChange={handleTargetChange}
      />
    </InstantSearch>
  );
};

const QuickSearchDropdownContent = ({
  indexName,
  onIndexNameChange,
  onItemSelected,
  filters,
  supportedIndexes,
  ...autocompleteProps
}: QuickSearchDropdownProps & {
  indexName: SearchIndex;
  onIndexNameChange: (indexName: SupportedSearchIndex) => void;
}) => {
  const currentUser = useCurrentUser();
  const { query, refine: setQuery } = useSearchBox();
  const { hits, results } = useHits();
  const { classes } = useStyles();
  const features = useFeatureFlags();
  const [search, setSearch] = useState(query);
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const availableIndexes = useMemo(() => {
    if (!supportedIndexes) return SUPPORTED_USERNAME_INDEXES;

    return SUPPORTED_USERNAME_INDEXES.filter((index) => supportedIndexes.includes(index.value));
  }, [supportedIndexes]);

  const {
    models: hiddenModels,
    images: hiddenImages,
    tags: hiddenTags,
    users: hiddenUsers,
    isLoading: loadingPreferences,
  } = useHiddenPreferencesContext();

  const items = useMemo(() => {
    if (!results || !results.nbHits) return [];

    let filteredResults: (
      | ModelSearchIndexRecord
      | ArticleSearchIndexRecord
      | ImageSearchIndexRecord
      | UserSearchIndexRecord
      | CollectionSearchIndexRecord
      | BountySearchIndexRecord
    )[] = [];

    const opts = {
      currentUserId: currentUser?.id,
      hiddenImages: hiddenImages,
      hiddenTags: hiddenTags,
      hiddenUsers: hiddenUsers,
      hiddenModels,
    };

    if (indexName === MODELS_SEARCH_INDEX) {
      filteredResults = applyUserPreferencesModels({
        ...opts,
        items: hits as unknown as ModelSearchIndexRecord[],
      });
    } else if (indexName === ARTICLES_SEARCH_INDEX) {
      filteredResults = applyUserPreferencesArticles({
        ...opts,
        items: hits as unknown as ArticleSearchIndexRecord[],
      });
    } else if (indexName === IMAGES_SEARCH_INDEX) {
      filteredResults = applyUserPreferencesImages({
        ...opts,
        items: hits as unknown as ImageSearchIndexRecord[],
      });
    } else if (indexName === USERS_SEARCH_INDEX) {
      filteredResults = applyUserPreferencesUsers({
        ...opts,
        items: hits as unknown as UserSearchIndexRecord[],
      });
    } else if (indexName === COLLECTIONS_SEARCH_INDEX) {
      filteredResults = applyUserPreferencesCollections({
        ...opts,
        items: hits as unknown as CollectionSearchIndexRecord[],
      });
    } else if (indexName === BOUNTIES_SEARCH_INDEX) {
      filteredResults = applyUserPreferencesBounties({
        ...opts,
        items: hits as unknown as BountySearchIndexRecord[],
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

    return items;
  }, [hits, query, results, hiddenModels, hiddenImages, hiddenTags, hiddenUsers]);

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
        defaultValue={availableIndexes[0].value}
        // Ensure we disable search targets if they are not enabled
        data={availableIndexes.filter((value) =>
          features.imageSearch ? true : value.value !== IMAGES_SEARCH_INDEX
        )}
        rightSection={<IconChevronDown size={16} color="currentColor" />}
        sx={{ flexShrink: 1 }}
        onChange={onIndexNameChange}
      />
      <ClearableAutoComplete
        key={indexName}
        classNames={classes}
        placeholder="Search Civitai"
        type="search"
        nothingFound={
          !hits.length ? (
            <TimeoutLoader delay={1500} renderTimeout={() => <Text>No results found</Text>} />
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
        onClear={() => setSearch('')}
        // onBlur={() => (!isMobile ? onClear?.() : undefined)}
        onItemSubmit={(item) => {
          if (item.hit) {
            onItemSelected({
              entityId: item.hit.id,
              entityType: SearchIndexEntityTypes[indexName],
            });

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
};

const IndexRenderItem: Record<string, React.FC> = {
  [MODELS_SEARCH_INDEX]: ModelSearchItem,
  [ARTICLES_SEARCH_INDEX]: ArticlesSearchItem,
  [USERS_SEARCH_INDEX]: UserSearchItem,
  [IMAGES_SEARCH_INDEX]: ImagesSearchItem,
  [COLLECTIONS_SEARCH_INDEX]: CollectionsSearchItem,
  [BOUNTIES_SEARCH_INDEX]: BountiesSearchItem,
};
