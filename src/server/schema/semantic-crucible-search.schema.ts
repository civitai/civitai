import * as z from 'zod';
import { baseQuerySchema } from '~/server/schema/base.schema';
import {
  SEMANTIC_QUERY_MAX_LENGTH,
  SEMANTIC_SEARCH_PAGE_SIZE,
} from '~/server/schema/semantic-image-search.schema';
import { CRUCIBLE_CONTENT_TYPES } from '~/shared/constants/crucible.constants';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';

export type SemanticCrucibleSearchInput = z.infer<typeof semanticCrucibleSearchSchema>;
/** The crucible feed's filters (getCruciblesInfiniteSchema) that the index can apply. */
export const semanticCrucibleSearchSchema = baseQuerySchema.extend({
  query: z.string().trim().min(1, 'Enter a query').max(SEMANTIC_QUERY_MAX_LENGTH),
  // Cancelled crucibles are not indexed, and the public feed never lists them.
  status: z.enum(CrucibleStatus).exclude([CrucibleStatus.Cancelled]).array().optional(),
  contentType: z.enum(CRUCIBLE_CONTENT_TYPES).optional(),
  limit: z.number().int().min(1).max(100).default(SEMANTIC_SEARCH_PAGE_SIZE),
  cursor: z.number().int().min(0).optional(),
});
