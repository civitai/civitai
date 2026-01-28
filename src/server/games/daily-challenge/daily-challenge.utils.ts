import { mergeWith } from 'lodash-es';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';

import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  type ChallengeDetails,
  getActiveChallengeFromDb,
  getActiveChallengesFromDb,
  getEndedActiveChallengesFromDb,
  getScheduledChallengeFromDb,
  getScheduledChallengesReadyToStart,
  getUpcomingSystemChallengeFromDb,
} from './challenge-helpers';

const challengeConfigSchema = z.object({
  challengeType: z.string(),
  challengeCollectionId: z.number(),
  judgedTagId: z.number(),
  reviewMeTagId: z.number(),
  userCooldown: z.string(),
  resourceCooldown: z.string(),
  prizes: z.array(
    z.object({
      buzz: z.number(),
      points: z.number(),
    })
  ),
  entryPrizeRequirement: z.number(),
  entryPrize: z.object({
    buzz: z.number(),
    points: z.number(),
  }),
  reviewAmount: z.object({
    min: z.number(),
    max: z.number(),
  }),
  maxScoredPerUser: z.number(),
  finalReviewAmount: z.number(),
  resourceCosmeticId: z.number().nullable(),
  articleTagId: z.number(),
});
export type ChallengeConfig = z.infer<typeof challengeConfigSchema>;
export const dailyChallengeConfig: ChallengeConfig = {
  challengeType: 'world-morph',
  challengeCollectionId: 6236625,
  judgedTagId: 299729,
  reviewMeTagId: 301770,
  userCooldown: '14 day',
  resourceCooldown: '90 day',
  prizes: [
    { buzz: 5000, points: 150 },
    { buzz: 2500, points: 100 },
    { buzz: 1500, points: 50 },
  ] as Prize[],
  entryPrizeRequirement: 10,
  entryPrize: { buzz: 200, points: 10 } as Prize,
  reviewAmount: { min: 2, max: 6 },
  maxScoredPerUser: 5,
  finalReviewAmount: 10,
  resourceCosmeticId: null,
  articleTagId: 128643, // Announcement.
};
export async function getChallengeConfig() {
  let config: Partial<ChallengeConfig> = {};
  try {
    const redisConfig = await sysRedis.packed.get<Partial<ChallengeConfig>>(
      REDIS_SYS_KEYS.DAILY_CHALLENGE.CONFIG
    );
    if (redisConfig) config = challengeConfigSchema.partial().parse(redisConfig);
  } catch (e) {
    console.error('Invalid daily challenge config in redis:', e);
  }

  return { ...dailyChallengeConfig, ...config };
}

export type ChallengePrompts = {
  systemMessage: string;
  collection: string;
  article: string;
  review: string;
  winner: string;
};
type ChallengeType = {
  collectionId: number;
  userId: number;
  prompts: ChallengePrompts;
};
const DEFAULT_CHALLENGE_TYPE = 'world-morph';
type ChallengeTypeRow = {
  name: string;
  collectionId: number;
  userId: number;
  promptSystemMessage: string;
  promptCollection: string;
  promptArticle: string;
  promptReview: string;
  promptWinner: string;
};
export async function getChallengeTypeConfig(type: string | undefined) {
  type ??= DEFAULT_CHALLENGE_TYPE;
  const rows = await dbRead.$queryRaw<ChallengeTypeRow[]>`
    SELECT
      "name",
      "collectionId",
      "userId",
      "promptSystemMessage",
      "promptCollection",
      "promptArticle",
      "promptReview",
      "promptWinner"
    FROM "ChallengeType"
    WHERE "name" IN (${type}, ${DEFAULT_CHALLENGE_TYPE})
  `;
  const result = rows.find((r) => r.name === DEFAULT_CHALLENGE_TYPE);
  if (!result) throw new Error('Default challenge type not found in database');

  let override = rows.find((r) => r.name === type);
  if (!override) override = result;
  else {
    mergeWith(result, override, (objValue, srcValue) => {
      // Handle empty strings as null
      if (typeof srcValue === 'string' && !srcValue) return objValue;
    });
  }

  return {
    collectionId: result.collectionId,
    userId: result.userId,
    prompts: {
      systemMessage: result.promptSystemMessage,
      collection: result.promptCollection,
      article: result.promptArticle,
      review: result.promptReview,
      winner: result.promptWinner,
    },
  } as ChallengeType;
}

export type Prize = {
  buzz: number;
  points: number;
};

export type Score = {
  theme: number; // 0-10 how well it fits the theme
  wittiness: number; // 0-10 how witty it is
  humor: number; // 0-10 how funny it is
  aesthetic: number; // 0-10 how aesthetically pleasing it is
};

export type DailyChallengeDetails = {
  challengeId: number; // Challenge table ID for status updates
  articleId?: number; // Deprecated: Legacy article ID (no longer used for new challenges)
  type: string;
  date: Date;
  theme: string;
  modelId: number;
  modelVersionIds: number[];
  collectionId: number;
  title: string;
  invitation: string;
  coverUrl: string;
  prizes: Prize[];
  entryPrizeRequirement: number;
  entryPrize: Prize;
};

/**
 * Convert new ChallengeDetails format to legacy DailyChallengeDetails format.
 * This adapter enables backward compatibility during the transition period.
 */
export function challengeToLegacyFormat(challenge: ChallengeDetails): DailyChallengeDetails {
  const metadata = challenge.metadata as Record<string, unknown> | null;
  return {
    challengeId: challenge.id,
    articleId: (metadata?.articleId as number) ?? 0,
    type: (metadata?.challengeType as string) ?? 'world-morph',
    date: challenge.startsAt,
    theme: challenge.theme ?? '',
    modelId: (metadata?.resourceUserId as number) ?? 0,
    modelVersionIds: challenge.modelVersionIds,
    collectionId: challenge.collectionId!,
    title: challenge.title,
    invitation: challenge.invitation ?? '',
    coverUrl: challenge.coverUrl ?? '',
    prizes: challenge.prizes,
    entryPrizeRequirement: challenge.entryPrizeRequirement,
    entryPrize: challenge.entryPrize ?? { buzz: 0, points: 0 },
  };
}

/**
 * @deprecated Use getChallengeById from challenge-helpers.ts instead.
 * This function looks up challenges by Article ID which is no longer used.
 * Will be removed in a future release.
 */
export async function getChallengeDetails(articleId: number) {
  const db = await getDbWithoutLag('article', articleId);
  const rows = await db.$queryRaw<DailyChallengeDetails[]>`
    SELECT
      a."id" as "articleId",
      (a.metadata->>'challengeType') as "type",
      (a.metadata->>'theme') as "theme",
      (a.metadata->>'challengeDate')::timestamp as "date",
      cast(a.metadata->'modelId' as int) as "modelId",
      (SELECT array_agg("id") FROM "ModelVersion" WHERE "modelId" = cast(a.metadata->'modelId' as int)) as "modelVersionIds",
      cast(a.metadata->'collectionId' as int) as "collectionId",
      a."title",
      (a.metadata->>'invitation') as "invitation",
      (SELECT "url" FROM "Image" WHERE "id" = a."coverId") as "coverUrl",
      (a.metadata->'prizes') as "prizes",
      (a.metadata->>'entryPrizeRequirement')::int as "entryPrizeRequirement",
      (a.metadata->'entryPrize') as "entryPrize"
    FROM "Article" a
    WHERE a.id = ${articleId}
  `;

  const result = rows[0];
  if (!result) return null;
  if (!result.prizes) result.prizes = dailyChallengeConfig.prizes;
  if (!result.entryPrizeRequirement)
    result.entryPrizeRequirement = dailyChallengeConfig.entryPrizeRequirement;
  if (!result.entryPrize) result.entryPrize = dailyChallengeConfig.entryPrize;

  return result;
}

/**
 * @deprecated Challenge caching is now managed via Challenge table status.
 * This function is a no-op and will be removed in a future release.
 */
export async function setCurrentChallenge(_articleId: number): Promise<void> {
  // No-op: Challenge.status is now the source of truth
  // Redis cache is no longer used for challenge tracking
  return;
}

/**
 * Gets the currently active challenge from the Challenge table.
 */
export async function getCurrentChallenge(): Promise<DailyChallengeDetails | null> {
  const challenge = await getActiveChallengeFromDb();
  if (!challenge) return null;
  return challengeToLegacyFormat(challenge);
}

/**
 * Gets the next scheduled challenge from the Challenge table.
 */
export async function getUpcomingChallenge(): Promise<DailyChallengeDetails | null> {
  const challenge = await getScheduledChallengeFromDb();
  if (!challenge) return null;
  return challengeToLegacyFormat(challenge);
}
export async function endChallenge(challenge?: { collectionId: number } | null) {
  challenge ??= await getCurrentChallenge();
  if (!challenge) return;

  // Close challenge
  await dbWrite.$executeRaw`
    UPDATE "Collection"
    SET write = 'Private'::"CollectionWriteConfiguration"
    WHERE id = ${challenge.collectionId};
  `;

  // Remove all contributors
  await dbWrite.$executeRaw`
    DELETE FROM "CollectionContributor"
    WHERE "collectionId" = ${challenge.collectionId}
  `;
}

// =============================================================================
// Multi-Challenge Support Functions
// =============================================================================

/**
 * Gets ALL active challenges in legacy format (supports multiple concurrent challenges).
 */
export async function getActiveChallenges(): Promise<DailyChallengeDetails[]> {
  const challenges = await getActiveChallengesFromDb();
  return challenges.map(challengeToLegacyFormat);
}

/**
 * Gets active challenges that have ENDED (endsAt <= now) in legacy format.
 * These challenges need winner picking.
 */
export async function getEndedActiveChallenges(): Promise<DailyChallengeDetails[]> {
  const challenges = await getEndedActiveChallengesFromDb();
  return challenges.map(challengeToLegacyFormat);
}

/**
 * Gets scheduled challenges that are ready to START (startsAt <= now) in legacy format.
 * These challenges should be activated.
 */
export async function getChallengesReadyToStart(): Promise<DailyChallengeDetails[]> {
  const challenges = await getScheduledChallengesReadyToStart();
  return challenges.map(challengeToLegacyFormat);
}

/**
 * Gets an upcoming system-created challenge (scheduled or active) in legacy format.
 * Returns null if no system challenge exists.
 */
export async function getUpcomingSystemChallenge(): Promise<DailyChallengeDetails | null> {
  const challenge = await getUpcomingSystemChallengeFromDb();
  if (!challenge) return null;
  return challengeToLegacyFormat(challenge);
}
