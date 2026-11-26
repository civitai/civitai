import * as z from 'zod';
import { baseQuerySchema } from '~/server/schema/base.schema';
import { StorylineStatus } from '~/shared/utils/prisma/enums';
import {
  SEMANTIC_QUERY_MAX_LENGTH,
  SEMANTIC_SEARCH_PAGE_SIZE,
} from '~/server/schema/semantic-image-search.schema';

export type SemanticStorylineSearchInput = z.infer<typeof semanticStorylineSearchSchema>;
export const semanticStorylineSearchSchema = baseQuerySchema.extend({
  query: z.string().trim().min(1, 'Enter a query').max(SEMANTIC_QUERY_MAX_LENGTH),
  status: z.enum(StorylineStatus).optional(),
  limit: z.number().int().min(1).max(100).default(SEMANTIC_SEARCH_PAGE_SIZE),
  // Offset into the ranked candidate list.
  cursor: z.number().int().min(0).optional(),
});
