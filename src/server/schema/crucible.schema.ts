import * as z from 'zod';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import { CrucibleSort } from '~/server/common/enums';
import { infiniteQuerySchema } from './base.schema';
import { isUUID } from '~/utils/string-helpers';
import {
  CRUCIBLE_CONTENT_TYPES,
  CRUCIBLE_DURATION_COSTS,
  CRUCIBLE_MAX_ENTRIES,
  CRUCIBLE_MAX_ENTRY_FEE,
  CRUCIBLE_MAX_CLIP_SECONDS,
  CRUCIBLE_MAX_MIN_VIEW_SECONDS,
  CRUCIBLE_MAX_SEEDED_PRIZE_POOL,
  CRUCIBLE_PRIZE_CUSTOMIZATION_COST,
} from '~/shared/constants/crucible.constants';

// Re-export CrucibleSort for convenience
export { CrucibleSort };

// Schema for infinite list of crucibles with filters
export type GetCruciblesInfiniteSchema = z.infer<typeof getCruciblesInfiniteSchema>;
export const getCruciblesInfiniteSchema = infiniteQuerySchema.extend({
  status: z.nativeEnum(CrucibleStatus).optional(),
  sort: z.nativeEnum(CrucibleSort).default(CrucibleSort.PrizePool),
  limit: z.coerce.number().min(1).max(200).default(20),
});

// Schema for getting a single crucible by ID
export type GetCrucibleByIdSchema = z.infer<typeof getCrucibleByIdSchema>;
export const getCrucibleByIdSchema = z.object({
  id: z.number(),
});

// Schema for crucible cover image (accepts CF upload data).
//
// `isUUID` rather than `z.string().uuid()`: Cloudflare image ids are uuid-SHAPED but not
// RFC-4122 conformant, and Zod 4's `.uuid()` enforces the variant nibble. Measured over 20k rows
// of `Image.url`, 18 in 19,986 fail that check, and the rejection surfaces as "did not upload
// properly" — blaming an upload that succeeded.
export const crucibleImageSchema = z.object({
  url: z.string().refine(isUUID, 'Cover image did not upload properly, please try again'),
  width: z.number(),
  height: z.number(),
  hash: z.string().optional(),
});
export type CrucibleImageSchema = z.infer<typeof crucibleImageSchema>;

// Re-export crucible constants for backward compatibility
export {
  CRUCIBLE_CONTENT_TYPES,
  CRUCIBLE_DURATION_COSTS,
  CRUCIBLE_MAX_SEEDED_PRIZE_POOL,
  CRUCIBLE_PRIZE_CUSTOMIZATION_COST,
} from '~/shared/constants/crucible.constants';

/**
 * Calculate the total setup cost for creating a crucible
 * @param duration - Duration in hours
 * @param prizeCustomized - Whether prize distribution was customized
 * @returns Total Buzz cost
 */
export function calculateCrucibleSetupCost(duration: number, prizeCustomized: boolean): number {
  const durationCost = CRUCIBLE_DURATION_COSTS[duration] ?? 0;
  const prizeCustomizationCost = prizeCustomized ? CRUCIBLE_PRIZE_CUSTOMIZATION_COST : 0;
  return durationCost + prizeCustomizationCost;
}

// Schema for creating a new crucible
export type CreateCrucibleInputSchema = z.infer<typeof createCrucibleInputSchema>;
const createCrucibleInputBaseSchema = z.object({
  name: z.string().trim().nonempty(),
  description: z.string().nonempty(),
  coverImage: crucibleImageSchema,
  nsfwLevel: z.number(),
  contentType: z.enum(CRUCIBLE_CONTENT_TYPES).default(MediaType.image),
  entryFee: z.number().min(0).max(CRUCIBLE_MAX_ENTRY_FEE),
  seededPrizePool: z.number().int().min(0).max(CRUCIBLE_MAX_SEEDED_PRIZE_POOL).default(0),
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
  duration: z.number().min(1), // duration in hours
  minViewSeconds: z.number().int().min(1).max(CRUCIBLE_MAX_MIN_VIEW_SECONDS).nullish(),
  maxClipSeconds: z.number().int().min(1).max(CRUCIBLE_MAX_CLIP_SECONDS).nullish(),
});

export const createCrucibleInputSchema = createCrucibleInputBaseSchema
  .refine(
    ({ contentType, minViewSeconds, maxClipSeconds }) =>
      contentType === MediaType.video || (minViewSeconds == null && maxClipSeconds == null),
    {
      message: 'Minimum view time and maximum clip length apply to video crucibles only',
      path: ['contentType'],
    }
  )
  .refine(
    ({ minViewSeconds, maxClipSeconds }) =>
      minViewSeconds == null || maxClipSeconds == null || minViewSeconds <= maxClipSeconds,
    {
      // Otherwise no entry can clear the bar and the crucible has nothing votable in it.
      message: 'Minimum view time cannot exceed the maximum clip length',
      path: ['minViewSeconds'],
    }
  );

// Schema for submitting an entry to a crucible
export type CreateEntryPostSchema = z.infer<typeof createEntryPostSchema>;
export const createEntryPostSchema = z.object({
  crucibleId: z.number(),
});

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
  // Playback actually watched on each side. Optional because only a crucible that sets
  // `minViewSeconds` needs them — an image crucible has nothing to watch, and the server
  // requires them only where the rule applies.
  //
  // NOT `.int()`. These are accumulated from `video.currentTime` deltas, so the real client sends
  // fractions (10894.686999999998); an int-only schema rejected every genuine vote while every
  // test that passed a round number passed.
  winnerWatchedMs: z.number().min(0).finite().optional(),
  loserWatchedMs: z.number().min(0).finite().optional(),
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

// Schema for user crucible stats (no input needed - uses authenticated user)
export type GetUserCrucibleStatsSchema = z.infer<typeof getUserCrucibleStatsSchema>;
export const getUserCrucibleStatsSchema = z.object({});

// User crucible stats response type
export type UserCrucibleStats = {
  totalCrucibles: number;
  buzzWon: number;
  bestPlacement: number | null;
  winRate: number;
};

// Schema for getting user's active crucibles (no input needed - uses authenticated user)
export type GetUserActiveCruciblesSchema = z.infer<typeof getUserActiveCruciblesSchema>;
export const getUserActiveCruciblesSchema = z.object({});

// User active crucible response type
export type UserActiveCrucible = {
  id: number;
  name: string;
  prizePool: number;
  timeRemaining: string;
  endAt: Date | null;
  position: number | null;
  imageUrl: string | null;
};

// Schema for getting featured crucible (no input needed - returns highest prize pool active crucible)
export type GetFeaturedCrucibleSchema = z.infer<typeof getFeaturedCrucibleSchema>;
export const getFeaturedCrucibleSchema = z.object({});

// Schema for getting judges count for a crucible
export type GetJudgesCountSchema = z.infer<typeof getJudgesCountSchema>;
export const getJudgesCountSchema = z.object({
  crucibleId: z.number(),
});

// Featured crucible response type
export type FeaturedCrucible = {
  id: number;
  name: string;
  description: string;
  prizePool: number;
  timeRemaining: string;
  entriesCount: number;
  imageUrl: string | null;
};

// Schema for getting judge stats for the rating page
export type GetJudgeStatsSchema = z.infer<typeof getJudgeStatsSchema>;
export const getJudgeStatsSchema = z.object({
  crucibleId: z.number(),
});

// Judge stats response type
export type JudgeStats = {
  // Total pairs this user has rated across all crucibles
  totalPairsRated: number;
  // Percentile rank among all judges (e.g., "Top 8%" means they're in top 8%)
  percentileRank: number | null;
  // User's influence score based on voting consistency with final rankings
  influenceScore: number;
};
