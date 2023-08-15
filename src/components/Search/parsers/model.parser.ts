import { InstantSearchRoutingParser, searchParamsSchema } from '~/components/Search/parsers/base';
import { z } from 'zod';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';
import { UiState } from 'instantsearch.js';

export const ModelSearchIndexSortBy = [
  'models:metrics.weightedRating:desc',
  'models:metrics.downloadCount:desc',
  'models:metrics.favoriteCount:desc',
  'models:metrics.commentCount:desc',
  'models:createdAt:desc',
] as const;

const ModelDefaultSortBy = ModelSearchIndexSortBy[0];

const modelSearchParamsSchema = searchParamsSchema
  .extend({
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

export type ModelSearchParams = z.output<typeof modelSearchParamsSchema>;

export const modelInstantSearchRoutingParser: InstantSearchRoutingParser = {
  parseURL: ({ location }) => {
    const modelSearchIndexResult = modelSearchParamsSchema.safeParse(QS.parse(location.search));
    const modelSearchIndexData: ModelSearchParams | Record<string, string[]> =
      modelSearchIndexResult.success ? modelSearchIndexResult.data : {};

    console.log('modelSearchIndexData', modelSearchIndexData, removeEmpty(modelSearchIndexData));

    return { models: removeEmpty(modelSearchIndexData) };
  },
  routeToState: (routeState: UiState) => {
    console.log('routeToState', routeState);
    const models: ModelSearchParams = routeState.models as ModelSearchParams;
    const refinementList: Record<string, string[]> = removeEmpty({
      'version.baseModel': models.baseModel,
      type: models.modelType,
      checkpointType: models.checkpointType,
      'tags.name': models.tags,
    });

    const { query, page, sortBy } = models;

    return {
      models: {
        query,
        page,
        sortBy: sortBy ?? ModelDefaultSortBy,
        refinementList,
      },
    };
  },
  stateToRoute: (uiState: UiState) => {
    console.log('stateToRoute', uiState);

    const baseModel = uiState.models.refinementList?.['version.baseModel'];
    const modelType = uiState.models.refinementList?.['type'];
    const checkpointType = uiState.models.refinementList?.['checkpointType'];
    const tags = uiState.models.refinementList?.['tags.name'];
    const sortBy = (uiState.models.sortBy as ModelSearchParams['sortBy']) || ModelDefaultSortBy;
    const { query, page } = uiState.models;

    const state: ModelSearchParams = {
      baseModel,
      modelType,
      checkpointType,
      tags,
      sortBy,
      query,
      page,
    };

    return {
      models: state,
    };
  },
};
