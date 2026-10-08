import * as z from 'zod';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import { CrucibleSort } from '~/server/common/enums';
import { baseQuerySchema, infiniteQuerySchema } from './base.schema';
import { isUUID } from '~/utils/string-helpers';
import { baseModelByName } from '~/shared/constants/basemodel.constants';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import {
  CRUCIBLE_CONTENT_TYPES,
  CRUCIBLE_DESCRIPTION_MAX_LENGTH,
  CRUCIBLE_DURATION_COSTS,
  CRUCIBLE_MAX_ENTRIES,
  CRUCIBLE_ENTRY_CUTOFF_PERCENT,
  CRUCIBLE_ENTRY_WARNING_PERCENT,
  CRUCIBLE_ENTRY_WINDOW_ORDER_MESSAGE,
  CRUCIBLE_MAX_ENTRY_FEE,
  CRUCIBLE_MAX_CLIP_SECONDS_OPTIONS,
  CRUCIBLE_MAX_PRIZE_POSITIONS,
  CRUCIBLE_MAX_TOTAL_ENTRIES,
  CRUCIBLE_MIN_ENTRY_FEE,
  CRUCIBLE_MIN_TOTAL_ENTRIES,
  CRUCIBLE_MIN_VIEW_SECONDS_OPTIONS,
  CRUCIBLE_MAX_SEEDED_PRIZE_POOL,
  CRUCIBLE_MAX_ALLOWED_BASE_MODELS,
  CRUCIBLE_MAX_ALLOWED_RESOURCES,
  CRUCIBLE_MAX_START_LEAD_DAYS,
  CRUCIBLE_NAME_MAX_LENGTH,
  CRUCIBLE_PRIZE_CUSTOMIZATION_COST,
  CRUCIBLE_RESOURCE_REQUIREMENTS_COST,
  getMaxCrucibleStartAt,
  getPrizeDistributionTotal,
} from '~/shared/constants/crucible.constants';

// Re-export CrucibleSort for convenience
export { CrucibleSort };

// Schema for infinite list of crucibles with filters
export type GetCruciblesInfiniteSchema = z.infer<typeof getCruciblesInfiniteSchema>;
export const getCruciblesInfiniteSchema = infiniteQuerySchema.extend({
  status: z.array(z.nativeEnum(CrucibleStatus)).optional(),
  contentType: z.enum(CRUCIBLE_CONTENT_TYPES).optional(),
  browsingLevel: z.number().int().min(0).optional(),
  sort: z.nativeEnum(CrucibleSort).default(CrucibleSort.PrizePool),
  limit: z.coerce.number().min(1).max(200).default(20),
});

// Schema for getting a single crucible by ID
export type GetCrucibleByIdSchema = z.infer<typeof getCrucibleByIdSchema>;
export const getCrucibleByIdSchema = z.object({
  id: z.number(),
});

export type ToggleCrucibleFollowInput = z.infer<typeof toggleCrucibleFollowSchema>;
export const toggleCrucibleFollowSchema = z.object({
  crucibleId: z.number(),
  setTo: z.boolean().optional(),
});

export const getCrucibleRequiredModelsSchema = z.object({
  id: z.number(),
  browsingLevel: z.number().optional(),
});
export type GetCrucibleRequiredModelsSchema = z.infer<typeof getCrucibleRequiredModelsSchema>;

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
 * @param requiresResources - Whether entries are restricted to specific model versions
 * @returns Total Buzz cost
 */
export function calculateCrucibleSetupCost(
  duration: number,
  prizeCustomized: boolean,
  requiresResources = false
): number {
  const durationCost = CRUCIBLE_DURATION_COSTS[duration] ?? 0;
  const prizeCustomizationCost = prizeCustomized ? CRUCIBLE_PRIZE_CUSTOMIZATION_COST : 0;
  const resourceRequirementsCost = requiresResources ? CRUCIBLE_RESOURCE_REQUIREMENTS_COST : 0;
  return durationCost + prizeCustomizationCost + resourceRequirementsCost;
}

const allowedBaseModelsSchema = z
  .array(z.string().refine((name) => baseModelByName.has(name), { message: 'Unknown base model' }))
  .max(CRUCIBLE_MAX_ALLOWED_BASE_MODELS)
  .transform((names) => [...new Set(names)]);

// Schema for creating a new crucible
export type CreateCrucibleInputSchema = z.infer<typeof createCrucibleInputSchema>;
const prizePositionsSchema = z
  .record(z.string().regex(/^[1-9]\d*$/), z.number().int().min(0).max(100))
  .refine((positions) => {
    const count = Object.keys(positions).length;
    return count >= 1 && count <= CRUCIBLE_MAX_PRIZE_POSITIONS;
  }, `Between 1 and ${CRUCIBLE_MAX_PRIZE_POSITIONS} prize positions are allowed`)
  .refine(
    (positions) =>
      Object.keys(positions)
        .map(Number)
        .sort((a, b) => a - b)
        .every((position, index) => position === index + 1),
    'Prize positions must run from 1st place without gaps'
  )
  .refine(
    (positions) => getPrizeDistributionTotal(positions) === 100,
    'Prize percentages must add up to exactly 100%'
  );

// Blank stores NULL; an absent key leaves the stored description unchanged on update.
const crucibleDescriptionSchema = z
  .string()
  .trim()
  .max(CRUCIBLE_DESCRIPTION_MAX_LENGTH)
  .nullish()
  .transform((value) => (value === undefined ? undefined : value || null));

export const createCrucibleInputBaseSchema = z.object({
  name: z.string().trim().nonempty().max(CRUCIBLE_NAME_MAX_LENGTH),
  description: crucibleDescriptionSchema,
  coverImage: crucibleImageSchema,
  heroImage: crucibleImageSchema.optional(),
  nsfwLevel: z.number().int().positive().max(allBrowsingLevelsFlag),
  contentType: z.enum(CRUCIBLE_CONTENT_TYPES).default(MediaType.image),
  entryFee: z.number().int().min(CRUCIBLE_MIN_ENTRY_FEE).max(CRUCIBLE_MAX_ENTRY_FEE),
  seededPrizePool: z.number().int().min(0).max(CRUCIBLE_MAX_SEEDED_PRIZE_POOL).default(0),
  entryLimit: z.number().int().min(1).max(CRUCIBLE_MAX_ENTRIES),
  freeEntriesPerUser: z.number().int().min(0).max(CRUCIBLE_MAX_ENTRIES).default(0),
  maxTotalEntries: z
    .number()
    .int()
    .min(CRUCIBLE_MIN_TOTAL_ENTRIES)
    .max(CRUCIBLE_MAX_TOTAL_ENTRIES)
    .optional(),
  entryWarningPercent: z
    .number()
    .int()
    .min(CRUCIBLE_ENTRY_WARNING_PERCENT.min)
    .max(CRUCIBLE_ENTRY_WARNING_PERCENT.max)
    .default(CRUCIBLE_ENTRY_WARNING_PERCENT.default),
  entryCutoffPercent: z
    .number()
    .int()
    .min(CRUCIBLE_ENTRY_CUTOFF_PERCENT.min)
    .max(CRUCIBLE_ENTRY_CUTOFF_PERCENT.max)
    .default(CRUCIBLE_ENTRY_CUTOFF_PERCENT.default),
  prizePositions: prizePositionsSchema,
  allowedResources: z.array(z.number().int()).max(CRUCIBLE_MAX_ALLOWED_RESOURCES).optional(),
  allowedBaseModels: allowedBaseModelsSchema.optional(),
  duration: z.number().refine((hours) => hours in CRUCIBLE_DURATION_COSTS, {
    message: 'Unsupported crucible duration',
  }), // duration in hours
  // Absent or already past means "start now"; a start that went stale while the creator sat on the
  // review step should not fail the submit.
  startAt: z
    .date()
    .refine((startAt) => startAt <= getMaxCrucibleStartAt(), {
      message: `A crucible can start at most ${CRUCIBLE_MAX_START_LEAD_DAYS} days from now`,
    })
    .optional(),
  minViewSeconds: z
    .number()
    .refine((s) => (CRUCIBLE_MIN_VIEW_SECONDS_OPTIONS as readonly number[]).includes(s), {
      message: 'Unsupported minimum view time',
    })
    .nullish(),
  maxClipSeconds: z
    .number()
    .refine((s) => (CRUCIBLE_MAX_CLIP_SECONDS_OPTIONS as readonly number[]).includes(s), {
      message: 'Unsupported maximum clip length',
    })
    .nullish(),
});

type CrucibleSettings = {
  contentType: string;
  minViewSeconds?: number | null;
  maxClipSeconds?: number | null;
  entryLimit: number;
  freeEntriesPerUser?: number;
  maxTotalEntries?: number | null;
  entryWarningPercent?: number;
  entryCutoffPercent?: number;
  prizePositions: Record<string, number>;
};

/** The cross-field rules, shared by create and by an edit's merged result. */
export function checkCrucibleSettings(settings: CrucibleSettings) {
  const { contentType, minViewSeconds, maxClipSeconds, entryLimit, maxTotalEntries } = settings;
  if (contentType !== MediaType.video && (minViewSeconds != null || maxClipSeconds != null))
    return {
      message: 'Minimum view time and maximum clip length apply to video crucibles only',
      path: 'contentType',
    };
  // Otherwise no entry can clear the bar and the crucible has nothing votable in it.
  if (minViewSeconds != null && maxClipSeconds != null && minViewSeconds > maxClipSeconds)
    return {
      message: 'Minimum view time cannot exceed the maximum clip length',
      path: 'minViewSeconds',
    };
  if ((settings.freeEntriesPerUser ?? 0) > entryLimit)
    return {
      message: 'Free entries cannot exceed the entry limit per user',
      path: 'freeEntriesPerUser',
    };
  if (maxTotalEntries != null && entryLimit > maxTotalEntries)
    return {
      message: 'Entries per user cannot exceed the maximum total entries',
      path: 'entryLimit',
    };
  if (
    settings.entryWarningPercent != null &&
    settings.entryCutoffPercent != null &&
    settings.entryCutoffPercent >= settings.entryWarningPercent
  )
    return {
      message: CRUCIBLE_ENTRY_WINDOW_ORDER_MESSAGE,
      path: 'entryCutoffPercent',
    };
  if (maxTotalEntries != null && Object.keys(settings.prizePositions).length > maxTotalEntries)
    return {
      message: 'There cannot be more prize places than the maximum total entries',
      path: 'prizePositions',
    };
  return null;
}

export const createCrucibleInputSchema = createCrucibleInputBaseSchema.superRefine((input, ctx) => {
  const issue = checkCrucibleSettings(input);
  if (issue) ctx.addIssue({ code: 'custom', message: issue.message, path: [issue.path] });
});

// Schema for submitting an entry to a crucible
export type GetCrucibleEntriesSchema = z.infer<typeof getCrucibleEntriesSchema>;
export const getCrucibleEntriesSchema = z.object({
  crucibleId: z.number(),
  limit: z.number().min(1).max(100).default(50),
  cursor: z.number().optional(),
  seed: z.number().int().optional(),
  browsingLevel: z.number().int().min(0).optional(),
});

export type CreateEntryPostSchema = z.infer<typeof createEntryPostSchema>;
export const createEntryPostSchema = z.object({
  crucibleId: z.number(),
});

export type SubmitEntrySchema = z.infer<typeof submitEntrySchema>;
export const submitEntrySchema = z.object({
  crucibleId: z.number(),
  imageId: z.number(),
});

export type CheckCrucibleEntryEligibilitySchema = z.infer<
  typeof checkCrucibleEntryEligibilitySchema
>;
export const checkCrucibleEntryEligibilitySchema = z.object({
  crucibleId: z.number(),
  imageIds: z.array(z.number()).max(1000),
});

// Schema for submitting a vote
// Minted by the judge page on entry. Absent (an older client) means no session, so every clip
// needs the full watch. Charset-limited because it becomes part of a Redis key.
const judgingSessionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{8,64}$/)
  .optional();

export type SubmitVoteSchema = z.infer<typeof submitVoteSchema>;
export const submitVoteSchema = z
  .object({
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
    judgingSessionId: judgingSessionIdSchema,
  })
  .refine(({ winnerEntryId, loserEntryId }) => winnerEntryId !== loserEntryId, {
    message: 'A vote needs two different entries',
    path: ['loserEntryId'],
  });

// Schema for getting a judging pair
export type GetJudgingPairSchema = z.infer<typeof getJudgingPairSchema>;
export type GetJudgingProgressSchema = z.infer<typeof getJudgingProgressSchema>;
export const getJudgingProgressSchema = z.object({
  crucibleId: z.number(),
  browsingLevel: z.number().int().min(0).optional(),
});

export type CrucibleJudgingStatus = {
  crucibleId: number;
  judged: boolean;
  available: boolean;
  votesUsedUp: boolean;
};

export type GetJudgingStatusesSchema = z.infer<typeof getJudgingStatusesSchema>;
export const getJudgingStatusesSchema = z.object({
  crucibleIds: z.array(z.number().int()).min(1).max(100),
  browsingLevel: z.number().int().min(0).optional(),
});

export const getJudgingPairSchema = z.object({
  crucibleId: z.number(),
  // Superseded by `skippedPairs`; still read from clients loaded before it shipped.
  excludeEntryIds: z.array(z.number()).max(50).optional(),
  // Recently skipped pairs, oldest first. Their entries are avoided while anything else is left,
  // and the pairs themselves for as long as another pair is left.
  skippedPairs: z
    .array(z.tuple([z.number().int(), z.number().int()]))
    .max(25)
    .optional(),
  browsingLevel: z.number().int().min(0).optional(),
  judgingSessionId: judgingSessionIdSchema,
});

// Not `createCrucibleInputBaseSchema.partial()`: Zod 4 still applies its `.default()`s to omitted
// keys, overwriting the stored value.
export type UpdateCrucibleSchema = z.infer<typeof updateCrucibleSchema>;
export const updateCrucibleSchema = z.object({
  id: z.number(),
  name: z.string().trim().nonempty().max(CRUCIBLE_NAME_MAX_LENGTH).optional(),
  description: crucibleDescriptionSchema,
  coverImage: crucibleImageSchema.optional(),
  heroImage: crucibleImageSchema.nullish(),
  nsfwLevel: z.number().int().positive().max(allBrowsingLevelsFlag).optional(),
  contentType: z.enum(CRUCIBLE_CONTENT_TYPES).optional(),
  entryFee: z.number().int().min(CRUCIBLE_MIN_ENTRY_FEE).max(CRUCIBLE_MAX_ENTRY_FEE).optional(),
  seededPrizePool: z.number().int().min(0).max(CRUCIBLE_MAX_SEEDED_PRIZE_POOL).optional(),
  entryLimit: z.number().int().min(1).max(CRUCIBLE_MAX_ENTRIES).optional(),
  freeEntriesPerUser: z.number().int().min(0).max(CRUCIBLE_MAX_ENTRIES).optional(),
  maxTotalEntries: z
    .number()
    .int()
    .min(CRUCIBLE_MIN_TOTAL_ENTRIES)
    .max(CRUCIBLE_MAX_TOTAL_ENTRIES)
    .nullish(),
  entryWarningPercent: z
    .number()
    .int()
    .min(CRUCIBLE_ENTRY_WARNING_PERCENT.min)
    .max(CRUCIBLE_ENTRY_WARNING_PERCENT.max)
    .optional(),
  entryCutoffPercent: z
    .number()
    .int()
    .min(CRUCIBLE_ENTRY_CUTOFF_PERCENT.min)
    .max(CRUCIBLE_ENTRY_CUTOFF_PERCENT.max)
    .optional(),
  prizePositions: prizePositionsSchema.optional(),
  allowedResources: z.array(z.number().int()).max(CRUCIBLE_MAX_ALLOWED_RESOURCES).optional(),
  allowedBaseModels: allowedBaseModelsSchema.optional(),
  duration: z
    .number()
    .refine((hours) => hours in CRUCIBLE_DURATION_COSTS, {
      message: 'Unsupported crucible duration',
    })
    .optional(),
  startAt: z
    .date()
    .refine((startAt) => startAt <= getMaxCrucibleStartAt(), {
      message: `A crucible can start at most ${CRUCIBLE_MAX_START_LEAD_DAYS} days from now`,
    })
    .nullish(),
  minViewSeconds: z
    .number()
    .refine((s) => (CRUCIBLE_MIN_VIEW_SECONDS_OPTIONS as readonly number[]).includes(s))
    .nullish(),
  maxClipSeconds: z
    .number()
    .refine((s) => (CRUCIBLE_MAX_CLIP_SECONDS_OPTIONS as readonly number[]).includes(s))
    .nullish(),
});

// Schema for cancelling a crucible
export type CancelCrucibleSchema = z.infer<typeof cancelCrucibleSchema>;
export const cancelCrucibleSchema = z.object({
  id: z.number(),
});

export type RemoveCrucibleEntrySchema = z.infer<typeof removeCrucibleEntrySchema>;
export const removeCrucibleEntrySchema = z.object({
  entryId: z.number(),
});

export type WithdrawCrucibleEntrySchema = z.infer<typeof withdrawCrucibleEntrySchema>;
export const withdrawCrucibleEntrySchema = removeCrucibleEntrySchema;

// Schema for user crucible stats (no input needed - uses authenticated user)
export type GetUserCrucibleStatsSchema = z.infer<typeof getUserCrucibleStatsSchema>;
export const getUserCrucibleStatsSchema = z.object({});

// User crucible stats response type
export type UserCrucibleStats = {
  totalCrucibles: number;
  buzzWon: number;
  bestPlacement: number | null;
  /** Average finish as the top percent of the field; null until enough crucibles count. */
  avgFinishTopPercent: number | null;
  prizesWon: number;
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

export type GetFeaturedCrucibleSchema = z.infer<typeof getFeaturedCrucibleSchema>;
export const getFeaturedCrucibleSchema = z.object({
  browsingLevel: z.number().int().min(0).optional(),
});

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

export type GetJudgingSuggestionsSchema = z.infer<typeof getJudgingSuggestionsSchema>;
export const getJudgingSuggestionsSchema = baseQuerySchema.extend({
  excludeCrucibleId: z.number().optional(),
  limit: z.number().int().min(1).max(12).default(4),
});

// Judge stats response type
export type JudgeStats = {
  // Total pairs this user has rated across all crucibles
  totalPairsRated: number;
  // Percentile rank among all judges (e.g., "Top 8%" means they're in top 8%)
  percentileRank: number | null;
  // Display only: it does not weight the user's votes.
  influenceScore: number;
};
