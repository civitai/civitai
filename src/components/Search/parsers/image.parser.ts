import type { IndexUiState, UiState } from 'instantsearch.js';
import * as z from 'zod';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { removeEmpty } from '~/utils/object-helpers';
import { QS } from '~/utils/qs';
import type { InstantSearchRoutingParser } from './base';
import { searchParamsSchema } from './base';

export const ImagesSearchIndexSortBy = [
  IMAGES_SEARCH_INDEX,
  `${IMAGES_SEARCH_INDEX}:stats.reactionCountAllTime:desc`,
  `${IMAGES_SEARCH_INDEX}:stats.commentCountAllTime:desc`,
  `${IMAGES_SEARCH_INDEX}:stats.collectedCountAllTime:desc`,
  `${IMAGES_SEARCH_INDEX}:stats.tippedAmountCountAllTime:desc`,
  `${IMAGES_SEARCH_INDEX}:createdAt:desc`,
] as const;

const defaultSortBy = ImagesSearchIndexSortBy[0];

const imageSearchParamsSchema = searchParamsSchema
  .extend({
    imageId: z.coerce.number(),
    index: z.literal('images'),
    createdAt: z.string(),
    sortBy: z.enum(ImagesSearchIndexSortBy),
    baseModel: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    aspectRatio: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    tags: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    tools: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    techniques: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    users: z
      .union([z.array(z.string()), z.string()])
      .transform((val) => (Array.isArray(val) ? val : [val])),
  })
  .partial();

type ImageUiState = UiState & {
  [IMAGES_SEARCH_INDEX]?: IndexUiState & { imageId?: number | null };
};

export type ImageSearchParams = z.output<typeof imageSearchParamsSchema>;

export const imagesInstantSearchRoutingParser: InstantSearchRoutingParser = {
  parseURL: ({ location }) => {
    const imageSearchIndexResult = imageSearchParamsSchema.safeParse(QS.parse(location.search));
    const imageSearchIndexData: ImageSearchParams | Record<string, string[]> =
      imageSearchIndexResult.success ? imageSearchIndexResult.data : {};

    return { [IMAGES_SEARCH_INDEX]: removeEmpty(imageSearchIndexData) };
  },
  routeToState: (routeState: ImageUiState) => {
    const images: ImageSearchParams = (routeState[IMAGES_SEARCH_INDEX] || {}) as ImageSearchParams;
    const refinementList: Record<string, string[]> = removeEmpty({
      aspectRatio: images.aspectRatio as string[],
      baseModel: images.baseModel as string[],
      tagNames: images.tags as string[],
      toolNames: images.tools as string[],
      techniqueNames: images.techniques as string[],
      'user.username': images.users as string[],
    });
    const range = removeEmpty({
      createdAtUnix: images.createdAt as string,
    });

    const { query, sortBy, imageId } = images;

    return {
      [IMAGES_SEARCH_INDEX]: {
        sortBy: sortBy ?? defaultSortBy,
        refinementList,
        query,
        imageId,
        range,
      },
    };
  },
  stateToRoute: (uiState: ImageUiState) => {
    if (!uiState[IMAGES_SEARCH_INDEX]) {
      return {
        [IMAGES_SEARCH_INDEX]: {},
      };
    }

    const createdAt = uiState[IMAGES_SEARCH_INDEX].range?.['createdAtUnix'];
    const aspectRatio = uiState[IMAGES_SEARCH_INDEX].refinementList?.['aspectRatio'];
    const baseModel = uiState[IMAGES_SEARCH_INDEX].refinementList?.['baseModel'];
    const tags = uiState[IMAGES_SEARCH_INDEX].refinementList?.['tagNames'];
    const tools = uiState[IMAGES_SEARCH_INDEX].refinementList?.['toolNames'];
    const techniques = uiState[IMAGES_SEARCH_INDEX].refinementList?.['techniqueNames'];
    const users = uiState[IMAGES_SEARCH_INDEX].refinementList?.['user.username'];
    const sortBy =
      (uiState[IMAGES_SEARCH_INDEX].sortBy as ImageSearchParams['sortBy']) || defaultSortBy;
    const imageId = uiState[IMAGES_SEARCH_INDEX].imageId || undefined;

    const { query } = uiState[IMAGES_SEARCH_INDEX];

    const state: ImageSearchParams = {
      tags,
      tools,
      techniques,
      users,
      sortBy,
      query,
      imageId,
      baseModel,
      aspectRatio,
      createdAt,
    };

    return { [IMAGES_SEARCH_INDEX]: state };
  },
};
