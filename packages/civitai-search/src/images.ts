import * as z from 'zod';

export const IMAGE_QUERY_MAX_LENGTH = 500;
// Qdrant pays for every skipped candidate on each request, so deep paging is capped.
export const IMAGE_SEARCH_MAX_OFFSET = 2000;
export const IMAGE_SEARCH_MAX_LIMIT = 100;

const ids = (max: number) => z.number().int().array().max(max);

/**
 * Filter clauses for the image index. Viewer policy (which NSFW levels, whose images to hide, the
 * base-model licence rule) is decided by the caller and arrives here as plain values: the service
 * applies clauses, it never derives them.
 */
export const imageSearchFilter = z.object({
  // Required and non-empty, so a caller that forgets the browsing level gets an error, not everything.
  nsfwLevels: z.number().int().array().min(1).max(32),
  // Every listed tag must be present.
  tagIds: ids(20).optional(),
  excludedTagIds: ids(500).optional(),
  baseModels: z.string().array().max(50).optional(),
  types: z.string().array().max(5).optional(),
  userIds: ids(50).optional(),
  excludedUserIds: ids(5000).optional(),
  excludedImageIds: ids(5000).optional(),
  // Bounds on `sortAt`, the publish time for a published image.
  postedAfter: z.iso.datetime().optional(),
  postedBefore: z.iso.datetime().optional(),
  // Images at these NSFW levels made with any of these base models are excluded.
  restrictedBaseModels: z
    .object({ nsfwLevels: ids(32).min(1), baseModels: z.string().array().min(1).max(200) })
    .optional(),
});
export type ImageSearchFilter = z.infer<typeof imageSearchFilter>;

export const imageSearchQuery = z.union([
  z.object({ text: z.string().trim().min(1).max(IMAGE_QUERY_MAX_LENGTH) }),
  // "More like this": the image whose vector is the query.
  z.object({ similarTo: z.number().int().positive() }),
]);
export type ImageSearchQuery = z.infer<typeof imageSearchQuery>;

export const imageSearchInput = z.object({
  query: imageSearchQuery,
  filter: imageSearchFilter,
  offset: z.number().int().min(0).max(IMAGE_SEARCH_MAX_OFFSET).default(0),
  limit: z.number().int().min(1).max(IMAGE_SEARCH_MAX_LIMIT).default(50),
});
export type ImageSearchInput = z.input<typeof imageSearchInput>;

/**
 * Ranked image ids, best first. Ids only, never images: the index is updated asynchronously, so a
 * removed or re-rated image can still be returned. The caller must load the ids through its own
 * visibility rules, which drop anything that should no longer be shown.
 */
export const imageSearchResult = z.object({ ids: z.number().int().array() });
export type ImageSearchResult = z.infer<typeof imageSearchResult>;
