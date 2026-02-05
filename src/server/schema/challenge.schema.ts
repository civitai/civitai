import * as z from 'zod';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { ChallengeSource, ChallengeStatus, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { infiniteQuerySchema } from './base.schema';
import { imageSchema } from './image.schema';
import type { ProfileImage } from '~/server/selectors/image.selector';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';

// Cover image type for challenges (compatible with ImageGuard2)
export type ChallengeCoverImage = {
  id: number;
  url: string;
  nsfwLevel: number;
  hash: string | null;
  width: number | null;
  height: number | null;
  type: MediaType;
};

// Sort options for challenges
export const ChallengeSort = {
  Newest: 'Newest',
  EndingSoon: 'EndingSoon',
  MostEntries: 'MostEntries',
  HighestPrize: 'HighestPrize',
} as const;
export type ChallengeSort = (typeof ChallengeSort)[keyof typeof ChallengeSort];

// Prize structure
export const prizeSchema = z.object({
  buzz: z.number(),
  points: z.number(),
});
export type Prize = z.infer<typeof prizeSchema>;

// Types for challenge data
export type ChallengeListItem = {
  id: number;
  title: string;
  theme: string | null;
  invitation: string | null;
  coverImage: ChallengeCoverImage | null;
  startsAt: Date;
  endsAt: Date;
  status: ChallengeStatus;
  source: ChallengeSource;
  prizePool: number;
  entryCount: number;
  modelVersionIds: number[];
  collectionId: number | null;
  createdBy: {
    id: number;
    username: string | null;
    image: string | null;
    profilePicture?: ProfileImage | null;
    cosmetics?: UserWithCosmetics['cosmetics'] | null;
    deletedAt: Date | null;
  };
};

// Completion summary stored in Challenge.metadata when winners are picked
export type ChallengeCompletionSummary = {
  judgingProcess: string;
  outcome: string;
  completedAt: string;
};

export type ChallengeJudgeInfo = {
  id: number;
  userId: number;
  name: string;
  bio: string | null;
  profilePicture?: ProfileImage | null;
  cosmetics?: UserWithCosmetics['cosmetics'] | null;
};

export type ChallengeDetail = {
  id: number;
  title: string;
  description: string | null;
  theme: string | null;
  invitation: string | null;
  coverImage: ChallengeCoverImage | null;
  startsAt: Date;
  endsAt: Date;
  visibleAt: Date;
  status: ChallengeStatus;
  source: ChallengeSource;
  nsfwLevel: number;
  allowedNsfwLevel: number;
  modelVersionIds: number[];
  models: Array<{
    id: number;
    name: string;
    versionId: number;
    versionName: string;
    image: {
      id: number;
      url: string;
      nsfwLevel: number;
      hash: string;
      width: number;
      height: number;
      type: MediaType;
    } | null;
  }>;
  collectionId: number | null;
  judgingPrompt: string | null;
  reviewPercentage: number;
  maxEntriesPerUser: number;
  prizes: Prize[];
  entryPrize: Prize | null;
  entryPrizeRequirement: number;
  prizePool: number;
  operationBudget: number;
  entryCount: number;
  createdBy: {
    id: number;
    username: string | null;
    image: string | null;
    profilePicture?: ProfileImage | null;
    cosmetics?: UserWithCosmetics['cosmetics'] | null;
    deletedAt?: Date | null;
  };
  judge: ChallengeJudgeInfo | null;
  winners: Array<{
    place: number;
    userId: number;
    username: string;
    imageId: number;
    imageUrl: string;
    buzzAwarded: number;
    reason: string | null;
    profilePicture?: ProfileImage | null;
    cosmetics?: UserWithCosmetics['cosmetics'] | null;
  }>;
  completionSummary: ChallengeCompletionSummary | null;
};

export type ModeratorChallengeListItem = {
  id: number;
  title: string;
  theme: string | null;
  startsAt: Date;
  endsAt: Date;
  visibleAt: Date;
  status: ChallengeStatus;
  source: ChallengeSource;
  prizePool: number;
  entryCount: number;
  collectionId: number;
  createdById: number;
  creatorUsername: string | null;
};

export type UpcomingTheme = {
  date: string;
  theme: string;
  modelName: string;
  modelCreator: string | null;
};

// Composite cursor for stable pagination across all sort types
// Format: "sortValue:id" where sortValue depends on sort type
export const challengeCursorSchema = z.string().optional();

// Query schema for infinite challenge list
export type GetInfiniteChallengesInput = z.infer<typeof getInfiniteChallengesSchema>;
export const getInfiniteChallengesSchema = z.object({
  ...infiniteQuerySchema.omit({ cursor: true }).shape,
  // Override cursor to be a string for composite cursor support
  cursor: challengeCursorSchema,
  query: z.string().optional(),
  status: z.enum(ChallengeStatus).array().optional(),
  source: z.enum(ChallengeSource).array().optional(),
  period: z.enum(MetricTimeframe).default(MetricTimeframe.AllTime),
  sort: z
    .enum([
      ChallengeSort.Newest,
      ChallengeSort.EndingSoon,
      ChallengeSort.MostEntries,
      ChallengeSort.HighestPrize,
    ])
    .default(ChallengeSort.Newest),
  userId: z.number().optional(),
  modelVersionId: z.number().optional(),
  includeEnded: z.boolean().default(false),
  limit: z.coerce.number().min(1).max(100).default(20),
});

// Note: Challenge entries are stored as CollectionItems in the challenge's collection.
// Use collection endpoints to query entries.

// Query schema for challenge winners
export type GetChallengeWinnersInput = z.infer<typeof getChallengeWinnersSchema>;
export const getChallengeWinnersSchema = z.object({
  challengeId: z.number(),
});

// Query schema for user entry count
export type GetUserEntryCountInput = z.infer<typeof getUserEntryCountSchema>;
export const getUserEntryCountSchema = z.object({
  challengeId: z.number(),
});

// Moderator: Get all challenges (including drafts and hidden)
export type GetModeratorChallengesInput = z.infer<typeof getModeratorChallengesSchema>;
export const getModeratorChallengesSchema = infiniteQuerySchema.merge(
  z.object({
    query: z.string().optional(),
    status: z.enum(ChallengeStatus).array().optional(),
    source: z.enum(ChallengeSource).array().optional(),
    limit: z.coerce.number().min(1).max(100).default(30),
  })
);

// Moderator: Create/Update challenge
// Base schema is a ZodObject so the form can use .omit().extend()
export const upsertChallengeBaseSchema = z.object({
  id: z.number().optional(),
  title: z.string().min(3).max(200),
  description: z.string().optional(),
  theme: z.string().optional(),
  invitation: z.string().optional(),
  coverImage: imageSchema,
  nsfwLevel: z.number().min(1).max(32).default(1),
  allowedNsfwLevel: z.number().min(1).max(63).default(1),
  modelVersionIds: z.array(z.number()).default([]),
  judgeId: z.number().optional().nullable(),
  judgingPrompt: z.string().optional().nullable(),
  reviewPercentage: z.number().min(0).max(100).default(100),
  maxReviews: z.number().optional().nullable(),
  maxEntriesPerUser: z.number().min(1).max(100).default(20),
  prizes: z.array(prizeSchema).default([]),
  entryPrize: prizeSchema.optional().nullable(),
  entryPrizeRequirement: z.number().min(1).max(100).default(10),
  prizePool: z.number().min(0).default(0),
  operationBudget: z.number().min(0).default(0),
  startsAt: z.date(),
  endsAt: z.date(),
  visibleAt: z.date(),
  status: z.enum(ChallengeStatus).default(ChallengeStatus.Scheduled),
  source: z.enum(ChallengeSource).default(ChallengeSource.System),
});

// Refined schema with cross-field validation (used by tRPC router)
export const upsertChallengeSchema = upsertChallengeBaseSchema.refine(
  (data) => data.endsAt > data.startsAt,
  { message: 'End date must be after start date', path: ['endsAt'] }
);
export type UpsertChallengeInput = z.infer<typeof upsertChallengeSchema>;

// Moderator: Delete challenge
export type DeleteChallengeInput = z.infer<typeof deleteChallengeSchema>;
export const deleteChallengeSchema = z.object({
  id: z.number(),
});

// Moderator: Quick actions
export type ChallengeQuickActionInput = z.infer<typeof challengeQuickActionSchema>;
export const challengeQuickActionSchema = z.object({
  id: z.number(),
});

export type GetUpcomingThemesInput = z.infer<typeof getUpcomingThemesSchema>;
export const getUpcomingThemesSchema = z.object({
  count: z.number().min(1).max(10).default(3),
});

// Check entry eligibility for challenge submission
export type CheckEntryEligibilityInput = z.infer<typeof checkEntryEligibilitySchema>;
export const checkEntryEligibilitySchema = z.object({
  challengeId: z.number(),
  imageIds: z.array(z.number()).min(1).max(100),
});

export type ImageEligibilityResult = {
  imageId: number;
  eligible: boolean;
  reasons: string[];
};

// System challenge config update schema
export const updateChallengeConfigSchema = z.object({
  defaultJudgeId: z.number().nullable(),
});
export type UpdateChallengeConfigInput = z.infer<typeof updateChallengeConfigSchema>;
