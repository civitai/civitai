import { Group, Text, UnstyledButton, createStyles } from '@mantine/core';
import { useDebouncedValue, useElementSize, useOs } from '@mantine/hooks';
import { SpotlightAction, SpotlightProvider, openSpotlight } from '@mantine/spotlight';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { IconSearch } from '@tabler/icons-react';
import { debounce } from 'lodash-es';
import Router from 'next/router';
import { useMemo } from 'react';
import {
  Configure,
  Index,
  InstantSearch,
  InstantSearchApi,
  SearchBoxProps,
  useInstantSearch,
  useSearchBox,
} from 'react-instantsearch-hooks-web';

import { useSearchStore } from '~/components/QuickSearch/search.store';
import {
  applyQueryMatchers,
  filterIcons,
  getFiltersByIndexName,
  hasForceUniqueQueryAttribute,
} from '~/components/QuickSearch/util';
import { env } from '~/env/client.mjs';
import { ActionsWrapper } from './ActionsWrapper';
import { CustomSpotlightAction } from './CustomSpotlightAction';

const searchClient = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id' }
);

const useStyles = createStyles((theme) => ({
  searchBar: {
    padding: `4px 5px 4px 12px`,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : 'transparent',
    border: `1px solid ${
      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
    }`,
    outline: 0,
    width: 225,
  },
  keyboardIndicator: {
    border: `1px solid ${
      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
    }`,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[0],
    padding: `0 ${theme.spacing.xs}px`,
  },
}));

function prepareModelActions(hits: InstantSearchApi['results']['hits']): SpotlightAction[] {
  return hits.map((hit) => {
    // TODO.clientsideFiltering modify this to use the user's tag preferences
    let coverImage = hit.images.at(0);
    for (const image of hit.images) {
      if (coverImage.nsfw === 'None') break;
      if (image.nsfw === 'None') {
        coverImage = image;
        break;
      } else if (image.nsfw === 'Safe' && coverImage.nsfw !== 'Safe') {
        coverImage = image;
      }
    }

    return {
      ...hit,
      id: hit.id,
      title: hit.name,
      group: 'models',
      image: coverImage,
      onTrigger: () => Router.push(`/models/${hit.id}`),
    };
  });
}

function prepareUserActions(hits: InstantSearchApi['results']['hits']): SpotlightAction[] {
  return hits.map((hit) => ({
    ...hit,
    id: hit.id,
    title: hit.username,
    image: hit.image,
    group: 'users',
    onTrigger: () => Router.push(`/user/${hit.username}`),
  }));
}

function prepareArticleActions(hits: InstantSearchApi['results']['hits']): SpotlightAction[] {
  return hits.map((hit) => ({
    ...hit,
    id: hit.id,
    title: hit.title,
    image: hit.cover,
    group: 'articles',
    onTrigger: () => Router.push(`/articles/${hit.id}`),
  }));
}

function prepareTagActions(hits: InstantSearchApi['results']['hits']): SpotlightAction[] {
  return hits.map((hit) => ({
    ...hit,
    id: hit.id,
    title: hit.name,
    group: 'tags',
    onTrigger: () => Router.push('/tag/' + encodeURIComponent(hit.name)),
  }));
}

function InnerSearch(props: SearchBoxProps) {
  const os = useOs();
  const { classes } = useStyles();
  const { scopedResults, results } = useInstantSearch();
  const { refine, query } = useSearchBox(props);
  const { ref, height } = useElementSize();

  const rawQuery = useSearchStore((state) => state.query);
  const setRawQuery = useSearchStore((state) => state.setQuery);
  const quickSearchFilter = useSearchStore((state) => state.quickSearchFilter);
  const setQuickSearchFilter = useSearchStore((state) => state.setQuickSearchFilter);
  const [debouncedRawQuery] = useDebouncedValue(rawQuery, 300);

  const { matchedFilters } = applyQueryMatchers(debouncedRawQuery, [quickSearchFilter]);
  const uniqueQueryAttributeMatched = hasForceUniqueQueryAttribute(matchedFilters);
  const indexName = uniqueQueryAttributeMatched?.indexName ?? 'models';
  const filters = getFiltersByIndexName(indexName, matchedFilters);

  console.log(scopedResults, results);

  let actions: SpotlightAction[] = [];
  if (scopedResults && scopedResults.length > 0) {
    actions = scopedResults.flatMap((scope) => {
      if (!scope.results || scope.results.nbHits === 0) return [];

      switch (scope.indexId) {
        case 'models':
          return prepareModelActions(scope.results.hits);
        case 'users':
          return prepareUserActions(scope.results.hits);
        case 'articles':
          return prepareArticleActions(scope.results.hits);
        case 'tags':
          return prepareTagActions(scope.results.hits);
        default:
          return [];
      }
    });
  }

  if (query.length > 0) {
    actions.unshift({
      id: 'old-search',
      group: 'search',
      title: 'Keyword search',
      description: 'Search for models using the keywords you entered',
      onTrigger: () => Router.push(`/?query=${encodeURIComponent(query)}&view=feed`),
    });
  }

  const modelsFilter = getFiltersByIndexName('models', matchedFilters);

  const handleQueryChange = (value: string) => {
    setRawQuery(value);
    const { updatedQuery, matchedFilters: queryMatchedFilters } = applyQueryMatchers(value, [
      quickSearchFilter,
    ]);
    refine(updatedQuery);

    // Set filter based on first character of the query
    if (value.length > 1) {
      return;
    }

    // If a filter is already active, hasForceUniqueQueryAttribute will return the that value and as such
    // we won't get the "newly" selected filter, so we have to match it with the actual query temporarily.
    const queryUniqueQueryAttributeMatched = hasForceUniqueQueryAttribute(queryMatchedFilters);

    if (
      queryUniqueQueryAttributeMatched &&
      queryUniqueQueryAttributeMatched.filterId &&
      quickSearchFilter !== queryUniqueQueryAttributeMatched.filterId
    ) {
      setQuickSearchFilter(queryUniqueQueryAttributeMatched.filterId);
    } else if (!value || (quickSearchFilter !== 'all' && !queryUniqueQueryAttributeMatched)) {
      setQuickSearchFilter('all');
    }
  };

  // Wrap it in useMemo to avoid re-rendering the component on every render
  const ActionsWrapperComponent = useMemo(
    // eslint-disable-next-line react/display-name
    () => (props: { children: React.ReactNode }) => <ActionsWrapper {...props} ref={ref} />,
    [ref]
  );

  return (
    <>
      {uniqueQueryAttributeMatched ? (
        <>
          <Index indexName={indexName}>
            <Configure filters={filters} hitsPerPage={20} />
          </Index>
        </>
      ) : (
        <>
          <Index indexName="models">
            <Configure filters={modelsFilter} hitsPerPage={5} />
          </Index>
          <Index indexName="users">
            <Configure hitsPerPage={5} />
          </Index>
          <Index indexName="articles">
            <Configure hitsPerPage={5} />
          </Index>
          <Index indexName="tags">
            <Configure hitsPerPage={5} />
          </Index>
        </>
      )}

      <SpotlightProvider
        actions={actions}
        searchIcon={filterIcons[quickSearchFilter]}
        actionComponent={CustomSpotlightAction}
        actionsWrapperComponent={ActionsWrapperComponent}
        searchPlaceholder="Search models, users, articles, tags"
        nothingFoundMessage="Nothing found"
        onQueryChange={handleQueryChange}
        cleanQueryOnClose={false}
        filter={(_, actions) => actions}
        limit={20}
        styles={(theme) => ({
          inner: { paddingTop: 50 },
          spotlight: { overflow: 'hidden' },
          actions: {
            overflow: 'auto',
            height: '55vh',

            [theme.fn.smallerThan('sm')]: {
              height: `calc(100vh - ${height + 137}px)`,
            },
          },
        })}
      >
        <UnstyledButton className={classes.searchBar} onClick={() => openSpotlight()}>
          <Group position="apart" noWrap>
            <Group spacing={8} noWrap>
              <IconSearch size={16} />
              <Text color="dimmed">Search</Text>
            </Group>
            <Text className={classes.keyboardIndicator} size="xs" color="dimmed">
              {os === 'macos' ? '⌘ + K' : 'Ctrl + K'}
            </Text>
          </Group>
        </UnstyledButton>
      </SpotlightProvider>
    </>
  );
}

/**
 * Needs to be declared either outside or inside a useCallback to avoid re-rendering the component on every render
 * @see https://www.algolia.com/doc/api-reference/widgets/search-box/react-hooks/#hook-params
 */
const debouncedQueryHook = debounce((query, refine) => {
  refine(query);
}, 300);

export function QuickSearch() {
  return (
    <InstantSearch
      searchClient={searchClient}
      initialUiState={{
        models: { hitsPerPage: 0 },
      }}
    >
      {/* hitsPerPage = 0 because this refers to the "main" index instead of the configured. Might get duped results if we don't remove the results */}
      <Configure hitsPerPage={0} />
      <InnerSearch queryHook={debouncedQueryHook} />
    </InstantSearch>
  );
}
