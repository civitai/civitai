import * as z from 'zod';
import { baseQuerySchema } from '~/server/schema/base.schema';
import { MediaType } from '~/shared/utils/prisma/enums';

export const SEMANTIC_QUERY_MAX_LENGTH = 500;
export const SEMANTIC_SEARCH_PAGE_SIZE = 50;

export type SemanticImageSearchInput = z.infer<typeof semanticImageSearchSchema>;
export const semanticImageSearchSchema = baseQuerySchema
  .extend({
    query: z.string().trim().max(SEMANTIC_QUERY_MAX_LENGTH).optional(),
    // "More like this": the image whose vector is the query.
    imageId: z.number().int().positive().optional(),
    tagIds: z.number().int().array().max(20).optional(),
    excludedTagIds: z.number().int().array().max(50).optional(),
    baseModels: z.string().array().max(20).optional(),
    types: z.enum(MediaType).array().optional(),
    limit: z.number().int().min(1).max(100).default(SEMANTIC_SEARCH_PAGE_SIZE),
    // Offset into the ranked candidate list.
    cursor: z.number().int().min(0).optional(),
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
