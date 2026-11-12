import * as z from 'zod';
import { baseQuerySchema } from '~/server/schema/base.schema';
import {
  SEMANTIC_QUERY_MAX_LENGTH,
  SEMANTIC_SEARCH_PAGE_SIZE,
} from '~/server/schema/semantic-image-search.schema';

export type SemanticArticleSearchInput = z.infer<typeof semanticArticleSearchSchema>;
export const semanticArticleSearchSchema = baseQuerySchema.extend({
  query: z.string().trim().min(1, 'Enter a query').max(SEMANTIC_QUERY_MAX_LENGTH),
  // By name, as the article search URLs and pickers carry them; resolved to ids on the server.
  tagNames: z.string().trim().min(1).array().max(20).optional(),
  usernames: z.string().trim().min(1).array().max(20).optional(),
  limit: z.number().int().min(1).max(100).default(SEMANTIC_SEARCH_PAGE_SIZE),
  // Offset into the ranked candidate list.
  cursor: z.number().int().min(0).optional(),
});
