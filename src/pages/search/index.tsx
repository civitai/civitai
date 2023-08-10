import { Container, Title, Stack } from '@mantine/core';
import { InstantSearch, InstantSearchProps } from 'react-instantsearch-hooks-web';
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
import { removeEmpty } from '~/utils/object-helpers';
import { z } from 'zod';

const searchClient = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id', keepZeroFacets: true }
);

const searchParamsSchema = z.object({
  index: z.enum(['models']),
});

type SearchParams = z.output<typeof searchParamsSchema>;

const ModelIndexSortBy = [
  'models:metrics.weightedRating:desc',
  'models:metrics.downloadCount:desc',
  'models:metrics.favoriteCount:desc',
  'models:metrics.commentCount:desc',
  'models:createdAt:desc',
] as const;

const modelSearchParamsSchema = z
  .object({
    query: z.string(),
    index: z.literal('models'),
    sortBy: z.enum(ModelIndexSortBy),
    baseModel: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    modelType: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    checkpointType: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    tags: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
  })
  .partial();

type ModelSearchParams = z.output<typeof modelSearchParamsSchema>;

const routing: InstantSearchProps['routing'] = {
  router: createInstantSearchRouterNext({
    singletonRouter,
    routerOptions: {
      windowTitle(routeState) {
        if (routeState.models) {
          return 'Searching for: Models';
        }

        return '';
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

        if (index === 'models') {
          const modelSearchIndexResult = modelSearchParamsSchema.safeParse(
            QS.parse(location.search)
          );
          const modelSearchIndexData: ModelSearchParams | Record<string, string[]> =
            modelSearchIndexResult.success ? modelSearchIndexResult.data : {};

          return { [index]: removeEmpty(modelSearchIndexData) };
        }

        return {
          [index]: {},
        };
      },
    },
  }),
  stateMapping: {
    routeToState(routeState) {
      const routeStateFinal: typeof routeState = {};

      if (routeState.models) {
        const models: ModelSearchParams = routeState.models as ModelSearchParams;
        const refinementList: Record<string, string[]> = removeEmpty({
          'modelVersion.baseModel': models.baseModel,
          type: models.modelType,
          checkpointType: models.checkpointType,
          tags: models.tags,
        });

        routeStateFinal.models = {
          refinementList,
          sortBy: models.sortBy,
        };

        return routeStateFinal;
      }

      return routeState;
    },
    stateToRoute(uiState) {
      const [index] = Object.keys(uiState);

      switch (index) {
        default: // Default to models:
        case 'models': {
          const baseModel = uiState[index].refinementList?.['modelVersion.baseModel'];
          const modelType = uiState[index].refinementList?.['type'];
          const checkpointType = uiState[index].refinementList?.['checkpointType'];
          const tags = uiState[index].refinementList?.['tags'];
          const sortBy =
            (uiState[index].sortBy as ModelSearchParams['sortBy']) ||
            'models:metrics.weightedRating:desc';

          const state: ModelSearchParams = {
            index: 'models',
            baseModel,
            modelType,
            checkpointType,
            tags,
            sortBy,
          };

          return {
            models: state,
          };
        }
      }
    },
  },
};

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
          <Title>Models Search experience</Title>
          <ModelsHitList />
        </Stack>
      </Container>
    </InstantSearch>
  );
}
