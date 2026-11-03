import * as z from 'zod';
import { CheckpointType, CollectionType, ModelType } from '~/shared/utils/prisma/enums';

// The engine-neutral search contract the rebuilt search UI and the server consumers speak.
// The client names what it wants (text, typed filters, a sort, facets); it never writes engine
// syntax. Who may see what (browsing level cap, POI, private availability) is not part of the
// input at all: the server adds it from the session (see ~/server/search/search-scope.ts).

const value = z.string().trim().min(1).max(100);
const values = z.array(value).max(50).optional();

const textQuery = z.string().trim().max(200).default('');
const limit = z.number().int().min(1).max(100).default(20);
const cursor = z.string().max(200).optional();
/** The viewer's own browsing-level choice; the server narrows it to what the site may serve. */
const browsingLevel = z.number().int().min(1).optional();

const base = { text: textQuery, limit, cursor, browsingLevel };

export const modelSearchSorts = [
  'relevance',
  'mostLiked',
  'mostDownloaded',
  'mostFavorited',
  'mostDiscussed',
  'mostCollected',
  'mostTipped',
  'newest',
] as const;
export const articleSearchSorts = [
  'relevance',
  'mostFavorited',
  'mostViewed',
  'mostDiscussed',
  'mostTipped',
  'newest',
] as const;
export const userSearchSorts = [
  'relevance',
  'mostFollowed',
  'mostLiked',
  'mostUploads',
  'newest',
] as const;
export const collectionSearchSorts = ['relevance', 'mostFollowed', 'mostItems', 'newest'] as const;
export const bountySearchSorts = [
  'relevance',
  'highestBounty',
  'mostEntries',
  'mostFavorited',
  'newest',
] as const;
export const toolSearchSorts = ['relevance', 'nameAsc', 'nameDesc', 'oldest', 'newest'] as const;
export const comicSearchSorts = [
  'relevance',
  'newest',
  'oldest',
  'mostFollowed',
  'mostChapters',
] as const;

export const modelSearchFacets = [
  'types',
  'baseModels',
  'categories',
  'checkpointTypes',
  'tags',
  'usernames',
] as const;

const modelQuery = z.object({
  index: z.literal('models'),
  ...base,
  sort: z.enum(modelSearchSorts).default('relevance'),
  filters: z
    .object({
      types: z.array(z.enum(ModelType)).max(50).optional(),
      baseModels: values,
      categories: values,
      checkpointTypes: z.array(z.enum(CheckpointType)).max(10).optional(),
      tags: values,
      excludeTags: values,
      usernames: values,
      excludeUsernames: values,
      hashes: values,
      /** Unix ms bounds on the latest version's publish time. */
      lastVersionAt: z
        .object({ from: z.number().int().optional(), to: z.number().int().optional() })
        .optional(),
    })
    .strict()
    .default({}),
  facets: z.array(z.enum(modelSearchFacets)).max(modelSearchFacets.length).default([]),
});

const tagUserFilters = z
  .object({ tags: values, excludeTags: values, usernames: values, excludeUsernames: values })
  .strict()
  .default({});

const articleQuery = z.object({
  index: z.literal('articles'),
  ...base,
  sort: z.enum(articleSearchSorts).default('relevance'),
  filters: tagUserFilters,
  facets: z
    .array(z.enum(['tags', 'usernames']))
    .max(2)
    .default([]),
});

const userQuery = z.object({
  index: z.literal('users'),
  ...base,
  sort: z.enum(userSearchSorts).default('relevance'),
  filters: z.object({}).strict().default({}),
  facets: z.array(z.never()).max(0).default([]),
});

const collectionQuery = z.object({
  index: z.literal('collections'),
  ...base,
  sort: z.enum(collectionSearchSorts).default('relevance'),
  filters: z
    .object({
      types: z.array(z.enum(CollectionType)).max(10).optional(),
      usernames: values,
      excludeUsernames: values,
    })
    .strict()
    .default({}),
  facets: z
    .array(z.enum(['types', 'usernames']))
    .max(2)
    .default([]),
});

const bountyQuery = z.object({
  index: z.literal('bounties'),
  ...base,
  sort: z.enum(bountySearchSorts).default('relevance'),
  filters: z
    .object({
      types: values,
      baseModels: values,
      tags: values,
      excludeTags: values,
      usernames: values,
      excludeUsernames: values,
    })
    .strict()
    .default({}),
  facets: z
    .array(z.enum(['types', 'baseModels', 'tags', 'usernames']))
    .max(4)
    .default([]),
});

const toolQuery = z.object({
  index: z.literal('tools'),
  ...base,
  sort: z.enum(toolSearchSorts).default('relevance'),
  filters: z.object({ types: values, companies: values }).strict().default({}),
  facets: z
    .array(z.enum(['types', 'companies']))
    .max(2)
    .default([]),
});

const comicQuery = z.object({
  index: z.literal('comics'),
  ...base,
  sort: z.enum(comicSearchSorts).default('relevance'),
  filters: z.object({ genres: values }).strict().default({}),
  facets: z
    .array(z.enum(['genres']))
    .max(1)
    .default([]),
});

export const searchQuerySchema = z.discriminatedUnion('index', [
  modelQuery,
  articleQuery,
  userQuery,
  collectionQuery,
  bountyQuery,
  toolQuery,
  comicQuery,
]);

export type SearchQueryInput = z.input<typeof searchQuerySchema>;
export type SearchQuery = z.output<typeof searchQuerySchema>;
export type SearchIndex = SearchQuery['index'];
export type SearchQueryFor<I extends SearchIndex> = Extract<SearchQuery, { index: I }>;
