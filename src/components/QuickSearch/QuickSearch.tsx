import { Group, Text, UnstyledButton, createStyles } from '@mantine/core';
import { useDebouncedValue, useOs } from '@mantine/hooks';
import { SpotlightAction, SpotlightProvider, openSpotlight } from '@mantine/spotlight';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { IconSearch } from '@tabler/icons-react';
import Router from 'next/router';
import { useEffect } from 'react';
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
  const { scopedResults } = useInstantSearch();
  const { refine } = useSearchBox(props);

  const query = useSearchStore((state) => state.query);
  const quickSearchFilter = useSearchStore((state) => state.quickSearchFilter);
  const setQuery = useSearchStore((state) => state.setQuery);
  const setQuickSearchFilter = useSearchStore((state) => state.setQuickSearchFilter);

  const [debouncedQuery] = useDebouncedValue(query, 300);

  const { updatedQuery, matchedFilters } = applyQueryMatchers(debouncedQuery, [quickSearchFilter]);
  const uniqueQueryAttributeMatched = hasForceUniqueQueryAttribute(matchedFilters);

  useEffect(() => refine(updatedQuery), [refine, updatedQuery]);

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
      onTrigger: () => Router.push(`/?query=${updatedQuery}&view=feed`),
    });
  }

  const modelsFilter = getFiltersByIndexName('models', matchedFilters);

  const renderIndexes = () => {
    if (uniqueQueryAttributeMatched) {
      const { indexName } = uniqueQueryAttributeMatched;
      const filters = getFiltersByIndexName(indexName, matchedFilters);

      return (
        <>
          <Configure hitsPerPage={0} />
          <Index indexName={indexName}>
            <Configure filters={filters} hitsPerPage={20} />
          </Index>
        </>
      );
    }

    return (
      <>
        {/*  hitsPerPage = 0 because this refers to the "main" index instead of the configured. Might get duped results if we don't remove the results */}
        <Configure hitsPerPage={0} />
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
    );
  };

  const handleQueryChange = (value: string) => {
    setQuery(value);

    // Set filter based on first character of the query
    if (value.length > 1 || quickSearchFilter !== 'all') {
      return;
    }

    // If a filter is already active, hasForceUniqueQueryAttribute will return the that value and as such
    // we won't get the "newly" selected filter, so we have to match it with the actual query temporarily.
    const { matchedFilters: queryMatchedFilters } = applyQueryMatchers(value);
    const queryUniqueQueryAttributeMatched = hasForceUniqueQueryAttribute(queryMatchedFilters);

    if (
      queryUniqueQueryAttributeMatched &&
      queryUniqueQueryAttributeMatched.filterId &&
      quickSearchFilter !== queryUniqueQueryAttributeMatched.filterId
    ) {
      // setQuery('');
      setQuickSearchFilter(queryUniqueQueryAttributeMatched.filterId);
    } else {
      setQuickSearchFilter('all');
    }
  };

  return (
    <>
      {/* hitsPerPage = 0 because this refers to the "main" index instead of the configured. Might get duped results if we don't remove the results */}
      {renderIndexes()}

      <SpotlightProvider
        actions={actions}
        searchIcon={
          quickSearchFilter !== 'all' ? filterIcons[quickSearchFilter] : <IconSearch size={18} />
        }
        actionComponent={CustomSpotlightAction}
        actionsWrapperComponent={ActionsWrapper}
        searchPlaceholder="Search models, users, articles, tags"
        nothingFoundMessage="Nothing found"
        onQueryChange={handleQueryChange}
        cleanQueryOnClose={false}
        filter={(_, actions) => actions}
        limit={20}
        styles={() => ({
          inner: { paddingTop: 50 },
          spotlight: { overflow: 'hidden' },
          actions: { overflow: 'auto', maxHeight: '55vh' },
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

export function QuickSearch() {
  return (
    <InstantSearch searchClient={searchClient} indexName="models">
      <InnerSearch />
    </InstantSearch>
  );
}
