import type { UiState } from 'instantsearch.js';
import * as z from 'zod';
import {
  ARTICLES_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  MODELS_3D_SEARCH_INDEX,
} from '~/server/common/constants';

const searchIndexes = [
  MODELS_SEARCH_INDEX,
  ARTICLES_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  // TODO: add MODELS_3D_SEARCH_INDEX once the Model3D parser + routing is implemented
] as const;
export type SearchIndex = (typeof searchIndexes)[number];
export const SearchIndexEntityTypes = {
  [MODELS_SEARCH_INDEX]: 'Model',
  [ARTICLES_SEARCH_INDEX]: 'Article',
  [USERS_SEARCH_INDEX]: 'User',
  [IMAGES_SEARCH_INDEX]: 'Image',
  [COLLECTIONS_SEARCH_INDEX]: 'Collection',
  [BOUNTIES_SEARCH_INDEX]: 'Bounty',
  [TOOLS_SEARCH_INDEX]: 'Tool',
  [COMICS_SEARCH_INDEX]: 'Comic',
  // TODO: implement Model3D search parser
  [MODELS_3D_SEARCH_INDEX]: 'Model3D',
} as const;

export type SearchIndexEntityType =
  (typeof SearchIndexEntityTypes)[keyof typeof SearchIndexEntityTypes];

export const searchParamsSchema = z.object({
  query: z.coerce.string().optional(),
  page: z.coerce.number().optional(),
});

// QS.parse runs with parseNumbers/parseBooleans, so `?tags=2026` arrives as a number and
// `?tags=true` as a boolean. Narrower than `z.coerce.string()`, which would also accept the `null`
// a bare `?tags` produces and turn it into the string "null" — a filter that matches nothing.
const coercedString = z.union([z.string(), z.number(), z.boolean()]).transform(String);

export const stringArrayParamSchema = z
  .union([z.array(coercedString), coercedString])
  .transform((val) => (Array.isArray(val) ? val : [val]));

/** Retries without the params that failed, so one bad value can't discard the search state. */
export function parseSearchParams<TSchema extends z.ZodType<Record<string, unknown>>>(
  schema: TSchema,
  params: Record<string, unknown>
): z.output<TSchema> | Record<string, never> {
  const result = schema.safeParse(params);
  if (result.success) return result.data;

  const invalidKeys = new Set(
    result.error.issues
      .map((issue) => issue.path[0])
      .filter((key): key is string => typeof key === 'string')
  );
  if (!invalidKeys.size) return {};

  const retried = schema.safeParse(
    Object.fromEntries(Object.entries(params).filter(([key]) => !invalidKeys.has(key)))
  );

  return retried.success ? retried.data : {};
}

export type InstantSearchRoutingParser = {
  parseURL: (params: { location: Location }) => UiState;
  routeToState: (routeState: UiState) => UiState;
  stateToRoute: (routeState: UiState) => UiState;
};
