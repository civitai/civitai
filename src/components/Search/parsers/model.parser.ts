import { InstantSearchRoutingParser, searchParamsSchema } from '~/components/Search/parsers/base';
import { z } from 'zod';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';
import { UiState } from 'instantsearch.js';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';

export const ModelSearchIndexSortBy = [
  MODELS_SEARCH_INDEX,
  `${MODELS_SEARCH_INDEX}:metrics.weightedRating:desc`,
  `${MODELS_SEARCH_INDEX}:metrics.downloadCount:desc`,
  `${MODELS_SEARCH_INDEX}:metrics.favoriteCount:desc`,
  `${MODELS_SEARCH_INDEX}:metrics.commentCount:desc`,
  `${MODELS_SEARCH_INDEX}:createdAt:desc`,
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
    users: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    category: z
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

    return { [MODELS_SEARCH_INDEX]: removeEmpty(modelSearchIndexData) };
  },
  routeToState: (routeState: UiState) => {
    const models: ModelSearchParams = routeState[MODELS_SEARCH_INDEX] as ModelSearchParams;
    const refinementList: Record<string, string[]> = removeEmpty({
      'version.baseModel': models.baseModel,
      'category.name': models.category,
      type: models.modelType,
      checkpointType: models.checkpointType,
      'tags.name': models.tags,
      'user.username': models.users,
    });

    const { query, sortBy } = models;

    return {
      [MODELS_SEARCH_INDEX]: {
        sortBy: sortBy ?? ModelDefaultSortBy,
        refinementList,
        query,
      },
    };
  },
  stateToRoute: (uiState: UiState) => {
    const baseModel = uiState[MODELS_SEARCH_INDEX].refinementList?.['version.baseModel'];
    const modelType = uiState[MODELS_SEARCH_INDEX].refinementList?.['type'];
    const category = uiState[MODELS_SEARCH_INDEX].refinementList?.['category.name'];
    const checkpointType = uiState[MODELS_SEARCH_INDEX].refinementList?.['checkpointType'];
    const tags = uiState[MODELS_SEARCH_INDEX].refinementList?.['tags.name'];
    const users = uiState[MODELS_SEARCH_INDEX].refinementList?.['user.username'];
    const sortBy =
      (uiState[MODELS_SEARCH_INDEX].sortBy as ModelSearchParams['sortBy']) || ModelDefaultSortBy;
    const { query } = uiState[MODELS_SEARCH_INDEX];

    const state: ModelSearchParams = {
      category,
      baseModel,
      modelType,
      checkpointType,
      users,
      tags,
      sortBy,
      query,
    };

    return {
      [MODELS_SEARCH_INDEX]: state,
    };
  },
};
