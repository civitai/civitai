import * as z from 'zod';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { CrucibleSort } from '~/server/common/enums';
import { infiniteQuerySchema } from './base.schema';

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

// Schema for creating a new crucible
export type CreateCrucibleInputSchema = z.infer<typeof createCrucibleInputSchema>;
export const createCrucibleInputSchema = z.object({
  name: z.string().trim().nonempty(),
  description: z.string().nonempty(),
  coverImage: crucibleImageSchema,
  nsfwLevel: z.number(),
  entryFee: z.number().min(0),
  entryLimit: z.number().min(1).max(10),
  maxTotalEntries: z.number().min(1).optional(),
  prizePositions: z.record(z.string(), z.number()).refine(
    (positions) => {
      const total = Object.values(positions).reduce((sum, val) => sum + val, 0);
      return total <= 100;
    },
    { message: 'Prize percentages must sum to 100% or less' }
  ),
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

// Schema for cancelling a crucible
export type CancelCrucibleSchema = z.infer<typeof cancelCrucibleSchema>;
export const cancelCrucibleSchema = z.object({
  id: z.number(),
});
