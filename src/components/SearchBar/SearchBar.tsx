import { Group, Image, Text, ThemeIcon, UnstyledButton, createStyles } from '@mantine/core';
import { useOs } from '@mantine/hooks';
import {
  SpotlightAction,
  SpotlightProvider,
  openSpotlight,
  registerSpotlightActions,
} from '@mantine/spotlight';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { TagMetric } from '@prisma/client';
import { IconHash, IconSearch, IconUser } from '@tabler/icons-react';
import Router from 'next/router';
import { useEffect } from 'react';
import {
  Index,
  InstantSearch,
  InstantSearchApi,
  useInstantSearch,
  useSearchBox,
} from 'react-instantsearch-hooks-web';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { env } from '~/env/client.mjs';
import { isDefined } from '~/utils/type-guards';

import { CustomSpotlightAction } from './CustomSpotlightAction';

const searchClient = instantMeiliSearch(env.NEXT_PUBLIC_SEARCH_HOST as string, undefined, {
  primaryKey: 'id',
});

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
  return hits.map(({ id, name, images, ...hit }) => {
    const coverImage = images.at(0);

    return {
      ...hit,
      id,
      title: name,
      group: 'models',
      description: hit.tags.join(', '),
      keywords: hit.user.username,
      image: coverImage,
      onTrigger: () => Router.push(`/models/${id}`),
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

const mapTagMetricsToLabel = {
  modelCount: 'Models',
  imageCount: 'Images',
  articleCount: 'Articles',
  postCount: 'Posts',
} as const;
type TagMetricTarget = keyof typeof mapTagMetricsToLabel;

function prepareTagActions(hits: InstantSearchApi['results']['hits']): SpotlightAction[] {
  return hits.map((hit) => {
    const counts = Object.entries(hit.metrics as Pick<TagMetric, TagMetricTarget>)
      .map(([key, value]) =>
        mapTagMetricsToLabel[key as TagMetricTarget] && value > 0
          ? `${mapTagMetricsToLabel[key as TagMetricTarget]}: ${value.toLocaleString()}`
          : null
      )
      .filter(isDefined)
      .join(', ');

    return {
      id: hit.id,
      title: hit.name,
      description: counts,
      group: 'tags',
      icon: (
        <ThemeIcon variant="light" size="xl" radius="xl">
          <IconHash />
        </ThemeIcon>
      ),
      onTrigger: () => Router.push('/?tag=' + encodeURIComponent(hit.name)),
    };
  });
}

function InnerSearch() {
  const os = useOs();
  const { classes } = useStyles();
  const { refine } = useSearchBox();
  const { scopedResults } = useInstantSearch();
  let actions: SpotlightAction[] = [];

  if (scopedResults && scopedResults.length > 0) {
    const shouldUpdate = scopedResults.some((scope) => scope.results.nbHits > 0);

    if (shouldUpdate) {
      const [modelsScope, usersScope, imagesScope, tagsScope] = scopedResults;
      const modelActions = prepareModelActions(modelsScope.results.hits);
      const userActions = prepareUserActions(usersScope.results.hits);
      const tagActions = prepareTagActions(tagsScope.results.hits);
      actions = [...modelActions, ...userActions, ...tagActions];
    }
  }

  return (
    <SpotlightProvider
      actions={actions}
      searchIcon={<IconSearch size={18} />}
      actionComponent={CustomSpotlightAction}
      searchPlaceholder="Search models, images, articles, tags, users"
      nothingFoundMessage="Nothing found"
      onQueryChange={refine}
      limit={20}
      highlightQuery
    >
      <UnstyledButton className={classes.searchBar} onClick={() => openSpotlight()}>
        <Group position="apart" noWrap>
          <Group spacing={8} noWrap>
            <IconSearch size={16} />
            <Text color="dimmed">Search civitai</Text>
          </Group>
          <Text className={classes.keyboardIndicator} size="xs" color="dimmed">
            {os === 'macos' ? '⌘ + K' : 'Ctrl + K'}
          </Text>
        </Group>
      </UnstyledButton>
    </SpotlightProvider>
  );
}

export function SearchBar() {
  return (
    <InstantSearch indexName="models" searchClient={searchClient}>
      <Index indexName="creators" />
      <Index indexName="images" />
      <Index indexName="tags" />
      <InnerSearch />
    </InstantSearch>
  );
}
