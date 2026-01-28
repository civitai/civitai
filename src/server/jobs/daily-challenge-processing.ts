import { CollectionReadConfiguration, Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import {
  createChallengeRecord,
  createChallengeWinner,
  getChallengeById,
  updateChallengeStatus,
} from '~/server/games/daily-challenge/challenge-helpers';
import { ChallengeSource, ChallengeStatus } from '~/shared/utils/prisma/enums';
import type {
  ChallengeConfig,
  DailyChallengeDetails,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import {
  challengeToLegacyFormat,
  endChallenge,
  getActiveChallenges,
  getChallengeConfig,
  getChallengesReadyToStart,
  getChallengeTypeConfig,
  getEndedActiveChallenges,
  getUpcomingSystemChallenge,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import {
  generateArticle,
  generateCollectionDetails,
  generateReview,
  generateWinners,
} from '~/server/games/daily-challenge/generative-content';
import { logToAxiom } from '~/server/logging/client';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { entityMetricRedis, EntityMetricsHelper } from '~/server/redis/entity-metric.redis';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { upsertComment } from '~/server/services/commentsv2.service';
import { createNotification } from '~/server/services/notification.service';
import { toggleReaction } from '~/server/services/reaction.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { getRandom, shuffle } from '~/utils/array-helpers';
import { withRetries } from '~/utils/errorHandling';
import { createLogger } from '~/utils/logging';
import { getRandomInt } from '~/utils/number-helpers';
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
  // Stop if we already have any upcoming system challenges (scheduled or active)
  // This allows user-created challenges to run without blocking system challenge creation
  const existingSystemChallenge = await getUpcomingSystemChallenge();
  if (existingSystemChallenge) {
    log('System challenge already exists, skipping creation');
    return existingSystemChallenge;
  }
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

  // Get Users on cooldown (from Challenge table)
  const cooldownUsers = await dbRead.$queryRaw<{ userId: number }[]>`
      SELECT DISTINCT
        cast(c.metadata->'resourceUserId' as int) as "userId"
      FROM "Challenge" c
      WHERE c."status" IN ('Scheduled', 'Active', 'Completed')
      AND c."startsAt" > now() - ${config.userCooldown}::interval
    `;

  // Remove users on cooldown
  const availableUsers = users.filter(
    (user) => !cooldownUsers.some((cu) => cu.userId === user.userId)
  );

  // Get resources on cooldown (from Challenge table via model versions)
  const cooldownResources = (
    await dbRead.$queryRaw<{ modelId: number }[]>`
      SELECT DISTINCT mv."modelId"
      FROM "Challenge" c
      JOIN unnest(c."modelVersionIds") AS mvid ON TRUE
      JOIN "ModelVersion" mv ON mv.id = mvid
      WHERE c."status" IN ('Scheduled', 'Active', 'Completed')
      AND c."startsAt" > now() - ${config.resourceCooldown}::interval
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

  // Get published model version IDs for this model
  const modelVersionIds = (
    await dbRead.$queryRaw<{ id: number }[]>`
      SELECT mv.id
      FROM "ModelVersion" mv
      WHERE mv."modelId" = ${resource.modelId}
      AND mv.status = 'Published'
      ORDER BY mv.index ASC
    `
  ).map((v) => v.id);

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

  // Generate challenge content (title, description, invitation, theme)
  const challengeContent = await generateArticle({
    resource,
    image,
    collectionId: collection.id,
    challengeDate,
    ...prizeConfig,
    config: challengeTypeConfig,
  });

  // Create Challenge record
  const endsAt = dayjs(challengeDate).add(1, 'day').toDate();
  const challengeId = await createChallengeRecord({
    startsAt: challengeDate,
    endsAt,
    visibleAt: challengeDate, // Visible when it starts
    title: challengeContent.title,
    description: challengeContent.content,
    theme: challengeContent.theme,
    invitation: challengeContent.invitation,
    coverImageId,
    nsfwLevel: 1,
    allowedNsfwLevel: 1, // PG only for auto-generated challenges
    modelVersionIds,
    collectionId: collection.id,
    maxEntriesPerUser: config.entryPrizeRequirement * 2,
    prizes: prizeConfig.prizes,
    entryPrize: prizeConfig.entryPrize,
    prizePool: prizeConfig.prizes.reduce((sum, p) => sum + p.buzz, 0),
    createdById: challengeTypeConfig.userId,
    source: ChallengeSource.System,
    status: ChallengeStatus.Scheduled,
    metadata: {
      challengeType: config.challengeType,
      resourceUserId: randomUser.userId,
    },
  });
  log('Challenge record created:', challengeId);

  // Add link back to challenge from collection
  await dbWrite.$executeRawUnsafe(`
    UPDATE "Collection"
      SET description = COALESCE(description, ' [View Daily Challenge](/challenges/${challengeId})')
    WHERE id = ${collection.id};
  `);

  const challenge = await getChallengeById(challengeId);
  if (!challenge) throw new Error('Failed to create challenge');
  return challengeToLegacyFormat(challenge);
}

export async function reviewEntries() {
  try {
    // Get ALL active challenges (supports multiple concurrent challenges)
    const activeChallenges = await getActiveChallenges();
    if (!activeChallenges.length) {
      log('No active challenges to process');
      return;
    }

    log(`Processing entries for ${activeChallenges.length} active challenge(s)`);

    // Process each challenge with error isolation
    for (const challenge of activeChallenges) {
      try {
        await reviewEntriesForChallenge(challenge);
      } catch (error) {
        // Log error but continue with other challenges
        const err = error as Error;
        logToAxiom({
          type: 'error',
          name: 'daily-challenge-process-entries',
          message: err.message,
          challengeId: challenge.challengeId,
          collectionId: challenge.collectionId,
        });
        log(`Failed to process challenge ${challenge.challengeId}:`, error);
      }
    }
  } catch (e) {
    const error = e as Error;
    logToAxiom({
      type: 'error',
      name: 'daily-challenge-process-entries-global',
      message: error.message,
    });
    throw e;
  }
}

/**
 * Process entries for a single challenge.
 * Extracted from reviewEntries() to support multi-challenge processing.
 */
async function reviewEntriesForChallenge(currentChallenge: DailyChallengeDetails) {
  log('Processing entries for challenge:', currentChallenge.challengeId);
  const config = await getChallengeConfig();
  const challengeTypeConfig = await getChallengeTypeConfig(currentChallenge.type);

  // Update pending entries
  // ----------------------------------------------
  const reviewing = Date.now();

  // Get the Challenge record to check allowedNsfwLevel (new system)
  // Fall back to PG-only (1) for old article-based challenges
  const [challengeRecord] = await dbRead.$queryRaw<[{ allowedNsfwLevel: number } | undefined]>`
    SELECT "allowedNsfwLevel"
    FROM "Challenge"
    WHERE "collectionId" = ${currentChallenge.collectionId}
    LIMIT 1
  `;
  const allowedNsfwLevel = challengeRecord?.allowedNsfwLevel ?? 1;

  // Set their status to 'REJECTED' if they are not safe, don't have a required resource, or are too old
  // NSFW check uses bitwise AND: (imageLevel & allowedLevels) > 0 means the image's level is allowed
  const reviewedCount = await dbWrite.$executeRaw`
  WITH source AS (
    SELECT
    i.id,
    (i."nsfwLevel" & ${allowedNsfwLevel}) > 0 as "isSafe",
    EXISTS (SELECT 1 FROM "ImageResourceNew" ir WHERE ir."modelVersionId" = ANY(${currentChallenge.modelVersionIds}) AND ir."imageId" = i.id) as "hasResource",
    i."createdAt" >= ${currentChallenge.date} as "isRecent"
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    WHERE ci."collectionId" = ${currentChallenge.collectionId}
    AND ci.status = 'REVIEW'
    AND i."nsfwLevel" != 0
  )
  UPDATE "CollectionItem" ci SET
    status = CASE
      WHEN "isSafe" AND "hasResource" AND "isRecent" THEN 'ACCEPTED'::"CollectionItemStatus"
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
  const notificationKeyId = currentChallenge.challengeId ?? currentChallenge.collectionId;
  const notificationTasks = rejectedUsers.map(({ userId, count }) => async () => {
    await createNotification({
      type: 'challenge-rejection',
      category: NotificationCategory.System,
      key: `challenge-rejection:${notificationKeyId}:${processingDateStr}:${userId}`,
      userId,
      details: {
        challengeId: currentChallenge.challengeId,
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

  // Entries are randomized using hash-based ordering with an hourly seed (no DB update needed)

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
  // Get last time reviewed from Challenge metadata or default to challenge start
  let lastReviewedAt = currentChallenge.date ?? new Date(0); // Default to challenge start
  if (currentChallenge.challengeId) {
    const [challengeRecord] = await dbRead.$queryRaw<{ reviewedAt: number | null }[]>`
      SELECT
        cast(metadata->>'reviewedAt' as bigint) as "reviewedAt"
      FROM "Challenge"
      WHERE id = ${currentChallenge.challengeId}
    `;
    if (challengeRecord?.reviewedAt) {
      lastReviewedAt = new Date(Number(challengeRecord.reviewedAt));
    }
  }
  log('Last reviewed at:', lastReviewedAt);

  // Get count of already-scored entries per user for this challenge (for per-user cap)
  const userScoredCounts = await dbWrite.$queryRaw<{ userId: number; count: bigint }[]>`
  SELECT i."userId", COUNT(*) as count
  FROM "CollectionItem" ci
  JOIN "Image" i ON i.id = ci."imageId"
  WHERE ci."collectionId" = ${currentChallenge.collectionId}
  AND ci."tagId" = ${config.judgedTagId}
  GROUP BY i."userId"
`;
  const scoredCountMap = new Map(userScoredCounts.map((r) => [r.userId, Number(r.count)]));
  log('Users with scored entries:', scoredCountMap.size);

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
    // Skip users who have already hit the per-user scored cap
    const userScored = scoredCountMap.get(entry.userId) ?? 0;
    if (userScored >= config.maxScoredPerUser) continue;
    toReview.push(entry);
    reviewingUsers.add(entry.userId);
    toReviewCount--;
  }
  log('Entries to review:', toReview.length);

  // Get forced to review entries (also respecting per-user cap)
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
  // Filter reviewMe entries to also respect per-user cap
  for (const entry of requestReview) {
    const userScored = scoredCountMap.get(entry.userId) ?? 0;
    if (userScored >= config.maxScoredPerUser) continue;
    if (reviewingUsers.has(entry.userId)) continue;
    toReview.push(entry);
    reviewingUsers.add(entry.userId);
  }

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
    if (currentChallenge.challengeId) {
      const eventEngagementTasks = userIds.map((userId) => async () => {
        eventEngine.processEngagement({
          entityType: 'challenge',
          entityId: currentChallenge.challengeId!,
          type: 'entered',
          userId,
        });
      });
      await limitConcurrency(eventEngagementTasks, 3);
    }

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
      await withRetries(() =>
        createBuzzTransactionMany(
          earnedPrizes.map(({ userId }) => ({
            type: TransactionType.Reward,
            toAccountId: userId,
            fromAccountId: 0, // central bank
            amount: currentChallenge.entryPrize.buzz,
            description: `Challenge Entry Prize: ${currentChallenge.title}`,
            externalTransactionId: `challenge-entry-prize-${currentChallenge.challengeId}-${userId}`,
            toAccountType: 'blue',
          }))
        )
      );

      log('Prizes sent');

      // Notify them
      const notifyDate = dayjs(currentChallenge.date).format('HH-mm');
      const participationKeyId = currentChallenge.challengeId ?? currentChallenge.collectionId;
      await createNotification({
        type: 'challenge-participation',
        category: NotificationCategory.System,
        key: `challenge-participation:${participationKeyId}:${notifyDate}`,
        userIds: earnedPrizes.map((entry) => entry.userId),
        details: {
          challengeId: currentChallenge.challengeId,
          challengeName: currentChallenge.title,
          prize: currentChallenge.entryPrize.buzz,
        },
      });
      log('Users notified');
    }
  }

  // Update last review time in Challenge metadata
  // ----------------------------------------------
  if (currentChallenge.challengeId) {
    await dbWrite.$executeRawUnsafe(`
      UPDATE "Challenge"
      SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"reviewedAt": ${reviewing}}'
      WHERE id = ${currentChallenge.challengeId};
    `);
  }
  log('Last reviewed at updated');
}

export async function pickWinners() {
  const config = await getChallengeConfig();

  // Step 1: Process ended challenges (pick winners)
  // ----------------------------------------------
  const endedChallenges = await getEndedActiveChallenges();
  log(`Found ${endedChallenges.length} ended challenge(s) to process`);

  for (const challenge of endedChallenges) {
    try {
      await pickWinnersForChallenge(challenge, config);
    } catch (error) {
      const err = error as Error;
      logToAxiom({
        type: 'error',
        name: 'daily-challenge-pick-winners',
        message: err.message,
        challengeId: challenge.challengeId,
        collectionId: challenge.collectionId,
      });
      log(`Failed to pick winners for challenge ${challenge.challengeId ?? 'unknown'}:`, error);
    }
  }

  // Step 2: Start scheduled challenges ready to begin
  // ----------------------------------------------
  const challengesToStart = await getChallengesReadyToStart();
  log(`Found ${challengesToStart.length} scheduled challenge(s) ready to start`);

  for (const challenge of challengesToStart) {
    try {
      await startScheduledChallenge(challenge, config);
    } catch (error) {
      const err = error as Error;
      logToAxiom({
        type: 'error',
        name: 'daily-challenge-start',
        message: err.message,
        challengeId: challenge.challengeId,
        collectionId: challenge.collectionId,
      });
      log(`Failed to start challenge ${challenge.challengeId ?? 'unknown'}:`, error);
    }
  }

  // Step 3: Ensure system challenge exists for next period
  const existingSystemChallenge = await getUpcomingSystemChallenge();
  if (!existingSystemChallenge) {
    log('No system challenges found, creating upcoming challenge');
    try {
      await createUpcomingChallenge();
    } catch (e) {
      const error = e as Error;
      logToAxiom({
        type: 'error',
        name: 'failed-to-create-upcoming-challenge',
        message: error.message,
      });
      log('Failed to create upcoming challenge:', error);
    }
  }
}

/**
 * Pick winners for a single challenge.
 * Extracted from pickWinners() to support multi-challenge processing.
 */
async function pickWinnersForChallenge(
  currentChallenge: DailyChallengeDetails,
  config: ChallengeConfig
) {
  const challengeTypeConfig = await getChallengeTypeConfig(currentChallenge.type);

  log('Picking winners for challenge:', currentChallenge.challengeId);

  // Close challenge
  // ----------------------------------------------
  await endChallenge(currentChallenge);
  log('Collection closed');

  // Pick Winners
  // ----------------------------------------------
  // Get top judged entries
  const judgedEntries = await getJudgedEntries(currentChallenge.collectionId, config);
  if (!judgedEntries.length) {
    log('No judged entries for challenge:', currentChallenge.challengeId);
    // Still need to mark the challenge as completed even with no entries
    const challengeRecord = await dbRead.$queryRaw<{ id: number }[]>`
      SELECT id FROM "Challenge"
      WHERE "collectionId" = ${currentChallenge.collectionId}
      AND status = ${ChallengeStatus.Active}::"ChallengeStatus"
      LIMIT 1
    `;
    if (challengeRecord[0]) {
      await updateChallengeStatus(challengeRecord[0].id, ChallengeStatus.Completed);
      log('Challenge marked as completed (no entries)');
    }
    return;
  }

  // Send to LLM for final judgment
  log('Sending entries for final judgment');
  const { winners, process, outcome } = await generateWinners({
    theme: currentChallenge.theme,
    entries: judgedEntries.map((entry) => ({
      creator: entry.username,
      creatorId: entry.userId,
      summary: entry.summary,
      score: entry.score,
    })),
    config: challengeTypeConfig,
  });

  // Map winners to entries
  const winningEntries = winners
    .map((winner, i) => {
      const entry = judgedEntries.find(
        (e) =>
          e.username.toLowerCase() === winner.creator.toLowerCase() || e.userId === winner.creatorId
      );
      if (!entry) return null;
      return {
        ...entry,
        position: i + 1,
        prize: currentChallenge.prizes[i].buzz,
        reason: winner.reason,
      };
    })
    .filter(isDefined);
  // Send notifications to winners
  const notificationKey = currentChallenge.challengeId ?? currentChallenge.collectionId;
  for (const entry of winningEntries) {
    await createNotification({
      type: 'challenge-winner',
      category: NotificationCategory.System,
      key: `challenge-winner:${notificationKey}:${entry.position}`,
      userId: entry.userId,
      details: {
        challengeId: currentChallenge.challengeId,
        challengeName: currentChallenge.title,
        position: entry.position,
        prize: entry.prize,
      },
    });
  }
  log('Winners notified');

  // Send prizes to winners
  // ----------------------------------------------
  await withRetries(() =>
    createBuzzTransactionMany(
      winningEntries.map((entry, i) => ({
        type: TransactionType.Reward,
        toAccountId: entry.userId,
        fromAccountId: 0, // central bank
        amount: currentChallenge.prizes[i].buzz,
        description: `Challenge Winner Prize #${entry.position}: ${currentChallenge.title}`,
        externalTransactionId: `challenge-winner-prize-${currentChallenge.challengeId}-${entry.userId}-place-${entry.position}`,
        toAccountType: 'yellow',
      }))
    )
  );
  log('Prizes sent');

  // Send entry participation prizes to all eligible users
  // ----------------------------------------------
  if (currentChallenge.entryPrize && currentChallenge.entryPrize.buzz > 0) {
    const earnedEntryPrizes = await dbRead.$queryRaw<{ userId: number }[]>`
      SELECT DISTINCT i."userId"
      FROM "CollectionItem" ci
      JOIN "Image" i ON i.id = ci."imageId"
      WHERE ci."collectionId" = ${currentChallenge.collectionId}
        AND ci.status = 'ACCEPTED'
      GROUP BY i."userId"
      HAVING COUNT(*) >= ${currentChallenge.entryPrizeRequirement}
    `;

    if (earnedEntryPrizes.length > 0) {
      const winnerUserIds = winningEntries.map((e) => e.userId);
      // Exclude winners from entry prizes (they get winner prizes instead)
      const entryPrizeUsers = earnedEntryPrizes.filter((e) => !winnerUserIds.includes(e.userId));

      if (entryPrizeUsers.length > 0) {
        await withRetries(() =>
          createBuzzTransactionMany(
            entryPrizeUsers.map(({ userId }) => ({
              type: TransactionType.Reward,
              toAccountId: userId,
              fromAccountId: 0, // central bank
              amount: currentChallenge.entryPrize.buzz,
              description: `Challenge Entry Prize: ${currentChallenge.title}`,
              externalTransactionId: `challenge-entry-prize-${currentChallenge.challengeId}-${userId}`,
              toAccountType: 'blue',
            }))
          )
        );
        log('Entry participation prizes sent:', entryPrizeUsers.length);

        // Notify entry prize recipients
        const participationKeyId = currentChallenge.challengeId ?? currentChallenge.collectionId;
        await createNotification({
          type: 'challenge-participation',
          category: NotificationCategory.System,
          key: `challenge-participation:${participationKeyId}:final`,
          userIds: entryPrizeUsers.map((e) => e.userId),
          details: {
            challengeId: currentChallenge.challengeId,
            challengeName: currentChallenge.title,
            prize: currentChallenge.entryPrize.buzz,
          },
        });
        log('Entry prize users notified');
      }
    }
  }

  // Create ChallengeWinner records (new system - dual write during transition)
  // Find the Challenge by collectionId
  const winnerChallengeRecords = await dbRead.$queryRaw<{ id: number; metadata: unknown }[]>`
    SELECT id, metadata FROM "Challenge"
    WHERE "collectionId" = ${currentChallenge.collectionId}
    AND status = ${ChallengeStatus.Active}::"ChallengeStatus"
    LIMIT 1
  `;
  const winnerChallengeRecord = winnerChallengeRecords[0];
  if (winnerChallengeRecord) {
    for (const entry of winningEntries) {
      await createChallengeWinner({
        challengeId: winnerChallengeRecord.id,
        userId: entry.userId,
        imageId: entry.imageId,
        place: entry.position,
        buzzAwarded: entry.prize,
        pointsAwarded: currentChallenge.prizes[entry.position - 1].points,
        reason: entry.reason,
      });
    }
    // Update Challenge status to Completed and store completion summary
    const existingMetadata =
      typeof winnerChallengeRecord.metadata === 'object' ? winnerChallengeRecord.metadata : {};
    await dbWrite.challenge.update({
      where: { id: winnerChallengeRecord.id },
      data: {
        metadata: {
          ...existingMetadata,
          completionSummary: {
            judgingProcess: process,
            outcome: outcome,
            completedAt: new Date().toISOString(),
          },
        },
        status: ChallengeStatus.Completed,
      },
    });
    log('ChallengeWinner records created and status updated to Completed');
  }
}

/**
 * Start a scheduled challenge that is ready to begin.
 * Adapted from startNextChallenge() to work with a specific challenge.
 */
async function startScheduledChallenge(challenge: DailyChallengeDetails, config: ChallengeConfig) {
  log('Starting scheduled challenge:', challenge.challengeId);

  // Open collection
  await dbWrite.$executeRaw`
    UPDATE "Collection"
    SET write = 'Review'::"CollectionWriteConfiguration",
        read = 'Public'::"CollectionReadConfiguration"
    WHERE id = ${challenge.collectionId};
  `;
  log('Collection opened');

  // Update Challenge status to Active
  if (challenge.challengeId) {
    await updateChallengeStatus(challenge.challengeId, ChallengeStatus.Active);
    log('Challenge status updated to Active:', challenge.challengeId);
  }

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
      WHERE id = ${challenge.modelId};
    `;
    log('Cosmetic given');
  }

  // Notify to owner of the resource (only if modelId exists)
  if (challenge.modelId > 0) {
    const model = await dbRead.model.findUnique({
      where: { id: challenge.modelId },
      select: { userId: true, name: true },
    });
    if (model) {
      const resourceKeyId = challenge.challengeId ?? challenge.collectionId;
      createNotification({
        type: 'challenge-resource',
        category: NotificationCategory.System,
        key: `challenge-resource:${resourceKeyId}`,
        userId: model.userId,
        details: {
          challengeId: challenge.challengeId,
          challengeName: challenge.title,
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
  }
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
  // Get each user's BEST entry only (by AI score), so users with many entries
  // don't have an advantage over users with fewer entries
  const userBestEntries = await dbRead.$queryRaw<Omit<JudgedEntry, 'engagement'>[]>`
    WITH ranked AS (
      SELECT
        ci."imageId",
        i."userId",
        u."username",
        ci.note,
        ROW_NUMBER() OVER (
          PARTITION BY i."userId"
          ORDER BY (
            (ci.note::json->'score'->>'theme')::float +
            (ci.note::json->'score'->>'wittiness')::float +
            (ci.note::json->'score'->>'humor')::float +
            (ci.note::json->'score'->>'aesthetic')::float
          ) DESC
        ) as rn
      FROM "CollectionItem" ci
      JOIN "Image" i ON i.id = ci."imageId"
      JOIN "User" u ON u.id = i."userId"
      WHERE ci."collectionId" = ${collectionId}
      AND ci."tagId" = ${config.judgedTagId}
      AND ci.note IS NOT NULL
      AND ci.status = 'ACCEPTED'
    )
    SELECT "imageId", "userId", username, note
    FROM ranked
    WHERE rn = 1
  `;
  log('Users with judged entries:', userBestEntries?.length);
  if (!userBestEntries.length) {
    return [];
  }

  // Fetch engagement metrics from Redis for best entries only
  const imageIds = userBestEntries.map((entry) => entry.imageId);
  const metricsMap = await entityMetricRedis.getBulkMetrics('Image', imageIds);

  // Calculate engagement (sum of all metrics except Buzz)
  const entriesWithEngagement = userBestEntries.map((entry) => {
    const metrics = metricsMap.get(entry.imageId);
    const engagement = metrics ? EntityMetricsHelper.getTotalEngagement(metrics) : 0;
    return { ...entry, engagement };
  });

  // Sort entries by (rating * 0.75) and (engagement * 0.25)
  const maxEngagement = Math.max(...entriesWithEngagement.map((entry) => entry.engagement));
  const minEngagement = Math.min(...entriesWithEngagement.map((entry) => entry.engagement));
  const judgedEntries = entriesWithEngagement.map(({ note, engagement, ...entry }) => {
    const { score, summary } = JSON.parse(note);
    // Calculate average rating
    const rating = (score.theme + score.wittiness + score.humor + score.aesthetic) / 4;
    // Adjust engagement to be between 0 and 10
    const engagementNormalized =
      ((engagement - minEngagement) / Math.max(maxEngagement - minEngagement, 1)) * 10;
    return {
      ...entry,
      summary,
      score,
      weightedRating: rating * 0.75 + engagementNormalized * 0.25,
    };
  });
  judgedEntries.sort((a, b) => b.weightedRating - a.weightedRating);

  // Take top entries for final judgment (already one per user from the query)
  return judgedEntries.slice(0, config.finalReviewAmount);
}

export async function startNextChallenge(config: ChallengeConfig) {
  // Step 1: Start all scheduled challenges that are ready
  const challengesToStart = await getChallengesReadyToStart();
  log(`Found ${challengesToStart.length} scheduled challenge(s) ready to start`);

  for (const challenge of challengesToStart) {
    try {
      await startScheduledChallenge(challenge, config);
    } catch (error) {
      const err = error as Error;
      logToAxiom({
        type: 'error',
        name: 'daily-challenge-start',
        message: err.message,
        challengeId: challenge.challengeId,
        collectionId: challenge.collectionId,
      });
      log(`Failed to start challenge ${challenge.challengeId ?? 'unknown'}:`, error);
    }
  }

  // Step 2: If no system challenges exist, create one for the next period
  const existingSystemChallenge = await getUpcomingSystemChallenge();
  if (!existingSystemChallenge) {
    log('No system challenges found, creating upcoming challenge');
    try {
      await createUpcomingChallenge();
    } catch (e) {
      const error = e as Error;
      logToAxiom({
        type: 'error',
        name: 'failed-to-create-upcoming-challenge',
        message: error.message,
      });
      log('Failed to create upcoming challenge:', error);
    }
  }
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
