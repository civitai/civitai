import * as z from 'zod';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { CrucibleSort } from '~/server/common/enums';
import { infiniteQuerySchema } from './base.schema';
import {
  CRUCIBLE_DURATION_COSTS,
  CRUCIBLE_MAX_ENTRIES,
  CRUCIBLE_MAX_ENTRY_FEE,
  CRUCIBLE_PRIZE_CUSTOMIZATION_COST,
} from '~/shared/constants/crucible.constants';

// Re-export CrucibleSort for convenience
export { CrucibleSort };

// Schema for infinite list of crucibles with filters
export type GetCruciblesInfiniteSchema = z.infer<typeof getCruciblesInfiniteSchema>;
export const getCruciblesInfiniteSchema = infiniteQuerySchema.extend({
  status: z.nativeEnum(CrucibleStatus).optional(),
  sort: z.nativeEnum(CrucibleSort).default(CrucibleSort.Newest),
  limit: z.coerce.number().min(1).max(200).default(20),
});

// Schema for getting a single crucible by ID
export type GetCrucibleByIdSchema = z.infer<typeof getCrucibleByIdSchema>;
export const getCrucibleByIdSchema = z.object({
  id: z.number(),
});

// Schema for crucible cover image (accepts CF upload data)
export const crucibleImageSchema = z.object({
  url: z.string().uuid('Cover image did not upload properly, please try again'),
  width: z.number(),
  height: z.number(),
  hash: z.string().optional(),
});
export type CrucibleImageSchema = z.infer<typeof crucibleImageSchema>;

// Re-export crucible constants for backward compatibility
export { CRUCIBLE_DURATION_COSTS, CRUCIBLE_PRIZE_CUSTOMIZATION_COST } from '~/shared/constants/crucible.constants';

/**
 * Calculate the total setup cost for creating a crucible
 * @param duration - Duration in hours
 * @param prizeCustomized - Whether prize distribution was customized
 * @returns Total Buzz cost
 */
export function calculateCrucibleSetupCost(
  duration: number,
  prizeCustomized: boolean
): number {
  const durationCost = CRUCIBLE_DURATION_COSTS[duration] ?? 0;
  const prizeCustomizationCost = prizeCustomized ? CRUCIBLE_PRIZE_CUSTOMIZATION_COST : 0;
  return durationCost + prizeCustomizationCost;
}

// Schema for creating a new crucible
export type CreateCrucibleInputSchema = z.infer<typeof createCrucibleInputSchema>;
export const createCrucibleInputSchema = z.object({
  name: z.string().trim().nonempty(),
  description: z.string().nonempty(),
  coverImage: crucibleImageSchema,
  nsfwLevel: z.number(),
  entryFee: z.number().min(0).max(CRUCIBLE_MAX_ENTRY_FEE),
  entryLimit: z.number().min(1).max(CRUCIBLE_MAX_ENTRIES),
  maxTotalEntries: z.number().min(1).optional(),
  prizePositions: z.record(z.string(), z.number()).refine(
    (positions) => {
      const total = Object.values(positions).reduce((sum, val) => sum + val, 0);
      return total <= 100;
    },
    { message: 'Prize percentages must sum to 100% or less' }
  ),
  prizeCustomized: z.boolean().default(false), // Whether prize distribution was customized from default
  allowedResources: z.array(z.number()).optional(),
  judgeRequirements: z.record(z.string(), z.any()).optional(),
  duration: z.number().min(1), // duration in hours
});

// Schema for submitting an entry to a crucible
export type SubmitEntrySchema = z.infer<typeof submitEntrySchema>;
export const submitEntrySchema = z.object({
  crucibleId: z.number(),
  imageId: z.number(),
});

// Schema for submitting a vote
export type SubmitVoteSchema = z.infer<typeof submitVoteSchema>;
export const submitVoteSchema = z.object({
  crucibleId: z.number(),
  winnerEntryId: z.number(),
  loserEntryId: z.number(),
});

// Schema for getting a judging pair
export type GetJudgingPairSchema = z.infer<typeof getJudgingPairSchema>;
export const getJudgingPairSchema = z.object({
  crucibleId: z.number(),
  // Entry IDs to exclude from pair selection (e.g., recently skipped entries)
  // These entries won't appear in the returned pair
  excludeEntryIds: z.array(z.number()).max(50).optional(),
});

// Schema for cancelling a crucible
export type CancelCrucibleSchema = z.infer<typeof cancelCrucibleSchema>;
export const cancelCrucibleSchema = z.object({
  id: z.number(),
});
