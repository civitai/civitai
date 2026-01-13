import * as z from 'zod';
import { ChallengeSource, ChallengeStatus, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { infiniteQuerySchema } from './base.schema';

// Sort options for challenges
export const ChallengeSort = {
  Newest: 'Newest',
  EndingSoon: 'EndingSoon',
  MostEntries: 'MostEntries',
  HighestPrize: 'HighestPrize',
} as const;
export type ChallengeSort = (typeof ChallengeSort)[keyof typeof ChallengeSort];

// Query schema for infinite challenge list
export type GetInfiniteChallengesInput = z.infer<typeof getInfiniteChallengesSchema>;
export const getInfiniteChallengesSchema = infiniteQuerySchema.merge(
  z.object({
    query: z.string().optional(),
    status: z.nativeEnum(ChallengeStatus).array().optional(),
    source: z.nativeEnum(ChallengeSource).array().optional(),
    period: z.nativeEnum(MetricTimeframe).default(MetricTimeframe.AllTime),
    sort: z
      .enum([
        ChallengeSort.Newest,
        ChallengeSort.EndingSoon,
        ChallengeSort.MostEntries,
        ChallengeSort.HighestPrize,
      ])
      .default(ChallengeSort.Newest),
    userId: z.number().optional(), // Filter by creator
    modelId: z.number().optional(), // Filter by featured model
    includeEnded: z.boolean().default(false), // Include completed challenges
    limit: z.coerce.number().min(1).max(100).default(20),
  })
);

// Query schema for challenge entries
export type GetChallengeEntriesInput = z.infer<typeof getChallengeEntriesSchema>;
export const getChallengeEntriesSchema = infiniteQuerySchema.merge(
  z.object({
    challengeId: z.number(),
    userId: z.number().optional(), // Filter by entrant
    scored: z.boolean().optional(), // Only show scored entries
    limit: z.coerce.number().min(1).max(100).default(30),
  })
);

// Query schema for challenge winners
export type GetChallengeWinnersInput = z.infer<typeof getChallengeWinnersSchema>;
export const getChallengeWinnersSchema = z.object({
  challengeId: z.number(),
});

// Prize structure
export const prizeSchema = z.object({
  buzz: z.number(),
  points: z.number(),
});
export type Prize = z.infer<typeof prizeSchema>;

// Moderator: Get all challenges (including drafts and hidden)
export type GetModeratorChallengesInput = z.infer<typeof getModeratorChallengesSchema>;
export const getModeratorChallengesSchema = infiniteQuerySchema.merge(
  z.object({
    query: z.string().optional(),
    status: z.nativeEnum(ChallengeStatus).array().optional(),
    source: z.nativeEnum(ChallengeSource).array().optional(),
    limit: z.coerce.number().min(1).max(100).default(30),
  })
);

// Moderator: Create/Update challenge
export type UpsertChallengeInput = z.infer<typeof upsertChallengeSchema>;
export const upsertChallengeSchema = z.object({
  id: z.number().optional(), // Undefined = create, number = update
  title: z.string().min(3).max(200),
  description: z.string().optional(),
  theme: z.string().optional(),
  invitation: z.string().optional(),
  coverImageId: z.number().optional().nullable(),
  nsfwLevel: z.number().min(1).max(32).default(1),
  modelId: z.number().optional().nullable(),
  modelVersionId: z.number().optional().nullable(),
  judgingPrompt: z.string().optional().nullable(),
  reviewPercentage: z.number().min(0).max(100).default(100),
  maxReviews: z.number().optional().nullable(),
  maxEntriesPerUser: z.number().min(1).max(100).default(20),
  prizes: z.array(prizeSchema).default([]),
  entryPrize: prizeSchema.optional().nullable(),
  prizePool: z.number().min(0).default(0),
  operationBudget: z.number().min(0).default(0),
  startsAt: z.date(),
  endsAt: z.date(),
  visibleAt: z.date(),
  status: z.nativeEnum(ChallengeStatus).default(ChallengeStatus.Draft),
  source: z.nativeEnum(ChallengeSource).default(ChallengeSource.System),
});

// Moderator: Update challenge status
export type UpdateChallengeStatusInput = z.infer<typeof updateChallengeStatusSchema>;
export const updateChallengeStatusSchema = z.object({
  id: z.number(),
  status: z.nativeEnum(ChallengeStatus),
});

// Moderator: Delete challenge
export type DeleteChallengeInput = z.infer<typeof deleteChallengeSchema>;
export const deleteChallengeSchema = z.object({
  id: z.number(),
});
