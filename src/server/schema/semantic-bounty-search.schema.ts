import * as z from 'zod';
import { BountyStatus } from '~/server/common/enums';
import { baseQuerySchema } from '~/server/schema/base.schema';
import {
  SEMANTIC_QUERY_MAX_LENGTH,
  SEMANTIC_SEARCH_PAGE_SIZE,
} from '~/server/schema/semantic-image-search.schema';
import { BountyMode, BountyType } from '~/shared/utils/prisma/enums';

export type SemanticBountySearchInput = z.infer<typeof semanticBountySearchSchema>;
/** The bounty feed's filters (getInfiniteBountySchema) that semantic search can apply. */
export const semanticBountySearchSchema = baseQuerySchema.extend({
  query: z.string().trim().min(1, 'Enter a query').max(SEMANTIC_QUERY_MAX_LENGTH),
  // The query as typed: the service's spelling correction is skipped ("Search instead for").
  // The text is still audited as any query is.
  spellcheck: z.literal(false).optional(),
  types: z.enum(BountyType).array().optional(),
  mode: z.enum(BountyMode).optional(),
  // Depends on the clock, so applied at hydration rather than in the index.
  status: z.enum(BountyStatus).optional(),
  baseModels: z.string().array().max(20).optional(),
  userId: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).default(SEMANTIC_SEARCH_PAGE_SIZE),
  // Offset into the ranked candidate list.
  cursor: z.number().int().min(0).optional(),
});
