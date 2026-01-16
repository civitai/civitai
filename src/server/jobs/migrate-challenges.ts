/**
 * Migration Script: Article-based Challenges to Challenge Table
 *
 * This script migrates existing challenges stored in the Article table
 * (with metadata) to the new dedicated Challenge table.
 *
 * Run with: npx ts-node src/server/jobs/migrate-challenges.ts
 * Or add as a job and run via job runner.
 */

import type { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { dbRead, dbWrite } from '~/server/db/client';
import { dailyChallengeConfig } from '~/server/games/daily-challenge/daily-challenge.utils';
import { ChallengeSource, ChallengeStatus } from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';
import { createJob } from './job';

const log = createLogger('jobs:migrate-challenges', 'green');

type ArticleChallenge = {
  articleId: number;
  title: string;
  content: string;
  coverId: number | null;
  userId: number;
  publishedAt: Date | null;
  modelId: number | null;
  collectionId: number | null;
  theme: string | null;
  invitation: string | null;
  challengeDate: Date | null;
  status: string | null;
  prizes: string | null;
  entryPrize: string | null;
  entryPrizeRequirement: number | null;
};

/**
 * Migrates a single Article-based challenge to the Challenge table
 */
async function migrateChallenge(article: ArticleChallenge): Promise<number | null> {
  try {
    // Check if already migrated
    const existing = await dbRead.challenge.findFirst({
      where: {
        metadata: {
          path: ['articleId'],
          equals: article.articleId,
        },
      },
    });

    if (existing) {
      log(`Challenge already migrated: articleId=${article.articleId}, challengeId=${existing.id}`);
      return existing.id;
    }

    // Parse metadata
    const prizes = article.prizes ? JSON.parse(article.prizes) : dailyChallengeConfig.prizes;
    const entryPrize = article.entryPrize
      ? JSON.parse(article.entryPrize)
      : dailyChallengeConfig.entryPrize;
    const entryPrizeRequirement =
      article.entryPrizeRequirement ?? dailyChallengeConfig.entryPrizeRequirement;

    // Determine status
    let status: ChallengeStatus;
    if (article.status === 'complete') {
      status = ChallengeStatus.Completed;
    } else if (article.status === 'active') {
      status = ChallengeStatus.Active;
    } else if (article.publishedAt) {
      status = ChallengeStatus.Completed; // Old published challenges are complete
    } else {
      status = ChallengeStatus.Draft;
    }

    // Calculate dates
    const challengeDate = article.challengeDate ?? article.publishedAt ?? new Date();
    const startsAt = challengeDate;
    const endsAt = dayjs(challengeDate).add(1, 'day').toDate();
    const visibleAt = challengeDate;

    // Skip if no collection - collectionId is now required
    if (!article.collectionId) {
      log(`Skipping articleId=${article.articleId} - no collectionId`);
      return null;
    }

    // Get model version IDs for the model (if modelId exists)
    let modelVersionIds: number[] = [];
    if (article.modelId) {
      const versions = await dbRead.$queryRaw<{ id: number }[]>`
        SELECT mv.id
        FROM "ModelVersion" mv
        WHERE mv."modelId" = ${article.modelId}
        AND mv.status = 'Published'
        ORDER BY mv.index ASC
      `;
      modelVersionIds = versions.map((v) => v.id);
    }

    // Create Challenge record
    const challenge = await dbWrite.challenge.create({
      data: {
        startsAt,
        endsAt,
        visibleAt,
        title: article.title,
        description: article.content,
        theme: article.theme,
        invitation: article.invitation,
        coverImageId: article.coverId,
        nsfwLevel: 1,
        allowedNsfwLevel: 1, // PG only for migrated challenges
        modelVersionIds,
        collectionId: article.collectionId,
        maxEntriesPerUser: entryPrizeRequirement * 2,
        entryPrizeRequirement,
        prizes: prizes as Prisma.InputJsonValue,
        entryPrize: entryPrize as Prisma.InputJsonValue,
        prizePool: prizes.reduce((sum: number, p: { buzz: number }) => sum + p.buzz, 0),
        createdById: article.userId,
        source: ChallengeSource.System,
        status,
        metadata: {
          articleId: article.articleId,
          modelId: article.modelId, // Keep original modelId in metadata for reference
          migratedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    log(`Migrated challenge: articleId=${article.articleId} -> challengeId=${challenge.id}`);
    return challenge.id;
  } catch (error) {
    const err = error as Error;
    log(`Failed to migrate challenge articleId=${article.articleId}: ${err.message}`);
    return null;
  }
}

/**
 * Main migration function
 */
export async function migrateAllChallenges() {
  log('Starting challenge migration...');

  // Get all Article-based challenges from the challenge collection
  const articles = await dbRead.$queryRaw<ArticleChallenge[]>`
    SELECT
      a.id as "articleId",
      a.title,
      a.content,
      a."coverId",
      a."userId",
      a."publishedAt",
      cast(a.metadata->'modelId' as int) as "modelId",
      cast(a.metadata->'collectionId' as int) as "collectionId",
      (a.metadata->>'theme') as theme,
      (a.metadata->>'invitation') as invitation,
      (a.metadata->>'challengeDate')::timestamp as "challengeDate",
      (a.metadata->>'status') as status,
      (a.metadata->'prizes')::text as prizes,
      (a.metadata->'entryPrize')::text as "entryPrize",
      (a.metadata->>'entryPrizeRequirement')::int as "entryPrizeRequirement"
    FROM "CollectionItem" ci
    JOIN "Article" a ON a.id = ci."articleId"
    WHERE ci."collectionId" = ${dailyChallengeConfig.challengeCollectionId}
    ORDER BY a."publishedAt" DESC NULLS LAST
  `;

  log(`Found ${articles.length} Article-based challenges to migrate`);

  let migrated = 0;
  let failed = 0;

  for (const article of articles) {
    const challengeId = await migrateChallenge(article);
    if (challengeId) {
      migrated++;
    } else {
      failed++;
    }
  }

  log(`Migration complete: ${migrated} migrated, ${failed} failed`);

  return { migrated, failed };
}

// Create a job for the migration (run manually or add to job list)
export const migrateChallengesJob = createJob(
  'migrate-challenges',
  '0 0 * * 0', // Run weekly on Sunday at midnight (mainly for cleanup/retry)
  migrateAllChallenges
);
