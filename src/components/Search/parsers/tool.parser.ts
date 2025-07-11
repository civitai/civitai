import type { UiState } from 'instantsearch.js';
import * as z from 'zod/v4';
import type { InstantSearchRoutingParser } from '~/components/Search/parsers/base';
import { searchParamsSchema } from '~/components/Search/parsers/base';
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
    company: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    type: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
  })
  .partial();

export const toolsInstantSearchRoutingParser: InstantSearchRoutingParser = {
  parseURL: ({ location }) => {
    const collectionSearchIndexResult = toolSearchParamsSchema.safeParse(QS.parse(location.search));
    const collectionSearchIndexData: ToolSearchParams | Record<string, string[]> =
      collectionSearchIndexResult.success ? collectionSearchIndexResult.data : {};

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
