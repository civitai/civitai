import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { getChallengeConfig } from '~/server/games/daily-challenge/daily-challenge.utils';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { createWebhookProcessor } from '~/server/webhooks/base.webhooks';
import { isDefined } from '~/utils/type-guards';

const baseUrl = getBaseUrl();
export const dailyChallengeWebhooks = createWebhookProcessor({
  'daily-challenge-complete': {
    displayName: 'Daily Challenge Completed',
    getData: async ({ lastSent, prisma }) => {
      const config = await getChallengeConfig();
      const challenges = await prisma.$queryRaw<ChallengeDetails[]>`
        SELECT
          a.id,
          a.title as name,
          (SELECT "url" FROM "Image" WHERE "id" = a."coverId") as "coverUrl"
        FROM "CollectionItem" ci
        JOIN "Article" a ON a.id = ci."articleId"
        WHERE ci."collectionId" = ${config.challengeCollectionId}
        AND a.metadata->>'status' = 'complete'
        AND a."updatedAt" > ${lastSent}
      `;
      if (!challenges.length) return [];

      return challenges
        .map(({ coverUrl, ...challenge }) => {
          return {
            ...challenge,
            cover: coverUrl ? getEdgeUrl(coverUrl, { width: 450 }) : null,
            link: `${baseUrl}/articles/${challenge.id}`,
          };
        })
        .filter(isDefined);
    },
  },
  'daily-challenge-start': {
    displayName: 'Daily Challenge Started',
    getData: async ({ lastSent, prisma }) => {
      const config = await getChallengeConfig();
      const challenges = await prisma.$queryRaw<ChallengeDetails[]>`
        SELECT
          a.id,
          a.title as name,
          (SELECT "url" FROM "Image" WHERE "id" = a."coverId") as "coverUrl"
        FROM "CollectionItem" ci
        JOIN "Article" a ON a.id = ci."articleId"
        WHERE ci."collectionId" = ${config.challengeCollectionId}
        AND a.metadata->>'status' = 'active'
        AND a."updatedAt" > ${lastSent}
      `;
      if (!challenges.length) return [];

      return challenges
        .map(({ coverUrl, ...challenge }) => {
          return {
            ...challenge,
            cover: coverUrl ? getEdgeUrl(coverUrl, { width: 450 }) : null,
            link: `${baseUrl}/articles/${challenge.id}`,
          };
        })
        .filter(isDefined);
    },
  },
  'new-daily-challenge': {
    displayName: 'New Daily Challenge',
    getData: async ({ lastSent, prisma }) => {
      const config = await getChallengeConfig();
      const challenges = await prisma.$queryRaw<ChallengeDetails[]>`
        SELECT
          a.id,
          a.title as name,
          (SELECT "url" FROM "Image" WHERE "id" = a."coverId") as "coverUrl"
        FROM "CollectionItem" ci
        JOIN "Article" a ON a.id = ci."articleId"
        WHERE ci."collectionId" = ${config.challengeCollectionId}
        AND a.metadata->>'status' = 'pending'
        AND a."updatedAt" > ${lastSent}
      `;
      if (!challenges.length) return [];

      return challenges
        .map(({ coverUrl, ...challenge }) => {
          return {
            ...challenge,
            cover: coverUrl ? getEdgeUrl(coverUrl, { width: 450 }) : null,
            link: `${baseUrl}/articles/${challenge.id}`,
          };
        })
        .filter(isDefined);
    },
  },
});

type ChallengeDetails = {
  id: number;
  name: string;
  coverUrl: string | null;
};
