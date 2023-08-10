import { z } from 'zod';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';
import { UiState } from 'instantsearch.js';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

export const searchIndexes = ['models'] as const;
export type SearchIndex = (typeof searchIndexes)[number];
export const searchParamsSchema = z.object({
  index: z.enum(searchIndexes),
});

export type SearchParams = z.output<typeof searchParamsSchema>;

export const ModelSearchIndexSortBy = [
  'models:metrics.weightedRating:desc',
  'models:metrics.downloadCount:desc',
  'models:metrics.favoriteCount:desc',
  'models:metrics.commentCount:desc',
  'models:createdAt:desc',
] as const;

const modelSearchParamsSchema = z
  .object({
    query: z.any().transform((val) => val.toString()),
    index: z.literal('models'),
    sortBy: z.enum(ModelSearchIndexSortBy),
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

type StoreState = {
  models: ModelSearchParams;
  setSearchParamsByUiState: (uiState: UiState) => void;
  setModelSearchParams: (filters: Partial<ModelSearchParams>) => void;
};

type InstantSearchRoutingParser = {
  parseURL: (params: { location: Location }) => UiState;
  routeToState: (routeState: UiState) => UiState;
  stateToRoute: (routeState: UiState) => UiState;
  windowTitle: (routeState: UiState) => string;
};

const modelInstantSearchRoutingParser: InstantSearchRoutingParser = {
  windowTitle: (routeState) => {
    if (!routeState.models) {
      return '';
    }

    return routeState.models.query
      ? `Civitai | Search Models - ${routeState.models.query}`
      : 'Civitai | Search Models';
  },
  parseURL: ({ location }) => {
    const modelSearchIndexResult = modelSearchParamsSchema.safeParse(QS.parse(location.search));
    const modelSearchIndexData: ModelSearchParams | Record<string, string[]> =
      modelSearchIndexResult.success ? modelSearchIndexResult.data : {};

    return { models: removeEmpty(modelSearchIndexData) };
  },
  routeToState: (routeState: UiState) => {
    const models: ModelSearchParams = routeState.models as ModelSearchParams;
    const refinementList: Record<string, string[]> = removeEmpty({
      'modelVersion.baseModel': models.baseModel,
      type: models.modelType,
      checkpointType: models.checkpointType,
      tags: models.tags,
    });

    return {
      models: {
        query: models.query,
        sortBy: models.sortBy,
        refinementList,
      },
    };
  },
  stateToRoute: (uiState: UiState) => {
    const baseModel = uiState.models.refinementList?.['modelVersion.baseModel'];
    const modelType = uiState.models.refinementList?.['type'];
    const checkpointType = uiState.models.refinementList?.['checkpointType'];
    const tags = uiState.models.refinementList?.['tags'];
    const sortBy =
      (uiState.models.sortBy as ModelSearchParams['sortBy']) ||
      'models:metrics.weightedRating:desc';
    const query = uiState.models.query;

    const state: ModelSearchParams = {
      index: 'models',
      baseModel,
      modelType,
      checkpointType,
      tags,
      sortBy,
      query,
    };

    return {
      models: state,
    };
  },
};

export const getRoutingForIndex = (index: SearchIndex): InstantSearchRoutingParser => {
  switch (index) {
    case 'models':
      return modelInstantSearchRoutingParser;
  }
};

type SearchStore = ReturnType<typeof useSearchStore>;
export const useSearchStore = create<StoreState>()(
  devtools(
    immer((set) => {
      return {
        models: {}, // Initially, all of these will be empty.
        // methods
        setSearchParamsByUiState: (uiState: UiState) => {
          const [index] = Object.keys(uiState);

          if (!index) {
            return;
          }

          const routing = getRoutingForIndex(index as SearchIndex);

          switch (index) {
            default:
            case 'models':
              set((state) => {
                state.models = routing.stateToRoute(uiState).models as ModelSearchParams;
              });
          }
        },
        setModelSearchParams: (params) =>
          set((state) => {
            state.models = params;
          }),
      };
    })
  )
);
