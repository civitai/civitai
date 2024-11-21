import { createNotification } from '~/server/services/notification.service';
import { createJob } from './job';
import { dbRead, dbWrite } from '~/server/db/client';
import { NotificationCategory, NsfwLevel } from '~/server/common/enums';
import { Random } from '~/utils/random';
import {
  generateArticle,
  generateCollectionDetails,
  generateReview,
  generateWinners,
} from '~/server/games/daily-challenge/generative-content';
import {
  dailyChallengeConfig as config,
  getCurrentChallenge,
  getUpcomingChallenge,
  setCurrentChallenge,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import dayjs from 'dayjs';
import { CollectionReadConfiguration, Prisma } from '@prisma/client';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { getRandomInt } from '~/utils/number-helpers';
import { getRandom, shuffle } from '~/utils/array-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { upsertComment } from '~/server/services/commentsv2.service';
import { toggleReaction } from '~/server/services/reaction.service';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { TransactionType } from '~/server/schema/buzz.schema';
import { withRetries } from '~/utils/errorHandling';
import { isDefined } from '~/utils/type-guards';

export const dailyChallengeSetup = createJob('daily-challenge-setup', '45 23 * * *', async () => {
  // Get date of the challenge (should be the next day if it's past 11pm UTC)
  const addDays = dayjs().utc().hour() >= 23 ? 1 : 0;
  const challengeDate = dayjs().utc().add(addDays, 'day').startOf('day').toDate();

  // Pick Resource
  // ----------------------------------------------
  // Get all users
  const users = await dbRead.$queryRaw<{ userId: number }[]>`
      SELECT DISTINCT m."userId"
      FROM "CollectionItem" ci
      JOIN "Model" m ON m.id = ci."modelId"
      WHERE "collectionId" = ${config.collectionId}
      AND "status" = 'ACCEPTED'
    `;

  //Get Users on Cooldown ⚠️
  const cooldownUsers = await dbRead.$queryRaw<{ userId: number }[]>`
      SELECT DISTINCT
        cast(a.metadata->>'userId' as int) as "userId"
      FROM "CollectionItem" ci
      JOIN "Article" a ON a.id = ci."modelId"
      WHERE ci."collectionId" = ${config.collectionId}
      AND a."status" = 'Published'
      AND a."publishedAt" > now() - interval ${config.cooldownPeriod}
    `;

  // Remove users on cooldown
  const availableUsers = users.filter(
    (user) => !cooldownUsers.some((cu) => cu.userId === user.userId)
  );

  // Pick a user
  const randomUser = getRandom(availableUsers);

  // Get resources from that user
  const resourceIds = await dbRead.$queryRaw<{ id: number }[]>`
      SELECT ci."modelId" as id
      FROM "CollectionItem" ci
      JOIN "Model" m ON m.id = ci."modelId"
      WHERE "collectionId" = ${config.collectionId}
      AND "status" = 'ACCEPTED'
      AND m."userId" = ${randomUser.userId}
    `;

  // Pick a resource
  const randomResourceId = getRandom(resourceIds);

  // Get resource details
  const [resource] = await dbRead.$queryRaw<{ modelId: number; creator: string; title: string }[]>`
      SELECT
        m.id as "modelId",
        u."username" as creator,
        m.name as title
      FROM "Model" m
      JOIN "User" u ON u.id = m."userId"
      WHERE m.id = ${randomResourceId.id}
      LIMIT 1
    `;

  // Get cover of resource
  const image = await getCoverOfModel(resource.modelId);

  // Setup Collection
  // ----------------------------------------------
  // Generate title and description
  const collectionDetails = await generateCollectionDetails({ resource, image });

  // Create collection cover image
  const coverImageId = await duplicateImage(image.id);

  // Create collection
  const collection = await dbWrite.collection.create({
    data: {
      ...collectionDetails,
      imageId: coverImageId,
      userId: config.challengeRunnerUserId,
      read: CollectionReadConfiguration.Private,
      write: CollectionReadConfiguration.Private,
      mode: 'Contest',
      metadata: {
        modelId: resource.modelId,
        challengeDate,
        maxItemsPerUser: config.entryPrizeRequirement,
        endsAt: dayjs(challengeDate).add(1, 'day').toDate(),
      },
    },
    select: { id: true },
  });

  // Add Judged tag
  await dbWrite.$executeRaw`
    INSERT INTO "TagsOnCollection" ("collectionId", "tagId")
    VALUES (${collection.id}, ${config.judgedTagId});
  `;

  // Setup Article
  // ----------------------------------------------
  // Generate article
  const articleDetails = await generateArticle({ resource, image, collectionId: collection.id });

  // Create article
  const article = await dbWrite.article.create({
    data: {
      title: articleDetails.title,
      content: articleDetails.content,
      nsfw: false,
      nsfwLevel: 1,
      userId: config.challengeRunnerUserId,
      coverId: coverImageId,
      metadata: {
        modelId: resource.modelId,
        invitation: articleDetails.invitation,
        theme: articleDetails.theme,
        challengeDate,
        collectionId: collection.id,
        challengeType: 'world-morph',
        status: 'pending',
        userId: randomUser.userId,
      },
    },
    select: { id: true },
  });

  // Add to challenge collection
  await dbWrite.collectionItem.create({
    data: {
      collectionId: config.collectionId,
      articleId: article.id,
      addedById: config.challengeRunnerUserId,
      status: 'REVIEW',
    },
  });
});

export const processDailyChallengeEntries = createJob(
  'daily-challenge-process-entries',
  '55 * * * *',
  async () => {
    // Get current challenge
    const currentChallenge = await getCurrentChallenge();
    if (!currentChallenge) return;

    // Update pending entries
    // ----------------------------------------------
    // Set their status to 'REJECTED' if they are not safe or don't have a required resource
    await dbWrite.$executeRaw`
      WITH source AS (
        SELECT
        i.id,
        i."nsfwLevel" = 1 as "isSafe",
        EXISTS (SELECT 1 FROM "ImageResource" ir WHERE ir."modelVersionId" IN (${Prisma.join(
          currentChallenge.modelVersionIds
        )}) AND ir."imageId" = i.id) as "hasResource"
        FROM "CollectionItem" ci
        JOIN "Image" i ON i.id = ci."imageId"
        WHERE ci."collectionId" = ${config.collectionId}
        AND ci.status = 'REVIEW'
        AND i."nsfwLevel" != 0
      )
      UPDATE "CollectionItem" ci SET
        status = CASE
          WHEN "isSafe" AND "hasResource" THEN 'ACCEPTED'::"CollectionItemStatus"
          ELSE 'REJECTED'::"CollectionItemStatus"
        END,
        "reviewedAt" = now()
      FROM source s
      WHERE s.id = ci."imageId";
    `;

    // Rate new entries
    // ----------------------------------------------
    // Get last time reviewed
    const [article] = await dbRead.$queryRaw<{ reviewedAt: number }[]>`
      SELECT
        coalesce(cast(metadata->'reviewedAt' as int), 0) as "reviewedAt"
      FROM "Article"
      WHERE id = ${currentChallenge.articleId}
    `;
    const lastReviewedAt = new Date(article.reviewedAt);

    // Get entries approved since last reviewed
    const reviewing = Date.now();
    const recentEntries = await dbRead.$queryRaw<RecentEntry[]>`
      SELECT
        ci."imageId",
        i."userId",
        u."username",
        i."url"
      FROM "CollectionItem" ci
      JOIN "Image" i ON i.id = ci."imageId"
      JOIN "User" u ON u.id = i."userId"
      WHERE ci."collectionId" = ${config.collectionId}
      AND ci.status = 'ACCEPTED'
      AND ci."reviewedAt" >= ${lastReviewedAt}
    `;

    // Randomly select entries to review up to the limit
    let toReviewCount = getRandomInt(config.reviewAmount.min, config.reviewAmount.max);
    const shuffledEntries = shuffle(recentEntries);
    const toReview: typeof shuffledEntries = [];
    const reviewingUsers = new Set<number>();
    for (const entry of shuffledEntries) {
      if (toReviewCount <= 0) break;
      if (reviewingUsers.has(entry.userId)) continue;
      toReview.push(entry);
      toReviewCount--;
    }

    // Rate entries
    const tasks = toReview.map((entry) => async () => {
      const review = await generateReview({
        theme: currentChallenge.theme,
        creator: entry.username,
        imageUrl: getEdgeUrl(entry.url, { width: 1024 }),
      });

      // Send comment
      await upsertComment({
        userId: config.challengeRunnerUserId,
        entityType: 'image',
        entityId: entry.imageId,
        content: review.comment,
      });

      // Send reaction
      await toggleReaction({
        entityType: 'image',
        entityId: entry.imageId,
        reaction: review.reaction,
        userId: config.challengeRunnerUserId,
      });

      // Add tag and score note to collection item
      const note = JSON.stringify({
        score: review.score,
        summary: review.summary,
      });
      await dbWrite.$executeRaw`
        UPDATE "CollectionItem"
        SET "tagId" = ${config.judgedTagId}, note = ${note}
        WHERE
          "collectionId" = ${currentChallenge.collectionId}
          AND "imageId" = ${entry.imageId};
      `;
    });
    await limitConcurrency(tasks, 5);

    // Reward entry prizes
    // ----------------------------------------------
    // Get users that have recently added new entries
    const userIds = [...new Set(recentEntries.map((entry) => entry.userId))];
    const earnedPrizes = await dbRead.$queryRaw<{ userId: number; count: number }[]>`
      SELECT
      i."userId",
      COUNT(*) as count
      FROM "CollectionItem" ci
      JOIN "Image" i ON i.id = ci."imageId"
      WHERE
        ci."collectionId" = ${currentChallenge.collectionId}
        AND ci.status = 'ACCEPTED'
        AND i."userId" IN (${Prisma.join(userIds)})
      GROUP BY 1
      HAVING COUNT(*) >= ${config.entryPrizeRequirement};
    `;

    const dateStr = dayjs(currentChallenge.date).format('YYYY-MM-DD');
    await withRetries(() =>
      createBuzzTransactionMany(
        earnedPrizes.map(({ userId }) => ({
          type: TransactionType.Reward,
          toAccountId: userId,
          fromAccountId: 0, // central bank
          amount: config.entryPrize.buzz,
          description: `Challenge Entry Prize: ${dateStr}`,
          externalTransactionId: `challenge-entry-prize-${dateStr}-${userId}`,
          toAccountType: 'generation',
        }))
      )
    );

    // Update last review time
    // ----------------------------------------------
    await dbWrite.$executeRawUnsafe(`
      UPDATE "Article"
      SET metadata = metadata::jsonb || '{"reviewedAt": ${reviewing}}'
      WHERE id = ${currentChallenge.articleId};
    `);
  }
);

export const pickDailyChallengeWinners = createJob(
  'daily-challenge-pick-winners',
  '0 0 * * *',
  async () => {
    // Get current challenge
    const currentChallenge = await getCurrentChallenge();
    if (!currentChallenge) {
      await startNextChallenge();
      return;
    }

    // Close challenge
    // ----------------------------------------------
    await dbWrite.$executeRaw`
      UPDATE "Collection"
      SET write = 'Private'::"CollectionWriteConfiguration"
      WHERE id = ${currentChallenge.collectionId};
    `;

    // Pick Winners
    // ----------------------------------------------
    // Get all judged entries
    const judgedEntriesRaw = await dbRead.$queryRaw<JudgedEntry[]>`
      SELECT
        ci."imageId",
        i."userId",
        u."username",
        ci.note,
        (
          SELECT
          COALESCE(SUM("metricValue"), 0)
          FROM "EntityMetric"
          WHERE
            "entityType" = 'Image'
            AND "entityId" = ci."imageId"
            AND "metricType" != 'Buzz'
        ) as engagement
      FROM "CollectionItem" ci
      JOIN "Image" i ON i.id = ci."imageId"
      JOIN "User" u ON u.id = i."userId"
      JOIN "EntryMetric"
      WHERE ci."collectionId" = ${currentChallenge.collectionId}
      AND ci."tagId" = ${config.judgedTagId}
    `;
    if (!judgedEntriesRaw.length) {
      await startNextChallenge();
      return;
    }

    // Sort judged entries by (rating * 0.75) and (engagement * 0.25)
    const maxEngagement = Math.max(...judgedEntriesRaw.map((entry) => entry.engagement));
    const minEngagement = Math.min(...judgedEntriesRaw.map((entry) => entry.engagement));
    const judgedEntries = judgedEntriesRaw.map(({ note, engagement, ...entry }) => {
      const { score, summary } = JSON.parse(note);
      // Calculate average rating
      const rating = (score.theme + score.wittiness + score.humor + score.aesthetic) / 4;
      // Adjust engagement to be between 0 and 10
      const engagementNormalized =
        ((engagement - minEngagement) / (maxEngagement - minEngagement)) * 10;
      return {
        ...entry,
        summary,
        score,
        weightedRating: rating * 0.75 + engagementNormalized * 0.25,
      };
    });
    judgedEntries.sort((a, b) => b.weightedRating - a.weightedRating);

    // Take top 10 entries per user
    let toSend = config.finalReviewAmount;
    const toFinalJudgement: typeof judgedEntries = [];
    const finalJudgementUsers = new Set<number>();
    for (const entry of judgedEntries) {
      if (toSend <= 0) break;
      if (finalJudgementUsers.has(entry.userId)) continue;
      toFinalJudgement.push(entry);
      finalJudgementUsers.add(entry.userId);
      toSend--;
    }

    // Send to LLM for final judgement
    const { winners, process, outcome } = await generateWinners({
      theme: currentChallenge.theme,
      entries: toFinalJudgement.map((entry) => ({
        creator: entry.username,
        summary: entry.summary,
        score: entry.score,
      })),
    });

    // Map winners to entries
    const winningEntries = winners
      .map((winner) => {
        const entry = toFinalJudgement.find((e) => e.username === winner.creator);
        if (!entry) return null;
        return {
          ...entry,
          reason: winner.reason,
        };
      })
      .filter(isDefined);

    // TODO - Update Article with winners, process/outcome, and metadata
    await dbWrite.$executeRaw`
      UPDATE "Article"
      SET metadata = metadata::jsonb || '{"status": "complete"}'
      WHERE id = ${currentChallenge.articleId};
    `;

    // TODO - Send notifications to winners

    // Send prizes to winners
    // ----------------------------------------------
    const dateStr = dayjs(currentChallenge.date).format('YYYY-MM-DD');
    await withRetries(() =>
      createBuzzTransactionMany(
        winningEntries.map((entry, i) => ({
          type: TransactionType.Reward,
          toAccountId: entry.userId,
          fromAccountId: 0, // central bank
          amount: config.prizes[i].buzz,
          description: `Challenge Winner Prize ${i + 1}: ${dateStr}`,
          externalTransactionId: `challenge-winner-prize-${dateStr}-${i + 1}`,
          toAccountType: 'user',
        }))
      )
    );

    // Start next challenge
    // ----------------------------------------------
    await startNextChallenge();
  }
);

// Helper Functions
// ----------------------------------------------
const duplicateImageColumns = [
  'url',
  'createdAt',
  'updatedAt',
  'hash',
  'height',
  'width',
  'meta',
  'generationProcess',
  'hideMeta',
  'mimeType',
  'scanRequestedAt',
  'scannedAt',
  'sizeKB',
  'nsfw',
  'blockedFor',
  'ingestion',
  'metadata',
  'type',
  'scanJobs',
  'nsfwLevel',
  'nsfwLevelLocked',
  'aiNsfwLevel',
  'aiModel',
  'sortAt',
  'pHash',
];
async function duplicateImage(imageId: number) {
  const newImage = await dbWrite.$queryRawUnsafe<{ id: number }[]>(`
    INSERT INTO "Image" (${duplicateImageColumns.map((col) => `"${col}"`).join(', ')}, "userId")
    SELECT
      ${duplicateImageColumns.map((col) => `i."${col}"`).join(', ')},
      ${config.challengeRunnerUserId}
    FROM "Image" i
    WHERE i.id = ${imageId}
    RETURNING id;
  `);
  if (!newImage.length) throw new Error('Failed to duplicate image');

  return newImage[0].id;
}

async function getCoverOfModel(modelId: number) {
  const [image] = await dbRead.$queryRaw<{ id: number; url: string }[]>`
    SELECT
      i.id, i."url"
    FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE m.id = 577283
    AND p."userId" = m."userId"
    AND i."nsfwLevel" = 1
    ORDER BY mv.index, p.id, i.index
    LIMIT 1;
  `;
  if (!image) throw new Error('Failed to get cover image');
  image.url = getEdgeUrl(image.url, { width: 1024 });
  return image;
}

async function startNextChallenge() {
  const upcomingChallenge = await getUpcomingChallenge();
  if (!upcomingChallenge) return;

  // Open collection
  await dbWrite.$executeRaw`
    UPDATE "Collection"
    SET write = 'Review'::"CollectionWriteConfiguration",
        read = 'Public'::"CollectionReadConfiguration"
    WHERE id = ${upcomingChallenge.collectionId};
  `;

  // Publish article
  await dbWrite.$executeRaw`
    UPDATE "Article"
    SET
      status = 'Published',
      "publishedAt" = now(),
      metadata = metadata::jsonb || '{"status": "active"}'
    WHERE id = ${upcomingChallenge.articleId};
  `;

  // Accept Collection Item in Challenge Collection
  await dbWrite.$executeRaw`
    UPDATE "CollectionItem"
    SET status = 'ACCEPTED'
    WHERE "collectionId" = ${config.collectionId}
    AND "articleId" = ${upcomingChallenge.articleId};
  `;

  // Give cosmetic to resource owner
  await dbWrite.$executeRaw`
    INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "obtainedAt", "equippedAt", "forId", "forType", "equippedToId", "equippedToType")
    SELECT
      "userId",
      ${config.resourceCosmeticId},
      now(),
      now(),
      id,
      'Model',
      id,
      'Model'
    FROM "Model"
    WHERE id = ${upcomingChallenge.modelId};
  `;

  // Set as current challenge
  await setCurrentChallenge(upcomingChallenge.articleId);
}

// Types
// ----------------------------------------------
type ResourceDetails = {
  id: number;
  creator: string;
  title: string;
};

type RecentEntry = {
  imageId: number;
  userId: number;
  username: string;
  url: string;
};

type JudgedEntry = {
  imageId: number;
  userId: number;
  username: string;
  note: string;
  engagement: number;
};
