import * as z from 'zod';
import { baseQuerySchema } from '~/server/schema/base.schema';
import {
  SEMANTIC_QUERY_MAX_LENGTH,
  SEMANTIC_SEARCH_PAGE_SIZE,
} from '~/server/schema/semantic-image-search.schema';
import { ChallengeParticipation } from '~/server/schema/challenge.schema';
import { ChallengeSource, ChallengeStatus } from '~/shared/utils/prisma/enums';

export type SemanticChallengeSearchInput = z.infer<typeof semanticChallengeSearchSchema>;
/** The challenge feed's filters (getInfiniteChallengesSchema) that the index can apply. */
export const semanticChallengeSearchSchema = baseQuerySchema.extend({
  query: z.string().trim().min(1, 'Enter a query').max(SEMANTIC_QUERY_MAX_LENGTH),
  // Cancelled challenges are not indexed, and the public feed never lists them.
  status: z.enum(ChallengeStatus).exclude([ChallengeStatus.Cancelled]).array().optional(),
  source: z.enum(ChallengeSource).array().optional(),
  includeEnded: z.boolean().default(false),
  userId: z.number().int().positive().optional(),
  modelVersionId: z.number().int().positive().optional(),
  challengeEventId: z.number().int().positive().optional(),
  excludeEventChallenges: z.boolean().default(false),
  // Per viewer, so applied at hydration rather than in the index.
  participation: z.enum(ChallengeParticipation).optional(),
  limit: z.number().int().min(1).max(100).default(SEMANTIC_SEARCH_PAGE_SIZE),
  // Offset into the ranked candidate list.
  cursor: z.number().int().min(0).optional(),
});
