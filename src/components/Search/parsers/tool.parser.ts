import type { UiState } from 'instantsearch.js';
import * as z from 'zod';
import type { InstantSearchRoutingParser } from '~/components/Search/parsers/base';
import {
  parseSearchParams,
  searchParamsSchema,
  stringArrayParamSchema,
} from '~/components/Search/parsers/base';
import { TOOLS_SEARCH_INDEX } from '~/server/common/constants';
import { removeEmpty } from '~/utils/object-helpers';
import { QS } from '~/utils/qs';

export const ToolsSearchIndexSortBy = [
  TOOLS_SEARCH_INDEX,
  `${TOOLS_SEARCH_INDEX}:name:asc`,
  `${TOOLS_SEARCH_INDEX}:name:desc`,
  `${TOOLS_SEARCH_INDEX}:createdAt:asc`,
  `${TOOLS_SEARCH_INDEX}:createdAt:desc`,
] as const;

const defaultSortBy = ToolsSearchIndexSortBy[0];

export type ToolSearchParams = z.output<typeof toolSearchParamsSchema>;
const toolSearchParamsSchema = searchParamsSchema
  .extend({
    index: z.literal('tools'),
    sortBy: z.enum(ToolsSearchIndexSortBy),
    company: stringArrayParamSchema,
    type: stringArrayParamSchema,
  })
  .partial();

export const toolsInstantSearchRoutingParser: InstantSearchRoutingParser = {
  parseURL: ({ location }) => {
    const collectionSearchIndexData = parseSearchParams(
      toolSearchParamsSchema,
      QS.parse(location.search)
    );

    return { [TOOLS_SEARCH_INDEX]: removeEmpty(collectionSearchIndexData) };
  },
  routeToState: (routeState: UiState) => {
    const tools: ToolSearchParams = (routeState[TOOLS_SEARCH_INDEX] || {}) as ToolSearchParams;
    const refinementList: Record<string, string[]> = removeEmpty({
      company: tools.company as string[],
      type: tools.type as string[],
    });
    const { query, sortBy } = tools;

    return {
      [TOOLS_SEARCH_INDEX]: {
        sortBy: sortBy ?? defaultSortBy,
        refinementList,
        query,
      },
    };
  },
  stateToRoute: (uiState: UiState) => {
    const company = uiState[TOOLS_SEARCH_INDEX].refinementList?.['company'];
    const type = uiState[TOOLS_SEARCH_INDEX].refinementList?.['type'];
    const sortBy =
      (uiState[TOOLS_SEARCH_INDEX].sortBy as ToolSearchParams['sortBy']) || defaultSortBy;

    const { query } = uiState[TOOLS_SEARCH_INDEX];

    const state: ToolSearchParams = {
      company,
      type,
      sortBy,
      query,
    };

    return {
      [TOOLS_SEARCH_INDEX]: state,
    };
  },
};
