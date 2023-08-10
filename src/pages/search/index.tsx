import {
  Container,
  Title,
  Stack,
  SegmentedControl,
  SegmentedControlItem,
  Group,
  ThemeIcon,
  Text,
  createStyles,
} from '@mantine/core';
import {
  InstantSearch,
  InstantSearchProps,
  SearchBox,
  useInstantSearch,
  useSearchBox,
} from 'react-instantsearch-hooks-web';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { createInstantSearchRouterNext } from 'react-instantsearch-router-nextjs';
import singletonRouter from 'next/router';
import { QS } from '~/utils/qs';

import { env } from '~/env/client.mjs';
import {
  ChipRefinementList,
  SearchableMultiSelectRefinementList,
  SortBy,
} from '~/components/Search/CustomSearchComponents';
import { ModelsHitList } from '~/components/Search/ModelsHitList';
import {
  getRoutingForIndex,
  SearchIndex,
  SearchParams,
  searchParamsSchema,
  useSearchStore,
} from '~/components/Search/useSearchState';
import { IconCategory, IconFileText } from '@tabler/icons-react';
import { UiState } from 'instantsearch.js';

const searchClient = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id', keepZeroFacets: true }
);

const routing: InstantSearchProps['routing'] = {
  router: createInstantSearchRouterNext({
    singletonRouter,
    routerOptions: {
      windowTitle(routeState) {
        const [index] = Object.keys(routeState);
        return getRoutingForIndex((index as SearchIndex) || 'models').windowTitle(routeState);
      },
      createURL({ routeState, location }) {
        let query = '';

        if (routeState.models) {
          query = QS.stringify(routeState.models);
        }

        return `${location.pathname}?${query}`;
      },
      parseURL({ location }) {
        const result = searchParamsSchema.safeParse(QS.parse(location.search));
        const queryData: SearchParams | Record<string, string> = result.success ? result.data : {};

        const { index } = queryData;

        if (!index) {
          return {
            '': {},
          };
        }

        return getRoutingForIndex(index as SearchIndex).parseURL({ location });
      },
    },
  }),
  stateMapping: {
    routeToState(routeState) {
      if (routeState.models) {
        return getRoutingForIndex('models').routeToState(routeState);
      }

      return routeState;
    },
    stateToRoute(uiState) {
      const [index] = Object.keys(uiState);
      const routing = getRoutingForIndex(index ? (index as SearchIndex) : 'models');
      return routing.stateToRoute(uiState);
    },
  },
};

const useStyles = createStyles((theme) => ({}));

export default function Search() {
  return (
    <InstantSearch
      searchClient={searchClient}
      // Sets default sorting:
      indexName="models"
      routing={routing}
    >
      <Container fluid>
        <Stack
          sx={(theme) => ({
            height: 'calc(100vh - 2 * var(--mantine-header-height,50px))',
            position: 'fixed',
            left: 0,
            top: 'var(--mantine-header-height,50px)',
            width: '377px',
            overflowY: 'auto',
            padding: theme.spacing.md,
          })}
        >
          <SearchBox />
          <SortBy
            title="Sort models by"
            items={[
              { label: 'Highest Rated', value: 'models:metrics.weightedRating:desc' },
              { label: 'Most downloaded', value: 'models:metrics.downloadCount:desc' },
              { label: 'Most Liked', value: 'models:metrics.favoriteCount:desc' },
              { label: 'Most discussed', value: 'models:metrics.commentCount:desc' },
              { label: 'Newest', value: 'models:createdAt:desc' },
            ]}
          />
          <ChipRefinementList
            title="Filter by Base Model"
            attribute="modelVersion.baseModel"
            sortBy={['name']}
          />
          <ChipRefinementList title="Filter by Model Type" attribute="type" sortBy={['name']} />
          <ChipRefinementList
            title="Filter by Checkpoint Type"
            sortBy={['name']}
            attribute="checkpointType"
          />
          <SearchableMultiSelectRefinementList
            title="Tags"
            attribute="tags"
            // TODO.Search: Meiliserach & facet searching is not supported when used with sort by as Angolia provides it.  https://github.com/meilisearch/meilisearch-js-plugins/issues/1222
            // If that ever gets fixed, just make sortable true + limit 20 or something
            limit={9999}
            searchable={false}
          />
        </Stack>

        <Stack pl={377} w="100%">
          <SearchHeader />
          <RenderHits />
          <ModelsHitList />
        </Stack>
      </Container>
    </InstantSearch>
  );
}

const SearchHeader = () => {
  const { query } = useSearchBox();
  const { uiState, setUiState } = useInstantSearch();
  const { setSearchParamsByUiState, ...states } = useSearchStore((state) => state);
  const { theme } = useStyles();

  const [index] = Object.keys(uiState);
  const onChangeIndex = (value: string) => {
    console.log(value);
    // Now the complicated part:
    switch (index) {
      case 'models': {
        // We are on models, so we need to save the state of models
        setSearchParamsByUiState(uiState);
      }
    }

    if (states.hasOwnProperty(value)) {
      // Redirect to the route with the relevant state:
      const updatedUiState = getRoutingForIndex(value as SearchIndex).routeToState(
        states as UiState
      );

      setUiState(updatedUiState);
    } else {
      setUiState({ [value]: {} });
    }
  };

  const data: SegmentedControlItem[] = [
    {
      label: (
        <Group align="center" spacing={8} noWrap>
          <ThemeIcon
            size={30}
            color={index === 'models' ? theme.colors.dark[7] : 'transparent'}
            p={6}
          >
            <IconCategory />
          </ThemeIcon>
          <Text size="sm" inline>
            Models
          </Text>
        </Group>
      ),
      value: 'models',
    },
    {
      label: (
        <Group align="center" spacing={8} noWrap>
          <ThemeIcon
            size={30}
            color={index === 'articles' ? theme.colors.dark[7] : 'transparent'}
            p={6}
          >
            <IconFileText />
          </ThemeIcon>
          <Text size="sm" inline>
            Articles
          </Text>
        </Group>
      ),
      value: 'articles',
    },
  ];

  return (
    <>
      <Title>{query || 'Search page'}</Title>
      <SegmentedControl size="md" value={index} data={data} onChange={onChangeIndex} />
    </>
  );
};

const RenderHits = () => {
  const { uiState } = useInstantSearch();

  // console.log(uiState);

  return null;
};
