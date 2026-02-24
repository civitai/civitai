import type { UiState } from 'instantsearch.js';
import * as z from 'zod';
import type { InstantSearchRoutingParser } from '~/components/Search/parsers/base';
import { searchParamsSchema } from '~/components/Search/parsers/base';
import { COMICS_SEARCH_INDEX } from '~/server/common/constants';
import { removeEmpty } from '~/utils/object-helpers';
import { QS } from '~/utils/qs';

export const ComicsSearchIndexSortBy = [
  COMICS_SEARCH_INDEX,
  `${COMICS_SEARCH_INDEX}:createdAt:desc`,
  `${COMICS_SEARCH_INDEX}:createdAt:asc`,
  `${COMICS_SEARCH_INDEX}:stats.followerCount:desc`,
  `${COMICS_SEARCH_INDEX}:stats.chapterCount:desc`,
] as const;

const defaultSortBy = ComicsSearchIndexSortBy[0];

export type ComicSearchParams = z.output<typeof comicSearchParamsSchema>;
const comicSearchParamsSchema = searchParamsSchema
  .extend({
    index: z.literal('comics'),
    sortBy: z.enum(ComicsSearchIndexSortBy),
    genre: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
  })
  .partial();

export const comicsInstantSearchRoutingParser: InstantSearchRoutingParser = {
  parseURL: ({ location }) => {
    const comicSearchIndexResult = comicSearchParamsSchema.safeParse(QS.parse(location.search));
    const comicSearchIndexData: ComicSearchParams | Record<string, string[]> =
      comicSearchIndexResult.success ? comicSearchIndexResult.data : {};

    return { [COMICS_SEARCH_INDEX]: removeEmpty(comicSearchIndexData) };
  },
  routeToState: (routeState: UiState) => {
    const comics: ComicSearchParams = (routeState[COMICS_SEARCH_INDEX] || {}) as ComicSearchParams;
    const refinementList: Record<string, string[]> = removeEmpty({
      genre: comics.genre as string[],
    });
    const { query, sortBy } = comics;

    return {
      [COMICS_SEARCH_INDEX]: {
        sortBy: sortBy ?? defaultSortBy,
        refinementList,
        query,
      },
    };
  },
  stateToRoute: (uiState: UiState) => {
    const genre = uiState[COMICS_SEARCH_INDEX].refinementList?.['genre'];
    const sortBy =
      (uiState[COMICS_SEARCH_INDEX].sortBy as ComicSearchParams['sortBy']) || defaultSortBy;

    const { query } = uiState[COMICS_SEARCH_INDEX];

    const state: ComicSearchParams = {
      genre,
      sortBy,
      query,
    };

    return {
      [COMICS_SEARCH_INDEX]: state,
    };
  },
};
