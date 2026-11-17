import * as z from 'zod';
import { baseQuerySchema } from '~/server/schema/base.schema';
import {
  SEMANTIC_QUERY_MAX_LENGTH,
  SEMANTIC_SEARCH_PAGE_SIZE,
} from '~/server/schema/semantic-image-search.schema';
import { CollectionType } from '~/shared/utils/prisma/enums';

export type SemanticCollectionSearchInput = z.infer<typeof semanticCollectionSearchSchema>;
/** The collections feed's filters (getAllCollectionsInfiniteSchema) that the index can apply. */
export const semanticCollectionSearchSchema = baseQuerySchema.extend({
  query: z.string().trim().min(1, 'Enter a query').max(SEMANTIC_QUERY_MAX_LENGTH),
  types: z.enum(CollectionType).array().optional(),
  userId: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).default(SEMANTIC_SEARCH_PAGE_SIZE),
  // Offset into the ranked candidate list.
  cursor: z.number().int().min(0).optional(),
});
