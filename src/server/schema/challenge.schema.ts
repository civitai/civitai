import * as z from 'zod';
import { ChallengeSource, ChallengeStatus, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { infiniteQuerySchema } from './base.schema';
import { imageSchema } from './image.schema';

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
  coverUrl: string | null;
  startsAt: Date;
  endsAt: Date;
  status: ChallengeStatus;
  source: ChallengeSource;
  prizePool: number;
  entryCount: number;
  modelName: string | null;
  createdBy: {
    id: number;
    username: string | null;
    image: string | null;
  };
};

export type ChallengeDetail = {
  id: number;
  title: string;
  description: string | null;
  theme: string | null;
  invitation: string | null;
  coverImageId: number | null;
  coverUrl: string | null;
  startsAt: Date;
  endsAt: Date;
  visibleAt: Date;
  status: ChallengeStatus;
  source: ChallengeSource;
  nsfwLevel: number;
  allowedNsfwLevel: number;
  modelVersionIds: number[];
  model: {
    id: number;
    name: string;
  } | null;
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
  };
  winners: Array<{
    place: number;
    userId: number;
    username: string;
    imageId: number;
    imageUrl: string;
    buzzAwarded: number;
    reason: string | null;
  }>;
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

// Query schema for infinite challenge list
export type GetInfiniteChallengesInput = z.infer<typeof getInfiniteChallengesSchema>;
export const getInfiniteChallengesSchema = infiniteQuerySchema.merge(
  z.object({
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
  })
);

// Note: Challenge entries are stored as CollectionItems in the challenge's collection.
// Use collection endpoints to query entries.

// Query schema for challenge winners
export type GetChallengeWinnersInput = z.infer<typeof getChallengeWinnersSchema>;
export const getChallengeWinnersSchema = z.object({
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
export type UpsertChallengeInput = z.infer<typeof upsertChallengeSchema>;
export const upsertChallengeSchema = z.object({
  id: z.number().optional(),
  title: z.string().min(3).max(200),
  description: z.string().optional(),
  theme: z.string().optional(),
  invitation: z.string().optional(),
  coverImage: imageSchema.nullish(),
  nsfwLevel: z.number().min(1).max(32).default(1),
  allowedNsfwLevel: z.number().min(1).max(63).default(1),
  modelVersionIds: z.array(z.number()).default([]),
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
  status: z.enum(ChallengeStatus).default(ChallengeStatus.Draft),
  source: z.enum(ChallengeSource).default(ChallengeSource.System),
});

// Moderator: Update challenge status
export type UpdateChallengeStatusInput = z.infer<typeof updateChallengeStatusSchema>;
export const updateChallengeStatusSchema = z.object({
  id: z.number(),
  status: z.enum(ChallengeStatus),
});

// Moderator: Delete challenge
export type DeleteChallengeInput = z.infer<typeof deleteChallengeSchema>;
export const deleteChallengeSchema = z.object({
  id: z.number(),
});

export type GetUpcomingThemesInput = z.infer<typeof getUpcomingThemesSchema>;
export const getUpcomingThemesSchema = z.object({
  count: z.number().min(1).max(10).default(3),
});
