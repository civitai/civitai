import { InstantSearchRoutingParser, searchParamsSchema } from '~/components/Search/parsers/base';
import { z } from 'zod';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';
import { IndexUiState, UiState } from 'instantsearch.js';
import { IMAGES_SEARCH_INDEX, MODELS_SEARCH_INDEX } from '~/server/common/constants';

export const ModelSearchIndexSortBy = [
  MODELS_SEARCH_INDEX,
  `${MODELS_SEARCH_INDEX}:metrics.thumbsUpCount:desc`,
  `${MODELS_SEARCH_INDEX}:metrics.downloadCount:desc`,
  `${MODELS_SEARCH_INDEX}:metrics.favoriteCount:desc`,
  `${MODELS_SEARCH_INDEX}:metrics.commentCount:desc`,
  `${MODELS_SEARCH_INDEX}:metrics.collectedCount:desc`,
  `${MODELS_SEARCH_INDEX}:metrics.tippedAmountCount:desc`,
  `${MODELS_SEARCH_INDEX}:createdAt:desc`,
] as const;

const ModelDefaultSortBy = ModelSearchIndexSortBy[0];

const modelSearchParamsSchema = searchParamsSchema
  .extend({
    sortBy: z.enum(ModelSearchIndexSortBy),
    lastVersionAt: z.string(),
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
type ModelUiState = UiState & {
  [MODELS_SEARCH_INDEX]?: IndexUiState & { modelId?: number | null };
};

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
      'version.baseModel': models.baseModel as string[],
      'category.name': models.category as string[],
      type: models.modelType as string[],
      checkpointType: models.checkpointType as string[],
      'tags.name': models.tags as string[],
      'user.username': models.users as string[],
    });

    const range = removeEmpty({
      lastVersionAtUnix: models.lastVersionAt as string,
    });

    const { query, sortBy } = models;

    return {
      [MODELS_SEARCH_INDEX]: {
        sortBy: sortBy ?? ModelDefaultSortBy,
        refinementList,
        query,
        range,
      },
    };
  },
  stateToRoute: (uiState: ModelUiState) => {
    if (!uiState[MODELS_SEARCH_INDEX]) {
      return {
        [MODELS_SEARCH_INDEX]: {},
      };
    }

    const lastVersionAt = uiState[MODELS_SEARCH_INDEX].range?.['lastVersionAtUnix'];
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
      lastVersionAt,
    };

    return {
      [MODELS_SEARCH_INDEX]: state,
    };
  },
};
