import { CollectionReadConfiguration, Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { preventReplicationLag } from '~/server/db/db-lag-helpers';
import { eventEngine } from '~/server/events';
import type { ChallengeConfig } from '~/server/games/daily-challenge/daily-challenge.utils';
import {
  endChallenge,
  getChallengeConfig,
  getChallengeDetails,
  getChallengeTypeConfig,
  getCurrentChallenge,
  getUpcomingChallenge,
  setCurrentChallenge,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import {
  generateArticle,
  generateCollectionDetails,
  generateReview,
  generateWinners,
} from '~/server/games/daily-challenge/generative-content';
import { logToAxiom } from '~/server/logging/client';
import { TransactionType } from '~/server/schema/buzz.schema';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { randomizeCollectionItems } from '~/server/services/collection.service';
import { upsertComment } from '~/server/services/commentsv2.service';
import { createNotification } from '~/server/services/notification.service';
import { toggleReaction } from '~/server/services/reaction.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { getRandom, shuffle } from '~/utils/array-helpers';
import { withRetries } from '~/utils/errorHandling';
import { createLogger } from '~/utils/logging';
import { markdownToHtml } from '~/utils/markdown-helpers';
import { asOrdinal, getRandomInt } from '~/utils/number-helpers';
import { isDefined } from '~/utils/type-guards';
import { createJob } from './job';

const log = createLogger('jobs:daily-challenge-processing', 'blue');

const dailyChallengeSetupJob = createJob(
  'daily-challenge-setup',
  '0 22 * * *',
  createUpcomingChallenge
);

const processDailyChallengeEntriesJob = createJob(
  'daily-challenge-process-entries',
  '*/10 * * * *',
  reviewEntries
);

const pickDailyChallengeWinnersJob = createJob(
  'daily-challenge-pick-winners',
  '0 0 * * *',
  pickWinners
);

export const dailyChallengeJobs = [
  dailyChallengeSetupJob,
  processDailyChallengeEntriesJob,
  pickDailyChallengeWinnersJob,
];

// Job Functions
// ----------------------------------------------
export async function createUpcomingChallenge() {
  // Stop if we already have an upcoming challenge
  const upcomingChallenge = await getUpcomingChallenge();
  if (upcomingChallenge) return upcomingChallenge;
  log('Setting up daily challenge');
  const config = await getChallengeConfig();
  const challengeTypeConfig = await getChallengeTypeConfig(config.challengeType);

  // Get date of the challenge (should be the next day if it's past 1pm UTC)
  const addDays = dayjs().utc().hour() >= 13 ? 1 : 0;
  const challengeDate = dayjs().utc().add(addDays, 'day').startOf('day').toDate();

  // Pick Resource
  // ----------------------------------------------
  // Get all users
  const users = await dbRead.$queryRaw<{ userId: number }[]>`
      SELECT DISTINCT m."userId"
      FROM "CollectionItem" ci
      JOIN "Model" m ON m.id = ci."modelId"
      WHERE "collectionId" = ${challengeTypeConfig.collectionId}
      AND ci."status" = 'ACCEPTED'
    `;

  // Get Users on cooldown
  const cooldownUsers = await dbRead.$queryRaw<{ userId: number }[]>`
      SELECT DISTINCT
        cast(a.metadata->'userId' as int) as "userId"
      FROM "CollectionItem" ci
      JOIN "Article" a ON a.id = ci."modelId"
      WHERE ci."collectionId" = ${config.challengeCollectionId}
      AND a."status" = 'Published'
      AND a."publishedAt" > now() - ${config.userCooldown}::interval
    `;

  // Remove users on cooldown
  const availableUsers = users.filter(
    (user) => !cooldownUsers.some((cu) => cu.userId === user.userId)
  );

  // Get resources on cooldown
  const cooldownResources = (
    await dbRead.$queryRaw<{ modelId: number }[]>`
      SELECT DISTINCT
        cast(metadata->'modelId' as int) as "modelId"
      FROM "CollectionItem" ci
      JOIN "Article" a ON a.id = ci."articleId"
      WHERE ci."collectionId" = ${config.challengeCollectionId}
      AND a."status" = 'Published'
      AND "publishedAt" > now() - ${config.resourceCooldown}::interval
    `
  ).map((x) => x.modelId);

  let resource: SelectedResource | undefined;
  let randomUser: { userId: number } | undefined;
  let attempts = 0;
  while (!resource) {
    attempts++;
    if (attempts > 100) throw new Error('Failed to find resource');

    // Pick a user
    randomUser = getRandom(availableUsers);

    // Get resources from that user
    const resourceIds = await dbRead.$queryRaw<{ id: number }[]>`
      SELECT DISTINCT(ci."modelId") as id
      FROM "CollectionItem" ci
      JOIN "Model" m ON m.id = ci."modelId"
      JOIN "GenerationCoverage" gc ON gc."modelId" = m.id
      WHERE "collectionId" = ${challengeTypeConfig.collectionId}
      AND ci."status" = 'ACCEPTED'
      AND m."userId" = ${randomUser.userId}
      AND m.status = 'Published'
      ${
        cooldownResources.length
          ? Prisma.sql`AND m.id NOT IN (${Prisma.join(cooldownResources)})`
          : Prisma.empty
      }
      AND m.mode IS NULL
      AND gc.covered IS TRUE
    `;
    if (!resourceIds.length) continue;

    // Pick a resource
    const randomResourceId = getRandom(resourceIds);

    // Get resource details
    [resource] = await dbRead.$queryRaw<SelectedResource[]>`
        SELECT
          m.id as "modelId",
          u."username" as creator,
          m.name as title
        FROM "Model" m
        JOIN "User" u ON u.id = m."userId"
        WHERE m.id = ${randomResourceId.id}
        LIMIT 1
      `;
  }
  if (!randomUser || !resource) throw new Error('Failed to pick resource');

  // Get cover of resource
  const image = await getCoverOfModel(resource.modelId);

  // Setup Collection
  // ----------------------------------------------
  // Generate title and description
  const collectionDetails = await generateCollectionDetails({
    resource,
    image,
    config: challengeTypeConfig,
  });

  // Create collection cover image
  const coverImageId = await duplicateImage(image.id, challengeTypeConfig.userId);

  // Create collection
  const collection = await dbWrite.collection.create({
    data: {
      ...collectionDetails,
      imageId: coverImageId,
      userId: challengeTypeConfig.userId,
      read: CollectionReadConfiguration.Private,
      write: CollectionReadConfiguration.Private,
      type: 'Image',
      mode: 'Contest',
      metadata: {
        modelId: resource.modelId,
        challengeDate,
        maxItemsPerUser: config.entryPrizeRequirement * 2,
        endsAt: dayjs(challengeDate).add(1, 'day').toDate(),
        disableTagRequired: true,
        disableFollowOnSubmission: true,
      },
    },
    select: { id: true },
  });

  // Add Judged tag
  await dbWrite.$executeRaw`
    INSERT INTO "TagsOnCollection" ("collectionId", "tagId", "filterableOnly")
    VALUES (${collection.id}, ${config.judgedTagId}, true);
  `;

  const prizeConfig = {
    prizes: config.prizes,
    entryPrize: config.entryPrize,
    entryPrizeRequirement: config.entryPrizeRequirement,
  };

  // Setup Article
  // ----------------------------------------------
  // Generate article
  const articleDetails = await generateArticle({
    resource,
    image,
    collectionId: collection.id,
    challengeDate,
    ...prizeConfig,
    config: challengeTypeConfig,
  });

  // Create article
  const article = await dbWrite.article.create({
    data: {
      title: articleDetails.title,
      content: articleDetails.content,
      nsfw: false,
      nsfwLevel: 1,
      userNsfwLevel: 1,
      userId: challengeTypeConfig.userId,
      coverId: coverImageId,
      metadata: {
        modelId: resource.modelId,
        invitation: articleDetails.invitation,
        theme: articleDetails.theme,
        challengeDate,
        collectionId: collection.id,
        challengeType: config.challengeType,
        status: 'pending',
        userId: randomUser.userId,
        ...prizeConfig,
      },
    },
    select: { id: true },
  });

  // Add relevant tag:
  await dbWrite.$executeRaw`
    INSERT INTO "TagsOnArticle" ("articleId", "tagId")
    VALUES (${article.id}, ${config.articleTagId});
  `;

  await preventReplicationLag('article', article.id);

  log('Article created:', article);

  // Add to challenge collection
  await dbWrite.collectionItem.create({
    data: {
      collectionId: config.challengeCollectionId,
      articleId: article.id,
      addedById: challengeTypeConfig.userId,
      status: 'REVIEW',
    },
  });
  log('Added to challenge collection');

  // Add link back to challenge from collection
  await dbWrite.$executeRawUnsafe(`
    UPDATE "Collection"
      SET description = COALESCE(description, ' [View Daily Challenge](/articles/${article.id})')
    WHERE id = ${collection.id};
  `);

  const challenge = await getChallengeDetails(article.id);
  if (!challenge) throw new Error('Failed to create challenge');
  return challenge;
}

async function reviewEntries() {
  try {
    // Get current challenge
    const currentChallenge = await getCurrentChallenge();
    console.log('currentChallenge', currentChallenge);
    if (!currentChallenge) return;
    log('Processing entries for challenge:', currentChallenge);
    const config = await getChallengeConfig();
    const challengeTypeConfig = await getChallengeTypeConfig(currentChallenge.type);

    // Update pending entries
    // ----------------------------------------------
    const reviewing = Date.now();
    // Set their status to 'REJECTED' if they are not safe or don't have a required resource
    const reviewedCount = await dbWrite.$executeRaw`
    WITH source AS (
      SELECT
      i.id,
      i."nsfwLevel" = 1 as "isSafe",
      EXISTS (SELECT 1 FROM "ImageResourceNew" ir WHERE ir."modelVersionId" IN (${Prisma.join(
        currentChallenge.modelVersionIds
      )}) AND ir."imageId" = i.id) as "hasResource"
      FROM "CollectionItem" ci
      JOIN "Image" i ON i.id = ci."imageId"
      WHERE ci."collectionId" = ${currentChallenge.collectionId}
      AND ci.status = 'REVIEW'
      AND i."nsfwLevel" != 0
    )
    UPDATE "CollectionItem" ci SET
      status = CASE
        WHEN "isSafe" AND "hasResource" THEN 'ACCEPTED'::"CollectionItemStatus"
        ELSE 'REJECTED'::"CollectionItemStatus"
      END,
      "reviewedAt" = now(),
      "reviewedById" = ${challengeTypeConfig.userId}
    FROM source s
    WHERE s.id = ci."imageId";
  `;
    log('Reviewed entries:', reviewedCount);

    // Notify users of rejection
    const rejectedUsers = await dbRead.$queryRaw<{ userId: number; count: number }[]>`
    SELECT
      i."userId",
      CAST(COUNT(*) as int) as count
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    WHERE ci."collectionId" = ${currentChallenge.collectionId}
    AND ci.status = 'REJECTED'
    GROUP BY 1;
  `;
    const processingDateStr = dayjs().utc().startOf('hour').format('HH');
    const notificationTasks = rejectedUsers.map(({ userId, count }) => async () => {
      await createNotification({
        type: 'challenge-rejection',
        category: NotificationCategory.System,
        key: `challenge-rejection:${currentChallenge.articleId}:${processingDateStr}:${userId}`,
        userId,
        details: {
          articleId: currentChallenge.articleId,
          collectionId: currentChallenge.collectionId,
          challengeName: currentChallenge.title,
          count,
        },
      });
    });
    await limitConcurrency(notificationTasks, 3);

    // Remove rejected entries from collection
    await dbWrite.$executeRaw`
    DELETE FROM "CollectionItem"
    WHERE "collectionId" = ${currentChallenge.collectionId}
    AND status = 'REJECTED';
  `;

    // Randomize entries to get them visible
    await randomizeCollectionItems(currentChallenge.collectionId);

    // TEMP: Remove judged tag from unjudged entries
    // Doing this because users can still manually add it
    await dbWrite.$executeRaw`
    UPDATE "CollectionItem"
      SET "tagId" = NULL
    WHERE "collectionId" = ${currentChallenge.collectionId}
    AND "tagId" = ${config.judgedTagId}
    AND note IS NULL;
  `;

    // Rate new entries
    // ----------------------------------------------
    // Get last time reviewed
    const [article] = await dbRead.$queryRaw<{ reviewedAt: number }[]>`
    SELECT
      coalesce(cast(metadata->'reviewedAt' as bigint), 0) as "reviewedAt"
    FROM "Article"
    WHERE id = ${currentChallenge.articleId}
  `;
    const lastReviewedAt = new Date(Number(article.reviewedAt));
    log('Last reviewed at:', lastReviewedAt);

    // Get entries approved since last reviewed
    const recentEntries = await dbWrite.$queryRaw<RecentEntry[]>`
    SELECT
      ci."imageId",
      i."userId",
      u."username",
      i."url"
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    JOIN "User" u ON u.id = i."userId"
    WHERE ci."collectionId" = ${currentChallenge.collectionId}
    AND ci.status = 'ACCEPTED'
    AND ci."tagId" IS NULL
    AND ci."reviewedAt" >= ${lastReviewedAt}
  `;
    log('Recent entries:', recentEntries.length);

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
    log('Entries to review:', toReview.length);

    // Get forced to review entries
    const requestReview = await dbWrite.$queryRaw<RecentEntry[]>`
    SELECT
      ci."imageId",
      i."userId",
      u."username",
      i."url"
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    JOIN "User" u ON u.id = i."userId"
    WHERE ci."collectionId" = ${currentChallenge.collectionId}
    AND ci.status = 'ACCEPTED'
    AND ci."tagId" = ${config.reviewMeTagId}
  `;
    log('Requested review:', requestReview.length);
    toReview.push(...requestReview);

    // Rate entries
    const tasks = toReview.map((entry) => async () => {
      try {
        log('Reviewing entry:', entry);
        const review = await generateReview({
          theme: currentChallenge.theme,
          creator: entry.username,
          imageUrl: getEdgeUrl(entry.url, { width: 1200, name: 'image' }),
          config: challengeTypeConfig,
        });
        log('Review prepared', entry.imageId, review);

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
        log('Tag and note added', entry.imageId);

        // Send comment
        await upsertComment({
          userId: challengeTypeConfig.userId,
          entityType: 'image',
          entityId: entry.imageId,
          content: review.comment,
        });
        log('Comment sent', entry.imageId);

        // Send reaction
        try {
          await toggleReaction({
            entityType: 'image',
            entityId: entry.imageId,
            reaction: review.reaction,
            userId: challengeTypeConfig.userId,
          });
          log('Reaction sent', entry.imageId);
        } catch (error) {
          log('Failed to send reaction', entry.imageId, review.reaction);
        }
      } catch (error) {
        const err = error as Error;
        logToAxiom({ type: 'daily-challenge-review-error', message: err.message });
        log('Failed to review entry', entry.imageId, error);
      }
    });
    await limitConcurrency(tasks, 5);

    // Reward entry prizes
    // ----------------------------------------------
    // Get users that have recently added new entries
    const userIds = [...new Set(recentEntries.map((entry) => entry.userId))];
    if (userIds.length > 0) {
      // Process event engagement for approved entries
      const eventEngagementTasks = userIds.map((userId) => async () => {
        eventEngine.processEngagement({
          entityType: 'challenge',
          entityId: currentChallenge.articleId,
          type: 'entered',
          userId,
        });
      });
      await limitConcurrency(eventEngagementTasks, 3);

      // Send prizes to users that have met the entry requirement
      const earnedPrizes = await dbWrite.$queryRaw<{ userId: number; count: number }[]>`
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
      HAVING COUNT(*) >= ${currentChallenge.entryPrizeRequirement};
    `;
      log('Earned prizes:', earnedPrizes.length);

      if (earnedPrizes.length > 0) {
        const dateStr = dayjs(currentChallenge.date).format('YYYY-MM-DD');
        await withRetries(() =>
          createBuzzTransactionMany(
            earnedPrizes.map(({ userId }) => ({
              type: TransactionType.Reward,
              toAccountId: userId,
              fromAccountId: 0, // central bank
              amount: currentChallenge.entryPrize.buzz,
              description: `Challenge Entry Prize: ${dateStr}`,
              externalTransactionId: `challenge-entry-prize-${dateStr}-${userId}`,
              toAccountType: 'generation',
            }))
          )
        );

        log('Prizes sent');

        // Notify them
        const notifyDate = dayjs(currentChallenge.date).format('HH-mm');
        await createNotification({
          type: 'challenge-participation',
          category: NotificationCategory.System,
          key: `challenge-participation:${currentChallenge.articleId}:${notifyDate}`,
          userIds: earnedPrizes.map((entry) => entry.userId),
          details: {
            articleId: currentChallenge.articleId,
            challengeName: currentChallenge.title,
            prize: currentChallenge.entryPrize.buzz,
          },
        });
        log('Users notified');
      }
    }

    // Update last review time
    // ----------------------------------------------
    await dbWrite.$executeRawUnsafe(`
    UPDATE "Article"
    SET metadata = metadata::jsonb || '{"reviewedAt": ${reviewing}}'
    WHERE id = ${currentChallenge.articleId};
  `);
    log('Last reviewed at updated');
  } catch (e) {
    const error = e as Error;
    logToAxiom({
      type: 'error',
      name: 'daily-challenge-process-entries',
      message: error.message,
    });
    throw e;
  }
}

async function pickWinners() {
  // Get current challenge
  const config = await getChallengeConfig();
  const currentChallenge = await getCurrentChallenge();
  if (!currentChallenge) {
    await startNextChallenge(config);
    return;
  }
  const challengeTypeConfig = await getChallengeTypeConfig(currentChallenge.type);

  log('Picking winners for challenge:', currentChallenge);

  // Close challenge
  // ----------------------------------------------
  await endChallenge(currentChallenge);
  log('Collection closed');

  // Pick Winners
  // ----------------------------------------------
  // Get top judged entries
  const judgedEntries = await getJudgedEntries(currentChallenge.collectionId, config);
  if (!judgedEntries.length) {
    await startNextChallenge(config);
    return;
  }

  // Send to LLM for final judgment
  log('Sending entries for final judgment');
  const { winners, process, outcome } = await generateWinners({
    theme: currentChallenge.theme,
    entries: judgedEntries.map((entry) => ({
      creator: entry.username,
      summary: entry.summary,
      score: entry.score,
    })),
    config: challengeTypeConfig,
  });

  // Map winners to entries
  const winningEntries = winners
    .map((winner, i) => {
      const entry = judgedEntries.find((e) => e.username === winner.creator);
      if (!entry) return null;
      return {
        ...entry,
        position: i + 1,
        prize: currentChallenge.prizes[i].buzz,
        reason: winner.reason,
      };
    })
    .filter(isDefined);
  const winnerUserIds = winningEntries.map((entry) => entry.userId);

  // Update Article with winners, process/outcome, and metadata
  const updateContent = await markdownToHtml(`## Challenge Complete!
${process}


## Winners
${winningEntries
  .map(
    (entry) => `### ${asOrdinal(entry.position)}. [${entry.username}](/user/${entry.username})
${entry.reason}

**[View Entry](/images/${entry.imageId})**
`
  )
  .join('\n')}

${outcome}

---`);

  await dbWrite.$executeRaw`
    UPDATE "Article"
    SET
      metadata = metadata::jsonb || '{"status": "complete", "winners": ${Prisma.raw(
        JSON.stringify(winnerUserIds)
      )} }',
      content = CONCAT(${updateContent}, content),
      title = CONCAT('Completed: ', title),
      "updatedAt" = now()
    WHERE id = ${currentChallenge.articleId};
  `;
  log('Article updated');

  // Send notifications to winners
  for (const entry of winningEntries) {
    await createNotification({
      type: 'challenge-winner',
      category: NotificationCategory.System,
      key: `challenge-winner:${currentChallenge.articleId}:${entry.position}`,
      userId: entry.userId,
      details: {
        articleId: currentChallenge.articleId,
        challengeName: currentChallenge.title,
        position: entry.position,
        prize: entry.prize,
      },
    });
  }
  log('Winners notified');

  // Send prizes to winners
  // ----------------------------------------------
  const dateStr = dayjs(currentChallenge.date).format('YYYY-MM-DD');
  await withRetries(() =>
    createBuzzTransactionMany(
      winningEntries.map((entry, i) => ({
        type: TransactionType.Reward,
        toAccountId: entry.userId,
        fromAccountId: 0, // central bank
        amount: currentChallenge.prizes[i].buzz,
        description: `Challenge Winner Prize ${i + 1}: ${dateStr}`,
        externalTransactionId: `challenge-winner-prize-${dateStr}-${i + 1}`,
        toAccountType: 'user',
      }))
    )
  );
  log('Prizes sent');

  // Start next challenge
  // ----------------------------------------------
  await startNextChallenge(config);
}

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
async function duplicateImage(imageId: number, userId: number) {
  const newImage = await dbWrite.$queryRawUnsafe<{ id: number }[]>(`
    INSERT INTO "Image" (${duplicateImageColumns.map((col) => `"${col}"`).join(', ')}, "userId")
    SELECT
      ${duplicateImageColumns.map((col) => `i."${col}"`).join(', ')},
      ${userId}
    FROM "Image" i
    WHERE i.id = ${imageId}
    RETURNING id;
  `);
  if (!newImage.length) throw new Error('Failed to duplicate image');

  return newImage[0].id;
}

export async function getCoverOfModel(modelId: number) {
  const [image] = await dbRead.$queryRaw<{ id: number; url: string }[]>`
    SELECT
      i.id, i."url"
    FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE m.id = ${modelId}
    AND p."userId" = m."userId"
    AND i."nsfwLevel" = 1
    ORDER BY mv.index, p.id, i.index
    LIMIT 1;
  `;
  if (!image) throw new Error('Failed to get cover image');
  image.url = getEdgeUrl(image.url, { width: 1200, name: 'cover' });
  return image;
}

export async function getJudgedEntries(collectionId: number, config: ChallengeConfig) {
  const judgedEntriesRaw = await dbRead.$queryRaw<JudgedEntry[]>`
    SELECT
      ci."imageId",
      i."userId",
      u."username",
      ci.note,
      (
        SELECT
        CAST(COALESCE(SUM("metricValue"), 0) as int)
        FROM "EntityMetric"
        WHERE
          "entityType" = 'Image'
          AND "entityId" = ci."imageId"
          AND "metricType" != 'Buzz'
      ) as engagement
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    JOIN "User" u ON u.id = i."userId"
    WHERE ci."collectionId" = ${collectionId}
    AND ci."tagId" = ${config.judgedTagId}
    AND ci.note IS NOT NULL -- Since people can apply judged tag atm...
    AND ci.status = 'ACCEPTED'
  `;
  log('Judged entries:', judgedEntriesRaw?.length);
  if (!judgedEntriesRaw.length) {
    return [];
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
  const toFinalJudgment: typeof judgedEntries = [];
  const finalJudgmentUsers = new Set<number>();
  for (const entry of judgedEntries) {
    if (toSend <= 0) break;
    if (finalJudgmentUsers.has(entry.userId)) continue;
    toFinalJudgment.push(entry);
    finalJudgmentUsers.add(entry.userId);
    toSend--;
  }

  return toFinalJudgment;
}

export async function startNextChallenge(config: ChallengeConfig) {
  let upcomingChallenge = await getUpcomingChallenge();
  if (!upcomingChallenge) {
    try {
      await createUpcomingChallenge();
      upcomingChallenge = await getUpcomingChallenge();
      if (!upcomingChallenge) throw new Error('Failed to create upcoming challenge');
    } catch (e) {
      const error = e as Error;
      logToAxiom({
        type: 'error',
        name: 'failed-to-create-upcoming-challenge',
        message: error.message,
      });
      return;
    }
  }
  log('Starting next challenge');

  // Open collection
  await dbWrite.$executeRaw`
    UPDATE "Collection"
    SET write = 'Review'::"CollectionWriteConfiguration",
        read = 'Public'::"CollectionReadConfiguration"
    WHERE id = ${upcomingChallenge.collectionId};
  `;
  log('Collection opened');

  // Publish article
  await dbWrite.$executeRaw`
    UPDATE "Article"
    SET
      status = 'Published',
      "publishedAt" = now(),
      metadata = metadata::jsonb || '{"status": "active"}',
      "updatedAt" = now()
    WHERE id = ${upcomingChallenge.articleId};
  `;
  log('Article published');

  // Accept Collection Item in Challenge Collection
  await dbWrite.$executeRaw`
    UPDATE "CollectionItem"
    SET status = 'ACCEPTED'
    WHERE "collectionId" = ${config.challengeCollectionId}
    AND "articleId" = ${upcomingChallenge.articleId};
  `;
  log('Collection item accepted');

  // Give cosmetic to resource owner
  if (config.resourceCosmeticId) {
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
    log('Cosmetic given');
  }

  // Notify to owner of the resource
  const model = await dbRead.model.findUnique({
    where: { id: upcomingChallenge.modelId },
    select: { userId: true, name: true },
  });
  if (model) {
    createNotification({
      type: 'challenge-resource',
      category: NotificationCategory.System,
      key: `challenge-resource:${upcomingChallenge.articleId}`,
      userId: model.userId,
      details: {
        articleId: upcomingChallenge.articleId,
        challengeName: upcomingChallenge.title,
        resourceName: model.name,
      },
    }).catch((error) => {
      logToAxiom({
        type: 'error',
        name: 'challenge-resource-notification',
        message: error.message,
      });
      log('Failed to notify resource owner', error);
    });
    log('Resource owner notified');
  }

  // Set as current challenge
  await setCurrentChallenge(upcomingChallenge.articleId);
}

// Types
// ----------------------------------------------
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

type SelectedResource = {
  modelId: number;
  creator: string;
  title: string;
};
