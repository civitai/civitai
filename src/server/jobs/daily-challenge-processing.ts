import { CollectionReadConfiguration, Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import {
  challengeClaimStillHeld,
  claimChallengeForCompletion,
  completeChallengeIfClaimHeld,
  computeDynamicPool,
  distributePrizes,
  createChallengeRecord,
  createChallengeWinner,
  getChallengeById,
  getChallengeEntryCount,
  getExistingWinnersForRetry,
  incrementOperationSpent,
  resolveEventContext,
  setChallengeActive,
  type ChallengeDetails,
  type EventContext,
  type RecentEntry,
  type SelectedResource,
} from '~/server/games/daily-challenge/challenge-helpers';
import {
  distributeParticipationPrizes,
  promoteChallengeEntries,
} from '~/server/games/daily-challenge/challenge-rewards';
import { filterRecentWinners } from '~/server/games/daily-challenge/winner-cooldown';
import {
  buildJudgingEngineContext,
  resolveJudgingEngine,
} from '~/server/games/daily-challenge/challenge-engine-registry';
import {
  bestPerUserInRankOrder,
  recapField,
  type JudgedEntryRef,
} from '~/server/games/daily-challenge/challenge-judging-engine';
import {
  MAX_PLACEMENTS_PER_TICK,
  REVIEW_JOB_LOCK_SECONDS,
  REVIEW_TICK_BUDGET_MS,
} from '~/server/games/daily-challenge/challenge-ladder';
import {
  dedupeWinnersForPayout,
  reconcileWinnerToPersisted,
} from '~/server/games/daily-challenge/challenge-winner-reconcile';
import {
  ChallengeReviewCostType,
  ChallengeSource,
  ChallengeStatus,
  PrizeMode,
  PoolTrigger,
} from '~/shared/utils/prisma/enums';
import type {
  ChallengeConfig,
  DailyChallengeDetails,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import {
  challengeToLegacyFormat,
  deriveChallengeNsfwLevel,
  endChallenge,
  getActiveChallenges,
  getChallengeConfig,
  getJudgingConfig,
  getUpcomingSystemChallenge,
  type JudgingConfig,
} from '~/server/games/daily-challenge/daily-challenge.utils';
import {
  calculateWeightedCategoryScore,
  FIXED_JUDGING_CATEGORIES,
  normalizeJudgeScore,
} from '~/server/games/daily-challenge/daily-challenge-scoring';
import {
  getIsSafeBrowsingLevel,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import {
  estimateBuzzCost,
  generateArticle,
  generateCollectionDetails,
  generateReview,
  generateWinners,
} from '~/server/games/daily-challenge/generative-content';
import { logToAxiom } from '~/server/logging/client';
import {
  recordChallengeCompleted,
  recordChallengePrizePaidBuzz,
  recordChallengeWinnerDuplicatePick,
} from '~/server/prom/challenge.metrics';
import {
  challengeJudgingCategoriesSchema,
  parseChallengeMetadata,
  type ChallengeJudgingCategory,
} from '~/server/schema/challenge.schema';
import { TransactionType } from '~/shared/constants/buzz.constants';
import {
  createBuzzTransactionMany,
  getTransactionByExternalId,
} from '~/server/services/buzz.service';
import { upsertComment } from '~/server/services/commentsv2.service';
import { sendChallengeResultsNotification } from '~/server/services/challenge-engagement.service';
import { createNotification } from '~/server/services/notification.service';
import { toggleReaction } from '~/server/services/reaction.service';
import {
  refundUserChallengeFunds,
  buildWinnerPayoutTransactions,
  getChallengeBuzzType,
  reportPoolFundingShortfall,
} from '~/server/games/daily-challenge/challenge-funding';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import {
  CHALLENGE_ENTRY_HOUSE_CUT,
  CHALLENGE_JOB_BATCH_SIZE,
  CHALLENGE_JOB_CONCURRENCY,
} from '~/shared/constants/challenge.constants';
import { getRandom, shuffle } from '~/utils/array-helpers';
import { withRetries } from '~/utils/errorHandling';
import { createLogger } from '~/utils/logging';
import { getRandomInt } from '~/utils/number-helpers';
import { isDefined } from '~/utils/type-guards';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { createJob } from './job';

const log = createLogger('jobs:daily-challenge-processing', 'blue');

/**
 * Get judging config efficiently using cached default judge when possible.
 * Falls back to DB query if the judge differs from default or there's a prompt override.
 */
async function getJudgingConfigForChallenge(
  judgeId: number,
  cachedDefaultJudge: JudgingConfig | null,
  judgingPromptOverride?: string | null
): Promise<JudgingConfig> {
  // If this is the default judge and no prompt override, use cached config
  if (cachedDefaultJudge && judgeId === cachedDefaultJudge.judgeId && !judgingPromptOverride) {
    return cachedDefaultJudge;
  }
  // Otherwise fetch from DB (different judge or has prompt override)
  return getJudgingConfig(judgeId, judgingPromptOverride);
}

// Types for batch processing
// ----------------------------------------------
type ChallengeCreationContext = {
  config: ChallengeConfig;
  judgingConfig: JudgingConfig;
  sourceCollectionId: number;
  availableUsers: { userId: number }[];
  cooldownResourceIds: number[];
  prizeConfig: {
    prizes: ChallengeConfig['prizes'];
    entryPrize: ChallengeConfig['entryPrize'];
    entryPrizeRequirement: number;
  };
};

type PreSelectedChallenge = {
  targetDate: Date;
  challengeDate: Date;
  resource: SelectedResource;
  resourceUserId: number;
  modelVersionIds: number[];
  image: { id: number; url: string };
};

// Pre-compute shared context (runs 3 DB queries with Promise.all instead of 5 sequential)
// ----------------------------------------------
async function preComputeContext(): Promise<ChallengeCreationContext> {
  const config = await getChallengeConfig();
  if (!config.defaultJudge) throw new Error('defaultJudge not configured in Redis');
  const judgingConfig = config.defaultJudge;

  const sourceCollectionId = judgingConfig.sourceCollectionId ?? config.challengeCollectionId;
  if (!sourceCollectionId) throw new Error('No sourceCollectionId configured for judge');

  // Run all 3 DB queries in parallel
  const [users, cooldownUsers, cooldownResources] = await Promise.all([
    dbRead.$queryRaw<{ userId: number }[]>`
      SELECT DISTINCT m."userId"
      FROM "CollectionItem" ci
      JOIN "Model" m ON m.id = ci."modelId"
      WHERE "collectionId" = ${sourceCollectionId}
      AND ci."status" = 'ACCEPTED'
    `,
    dbRead.$queryRaw<{ userId: number }[]>`
      SELECT DISTINCT
        cast(c.metadata->'resourceUserId' as int) as "userId"
      FROM "Challenge" c
      WHERE c."status" IN ('Scheduled', 'Active', 'Completing', 'Completed')
      AND c."startsAt" > now() - ${config.userCooldown}::interval
    `,
    dbRead.$queryRaw<{ modelId: number }[]>`
      SELECT DISTINCT mv."modelId"
      FROM "Challenge" c
      JOIN unnest(c."modelVersionIds") AS mvid ON TRUE
      JOIN "ModelVersion" mv ON mv.id = mvid
      WHERE c."status" IN ('Scheduled', 'Active', 'Completing', 'Completed')
      AND c."startsAt" > now() - ${config.resourceCooldown}::interval
    `,
  ]);

  const cooldownUserIds = cooldownUsers.map((u) => u.userId).filter(isDefined);
  const availableUsers = users.filter((user) => !cooldownUserIds.includes(user.userId));
  if (!availableUsers.length) {
    throw new Error(
      `No available users found: ${users.length} total users, ${cooldownUserIds.length} on cooldown (source collection: ${sourceCollectionId})`
    );
  }

  const cooldownResourceIds = cooldownResources.map((x) => x.modelId);

  return {
    config,
    judgingConfig,
    sourceCollectionId,
    availableUsers,
    cooldownResourceIds,
    prizeConfig: {
      prizes: config.prizes,
      entryPrize: config.entryPrize,
      entryPrizeRequirement: config.entryPrizeRequirement,
    },
  };
}

// Select a resource for a specific date, respecting cooldowns + batch exclusions
// ----------------------------------------------
async function selectResourceForDate(
  ctx: ChallengeCreationContext,
  targetDate: Date,
  excludeModelIds: Set<number>
): Promise<PreSelectedChallenge> {
  const challengeDate = dayjs(targetDate).utc().startOf('day').toDate();
  const allExcludedModelIds = [...ctx.cooldownResourceIds, ...excludeModelIds];

  let resource: SelectedResource | undefined;
  let randomUser: { userId: number } | undefined;
  let attempts = 0;
  while (!resource) {
    attempts++;
    if (attempts > 100) {
      throw new Error(
        `Failed to find resource after 100 attempts for ${dayjs(targetDate).format(
          'YYYY-MM-DD'
        )} (${ctx.availableUsers.length} available users, ${
          allExcludedModelIds.length
        } excluded resources)`
      );
    }

    randomUser = getRandom(ctx.availableUsers);
    const resourceIds = await dbRead.$queryRaw<{ id: number }[]>`
      SELECT DISTINCT(ci."modelId") as id
      FROM "CollectionItem" ci
      JOIN "Model" m ON m.id = ci."modelId"
      JOIN "GenerationCoverage" gc ON gc."modelId" = m.id
      WHERE "collectionId" = ${ctx.sourceCollectionId}
      AND ci."status" = 'ACCEPTED'
      AND m."userId" = ${randomUser.userId}
      AND m.status = 'Published'
      ${
        allExcludedModelIds.length
          ? Prisma.sql`AND m.id NOT IN (${Prisma.join(allExcludedModelIds)})`
          : Prisma.empty
      }
      AND m.mode IS NULL
      AND gc.covered IS TRUE
    `;
    if (!resourceIds.length) continue;

    const randomResourceId = getRandom(resourceIds);
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

  // Get model versions and cover image in parallel
  const [modelVersionRows, image] = await Promise.all([
    dbRead.$queryRaw<{ id: number }[]>`
      SELECT mv.id
      FROM "ModelVersion" mv
      WHERE mv."modelId" = ${resource.modelId}
      AND mv.status = 'Published'
      ORDER BY mv.index ASC
    `,
    getCoverOfModel(resource.modelId),
  ]);

  return {
    targetDate,
    challengeDate,
    resource,
    resourceUserId: randomUser.userId,
    modelVersionIds: modelVersionRows.map((v) => v.id),
    image,
  };
}

// Create a challenge from pre-selected data (AI calls run in parallel)
// ----------------------------------------------
async function createChallengeFromSelection(
  selection: PreSelectedChallenge,
  ctx: ChallengeCreationContext
): Promise<number> {
  const { resource, image, challengeDate, modelVersionIds, resourceUserId } = selection;
  const { judgingConfig, config, prizeConfig } = ctx;
  const endsAt = dayjs(challengeDate).add(1, 'day').toDate();

  // Run both AI calls in parallel - they share inputs but outputs are independent
  log('Generating AI content in parallel for', dayjs(challengeDate).format('YYYY-MM-DD'));
  const [collectionDetails, challengeContent] = await Promise.all([
    generateCollectionDetails({ resource, image, config: judgingConfig }),
    generateArticle({
      resource,
      image,
      challengeDate: endsAt,
      allowedNsfwLevel: sfwBrowsingLevelsFlag,
      ...prizeConfig,
      config: judgingConfig,
    }),
  ]);
  log(
    'AI content generated:',
    `collection="${collectionDetails.name}"`,
    `title="${challengeContent.title}"`
  );

  // Create collection cover image
  const coverImageId = await duplicateImage(image.id, judgingConfig.userId);

  // Create collection
  const collection = await dbWrite.collection.create({
    data: {
      ...collectionDetails,
      imageId: coverImageId,
      userId: judgingConfig.userId,
      read: CollectionReadConfiguration.Private,
      write: CollectionReadConfiguration.Private,
      type: 'Image',
      mode: 'Contest',
      metadata: {
        modelId: resource.modelId,
        challengeDate,
        maxItemsPerUser: config.entryPrizeRequirement * 2,
        endsAt,
        autoTagId: config.challengeTagId,
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

  // Create Challenge record
  const challengeId = await createChallengeRecord({
    startsAt: challengeDate,
    endsAt,
    visibleAt: dayjs(challengeDate).subtract(3, 'day').toDate(),
    title: challengeContent.title,
    description: challengeContent.content,
    theme: challengeContent.theme,
    invitation: challengeContent.invitation,
    coverImageId,
    nsfwLevel: deriveChallengeNsfwLevel(sfwBrowsingLevelsFlag),
    allowedNsfwLevel: sfwBrowsingLevelsFlag,
    modelVersionIds,
    collectionId: collection.id,
    maxEntriesPerUser: config.entryPrizeRequirement * 2,
    prizes: prizeConfig.prizes,
    entryPrize: prizeConfig.entryPrize,
    prizePool: prizeConfig.prizes.reduce((sum, p) => sum + p.buzz, 0),
    createdById: judgingConfig.userId,
    source: ChallengeSource.System,
    status: ChallengeStatus.Scheduled,
    judgeId: config.defaultJudgeId,
    metadata: {
      challengeType: config.challengeType,
      resourceUserId,
      resourceModelId: resource.modelId,
      themeElements: challengeContent.themeElements,
    },
  });

  // Add link back to challenge from collection
  await dbWrite.$executeRawUnsafe(`
    UPDATE "Collection"
      SET description = COALESCE(description, ' [View Daily Challenge](/challenges/${challengeId})')
    WHERE id = ${collection.id};
  `);

  log(
    'Challenge created:',
    `id=${challengeId}`,
    `date=${dayjs(challengeDate).format('YYYY-MM-DD')}`,
    `title="${challengeContent.title}"`,
    `collectionId=${collection.id}`
  );

  return challengeId;
}

// Batch orchestrator: precompute → select sequentially → create in parallel
// ----------------------------------------------
export async function createChallengesBatch(targetDates: Date[]) {
  if (!targetDates.length) return { created: 0, failed: 0, skipped: 0 };

  log(`Batch creating challenges for ${targetDates.length} dates`);

  // Phase 1: Pre-compute shared context (once)
  const ctx = await preComputeContext();
  log(
    'Context loaded:',
    `${ctx.availableUsers.length} available users,`,
    `${ctx.cooldownResourceIds.length} resources on cooldown`
  );

  // Phase 2: Select resources sequentially (prevents duplicate model selection)
  const excludeModelIds = new Set<number>();
  const selections: PreSelectedChallenge[] = [];
  let skipped = 0;

  for (const targetDate of targetDates) {
    try {
      // Check if challenge already exists for this date
      const existingForDate = await dbRead.$queryRaw<{ id: number }[]>`
        SELECT id FROM "Challenge"
        WHERE DATE_TRUNC('day', "startsAt") = DATE_TRUNC('day', ${targetDate}::timestamp)
        AND status IN (${ChallengeStatus.Scheduled}::"ChallengeStatus", ${ChallengeStatus.Active}::"ChallengeStatus", ${ChallengeStatus.Completing}::"ChallengeStatus")
        LIMIT 1
      `;
      if (existingForDate.length > 0) {
        log(`Challenge already exists for ${dayjs(targetDate).format('YYYY-MM-DD')}, skipping`);
        skipped++;
        continue;
      }

      const selection = await selectResourceForDate(ctx, targetDate, excludeModelIds);
      excludeModelIds.add(selection.resource.modelId);
      selections.push(selection);
      log(
        `Selected resource for ${dayjs(targetDate).format('YYYY-MM-DD')}:`,
        `modelId=${selection.resource.modelId}`,
        `title="${selection.resource.title}"`
      );
    } catch (error) {
      const err = error as Error;
      log(
        `Failed to select resource for ${dayjs(targetDate).format('YYYY-MM-DD')}: ${err.message}`
      );
    }
  }

  if (!selections.length) {
    log('No selections made, nothing to create');
    return { created: 0, failed: targetDates.length - skipped, skipped };
  }

  // Phase 3: Create challenges in parallel (concurrency of 3 = up to 6 AI calls)
  let created = 0;
  let failed = 0;

  const tasks = selections.map((selection) => async () => {
    try {
      await createChallengeFromSelection(selection, ctx);
      created++;
    } catch (error) {
      failed++;
      const err = error as Error;
      log(
        `Failed to create challenge for ${dayjs(selection.targetDate).format('YYYY-MM-DD')}: ${
          err.message
        }`
      );
    }
  });
  await limitConcurrency(tasks, 3);

  log(`Batch complete: ${created} created, ${failed} failed, ${skipped} skipped`);
  return { created, failed, skipped };
}

const dailyChallengeSetupJob = createJob('daily-challenge-setup', '0 22 * * *', async () =>
  createUpcomingChallenge()
);

const processDailyChallengeEntriesJob = createJob(
  'daily-challenge-process-entries',
  '*/10 * * * *',
  reviewEntries,
  // Overrides createJob's 300s default, which this job had only inherited. Arrival placement is
  // serial, so a tick's work is bounded but not small; 300s could not hold a burst this job had
  // already been measured handling. Stays under the 600s cron so a tick cannot overlap itself.
  { lockExpiration: REVIEW_JOB_LOCK_SECONDS }
);

export const dailyChallengeJobs = [dailyChallengeSetupJob, processDailyChallengeEntriesJob];

// Job Functions
// ----------------------------------------------
export async function createUpcomingChallenge(targetDate?: Date) {
  // Check if challenge platform is enabled
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.CHALLENGE_PLATFORM_ENABLED))) {
    log('Challenge platform disabled, skipping job');
    return;
  }

  // Use provided targetDate or calculate from current time (legacy behavior)
  const challengeDate = targetDate
    ? dayjs(targetDate).utc().startOf('day').toDate()
    : dayjs()
        .utc()
        .add(dayjs().utc().hour() >= 13 ? 1 : 0, 'day')
        .startOf('day')
        .toDate();

  // If targetDate provided, check if challenge already exists for that specific date
  if (targetDate) {
    const existingForDate = await dbRead.$queryRaw<{ id: number }[]>`
      SELECT id FROM "Challenge"
      WHERE DATE_TRUNC('day', "startsAt") = DATE_TRUNC('day', ${targetDate}::timestamp)
      AND status IN (${ChallengeStatus.Scheduled}::"ChallengeStatus", ${ChallengeStatus.Active}::"ChallengeStatus", ${ChallengeStatus.Completing}::"ChallengeStatus")
      LIMIT 1
    `;
    if (existingForDate.length > 0) {
      log(`Challenge already exists for ${dayjs(targetDate).format('YYYY-MM-DD')}, skipping`);
      return undefined;
    }
  } else {
    // Original behavior: check for any upcoming system challenge
    const existingSystemChallenge = await getUpcomingSystemChallenge();
    if (existingSystemChallenge) {
      log('System challenge already exists, skipping creation');
      return existingSystemChallenge;
    }
  }

  log('Setting up daily challenge for', dayjs(challengeDate).format('YYYY-MM-DD'));

  // Use shared internals for single-challenge creation (gets parallel AI calls for free)
  const ctx = await preComputeContext();
  log('Using source collection:', ctx.sourceCollectionId);
  log('Total available users:', ctx.availableUsers.length);
  log('Resources on cooldown:', ctx.cooldownResourceIds.length);

  const selection = await selectResourceForDate(ctx, targetDate ?? challengeDate, new Set());
  log(
    'Selected resource:',
    `modelId=${selection.resource.modelId}`,
    `title="${selection.resource.title}"`,
    `creator="${selection.resource.creator}"`
  );
  log('Model version IDs:', selection.modelVersionIds.length);
  log('Cover image:', selection.image.id);

  const challengeId = await createChallengeFromSelection(selection, ctx);

  const challenge = await getChallengeById(challengeId);
  if (!challenge) throw new Error('Failed to create challenge');

  log('Challenge creation complete:', `id=${challengeId}`);

  return challengeToLegacyFormat(challenge);
}

// Indirection seam: reviewEntries() calls reviewEntriesForChallenge() through this object
// (rather than the bare function reference) so tests can substitute per-challenge processing
// via `vi.spyOn(challengeReviewInternals, 'reviewEntriesForChallenge')` without needing to mock
// every DB/LLM call the real implementation makes.
export const challengeReviewInternals = {
  reviewEntriesForChallenge,
};

export async function reviewEntries() {
  // Check if challenge platform is enabled
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.CHALLENGE_PLATFORM_ENABLED))) {
    log('Challenge platform disabled, skipping job');
    return;
  }

  try {
    // Get ALL active challenges (supports multiple concurrent challenges)
    const activeChallenges = await getActiveChallenges();
    if (!activeChallenges.length) {
      log('No active challenges to process');
      return;
    }

    log(`Processing entries for ${activeChallenges.length} active challenge(s)`);

    if (activeChallenges.length >= CHALLENGE_JOB_BATCH_SIZE) {
      logToAxiom({
        type: 'warning',
        name: 'daily-challenge-process-entries',
        message:
          'Active challenge count hit the batch ceiling; excess challenges roll to the next tick',
        count: activeChallenges.length,
      });
    }

    // Process challenges with bounded concurrency. Each task isolates its own error so one
    // failing challenge can't abort or block the rest of the batch.
    await limitConcurrency(
      activeChallenges.map((challenge) => async () => {
        try {
          await challengeReviewInternals.reviewEntriesForChallenge(challenge);
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
      }),
      CHALLENGE_JOB_CONCURRENCY
    );
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
  // Start of the tick's budget. Measured across the WHOLE function, not just the placement drain:
  // the job lock does not care which phase spent the time.
  const tickStartedAt = Date.now();
  const config = await getChallengeConfig();

  // Update pending entries
  // ----------------------------------------------
  const reviewing = Date.now();

  // Get the Challenge record to check allowedNsfwLevel and judgeId
  // Fall back to PG-only (1) and default judge for old article-based challenges
  const [challengeRecord] = await dbRead.$queryRaw<
    [
      | {
          allowedNsfwLevel: number;
          judgeId: number | null;
          judgingPrompt: string | null;
          prizeMode: PrizeMode;
          prizePool: number;
          basePrizePool: number;
          buzzPerAction: number;
          poolTrigger: PoolTrigger | null;
          maxPrizePool: number | null;
          prizeDistribution: number[] | null;
          metadata: unknown;
          source: ChallengeSource;
          judgingCategories: unknown;
          entryFee: number;
          judgingEngine: string | null;
        }
      | undefined
    ]
  >`
    SELECT "allowedNsfwLevel", "judgeId", "judgingPrompt",
           "prizeMode", "prizePool", "basePrizePool", "buzzPerAction", "poolTrigger", "maxPrizePool", "prizeDistribution",
           "metadata", "source", "judgingCategories", "entryFee", "judgingEngine"
    FROM "Challenge"
    WHERE id = ${currentChallenge.challengeId}
    LIMIT 1
  `;
  const allowedNsfwLevel = challengeRecord?.allowedNsfwLevel ?? 1;
  const challengeMetadata = parseChallengeMetadata(challengeRecord?.metadata);
  const themeElements = challengeMetadata.themeElements;
  // Parse defensively — a malformed value falls back to the fixed schema instead of failing the
  // review.
  const userJudgingCategories = challengeJudgingCategoriesSchema.safeParse(
    challengeRecord?.judgingCategories
  );
  const userCategories = userJudgingCategories.success ? userJudgingCategories.data : undefined;

  const judgingEngine = await resolveJudgingEngine(challengeRecord?.judgingEngine);
  const engineContext = buildJudgingEngineContext({
    challengeId: currentChallenge.challengeId,
    collectionId: currentChallenge.collectionId,
    theme: currentChallenge.theme,
    themeElements,
    categories: userCategories,
  });

  // Get judging config from ChallengeJudge (or cached default judge if not assigned)
  const judgeId = challengeRecord?.judgeId ?? config.defaultJudgeId;
  if (!judgeId) throw new Error('No judge assigned and no defaultJudgeId configured');
  // Use cached default judge if applicable, otherwise fetch from DB
  const judgingConfig = await getJudgingConfigForChallenge(
    judgeId,
    config.defaultJudge,
    challengeRecord?.judgingPrompt
  );

  // Set their status to 'REJECTED' if they are not safe, don't have a required resource, or are too old
  // NSFW check uses bitwise AND: (imageLevel & allowedLevels) > 0 means the image's level is allowed

  // Log diagnostic info for debugging model version validation issues
  log('Review parameters:', {
    challengeId: currentChallenge.challengeId,
    modelVersionIds: currentChallenge.modelVersionIds,
    modelVersionIdsLength: currentChallenge.modelVersionIds.length,
    allowedNsfwLevel,
    challengeDate: currentChallenge.date,
  });

  const reviewedCount = await promoteChallengeEntries({
    collectionId: currentChallenge.collectionId,
    allowedNsfwLevel,
    modelVersionIds: currentChallenge.modelVersionIds,
    challengeDate: currentChallenge.date,
    reviewerId: judgingConfig.userId,
  });
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
  const totalRejected = rejectedUsers.reduce((sum, r) => sum + r.count, 0);
  log('Rejected entries:', { users: rejectedUsers.length, items: totalRejected });

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

  // Refund buzz for rejected entries that paid for per-entry guaranteed review.
  // Flat-rate purchases are NOT refunded (you pay for all entries regardless of outcome).
  const challenge = await dbRead.challenge.findUnique({
    where: { id: currentChallenge.challengeId },
    select: { reviewCostType: true, reviewCost: true },
  });
  if (
    challenge &&
    challenge.reviewCostType === ChallengeReviewCostType.PerEntry &&
    challenge.reviewCost > 0
  ) {
    // Only refund per-entry purchases (notes starting with 'challenge-review-' but NOT 'challenge-review-flat-')
    const paidRejected = await dbRead.$queryRaw<
      { imageId: number; userId: number; note: string }[]
    >`
      SELECT ci."imageId", i."userId", ci.note
      FROM "CollectionItem" ci
      JOIN "Image" i ON i.id = ci."imageId"
      WHERE ci."collectionId" = ${currentChallenge.collectionId}
        AND ci.status = 'REJECTED'
        AND ci.note LIKE 'challenge-review-%'
        AND ci.note NOT LIKE 'challenge-review-flat-%'
    `;
    if (paidRejected.length > 0) {
      log('Refunding rejected paid entries:', paidRejected.length);
      await createBuzzTransactionMany(
        paidRejected.map((e) => ({
          fromAccountId: 0,
          toAccountId: e.userId,
          type: TransactionType.Refund,
          amount: challenge.reviewCost,
          description: `Challenge review refund: entry ${e.imageId}`,
          externalTransactionId: `challenge-review-refund-${currentChallenge.challengeId}-${e.imageId}`,
        }))
      );
    }
  }

  // Remove rejected entries from collection
  await dbWrite.$executeRaw`
    DELETE FROM "CollectionItem"
    WHERE "collectionId" = ${currentChallenge.collectionId}
    AND status = 'REJECTED';
  `;

  // Auto-tag entries from users who paid flat-rate review
  // Check for ACCEPTED entries without reviewMeTagId or judgedTagId, then verify
  // the user's flat-rate transaction exists via deterministic externalTransactionId
  if (challenge && challenge.reviewCostType === ChallengeReviewCostType.Flat) {
    const untaggedUsers = await dbRead.$queryRaw<{ userId: number }[]>`
      SELECT DISTINCT i."userId"
      FROM "CollectionItem" ci
      JOIN "Image" i ON i.id = ci."imageId"
      WHERE ci."collectionId" = ${currentChallenge.collectionId}
        AND ci.status = 'ACCEPTED'
        AND (ci."tagId" IS NULL OR ci."tagId" NOT IN (${config.reviewMeTagId}, ${config.judgedTagId}))
    `;

    if (untaggedUsers.length > 0) {
      const paidUserIds: number[] = [];
      await limitConcurrency(
        untaggedUsers.map(({ userId }) => async () => {
          const txId = `challenge-review-flat-${currentChallenge.challengeId}-${userId}`;
          const tx = await getTransactionByExternalId(txId);
          if (tx) paidUserIds.push(userId);
        }),
        5
      );

      if (paidUserIds.length > 0) {
        const tagged = await dbWrite.$executeRaw`
          UPDATE "CollectionItem" ci
          SET "tagId" = ${config.reviewMeTagId},
              "note" = 'challenge-review-flat-' || ${String(
                currentChallenge.challengeId
              )} || '-' || ci."imageId"
          FROM "Image" i
          WHERE i.id = ci."imageId"
            AND ci."collectionId" = ${currentChallenge.collectionId}
            AND ci.status = 'ACCEPTED'
            AND (ci."tagId" IS NULL OR ci."tagId" NOT IN (${config.reviewMeTagId}, ${
          config.judgedTagId
        }))
            AND i."userId" = ANY(ARRAY[${Prisma.join(paidUserIds)}])
        `;
        log('Auto-tagged flat-rate entries:', { users: paidUserIds.length, entries: tagged });
      }
    }
  }

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
    const [challengeReviewState] = await dbRead.$queryRaw<{ reviewedAt: number | null }[]>`
      SELECT
        cast(metadata->>'reviewedAt' as bigint) as "reviewedAt"
      FROM "Challenge"
      WHERE id = ${currentChallenge.challengeId}
    `;
    if (challengeReviewState?.reviewedAt) {
      lastReviewedAt = new Date(Number(challengeReviewState.reviewedAt));
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

  // Durable "already reviewed" gate: the judged tag lives in the mutable
  // CollectionItem.tagId, which resets when an entry is removed and re-added — letting
  // users re-roll their score. The judge's comment survives that collection churn.
  const notYetReviewedByJudge = Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "Thread" th
    JOIN "CommentV2" cm ON cm."threadId" = th.id
    WHERE th."imageId" = ci."imageId" AND cm."userId" = ${judgingConfig.userId}
  )`;

  // Get entries approved since last reviewed
  const recentEntries = await dbWrite.$queryRaw<RecentEntry[]>`
    SELECT
      ci."imageId",
      i."userId",
      u."username",
      i."url",
      i."nsfwLevel"
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    JOIN "User" u ON u.id = i."userId"
    WHERE ci."collectionId" = ${currentChallenge.collectionId}
    AND ci.status = 'ACCEPTED'
    AND ci."tagId" IS NULL
    AND ci."reviewedAt" >= ${lastReviewedAt}
    AND ${notYetReviewedByJudge}
  `;
  log('Recent entries:', recentEntries.length);

  // Paid user challenges judge EVERY new entry — participants paid a fee for a score, so the
  // random sampling and per-user cap (both sized for free dailies) must not leave a paying
  // entrant unjudged with no chance to win. Entry volume is bounded by maxEntriesPerUser and
  // the participant cap. Free challenges keep the sampled selection below.
  const judgeAllEntries =
    challengeRecord?.source === ChallengeSource.User && (challengeRecord?.entryFee ?? 0) > 0;

  let toReview: typeof recentEntries;
  if (judgeAllEntries) {
    toReview = [...recentEntries];
  } else {
    // Randomly select entries to review up to the limit
    let toReviewCount = getRandomInt(config.reviewAmount.min, config.reviewAmount.max);
    const shuffledEntries = shuffle(recentEntries);
    toReview = [];
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
  }
  log('Entries to review:', toReview.length, judgeAllEntries ? '(all — paid entries)' : '');

  // Get forced to review entries (also respecting per-user cap)
  const requestReview = await dbWrite.$queryRaw<RecentEntry[]>`
    SELECT
      ci."imageId",
      i."userId",
      u."username",
      i."url",
      i."nsfwLevel"
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    JOIN "User" u ON u.id = i."userId"
    WHERE ci."collectionId" = ${currentChallenge.collectionId}
    AND ci.status = 'ACCEPTED'
    AND ci."tagId" = ${config.reviewMeTagId}
    AND ${notYetReviewedByJudge}
  `;
  log('Requested review:', requestReview.length);
  // Paid review entries bypass per-user cap — users paid for guaranteed review
  for (const entry of requestReview) {
    toReview.push(entry);
  }

  // Entries that cleared the theme gate, waiting to be placed into the ladder. Collected during
  // the concurrent absolute pass and placed SERIALLY afterwards — see the note at the drain below.
  const awaitingPlacement: { order: number; entry: JudgedEntryRef }[] = [];

  // Rate entries
  const tasks = toReview.map((entry, submissionOrder) => async () => {
    try {
      log('Reviewing entry:', entry);

      // Defense-in-depth for the selection-time gate: an overlapping job run (lock
      // expires before the 10-min cron interval) could have selected this same entry.
      // Re-check on dbWrite right before spending an LLM call so concurrent runs can't
      // double-comment.
      const [alreadyReviewed] = await dbWrite.$queryRaw<[{ exists: boolean }?]>`
        SELECT EXISTS (
          SELECT 1 FROM "Thread" th
          JOIN "CommentV2" cm ON cm."threadId" = th.id
          WHERE th."imageId" = ${entry.imageId} AND cm."userId" = ${judgingConfig.userId}
        ) AS "exists"
      `;
      if (alreadyReviewed?.exists) {
        log('Skipping already-reviewed entry', entry.imageId);
        return;
      }

      const review = await generateReview({
        theme: currentChallenge.theme,
        themeElements,
        creator: entry.username,
        imageUrl: getEdgeUrl(entry.url, { width: 1200, name: 'image' }),
        config: judgingConfig,
        categories: userCategories?.map((c) => ({
          key: c.key,
          name: c.label,
          criteria: c.criteria,
        })),
        nsfw: !getIsSafeBrowsingLevel(allowedNsfwLevel),
      });
      log('Review prepared', entry.imageId, review);

      const reviewBuzzCost = Math.ceil(estimateBuzzCost(review.model, review.usage));
      if (reviewBuzzCost > 0) {
        await incrementOperationSpent(currentChallenge.challengeId, reviewBuzzCost);
      }

      const normalizedScore = normalizeJudgeScore(review.score);

      // Add tag and score note to collection item (include judgeId for tracking)
      const note = JSON.stringify({
        // Never persist a non-object score. `review.score` is whatever the model returned (the
        // response is cast, not parsed), and a safety-rejected entry comes back as null; stored
        // raw it reaches every ranking path and takes the whole challenge's winner-pick down.
        score: normalizedScore,
        summary: review.summary,
        judgeId: judgingConfig.judgeId,
        ...(review.aestheticFlaws?.length && { aestheticFlaws: review.aestheticFlaws }),
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
        userId: judgingConfig.userId,
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
          userId: judgingConfig.userId,
        });
        log('Reaction sent', entry.imageId);
      } catch (error) {
        log('Failed to send reaction', entry.imageId, review.reaction);
      }

      // Hand the entry to the challenge's judging engine. Disqualified entries are never placed:
      // the theme gate is an absolute judgement about one image and a comparison cannot express
      // it, so an entry the gate drops must not become a rung others are measured against.
      // A failure here costs this entry's placement and nothing else — the engine places
      // whatever it is missing when it ranks the field at close.
      const gatedScore = calculateWeightedCategoryScore(
        normalizedScore,
        userCategories?.length ? userCategories : FIXED_JUDGING_CATEGORIES
      );
      if (gatedScore !== null) {
        awaitingPlacement.push({
          order: submissionOrder,
          entry: {
            imageId: entry.imageId,
            userId: entry.userId,
            username: entry.username,
            url: entry.url,
            nsfwLevel: entry.nsfwLevel,
          },
        });
      }
    } catch (error) {
      const err = error as Error;
      logToAxiom({ type: 'daily-challenge-review-error', message: err.message });
      log('Failed to review entry', entry.imageId, error);
    }
  });
  await limitConcurrency(tasks, 5);

  // 🔴 Ladder placement is SERIAL, even though the absolute pass above is not.
  //
  // `recordEntry` is read-modify-write — getStandings, findSlot, insertStanding — with nothing
  // serialising it. Run inside the concurrent tasks, up to 5 entries binary-search the SAME
  // standings snapshot, so every one of them measures itself against whatever was there before the
  // tick and none of them ever meets another. Measured on a live 6-entry challenge: every single
  // arrival bout was against the first entry placed, 0/1/1/1/1/1 comparisons where serial placement
  // costs ~11 across different incumbents. Six entries hanging off one pivot is not a measurement.
  //
  // It is invisible from the outside — the standings look complete and `comparisons` faithfully
  // records the small number — and at small field sizes the close-time rerun repairs it, which is
  // why the live test passed. On a 284-entry field it will not: the rerun is bounded at
  // RERUN_TOP_K and the rest keep whatever the burst gave them.
  //
  // The absolute pass stays concurrent: it is independent per entry and it is where the latency is.
  // Placement is ordered by submission so a run is reproducible rather than depending on which LLM
  // call happened to return first. Same per-entry error boundary as before — a throw costs this
  // entry's rung and nothing else, and `rankField` places whatever was missed.
  //
  // 🔴 Serialising it is what makes the drain BOUNDED WORK, so the tick has to bound it.
  // Placement cost grows with the ladder — ceil(log2(n+1)) serial bouts — so a burst against a
  // mature ladder is the expensive case, not a big burst against an empty one. The job lock is
  // `REVIEW_JOB_LOCK_SECONDS` (540s) against a 600s cron, and `REVIEW_TICK_BUDGET_MS` is per
  // CHALLENGE, measured from that challenge's own start — so the lock covers one challenge's
  // budget, not the job's. `reviewEntries` fans out at `CHALLENGE_JOB_CONCURRENCY`, so a batch
  // larger than that runs in waves and only the first wave is inside the lock; a later wave still
  // going at 600s gets a concurrent sibling — the shared-snapshot race again, from the other
  // direction.
  //
  // The budget is checked BETWEEN placements, never inside one: a placement is atomic, so the
  // overshoot is one placement rather than unbounded. At least one always runs, so a challenge
  // whose absolute pass already ate the budget still makes progress instead of starving.
  //
  // Deferred entries are NOT lost and NOT retried next tick — the absolute pass has already tagged
  // them judged, so the recent-entries query will not offer them again. They are placed by
  // `rankField` at close, on exactly the path that already covers a placement that threw. That is
  // correct but not free: enough deferrals and the engine's `arrivalUsable` guard flips and the
  // close-time rerun runs unbounded. The log below is how that becomes visible before it bites.
  awaitingPlacement.sort((a, b) => a.order - b.order);
  const placementDeadline = tickStartedAt + REVIEW_TICK_BUDGET_MS;
  let placed = 0;
  for (const { entry } of awaitingPlacement) {
    if (placed > 0 && (Date.now() >= placementDeadline || placed >= MAX_PLACEMENTS_PER_TICK)) break;
    try {
      await judgingEngine.recordEntry(engineContext, entry);
      placed++;
      log('Engine recorded entry', judgingEngine.key, entry.imageId);
    } catch (error) {
      placed++;
      const err = error as Error;
      logToAxiom({
        type: 'error',
        name: 'challenge-engine-record-entry',
        message: err.message,
        challengeId: currentChallenge.challengeId,
        imageId: entry.imageId,
        engine: judgingEngine.key,
      });
    }
  }

  const deferred = awaitingPlacement.length - placed;
  if (deferred > 0) {
    logToAxiom({
      type: 'warning',
      name: 'challenge-arrival-placement-deferred',
      message:
        'Arrival placement hit the per-tick bound; the rest are placed by the close-time rerun',
      challengeId: currentChallenge.challengeId,
      engine: judgingEngine.key,
      placed,
      deferred,
      elapsedMs: Date.now() - tickStartedAt,
      // Which bound stopped it. `count` on a shallow ladder, `budget` on a deep one — they call for
      // different responses, and the difference is invisible from the totals alone.
      bound: placed >= MAX_PLACEMENTS_PER_TICK ? 'count' : 'budget',
      budgetMs: REVIEW_TICK_BUDGET_MS,
      lockSeconds: REVIEW_JOB_LOCK_SECONDS,
    }).catch(() => undefined);
    log('Deferred arrival placements', { placed, deferred });
  }

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

  // Dynamic prize pool recomputation
  // ----------------------------------------------
  if (
    challengeRecord?.prizeMode === PrizeMode.Dynamic &&
    challengeRecord.poolTrigger &&
    challengeRecord.prizeDistribution
  ) {
    if (challengeRecord.source === ChallengeSource.User) {
      // Entry-fee challenges: the pool is the REAL collected total already accumulated in
      // Challenge.prizePool (seeded to basePrizePool, grown by chargeEntryFees only for entries
      // that actually paid). NEVER derive it from the ACCEPTED entry count — accepted entries can
      // be unpaid (mod-curated images, entry-fee rollback survivors), which would inflate the pool
      // into minted payout from account 0. Only recompute the per-place breakdown from that total.
      const totalPool = challengeRecord.prizePool;
      const dynamicPrizes = distributePrizes(totalPool, challengeRecord.prizeDistribution);

      await dbWrite.challenge.update({
        where: { id: currentChallenge.challengeId },
        data: { prizes: dynamicPrizes as unknown as Prisma.InputJsonValue },
      });

      log('Dynamic prizes recomputed from real collected pool (user challenge):', {
        totalPool,
        prizes: dynamicPrizes,
      });
    } else {
      const [stats] = await dbRead.$queryRaw<[{ entryCount: bigint; uniqueUsers: bigint }]>`
        SELECT
          COUNT(*) as "entryCount",
          COUNT(DISTINCT i."userId") as "uniqueUsers"
        FROM "CollectionItem" ci
        JOIN "Image" i ON i.id = ci."imageId"
        WHERE ci."collectionId" = ${currentChallenge.collectionId}
          AND ci.status = 'ACCEPTED'
      `;

      const actionCount =
        challengeRecord.poolTrigger === PoolTrigger.Entry
          ? Number(stats.entryCount)
          : Number(stats.uniqueUsers);

      const { totalPool, prizes: dynamicPrizes } = computeDynamicPool({
        basePrizePool: challengeRecord.basePrizePool,
        buzzPerAction: challengeRecord.buzzPerAction,
        actionCount,
        maxPrizePool: challengeRecord.maxPrizePool,
        prizeDistribution: challengeRecord.prizeDistribution,
      });

      await dbWrite.challenge.update({
        where: { id: currentChallenge.challengeId },
        data: {
          prizePool: totalPool,
          prizes: dynamicPrizes as unknown as Prisma.InputJsonValue,
        },
      });

      log('Dynamic prize pool updated:', { totalPool, prizes: dynamicPrizes });
    }
  }

  // Let the engine do this tick's share of the ranking
  // ----------------------------------------------
  // Engines that rank incrementally do their work here rather than at close. The deadline is the
  // tick budget the arrival loop above already respects, so a slow provider costs this tick's
  // progress and nothing else — the next tick catches up, because the engine paces against the
  // challenge clock rather than against how much it managed last time.
  if (judgingEngine.advance) {
    try {
      const advanceStartedAt = Date.now();
      const calls = await judgingEngine.advance(
        engineContext,
        tickStartedAt + REVIEW_TICK_BUDGET_MS
      );
      if (calls > 0) log('Engine advanced', judgingEngine.key, calls, 'calls');
      // Emitted on EVERY tick, including zero-call ones. A tick that did no work is the signal that
      // pacing is not keeping up with arrivals, and that is invisible if only non-zero ticks report.
      // ~144 ticks per challenge per day — nothing to query against, and exactly the series worth
      // having while this is being rolled out.
      logToAxiom({
        type: 'info',
        name: 'challenge-engine-advance',
        challengeId: currentChallenge.challengeId,
        engine: judgingEngine.key,
        calls,
        elapsedMs: Date.now() - advanceStartedAt,
        // Wall-clock left when it stopped. Near zero means the DEADLINE bound this tick; a large
        // remainder means the clock pacing did. They call for different responses, and the totals
        // alone cannot tell them apart.
        remainingBudgetMs: tickStartedAt + REVIEW_TICK_BUDGET_MS - Date.now(),
      });
    } catch (error) {
      // A failed advance costs this tick's comparisons. It must not take the review tick with it:
      // the absolute pass, the entry notes and the reviewedAt stamp below are all still correct.
      logToAxiom({
        type: 'error',
        name: 'challenge-engine-advance',
        message: (error as Error).message,
        challengeId: currentChallenge.challengeId,
        engine: judgingEngine.key,
      });
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

/**
 * Emit the `challenge-llm-spend` cost-observability metric when a challenge reaches a terminal
 * (Completed) state. `houseCutCollected` approximates the house cut collected from paid entries
 * as `entryCount * CHALLENGE_ENTRY_HOUSE_CUT` — 0 for challenges that don't charge an entry fee.
 * Best-effort: this runs after the challenge's terminal state is already committed, so a failure
 * here is logged rather than thrown.
 */
async function logChallengeSpendMetric(challenge: ChallengeDetails) {
  try {
    const entryCount = await getChallengeEntryCount(challenge.collectionId);
    const houseCutCollected =
      challenge.source === ChallengeSource.User && challenge.entryFee > 0
        ? entryCount * CHALLENGE_ENTRY_HOUSE_CUT
        : 0;
    logToAxiom({
      name: 'challenge-llm-spend',
      challengeId: challenge.id,
      source: challenge.source,
      operationSpent: challenge.operationSpent,
      houseCutCollected,
    });
  } catch (error) {
    const err = error as Error;
    log('Failed to log challenge-llm-spend metric', challenge.id, err.message);
  }
}

/**
 * A run that has lost its completion claim stops here rather than judging, paying and writing an
 * outcome alongside the run that took over. Best-effort telemetry; never throws.
 */
function logClaimLost(challengeId: number | null, stage: string) {
  log('Completion claim lost, abandoning run:', { challengeId, stage });
  logToAxiom({
    type: 'warning',
    name: 'challenge-completion-claim-lost',
    message: 'Completion claim was revoked and re-taken while this run was still executing',
    challengeId,
    stage,
  }).catch(() => undefined);
}

/**
 * Pick winners for a single challenge.
 *
 * Operation order (race-condition safe):
 * 1. Atomic claim (Active → Completing)
 * 2. Close collection + get judging config
 * 3. LLM judgment + map winners (skipped on retry if winners already exist)
 * 4. Create ChallengeWinner records
 * 5. Distribute winner buzz prizes
 * 6. Distribute entry participation prizes
 * 7. Set challenge status to Completed
 * 8. Send notifications (non-critical, last)
 */
export async function pickWinnersForChallenge(
  currentChallenge: DailyChallengeDetails,
  config: ChallengeConfig
) {
  log('Picking winners for challenge:', currentChallenge.challengeId);

  // 1. Atomic claim — prevent duplicate processing. `claimedAt` is the stamp written to
  // metadata.completingClaimedAt; a later read showing a different stamp means this run's claim was
  // revoked (resetStuckCompletingChallenges) and re-taken, and this run must stop.
  const claimedAt = await claimChallengeForCompletion(currentChallenge.challengeId);
  if (!claimedAt) {
    log('Challenge already claimed for completion, skipping:', currentChallenge.challengeId);
    return;
  }
  log('Challenge claimed for completion');

  try {
    const winnerBuzzType = await getChallengeBuzzType(currentChallenge.challengeId);

    // Check if winners already exist from a previous (failed) run.
    // If so, skip LLM generation entirely to avoid non-deterministic re-picks.
    const existingWinners = await getExistingWinnersForRetry(currentChallenge.challengeId);

    let winningEntries: Array<{
      userId: number;
      imageId: number | null;
      position: number;
      prize: number;
      reason: string | null;
    }>;
    let process: string | undefined;
    let outcome: string | undefined;

    if (existingWinners.length > 0) {
      log('Reusing existing winners from previous run (retry-safe):', existingWinners.length);
      winningEntries = existingWinners.map((w) => ({
        userId: w.userId,
        imageId: w.imageId,
        position: w.place,
        prize: w.buzzAwarded,
        reason: w.reason,
      }));

      // Still close the collection if not already closed
      await endChallenge(currentChallenge);
    } else {
      // 2. Get judging config and event context from Challenge
      const [challengeJudgeRow] = await dbRead.$queryRaw<
        [
          | {
              judgeId: number | null;
              judgingPrompt: string | null;
              eventId: number | null;
              source: ChallengeSource;
              judgingCategories: unknown;
              judgingEngine: string | null;
              metadata: Record<string, unknown> | null;
            }
          | undefined
        ]
      >`
        SELECT "judgeId", "judgingPrompt", "eventId", "source", "judgingCategories", "judgingEngine", "metadata" FROM "Challenge"
        WHERE id = ${currentChallenge.challengeId}
        LIMIT 1
      `;
      const judgeId = challengeJudgeRow?.judgeId ?? config.defaultJudgeId;
      if (!judgeId) throw new Error('No judge assigned and no defaultJudgeId configured');
      const judgingConfig = await getJudgingConfigForChallenge(
        judgeId,
        config.defaultJudge,
        challengeJudgeRow?.judgingPrompt
      );

      const eventContext = await resolveEventContext(challengeJudgeRow?.eventId ?? null);

      // Rank by stored judgingCategories when present (any source); otherwise the fixed
      // theme/wittiness/humor/aesthetic rubric. Parse defensively — a malformed value falls back
      // to the fixed schema.
      const userJudgingCategories = challengeJudgingCategoriesSchema.safeParse(
        challengeJudgeRow?.judgingCategories
      );
      const userCategories = userJudgingCategories.success ? userJudgingCategories.data : undefined;

      // Close challenge collection
      await endChallenge(currentChallenge);
      log('Collection closed');

      // Entry fees charged since the last 10-min review recompute grew prizePool but not the
      // stored per-place breakdown — with the collection now closed the pool is final, so
      // recompute the breakdown before winners are mapped/paid. Skipping this would underpay
      // winners and strand the last window's fees in account 0 (and the residual alert below
      // compares against the same stale breakdown, so it would never fire).
      if (challengeJudgeRow?.source === ChallengeSource.User) {
        const fresh = await dbWrite.challenge.findUnique({
          where: { id: currentChallenge.challengeId },
          select: { prizePool: true, prizeDistribution: true },
        });
        const distribution = Array.isArray(fresh?.prizeDistribution)
          ? (fresh.prizeDistribution as number[])
          : null;
        if (fresh && distribution?.length) {
          const finalPrizes = distributePrizes(fresh.prizePool, distribution);
          await dbWrite.challenge.update({
            where: { id: currentChallenge.challengeId },
            data: { prizes: finalPrizes as unknown as Prisma.InputJsonValue },
          });
          currentChallenge.prizes = finalPrizes;
          log('Final prize breakdown recomputed from collected pool:', {
            prizePool: fresh.prizePool,
            prizes: finalPrizes,
          });
        }

        await reportPoolFundingShortfall({
          challengeId: currentChallenge.challengeId,
          collectionId: currentChallenge.collectionId,
        });
      }

      // 3. Get judged entries + LLM judgment
      const judgingEngine = await resolveJudgingEngine(challengeJudgeRow?.judgingEngine);
      const judgedEntries = await getJudgedEntries(
        currentChallenge.collectionId,
        config,
        eventContext,
        challengeJudgeRow?.source ?? ChallengeSource.System,
        userCategories,
        judgingEngine.ranksFullField
          ? { limit: Infinity, perUserBest: !judgingEngine.dedupesAfterRanking }
          : undefined
      );
      if (!judgedEntries.length) {
        log('No judged entries for challenge:', currentChallenge.challengeId);
        // Zero-winner completion of a paid user challenge strands its entry fees + initial prize in
        // account 0 (no payout runs below). Reverse the actual charges (mint-safe + idempotent —
        // keyed off real charges) BEFORE marking Completed. No-op for daily/mod/system.
        if (challengeJudgeRow?.source === ChallengeSource.User) {
          await refundUserChallengeFunds(currentChallenge.challengeId);
          log('Refunded user challenge funds (no winners)');
        }
        const completed = await completeChallengeIfClaimHeld({
          challengeId: currentChallenge.challengeId,
          claimedAt,
        });
        if (!completed) {
          logClaimLost(currentChallenge.challengeId, 'zero-entries-completion');
          return;
        }
        log('Challenge marked as completed (no entries)');
        // Emit AFTER the Completed write: the write is what makes this run the one that completed
        // the challenge, so a run whose write was rejected must not count a completion.
        recordChallengeCompleted({ source: challengeJudgeRow?.source });
        const freshChallenge = await getChallengeById(currentChallenge.challengeId);
        if (freshChallenge) await logChallengeSpendMetric(freshChallenge);
        return;
      }

      // Everything from here on spends (judging calls) and writes an outcome (winner rows, payouts,
      // status). Judging a production-sized field can outlast the 10-minute claim revocation, so
      // re-check ownership at the last point where stopping costs nothing — a run that has already
      // been replaced would otherwise pick a second, different podium.
      if (!(await challengeClaimStillHeld(currentChallenge.challengeId, claimedAt))) {
        logClaimLost(currentChallenge.challengeId, 'pre-judging');
        return;
      }

      // Degenerate participation: asking an LLM to pick "exactly 3" winners among fewer than 2
      // distinct entrants is semantically broken (and a wasted judging call) — skip
      // generateWinners and award place 1 deterministically instead. judgedEntries.length is
      // already guaranteed >= 1 here (see the empty-entries return above), so "< 2 distinct"
      // can only mean exactly one distinct entrant.
      // The engine orders the eligible field. Legacy returns it untouched — and was handed the
      // same top-N cut it always was — so a challenge on the legacy engine reaches the winner pick
      // with exactly the list it always did.
      const engineContext = buildJudgingEngineContext({
        challengeId: currentChallenge.challengeId,
        collectionId: currentChallenge.collectionId,
        theme: currentChallenge.theme,
        themeElements: parseChallengeMetadata(challengeJudgeRow?.metadata).themeElements,
        categories: userCategories,
      });
      const ranked = await judgingEngine.rankField(engineContext, judgedEntries);
      // One entry per user, chosen by the RANKING rather than by the absolute score that the
      // ranking exists to replace. Applied after rankField so the engine's coverage assertion still
      // compares against the field it was given. A no-op for legacy, which was handed one entry per
      // user in the first place.
      const rankedField = judgingEngine.dedupesAfterRanking
        ? bestPerUserInRankOrder(ranked)
        : ranked;
      // Cut to finalReviewAmount AFTER ranking, not before: the engine ranks the whole field, and
      // only then is it meaningful to say which entries are the top N. Legacy was already handed
      // the cut, so this slice is a no-op for it. The full ranking still goes to `selectWinners`,
      // which draws its own shortlist and would otherwise be capped below its own podium size.
      const rankedEntries = rankedField.slice(0, config.finalReviewAmount);

      const distinctEntrantIds = new Set(rankedEntries.map((entry) => entry.userId));

      if (distinctEntrantIds.size < 2) {
        const [soleEntry] = rankedEntries;
        log('Fewer than 2 distinct entrants — awarding place 1 deterministically (no LLM):', {
          challengeId: currentChallenge.challengeId,
          userId: soleEntry.userId,
        });

        const prize = currentChallenge.prizes[0]?.buzz ?? 0;
        const soleWinnerReason = 'Sole eligible entrant';
        winningEntries = [
          {
            userId: soleEntry.userId,
            imageId: soleEntry.imageId,
            position: 1,
            prize,
            reason: soleWinnerReason,
          },
        ];
        process = 'Deterministic award: fewer than 2 distinct entrants';
        outcome = 'Sole entrant awarded place 1 without LLM judging';

        const solePersisted = await createChallengeWinner({
          challengeId: currentChallenge.challengeId,
          userId: soleEntry.userId,
          imageId: soleEntry.imageId,
          place: 1,
          buzzAwarded: prize,
          pointsAwarded: currentChallenge.prizes[0]?.points ?? 0,
          reason: soleWinnerReason,
        });
        // Pay the placement that is PERSISTED, not the one just picked — see the reconcile note on
        // the LLM path below.
        winningEntries = winningEntries.map((entry) =>
          reconcileWinnerToPersisted(entry, solePersisted)
        );
        log('ChallengeWinner record created (deterministic sole-entrant award)');
      } else {
        // An engine that ranks the field also picks the places from it; `generateWinners` is still
        // called for the recap it writes, and its own picks are discarded in that case.
        const engineWinners = await judgingEngine.selectWinners(
          engineContext,
          rankedField,
          currentChallenge.prizes.length
        );

        log('Sending entries for final judgment');
        // The recap must cover the podium shortlist, not just the top N: an entry ranked
        // 11-15 winning the round-robin is the stated reason the podium exists, and a recap
        // that never saw it would describe a challenge somebody else won.
        const recapEntries = recapField(rankedField, config.finalReviewAmount, judgingEngine);
        // The podium draws from that same shortlist, so this union is empty today. It is here so
        // that an engine returning a winner from outside it produces a recap that still has that
        // entry's summary to write from, instead of prose about a creator it knows nothing about.
        const recapPool = [
          ...recapEntries,
          ...rankedField.filter(
            (entry) =>
              engineWinners?.some((winner) => winner.userId === entry.userId) &&
              !recapEntries.includes(entry)
          ),
        ];
        const generated = await generateWinners({
          theme: currentChallenge.theme,
          entries: recapPool.map((entry) => ({
            creator: entry.username,
            creatorId: entry.userId,
            summary: entry.summary,
            score: entry.score,
          })),
          // Hand the engine's places to the recap writer so the prose and the podium describe the
          // same people. Without this the model picked its own three from the shortlist and the
          // published recap congratulated entrants who had not placed.
          decidedWinners: engineWinners?.map((winner, i) => ({
            creatorId: winner.userId,
            creator:
              rankedField.find((entry) => entry.userId === winner.userId)?.username ?? 'unknown',
            place: i + 1,
            reason: winner.reason,
          })),
          config: judgingConfig,
        });
        process = generated.process;
        outcome = generated.outcome;

        const winnersBuzzCost = Math.ceil(estimateBuzzCost(generated.model, generated.usage));
        if (winnersBuzzCost > 0) {
          await incrementOperationSpent(currentChallenge.challengeId, winnersBuzzCost);
        }

        // Map winners to entries by numeric creatorId only. `winner.creator` is the LLM's echo of
        // the (user-controlled, spoofable) display name — matching on it let a second entrant who
        // set their name equal to another entrant's name hijack `find`'s first-match semantics and
        // steal that entrant's payout. judgedEntries is already deduped to one entry per userId
        // (see getJudgedEntries), so creatorId alone fully disambiguates.
        winningEntries = engineWinners
          ? engineWinners.map((winner, i) => ({
              userId: winner.userId,
              imageId: winner.imageId,
              position: i + 1,
              prize: currentChallenge.prizes[i]?.buzz ?? 0,
              reason: winner.reason,
            }))
          : generated.winners
              .map((winner, i) => {
                const entry = rankedEntries.find((e) => e.userId === winner.creatorId);
                if (!entry) return null;
                return {
                  userId: entry.userId,
                  imageId: entry.imageId,
                  position: i + 1,
                  prize: currentChallenge.prizes[i]?.buzz ?? 0,
                  reason: winner.reason,
                };
              })
              .filter(isDefined);

        // Nothing above stops the LLM naming the same creator in two slots — "exactly 3 different
        // winners" is prompt text, and `find()` happily matches the same entry twice — which would
        // put one creator on two places. That creator has at most one `ChallengeWinner` row to be
        // paid for, so the extra placement is a duplicate, not a second prize. Dropped HERE, before
        // the create loop, rather than at the payout: it keeps the duplicate from conflicting
        // against the row its own twin just inserted, which would otherwise fire the
        // place-divergence warning and counter for an anomaly that is not a re-pick at all.
        const { winners: dedupedWinners, dropped: droppedWinners } =
          dedupeWinnersForPayout(winningEntries);
        if (droppedWinners.length) {
          winningEntries = dedupedWinners;
          await logToAxiom({
            type: 'warning',
            name: 'challenge-winner-duplicate-pick',
            message: `Winner pick named the same creator in more than one place; the extra placements were dropped before payout: challenge=${currentChallenge.challengeId}`,
            challengeId: currentChallenge.challengeId,
            droppedUserIds: droppedWinners.map((entry) => entry.userId),
            droppedPlaces: droppedWinners.map((entry) => entry.position),
          }).catch(() => undefined);
          recordChallengeWinnerDuplicatePick({
            // Defaulted the same way the judging call at ~:1365 defaults it: the judge row is typed
            // `| undefined`, and letting it fall through to `unknown` would put a caller-side emit
            // in a bucket that is meant to mean something else.
            source: challengeJudgeRow?.source ?? ChallengeSource.System,
            count: droppedWinners.length,
            origin: 'caller',
          });
        }

        // 4. Create ChallengeWinner records, then pay the placement that is PERSISTED rather than
        // the one just picked. A user already recorded as a winner of this challenge cannot get a
        // second row — (challengeId, userId) is unique, so the insert conflicts and the stored row
        // keeps its original place. Paying the freshly-picked place would key the payout to a
        // different externalTransactionId than the one already settled at the stored place and mint
        // a second prize (this is the observed duplicate-payout mechanism, and re-picks tend to be
        // permutations of the same users because the winner cooldown only excludes Completed
        // challenges, leaving this challenge's own in-flight winners eligible).
        const reconciledEntries: typeof winningEntries = [];
        for (const entry of winningEntries) {
          const persisted = await createChallengeWinner({
            challengeId: currentChallenge.challengeId,
            userId: entry.userId,
            imageId: entry.imageId!, // always non-null on fresh winner path
            place: entry.position,
            buzzAwarded: entry.prize,
            pointsAwarded: currentChallenge.prizes[entry.position - 1]?.points ?? 0,
            reason: entry.reason ?? undefined,
          });
          reconciledEntries.push(reconcileWinnerToPersisted(entry, persisted));
        }
        winningEntries = reconciledEntries;
        log('ChallengeWinner records created');
      }
    }

    // 5. Distribute winner buzz prizes. Pay `entry.prize` (keyed to the entry's PLACE and equal
    // to the recorded ChallengeWinner.buzzAwarded) — indexing prizes[] by array position would
    // overpay when an unmatched LLM winner was filtered out above (place-2 entry at index 0
    // would get place-1 buzz), and on the retry path the array order isn't tied to place at all.
    // Built OUTSIDE the retry closure. The output is deterministic so a rebuild would not move
    // money, but the builder increments the duplicate-pick counter on its drop branch, and
    // `withRetries` re-invokes up to 4 times — which would record 4x the placements actually
    // dropped on exactly the flaky-payout run where the number matters most.
    const winnerPayoutTransactions = buildWinnerPayoutTransactions({
      challengeId: currentChallenge.challengeId,
      title: currentChallenge.title,
      buzzType: winnerBuzzType,
      winners: winningEntries,
    });
    await withRetries(() => createBuzzTransactionMany(winnerPayoutTransactions));
    log('Prizes sent');

    // 6. Distribute entry participation prizes
    const participationKeyId = currentChallenge.challengeId ?? currentChallenge.collectionId;
    const paidParticipants = await distributeParticipationPrizes({
      challengeId: currentChallenge.challengeId,
      collectionId: currentChallenge.collectionId,
      title: currentChallenge.title,
      entryPrize: currentChallenge.entryPrize,
      entryPrizeRequirement: currentChallenge.entryPrizeRequirement,
      excludeUserIds: winningEntries.map((e) => e.userId),
      notificationKey: `challenge-participation:${participationKeyId}:final`,
    });
    log('Entry participation prizes sent:', paidParticipants.length);

    // 7. Set Completed status + store summary (AFTER all prizes distributed)
    const challengeRecord = await getChallengeById(currentChallenge.challengeId);

    // Partial-winner residual: unfilled prize buzz stays in account 0 by design (spec decision).
    if (challengeRecord?.source === ChallengeSource.User) {
      const totalPrizeBuzz = challengeRecord.prizes.reduce((sum, p) => sum + (p.buzz ?? 0), 0);
      const distributedPrizeBuzz = winningEntries.reduce((sum, e) => sum + e.prize, 0);
      const residualBuzz = totalPrizeBuzz - distributedPrizeBuzz;
      if (residualBuzz > 0) {
        await logToAxiom({
          type: 'info',
          name: 'challenge-partial-winner-residual',
          message:
            'User challenge completed with fewer winners than prize places; buzz not paid out',
          challengeId: currentChallenge.challengeId,
          residualBuzz,
          winnersCount: winningEntries.length,
          prizePlaces: challengeRecord.prizes.length,
        });
      }
    }

    const existingMetadata = parseChallengeMetadata(challengeRecord?.metadata);
    const completed = await completeChallengeIfClaimHeld({
      challengeId: currentChallenge.challengeId,
      claimedAt,
      metadata: {
        ...existingMetadata,
        completionSummary: {
          judgingProcess: process,
          outcome: outcome,
          completedAt: new Date().toISOString(),
        },
        reconciliation: {
          ...(existingMetadata.reconciliation ?? {}),
          paidUserIds: Array.from(
            new Set([...(existingMetadata.reconciliation?.paidUserIds ?? []), ...paidParticipants])
          ),
        },
      } as unknown as Prisma.InputJsonValue,
    });
    if (!completed) {
      // Winners and payouts this run already wrote stay behind — partial state left by an aborted
      // run is #3842, not this guard's job. What stops here is everything that would announce or
      // count an outcome this run no longer owns.
      logClaimLost(currentChallenge.challengeId, 'winners-completion');
      return;
    }
    log('Challenge status updated to Completed');

    // Telemetry: emitted AFTER the Completed write, deliberately NOT next to the payout above.
    // The payout is retry-safe by deterministic externalTransactionId, so a run that pays prizes
    // and then crashes before this write is reset Completing -> Active and re-enters via the
    // `existingWinners` branch, which re-issues the same (already-settled) payout. An emit at the
    // payout site would count that Buzz twice.
    //
    // Amount mirrors endChallengeAndPickWinners: the sum of the prizes SUBMITTED for the winners
    // paid on this completion (equal to each ChallengeWinner.buzzAwarded), not the configured prize
    // table — a partial-winner completion pays less and must report less. Note this is prize Buzz
    // ATTEMPTED, not confirmed-settled: `createBuzzTransactionMany` silently drops any non-success,
    // non-conflict result (e.g. insufficientFunds) from both of its result arrays, so a leg that did
    // not move money is invisible here and is still counted. `winnerBuzzType` is the currency
    // buildWinnerPayoutTransactions actually paid in, and `challengeRecord` is already in scope —
    // neither needs a new query.
    recordChallengeCompleted({ source: challengeRecord?.source });
    recordChallengePrizePaidBuzz({
      source: challengeRecord?.source,
      buzzType: winnerBuzzType,
      amount: winningEntries.reduce((sum, e) => sum + (e.prize ?? 0), 0),
    });

    if (challengeRecord) await logChallengeSpendMetric(challengeRecord);

    // 8. Send notifications to winners (non-critical, last)
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

    if (currentChallenge.challengeId) {
      await sendChallengeResultsNotification({
        challengeId: currentChallenge.challengeId,
        challengeTitle: currentChallenge.title,
        excludeUserIds: [
          ...new Set([...winningEntries.map((entry) => entry.userId), ...paidParticipants]),
        ],
      });
    }
    log('Winners notified');
  } catch (error) {
    // On failure, challenge stays in 'Completing' for recovery to handle
    log('Error during winner picking, challenge stays in Completing for recovery:', error);
    throw error;
  }
}

/**
 * Start a scheduled challenge that is ready to begin.
 * Start a scheduled challenge that is ready to begin.
 */
export async function startScheduledChallenge(
  challenge: DailyChallengeDetails,
  config: ChallengeConfig
) {
  log('Starting scheduled challenge:', challenge.challengeId);

  // Open collection
  await dbWrite.$executeRaw`
    UPDATE "Collection"
    SET write = 'Review'::"CollectionWriteConfiguration",
        read = 'Public'::"CollectionReadConfiguration"
    WHERE id = ${challenge.collectionId};
  `;
  log('Collection opened');

  // Update Challenge status to Active (includes Redis cache)
  if (challenge.challengeId) {
    await setChallengeActive(challenge.challengeId);
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
      await createNotification({
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
  // sortAt intentionally omitted: the image_sort_at_before trigger authors it
  // from the copied scannedAt/createdAt (postId is not copied → postless), so
  // copying the source's sortAt would be inert. Do not re-add it.
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

export async function getJudgedEntries(
  collectionId: number,
  config: ChallengeConfig,
  eventContext?: EventContext,
  source: ChallengeSource = ChallengeSource.System,
  categories?: ChallengeJudgingCategory[],
  // Defaults to the historical cut at config.finalReviewAmount. An engine that ranks by
  // comparison passes Infinity so the absolute score (and its random tiebreak) does not decide
  // which entries are eligible to be ranked.
  //
  // `perUserBest: false` additionally keeps EVERY entry rather than one per user, for an engine
  // that picks each user's representative from its own ranking instead. Both default to the
  // historical behaviour; legacy passes neither.
  options?: { limit?: number; perUserBest?: boolean }
) {
  // A challenge with no usable stored rubric (only a malformed value now that every challenge is
  // seeded) is ranked by the same fixed split the judge scored it against.
  const rubric = categories?.length ? categories : FIXED_JUDGING_CATEGORIES;

  // Every judged entry — the per-user best is picked below, after the theme gate has had a chance
  // to drop disqualified entries, so a user whose top entry is gated falls through to their next.
  const userBestEntries = await dbRead.$queryRaw<JudgedEntry[]>`
    SELECT
      ci."imageId",
      i."userId",
      u."username",
      ci.note
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    JOIN "User" u ON u.id = i."userId"
    WHERE ci."collectionId" = ${collectionId}
    AND ci."tagId" = ${config.judgedTagId}
    AND ci.note IS NOT NULL
    AND ci.status = 'ACCEPTED'
  `;
  log('Users with judged entries:', userBestEntries?.length);
  if (!userBestEntries.length) {
    return [];
  }

  // Exclude users who won a challenge within the cooldown period, scoped by event. Wins in a user
  // challenge are excluded from the lookback for the same reason user challenges skip the cooldown
  // below: the two prize pools are independent in both directions.
  let recentWinnerIds = new Set<number>();
  if (source === ChallengeSource.User) {
    // Paid user challenges never apply the winner cooldown — a recent daily-challenge win
    // must not silently disqualify someone from a pool they paid to enter.
    log('Skipping winner cooldown — user-created challenge');
  } else if (eventContext?.winnerCooldownDays === 0) {
    // Event allows consecutive wins — skip cooldown entirely
    log('Skipping winner cooldown — event cooldown set to 0', {
      eventId: eventContext.eventId,
    });
  } else if (eventContext !== undefined) {
    // Scoped cooldown: filter by event context
    const cooldownInterval =
      eventContext.winnerCooldownDays != null
        ? `${eventContext.winnerCooldownDays} day`
        : config.winnerCooldown;
    const eventCondition =
      eventContext.eventId != null
        ? Prisma.sql`AND c."eventId" = ${eventContext.eventId}`
        : Prisma.sql`AND c."eventId" IS NULL`;
    const recentWinners = await dbWrite.$queryRaw<{ userId: number }[]>`
      SELECT DISTINCT cw."userId"
      FROM "ChallengeWinner" cw
      JOIN "Challenge" c ON c.id = cw."challengeId"
      WHERE cw."createdAt" > now() - ${cooldownInterval}::interval
        AND c.status = 'Completed'
        AND c."source" <> 'User'
        ${eventCondition}
    `;
    recentWinnerIds = new Set(recentWinners.map((w) => w.userId));
  } else {
    // No event context provided — apply global cooldown (original behavior)
    const recentWinners = await dbWrite.$queryRaw<{ userId: number }[]>`
      SELECT DISTINCT cw."userId"
      FROM "ChallengeWinner" cw
      JOIN "Challenge" c ON c.id = cw."challengeId"
      WHERE cw."createdAt" > now() - ${config.winnerCooldown}::interval
        AND c.status = 'Completed'
        AND c."source" <> 'User'
    `;
    recentWinnerIds = new Set(recentWinners.map((w) => w.userId));
  }
  const eligibleEntries = filterRecentWinners(userBestEntries, recentWinnerIds);

  const cooldownSource =
    source === ChallengeSource.User
      ? 'none (user challenge)'
      : eventContext?.winnerCooldownDays === 0
      ? 'none (no cooldown)'
      : eventContext?.winnerCooldownDays != null
      ? `${String(eventContext.winnerCooldownDays)} day (event override)`
      : `${String(config.winnerCooldown)} (global default)`;
  log('Winner cooldown filter:', {
    total: userBestEntries.length,
    excluded: userBestEntries.length - eligibleEntries.length,
    eligible: eligibleEntries.length,
    cooldown: cooldownSource,
  });

  const ranked = eligibleEntries
    .map(({ note, ...entry }) => {
      const { score, summary } = JSON.parse(note);
      const weightedRating = calculateWeightedCategoryScore(score, rubric);
      return { ...entry, summary, score, weightedRating };
    })
    .filter((e): e is typeof e & { weightedRating: number } => e.weightedRating !== null);

  let candidates = ranked;
  if (options?.perUserBest !== false) {
    const bestPerUser = new Map<number, (typeof ranked)[number]>();
    for (const entry of ranked) {
      const current = bestPerUser.get(entry.userId);
      if (!current || entry.weightedRating > current.weightedRating) {
        bestPerUser.set(entry.userId, entry);
      }
    }
    candidates = [...bestPerUser.values()];
  }

  // Ties are shuffled rather than resolved by query order — entries scored 0-10 on a handful of
  // categories tie often, and the tied set is what gets cut at finalReviewAmount.
  return candidates
    .sort((a, b) => b.weightedRating - a.weightedRating || Math.random() - 0.5)
    .slice(0, options?.limit ?? config.finalReviewAmount);
}

// Types
// ----------------------------------------------

type JudgedEntry = {
  imageId: number;
  userId: number;
  username: string;
  note: string;
};
