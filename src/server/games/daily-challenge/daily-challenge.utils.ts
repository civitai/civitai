import { NotificationCategory } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';

export const dailyChallengeConfig = {
  collectionId: 2930699,
  challengeRunnerUserId: 6235605,
  challengeCollectionId: 6236625,
  judgedTagId: 299729,
  cooldownPeriod: '7 day',
  prizes: [
    { buzz: 5000, points: 150 },
    { buzz: 2500, points: 100 },
    { buzz: 1500, points: 50 },
  ] as Prize[],
  entryPrizeRequirement: 20,
  entryPrize: { buzz: 400, points: 10 } as Prize,
  reviewAmount: { min: 8, max: 12 },
  finalReviewAmount: 10,
  resourceCosmeticId: null,
};

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
  date: Date;
  theme: string;
  modelId: number;
  modelVersionIds: number[];
  collectionId: number;
  title: string;
  invitation: string;
  coverUrl: string;
};
async function getChallengeDetails(articleId: number) {
  const rows = await dbRead.$queryRaw<DailyChallengeDetails[]>`
    SELECT
      a."id" as "articleId",
      (a.metadata->>'theme') as "theme",
      (a.metadata->>'challengeDate')::timestamp as "date",
      cast(a.metadata->'modelId' as int) as "modelId",
      (SELECT array_agg("id") FROM "ModelVersion" WHERE "modelId" = cast(a.metadata->'modelId' as int)) as "modelVersionIds",
      cast(a.metadata->'collectionId' as int) as "collectionId",
      a."title",
      (a.metadata->>'invitation') as "invitation",
      (SELECT "url" FROM "Image" WHERE "id" = a."coverId") as "coverUrl"
    FROM "Article" a
    WHERE a.id = ${articleId}
  `;

  return rows[0];
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
      WHERE
        ci."collectionId" = ${dailyChallengeConfig.challengeCollectionId}
        AND ci."status" = 'ACCEPTED'
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

  return getChallengeDetails(results[0].articleId);
}
