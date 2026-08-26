import type { InstantSearchRoutingParser } from '~/components/Search/parsers/base';
import {
  parseSearchParams,
  searchParamsSchema,
  stringArrayParamSchema,
} from '~/components/Search/parsers/base';
import * as z from 'zod';
import { QS } from '~/utils/qs';
import { removeEmpty } from '~/utils/object-helpers';
import type { IndexUiState, UiState } from 'instantsearch.js';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';

// Every entry must name an attribute the LIVE models index declares sortable — see
// `modelsSortableAttributes` in src/server/search-index/sortable-attributes.ts and the contract
// test in src/components/Search/__tests__/search-index-contract.test.ts. InstantSearch sends this
// string straight through to Meilisearch, so an attribute the index does not expose is not a
// degraded sort, it is a failed request and an empty results page.
export const ModelSearchIndexSortBy = [
  MODELS_SEARCH_INDEX,
  `${MODELS_SEARCH_INDEX}:metrics.thumbsUpCount:desc`,
  // Creator Controls keeps unmasked copies of downloads/tips in a sort-only `sortMetrics` field so
  // a hidden number can still order correctly. That field is not sortable on the live index yet —
  // declaring it and sorting on it needs a models index reset first — so these two stay on
  // `metrics.*` until that lands.
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
    baseModel: stringArrayParamSchema,
    modelType: stringArrayParamSchema,
    checkpointType: stringArrayParamSchema,
    tags: stringArrayParamSchema,
    users: stringArrayParamSchema,
    category: stringArrayParamSchema,
  })
  .partial();

export type ModelSearchParams = z.output<typeof modelSearchParamsSchema>;
type ModelUiState = UiState & {
  [MODELS_SEARCH_INDEX]?: IndexUiState & { modelId?: number | null };
};

export const modelInstantSearchRoutingParser: InstantSearchRoutingParser = {
  parseURL: ({ location }) => {
    const modelSearchIndexData = parseSearchParams(
      modelSearchParamsSchema,
      QS.parse(location.search)
    );

    return { [MODELS_SEARCH_INDEX]: removeEmpty(modelSearchIndexData) };
  },
  routeToState: (routeState: UiState) => {
    const models: ModelSearchParams = routeState[MODELS_SEARCH_INDEX] as ModelSearchParams;
    const refinementList: Record<string, string[]> = removeEmpty({
      'versions.baseModel': models.baseModel as string[],
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
    const baseModel = uiState[MODELS_SEARCH_INDEX].refinementList?.['versions.baseModel'];
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
