import * as z from 'zod';
import { getAllModelsSchema } from '~/server/schema/model.schema';
import {
  SEMANTIC_QUERY_MAX_LENGTH,
  SEMANTIC_SEARCH_PAGE_SIZE,
} from '~/server/schema/semantic-image-search.schema';

/**
 * The models feed's own filters plus the query. `ids` is not accepted: on the feed's query it
 * relaxes the private-model rule, and the search narrows to its candidates with `onlyModelIds`.
 */
export const semanticModelSearchSchema = getAllModelsSchema
  .omit({ ids: true, modelVersionIds: true, page: true, cursor: true, query: true, limit: true })
  .extend({
    query: z.string().trim().min(1, 'Enter a query').max(SEMANTIC_QUERY_MAX_LENGTH),
    limit: z.number().int().min(1).max(100).default(SEMANTIC_SEARCH_PAGE_SIZE),
    // Offset into the ranked candidate list.
    cursor: z.number().int().min(0).optional(),
  });

export type SemanticModelSearchInput = z.infer<typeof semanticModelSearchSchema>;
/** What a caller sends, before the schema's defaults. */
export type SemanticModelSearchRequest = z.input<typeof semanticModelSearchSchema>;
