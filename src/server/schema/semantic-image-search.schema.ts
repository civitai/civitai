import * as z from 'zod';
import { baseQuerySchema } from '~/server/schema/base.schema';
import { baseModels } from '~/shared/constants/basemodel.constants';
import { MediaType } from '~/shared/utils/prisma/enums';

export const SEMANTIC_QUERY_MAX_LENGTH = 500;
export const SEMANTIC_SEARCH_PAGE_SIZE = 50;

export type SemanticImageSearchInput = z.infer<typeof semanticImageSearchSchema>;
export const semanticImageSearchSchema = baseQuerySchema
  .extend({
    query: z.string().trim().max(SEMANTIC_QUERY_MAX_LENGTH).optional(),
    // "More like this": the image whose vector is the query.
    imageId: z.number().int().positive().optional(),
    // Room for whatever the images feed can select: its filters carry into the search unchanged.
    tagIds: z.number().int().array().max(100).optional(),
    // By name, as the image search URLs and pickers carry them; resolved to ids on the server.
    tagNames: z.string().trim().min(1).array().max(20).optional(),
    excludedTagIds: z.number().int().array().max(50).optional(),
    baseModels: z.string().array().max(baseModels.length).optional(),
    types: z.enum(MediaType).array().optional(),
    usernames: z.string().trim().min(1).array().max(20).optional(),
    // The images feed's `?userId=`, as it filters by id.
    userIds: z.number().int().positive().array().max(20).optional(),
    // Bounds on `sortAt`, the publish time for a published image.
    postedAfter: z.coerce.date().optional(),
    postedBefore: z.coerce.date().optional(),
    limit: z.number().int().min(1).max(100).default(SEMANTIC_SEARCH_PAGE_SIZE),
    // Offset into the ranked candidate list.
    cursor: z.number().int().min(0).optional(),
    // newest: the best matches by similarity, newest first (text queries only; "more like this"
    // stays in similarity order). Absent or relevance: similarity order.
    sort: z.enum(['relevance', 'newest']).optional(),
  })
  .refine((x) => !!x.query || !!x.imageId, { message: 'Enter a query' });

export type SemanticSearchFeedbackInput = z.infer<typeof semanticSearchFeedbackSchema>;
export const semanticSearchFeedbackSchema = z.object({
  rating: z.enum(['up', 'down']),
  comment: z.string().trim().max(2000).optional(),
  query: z.string().trim().max(SEMANTIC_QUERY_MAX_LENGTH).optional(),
  imageId: z.number().int().positive().optional(),
  filters: z.string().max(1000).optional(),
  resultCount: z.number().int().min(0).optional(),
  latencyMs: z.number().int().min(0).optional(),
});
