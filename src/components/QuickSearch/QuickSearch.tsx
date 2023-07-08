import { Group, Text, UnstyledButton, createStyles } from '@mantine/core';
import { useOs } from '@mantine/hooks';
import { SpotlightAction, SpotlightProvider, openSpotlight } from '@mantine/spotlight';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { IconSearch } from '@tabler/icons-react';
import Router from 'next/router';
import {
  Configure,
  Index,
  InstantSearch,
  InstantSearchApi,
  SearchBoxProps,
  useInstantSearch,
  useSearchBox,
} from 'react-instantsearch-hooks-web';
import { env } from '~/env/client.mjs';

import { CustomSpotlightAction } from './CustomSpotlightAction';
import { useDebouncer } from '~/utils/debouncer';

const searchClient = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id' }
);

const useStyles = createStyles((theme) => ({
  searchBar: {
    padding: `4px 5px 4px 12px`,
    borderRadius: theme.radius.md,
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
  const { refine } = useSearchBox(props);
  const { scopedResults } = useInstantSearch();
  const debouncer = useDebouncer(300);
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

  return (
    <SpotlightProvider
      actions={actions}
      searchIcon={<IconSearch size={18} />}
      actionComponent={CustomSpotlightAction}
      searchPlaceholder="Search models, users, articles, tags"
      nothingFoundMessage="Nothing found"
      onQueryChange={(query) => debouncer(() => refine(query))}
      filter={(_, actions) => actions}
      limit={20}
      styles={(theme) => ({
        inner: {
          paddingTop: 70,
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
  );
}

export function QuickSearch() {
  return (
    <InstantSearch indexName="models" searchClient={searchClient}>
      <Index indexName="users" />
      <Index indexName="articles" />
      <Index indexName="tags" />
      <Configure hitsPerPage={5} />
      <InnerSearch />
    </InstantSearch>
  );
}
