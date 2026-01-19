import { mergeWith } from 'lodash-es';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';

import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import { redis, REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

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

type DailyChallengeDetails = {
  articleId: number;
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
export async function setCurrentChallenge(articleId: number) {
  const challenge = await getChallengeDetails(articleId);
  await redis.packed.set(REDIS_KEYS.DAILY_CHALLENGE.DETAILS, challenge);
}
export async function getCurrentChallenge() {
  const challenge = await redis.packed.get<DailyChallengeDetails>(
    REDIS_KEYS.DAILY_CHALLENGE.DETAILS
  );
  if (!challenge) {
    // If the challenge is not set, we need to find the most recent approved challenge
    const [article] = await dbRead.$queryRaw<{ id: number }[]>`
      SELECT
        ci."articleId" as id
      FROM "CollectionItem" ci
      JOIN "Article" a ON a.id = ci."articleId"
      WHERE
        ci."collectionId" = ${dailyChallengeConfig.challengeCollectionId}
        AND ci."status" = 'ACCEPTED'
        AND (a.metadata->>'status') = 'active'
      ORDER BY ci."createdAt" DESC
      LIMIT 1
    `;
    if (!article) return null;
    setCurrentChallenge(article.id);
    return getCurrentChallenge();
  }
  return challenge;
}
export async function getUpcomingChallenge() {
  const results = await dbRead.$queryRaw<{ articleId: number }[]>`
    SELECT
      ci."articleId"
    FROM "CollectionItem" ci
    WHERE
      ci."collectionId" = ${dailyChallengeConfig.challengeCollectionId}
      AND ci."status" = 'REVIEW'
    ORDER BY ci."createdAt" DESC
    LIMIT 1
  `;
  if (!results.length) return null;

  return await getChallengeDetails(results[0].articleId);
}
export async function endChallenge(challenge?: { collectionId: number } | null) {
  challenge ??= await getCurrentChallenge();
  if (!challenge) return;

  // Close challenge
  // ----------------------------------------------
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
