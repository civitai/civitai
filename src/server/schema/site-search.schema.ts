import * as z from 'zod';

// Meilisearch never returns more than its `maxTotalHits` (1000), so a larger window is clamped,
// not refused: infinite scroll grows `limit` page by page.
const MAX_WINDOW = 1000;
const windowNumber = z
  .number()
  .int()
  .min(0)
  .transform((value) => Math.min(value, MAX_WINDOW));

const attributeList = z.array(z.string().max(100)).max(100);
const filterSchema = z.union([
  z.string().max(10_000),
  z.array(z.union([z.string().max(10_000), z.array(z.string().max(10_000)).max(100)])).max(100),
]);
const querySchema = z.string().max(1000).nullish();
const matchingStrategySchema = z.enum(['last', 'all', 'frequency']).optional();

// Only what the site's search UI sends. Unknown keys are stripped, so a caller cannot reach
// vector search, ranking-score details or federation through this endpoint.
export const siteSearchParamsSchema = z.object({
  q: querySchema,
  filter: filterSchema.optional(),
  sort: attributeList.optional(),
  facets: attributeList.optional(),
  attributesToRetrieve: attributeList.optional(),
  attributesToHighlight: attributeList.optional(),
  attributesToCrop: attributeList.optional(),
  highlightPreTag: z.string().max(100).optional(),
  highlightPostTag: z.string().max(100).optional(),
  cropMarker: z.string().max(100).optional(),
  cropLength: z.number().int().min(0).max(1000).optional(),
  matchingStrategy: matchingStrategySchema,
  limit: windowNumber.optional(),
  offset: windowNumber.optional(),
  hitsPerPage: z.number().int().min(0).max(100).optional(),
  page: windowNumber.optional(),
});
export type SiteSearchParams = z.infer<typeof siteSearchParamsSchema>;

export const siteMultiSearchSchema = z.object({
  queries: z
    .array(siteSearchParamsSchema.extend({ indexUid: z.string().max(100) }))
    .min(1)
    .max(20),
});
export type SiteMultiSearchInput = z.infer<typeof siteMultiSearchSchema>;

export const siteFacetSearchSchema = z.object({
  facetName: z.string().max(100),
  facetQuery: z.string().max(1000).nullish(),
  q: querySchema,
  filter: filterSchema.optional(),
  matchingStrategy: matchingStrategySchema,
});
export type SiteFacetSearchInput = z.infer<typeof siteFacetSearchSchema>;
