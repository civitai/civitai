import * as z from 'zod';
import { ModelSort } from '~/server/common/enums';
import { keysetCursorSchema } from '~/server/schema/base.schema';
import { getAllModelsSchema } from '~/server/schema/model.schema';
import {
  SEMANTIC_QUERY_MAX_LENGTH,
  semanticSpellcheckField,
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
    spellcheck: semanticSpellcheckField,
    limit: z.number().int().min(1).max(100).default(SEMANTIC_SEARCH_PAGE_SIZE),
    /**
     * The search's own sort; absent is Best match. Not the feed's `sort`, which the viewer's saved
     * feed filters always carry and which would otherwise replace relevance on every search.
     */
    searchSort: z.enum(ModelSort).optional(),
    // Best match: an offset into the ranked candidates. A sort: the feed query's keyset cursor.
    cursor: z.union([z.number().int().min(0), keysetCursorSchema]).optional(),
  });

export type SemanticModelSearchInput = z.infer<typeof semanticModelSearchSchema>;
/** What a caller sends, before the schema's defaults. */
export type SemanticModelSearchRequest = z.input<typeof semanticModelSearchSchema>;
