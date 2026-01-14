import dayjs from '~/shared/utils/dayjs';
import type { Tracker } from '~/server/clickhouse/client';
import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL, newOrderConfig } from '~/server/common/constants';
import type { NewOrderDamnedReason } from '~/server/common/enums';
import {
  NewOrderImageRatingStatus,
  NewOrderSignalActions,
  NotificationCategory,
  NsfwLevel,
  SignalMessages,
  SignalTopic,
} from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import type { NewOrderHighRankType } from '~/server/games/new-order/utils';
import {
  acolyteFailedJudgments,
  allJudgmentsCounter,
  blessedBuzzCounter,
  checkVotingRateLimit,
  correctJudgmentsCounter,
  expCounter,
  fervorCounter,
  getActiveSlot,
  getImageRatingsCounter,
  pendingBuzzCounter,
  poolCounters,
  sanityCheckFailuresCounter,
  smitesCounter,
} from '~/server/games/new-order/utils';
import { logToAxiom } from '~/server/logging/client';
import { redis, REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { InfiniteQueryInput } from '~/server/schema/base.schema';
import type {
  AddImageRatingInput,
  CleanseSmiteInput,
  GetHistorySchema,
  GetImagesQueueSchema,
  SmitePlayerInput,
} from '~/server/schema/games/new-order.schema';
import type { ImageMetadata } from '~/server/schema/media.schema';
import { ReportEntity } from '~/server/schema/report.schema';
import { playerInfoSelect, userWithPlayerInfoSelect } from '~/server/selectors/user.selector';
import { handleBlockImages, updateImageNsfwLevel } from '~/server/services/image.service';
import { createNotification } from '~/server/services/notification.service';
import { createReport } from '~/server/services/report.service';
import { claimCosmetic } from '~/server/services/user.service';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import {
  handleLogError,
  throwBadRequestError,
  throwInternalServerError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { getLevelProgression } from '~/server/utils/game-helpers';
import {
  MediaType,
  NewOrderRankType,
  ReportReason,
  ReportStatus,
} from '~/shared/utils/prisma/enums';
import { getRandom, shuffle } from '~/utils/array-helpers';
import { signalClient } from '~/utils/signal-client';
import { isDefined } from '~/utils/type-guards';

const ACOLYTE_WRONG_ANSWER_LIMIT = 5;

// Helper functions for atomic voting
function getVoteLimitForRank(rank: NewOrderHighRankType): number {
  switch (rank) {
    case NewOrderRankType.Knight:
      return newOrderConfig.limits.knightVotes;
    case NewOrderRankType.Templar:
      return newOrderConfig.limits.templarVotes;
    case 'Inquisitor':
      return 1; // Inquisitors decide immediately
    default:
      return 1;
  }
}

async function notifyQueueUpdate(
  rank: NewOrderHighRankType,
  imageId: number,
  action: NewOrderSignalActions
) {
  const topic = `${SignalTopic.NewOrderQueue}:${rank}` as const;
  await signalClient
    .topicSend({
      topic,
      target: SignalMessages.NewOrderQueueUpdate,
      data: { imageId, action },
    })
    .catch((e) => handleLogError(e, `Failed to notify queue update: ${topic}`));
}

export async function joinGame({ userId }: { userId: number }) {
  const user = await dbRead.user.findUnique({
    where: { id: userId },
    select: {
      playerInfo: { select: playerInfoSelect },
    },
  });
  if (!user) throw throwNotFoundError(`No user with id ${userId}`);

  if (user.playerInfo) {
    // User is already in game
    const stats = await getPlayerStats({ playerId: userId });
    const { user: userInfo, ...playerData } = user.playerInfo;
    return { ...userInfo, ...playerData, stats };
  }

  const player = await dbWrite.newOrderPlayer.create({
    data: { userId, rankType: NewOrderRankType.Acolyte, startAt: new Date() },
    select: playerInfoSelect,
  });

  // Grant cosmetic to new players
  await claimCosmetic({
    id: newOrderConfig.cosmetics.badgeIds.acolyte,
    userId,
  }).catch(() => null); // Ignore if it fails

  const { user: userInfo, ...playerData } = player;
  return {
    ...playerData,
    ...userInfo,
    stats: {
      exp: 0,
      fervor: 0,
      smites: 0,
      blessedBuzz: 0,
      pendingBlessedBuzz: 0,
      nextGrantDate: dayjs().add(1, 'day').startOf('day').toDate(),
    },
  };
}

export async function getPlayerById({ playerId }: { playerId: number }) {
  const player = await dbRead.newOrderPlayer.findUnique({
    where: { userId: playerId },
    select: playerInfoSelect,
  });
  if (!player) throw throwNotFoundError(`No player with id ${playerId}`);

  const { user, ...playerData } = player;
  const stats = await getPlayerStats({ playerId });

  return { ...playerData, ...user, stats };
}

async function getPlayerStats({ playerId }: { playerId: number }) {
  const [exp, fervor, smites, blessedBuzz, pendingBlessedBuzz] = await Promise.all([
    expCounter.getCount(playerId),
    fervorCounter.getCount(playerId),
    smitesCounter.getCount(playerId),
    blessedBuzzCounter.getCount(playerId),
    pendingBuzzCounter.getCount(playerId),
  ]);
  const nextGrantDate = dayjs().add(1, 'day').startOf('day').toDate(); // Next 00:00 UTC

  return { exp, fervor, smites, blessedBuzz, pendingBlessedBuzz, nextGrantDate };
}

export async function smitePlayer({
  playerId,
  modId,
  reason,
  size,
}: SmitePlayerInput & { modId: number }) {
  const smite = await dbWrite.newOrderSmite.create({
    data: {
      targetPlayerId: playerId,
      givenById: modId,
      reason,
      size,
      remaining: size,
    },
  });

  const activeSmiteCount = await dbWrite.newOrderSmite.count({
    where: { targetPlayerId: playerId, cleansedAt: null },
  });
  if (activeSmiteCount >= 3) {
    return resetPlayer({
      playerId,
      withNotification: true,
      reason: 'Your New Order career has been reset due to excessive smites.',
    });
  }

  const newSmiteCount = await smitesCounter.increment({ id: playerId });

  await signalClient
    .send({
      userId: playerId,
      target: SignalMessages.NewOrderPlayerUpdate,
      data: {
        action: NewOrderSignalActions.UpdateStats,
        stats: { smites: newSmiteCount },
        notification: {
          type: 'smite' as const,
          title: '⚡ You have been smote',
          message: reason || 'A moderator has applied a smite penalty to your account.',
        },
      },
    })
    .catch((e) => handleLogError(e, 'signals:new-order-smite-player'));

  createNotification({
    category: NotificationCategory.System,
    type: 'new-order-smite-received',
    key: `new-order-smite-received:${playerId}:${smite.id}`,
    userId: playerId,
    details: {},
  }).catch();

  return smite;
}

export async function cleanseAllSmites({
  playerId,
  cleansedReason,
}: Omit<CleanseSmiteInput, 'id'>) {
  const data = await dbWrite.newOrderSmite.updateMany({
    where: { targetPlayerId: playerId, cleansedAt: null },
    data: { cleansedAt: new Date(), cleansedReason },
  });

  await smitesCounter.reset({ id: playerId });
  await sanityCheckFailuresCounter.reset({ id: playerId });

  if (data.count === 0) return; // Nothing done :shrug:

  await signalClient
    .send({
      userId: playerId,
      target: SignalMessages.NewOrderPlayerUpdate,
      data: { action: NewOrderSignalActions.UpdateStats, stats: { smites: 0 } },
    })
    .catch((e) => handleLogError(e, 'signals:new-order-smite-cleansed-all'));

  createNotification({
    category: NotificationCategory.System,
    type: 'new-order-smite-cleansed',
    key: `new-order-smite-cleansed:${playerId}:all:${new Date().getTime()}`,
    userId: playerId,
    details: { cleansedReason },
  }).catch();
}

export async function cleanseSmite({ id, cleansedReason, playerId }: CleanseSmiteInput) {
  const smite = await dbWrite.newOrderSmite.update({
    where: { id, cleansedAt: null },
    data: { cleansedAt: new Date(), cleansedReason },
  });

  const smiteCount = await smitesCounter.decrement({ id: playerId });
  await sanityCheckFailuresCounter.reset({ id: playerId });

  await signalClient
    .send({
      userId: playerId,
      target: SignalMessages.NewOrderPlayerUpdate,
      data: {
        action: NewOrderSignalActions.UpdateStats,
        stats: { smites: smiteCount },
        notification: {
          type: 'cleanse',
          title: '✨ Smite cleansed',
          message:
            'One of your smites has been removed! Keep up the good work with accurate ratings.',
        },
      },
    })
    .catch((e) => handleLogError(e, 'signals:new-order-smite-cleansed'));

  createNotification({
    category: NotificationCategory.System,
    type: 'new-order-smite-cleansed',
    key: `new-order-smite-cleansed:${playerId}:${id}`,
    userId: playerId,
    details: { cleansedReason },
  }).catch();

  return smite;
}

export async function addImageRating({
  playerId,
  imageId,
  rating,
  damnedReason,
  chTracker,
  isModerator,
}: AddImageRatingInput & { playerId: number; chTracker?: Tracker; isModerator?: boolean }) {
  if (!clickhouse) throw throwInternalServerError('Not supported');

  // Use distributed lock to prevent race conditions
  const result = await withDistributedLock(
    {
      key: `image-rating:${imageId}`,
      ttl: 30, // 30 second lock
      maxRetries: 5,
      retryDelay: 200,
    },
    async () => {
      return await processImageRating({
        playerId,
        imageId,
        rating,
        damnedReason,
        chTracker,
        isModerator,
      });
    }
  );

  if (result === null) {
    // Could not acquire lock, likely another process is handling this image
    throw throwBadRequestError('Image rating is currently being processed. Please try again.');
  }

  return result;
}

async function processImageRating({
  playerId,
  imageId,
  rating,
  damnedReason,
  chTracker,
  isModerator,
}: AddImageRatingInput & { playerId: number; chTracker?: Tracker; isModerator?: boolean }) {
  // Check player existence
  const player = await getPlayerById({ playerId });
  if (!player) throw throwNotFoundError(`No player with id ${playerId}`);

  // Check image existence
  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: { id: true, nsfwLevel: true, metadata: true },
  });
  if (!image) throw throwNotFoundError(`No image with id ${imageId}`);

  // Skip rate limiting for moderators
  if (!isModerator) {
    const rateLimitResult = await checkVotingRateLimit(playerId);

    // If abuse threshold exceeded, reset player career
    if (rateLimitResult.isAbuse) {
      // Log abuse detection for monitoring
      logToAxiom(
        {
          type: 'warning',
          name: 'new-order-abuse-detection',
          details: {
            playerId,
            imageId,
            action: 'career-reset',
            reason: 'excessive-voting',
          },
          message: `Player ${playerId} exceeded abuse threshold and was reset`,
        },
        'new-order'
      ).catch(() => null);

      await resetPlayer({
        playerId,
        withNotification: true,
        reason:
          'Your account has been reset due to suspicious voting patterns. Please vote at a reasonable pace to avoid this in the future.',
      });

      throw throwBadRequestError('Account has been reset due to suspicious voting patterns.');
    }

    // Standard rate limiting
    if (!rateLimitResult.allowed) {
      // Log rate limit hits for monitoring (but only occasionally to avoid spam)
      if (Math.random() < 0.1) {
        // 10% sampling
        logToAxiom(
          {
            type: 'info',
            name: 'new-order-rate-limit',
            details: {
              playerId,
              remaining: rateLimitResult.remaining,
              resetTime: rateLimitResult.resetTime,
            },
            message: `Player ${playerId} hit rate limit`,
          },
          'new-order'
        ).catch(() => null);
      }

      throw throwBadRequestError(
        `Rate limit exceeded. Please wait ${Math.ceil(
          (rateLimitResult.resetTime - Date.now()) / 1000
        )} seconds before voting again.`
      );
    }
  }

  // Find which specific queue this image is in
  const allowedRankTypes = isModerator
    ? (['Inquisitor', NewOrderRankType.Knight] as NewOrderHighRankType[])
    : [player.rankType];

  const valueInQueue = await isImageInQueue({
    imageId,
    rankType: allowedRankTypes,
  });
  if (!valueInQueue) return { stats: player.stats }; // Image not found in any valid queue for this player

  // Check if vote limits have been reached (using consistent logic)
  const currentVoteCount = valueInQueue.value;
  const voteLimit = getVoteLimitForRank(valueInQueue.rank);

  if (currentVoteCount >= voteLimit && valueInQueue.rank !== NewOrderRankType.Acolyte) {
    // Vote limit already reached, remove from queue
    await removeImageFromQueue({ imageId, valueInQueue });
    return { stats: player.stats };
  }

  // Update image nsfw level if the player is a mod
  if (isModerator) {
    await updateImageNsfwLevel({
      id: imageId,
      nsfwLevel: rating,
      userId: playerId,
      isModerator,
      status: 'Actioned',
    });
    await updatePendingImageRatings({ imageId, rating });
    await removeImageFromQueue({ imageId, valueInQueue });

    if (rating === NsfwLevel.Blocked) {
      await handleBlockImages({ ids: [imageId] });
    }

    // Finish the rating process for mods
    return { stats: player.stats };
  }

  // Atomically increment vote count and check limits
  const newVoteCount = await valueInQueue.pool.increment({ id: imageId });
  // Also increment total ratings for this image+rating
  // Calculate vote weight for this rating
  const playerLevel = getLevelProgression(player.stats.exp).level;
  const playerSmites = player.stats.smites;
  const voteWeight = Math.round(
    calculateVoteWeight({ level: playerLevel, smites: playerSmites }) * 100
  ); // to avoid floating point vote weights
  await getImageRatingsCounter(imageId).increment({
    id: `${player.rank.name}-${rating}`,
    value: voteWeight,
  });

  let currentNsfwLevel: NsfwLevel | undefined = image.nsfwLevel;

  // Check if we've reached vote limits after the atomic increment
  const reachedKnightVoteLimit =
    player.rankType === NewOrderRankType.Knight &&
    valueInQueue.rank === NewOrderRankType.Knight &&
    newVoteCount >= newOrderConfig.limits.knightVotes;

  // Now, process what to do with the image:
  if (reachedKnightVoteLimit) {
    const consensus = await checkWeightedConsensus({ imageId, voteCount: newVoteCount });
    const hitMaxVotes = newVoteCount >= newOrderConfig.limits.maxKnightVotes;
    if (consensus || hitMaxVotes) {
      // Apply the consensus decision
      if (consensus) {
        currentNsfwLevel = await updateImageNsfwLevel({
          id: imageId,
          nsfwLevel: consensus,
          userId: playerId,
          isModerator: true,
          activity: 'setNsfwLevelKono',
          status: 'Actioned',
        });
      }

      // Update pending ratings
      await updatePendingImageRatings({ imageId, rating: consensus });

      // Clear image from the pool
      await removeImageFromQueue({ imageId, valueInQueue });
    }
  }

  const isAcolyte = player.rankType === NewOrderRankType.Acolyte;
  let status: NewOrderImageRatingStatus;

  if (isAcolyte) {
    status =
      currentNsfwLevel === rating
        ? NewOrderImageRatingStatus.AcolyteCorrect
        : NewOrderImageRatingStatus.AcolyteFailed;
  } else if (reachedKnightVoteLimit && currentNsfwLevel !== undefined) {
    status =
      currentNsfwLevel === rating
        ? NewOrderImageRatingStatus.Correct
        : NewOrderImageRatingStatus.Failed;
  } else {
    // Knights leave the image in the pending status until their vote is confirmed.
    status = NewOrderImageRatingStatus.Pending;
  }

  const multiplier = [
    NewOrderImageRatingStatus.Failed,
    NewOrderImageRatingStatus.AcolyteFailed,
  ].includes(status)
    ? 0
    : 1;

  if (chTracker) {
    try {
      await chTracker.newOrderImageRating({
        userId: playerId,
        imageId,
        rating,
        status,
        damnedReason,
        grantedExp: newOrderConfig.baseExp,
        multiplier,
        rank: player.rankType,
        originalLevel: currentNsfwLevel,
      });

      if (isAcolyte) {
        const currentExp = await expCounter.getCount(playerId);
        const currentLevel = getLevelProgression(currentExp);
        const levelAfterRating = getLevelProgression(
          currentExp + newOrderConfig.baseExp * multiplier
        );

        if (status === NewOrderImageRatingStatus.AcolyteFailed) {
          const wrongAnswerCount = await acolyteFailedJudgments.increment({ id: playerId });
          if (wrongAnswerCount > ACOLYTE_WRONG_ANSWER_LIMIT) {
            // Smite player:
            await smitePlayer({
              playerId,
              modId: -1, // System
              reason: 'Exceeded wrong answer limit',
              size: newOrderConfig.smiteSize,
            });
            await acolyteFailedJudgments.reset({ id: playerId });
          }
        } else if (levelAfterRating.level > currentLevel.level) {
          // Cleanup all smites & reset failed judgments
          await cleanseAllSmites({
            playerId,
            cleansedReason: 'Acolyte - Level up!',
          });
          await acolyteFailedJudgments.reset({ id: playerId });
        }
      }
    } catch (e) {
      const error = e as Error;
      logToAxiom(
        {
          type: 'error',
          name: 'new-order-image-rating',
          details: {
            data: {
              playerId,
              imageId,
              rating,
              status,
              damnedReason,
              grantedExp: newOrderConfig.baseExp,
              multiplier,
            },
          },
          message: error.message,
          stack: error.stack,
          cause: error.cause,
        },
        'clickhouse'
      ).catch();
    }
  }

  // Check for report creation when Knights vote Blocked
  if (rating === NsfwLevel.Blocked && !isModerator && clickhouse) {
    try {
      // Query ClickHouse for total Blocked votes on this image
      const votes = await getImageRatingsCounter(imageId).getAll({ withCount: true });
      const blockedVoteWeight =
        votes.find((v) => v.value === `Knight-${NsfwLevel.Blocked}`)?.score || 0;

      // If 2+ Knights have voted Blocked, create report
      if (blockedVoteWeight >= 200) {
        // Check if report already exists for this image
        const existingReport = await dbRead.report.findFirst({
          where: {
            reason: ReportReason.AdminAttention,
            image: { imageId },
            status: ReportStatus.Pending,
          },
        });

        if (!existingReport) {
          // Create report with the knight's damned reason
          await createReport({
            userId: playerId,
            id: imageId,
            type: ReportEntity.Image,
            reason: ReportReason.AdminAttention,
            details: {
              reason: damnedReason || 'Multiple Knights have rated this image as Blocked.',
              comment: damnedReason
                ? `Knights reported: ${damnedReason} (${blockedVoteWeight} score)`
                : `Knights consensus: Blocked rating (${blockedVoteWeight} score)`,
            },
          });

          // Remove image from queue immediately after being reported
          await removeImageFromQueue({ imageId, valueInQueue });
        }
      }
    } catch (error) {
      // Log error but don't fail the vote
      logToAxiom({
        type: 'error',
        name: 'new-order-knights-report-error',
        details: {
          imageId,
          playerId,
          error: (error as Error).message,
        },
        message: `Failed to create report for image ${imageId}`,
      }).catch(() => null);
    }
  }

  // Add newly rated image to cache incrementally (O(1) operation, no cache busting needed)
  addRatedImage(playerId, imageId);

  // Increase all counters
  const stats = await updatePlayerStats({
    playerId,
    status,
    exp: newOrderConfig.baseExp * multiplier,
    updateAll: player.rankType !== NewOrderRankType.Acolyte,
  });

  // Check if player should be promoted
  const knightRank = await getNewOrderRanks({ name: 'Knight' });
  if (
    player.rankType === NewOrderRankType.Acolyte &&
    knightRank &&
    knightRank.minExp <= stats.exp
  ) {
    await dbWrite.newOrderPlayer.update({
      where: { userId: playerId },
      data: { rankType: knightRank.type },
    });

    // Grant cosmetic to new players
    await claimCosmetic({
      id: newOrderConfig.cosmetics.badgeIds.knight,
      userId: playerId,
    }).catch(() => null); // Ignore if it fails

    await signalClient
      .send({
        userId: playerId,
        target: SignalMessages.NewOrderPlayerUpdate,
        data: {
          action: NewOrderSignalActions.RankUp,
          rankType: knightRank.type,
          rank: { ...knightRank },
        },
      })
      .catch((e) => handleLogError(e, 'signals:new-order-rank-up'));
  }

  return { stats };
}

async function removeImageFromQueue({
  imageId,
  valueInQueue,
}: {
  imageId: number;
  valueInQueue: Awaited<ReturnType<typeof isImageInQueue>>;
}) {
  if (!valueInQueue) return;

  await valueInQueue.pool.reset({ id: imageId });
  await getImageRatingsCounter(imageId).reset({ all: true }); // Clear vote distribution
  await notifyQueueUpdate(valueInQueue.rank, imageId, NewOrderSignalActions.RemoveImage);
}

export async function updatePendingImageRatings({
  imageId,
  rating,
}: {
  imageId: number;
  rating?: NsfwLevel | null;
}) {
  if (!clickhouse) throw throwInternalServerError('Not supported');

  // Get players that rated this image (uses by_imageId projection via GROUP BY pattern)
  const votes = await clickhouse.$query<{ userId: number; createdAt: Date; rating: number }>`
    SELECT userId, lastCreatedAt as createdAt, latestRating as rating
    FROM (
      SELECT
        userId,
        max(createdAt) as lastCreatedAt,
        argMax(rating, createdAt) as latestRating,
        argMax(status, createdAt) as latestStatus
      FROM knights_new_order_image_rating
      WHERE imageId = ${imageId}
      GROUP BY imageId, userId
    )
    WHERE latestStatus = '${NewOrderImageRatingStatus.Pending}'
  `;

  await clickhouse.$exec`
    INSERT INTO knights_rating_updates_buffer (imageId, rating)
    VALUES (${imageId}, ${rating});
  `;
  await processFinalRatings();

  const correctVotes = votes.filter((v) => v.rating === rating);
  // Doing raw query cause I want 1 smite per player :shrug:
  // '[{"userId":5376986,"createdAt":"2025-05-07T21:58:38.691Z"}]'
  const updated = await dbWrite.$queryRaw<{ id: number; userId: number; remaining: number }[]>`
    WITH votes AS (
        SELECT
          (value ->> 'userId')::int as "userId",
          (value ->> 'createdAt')::TIMESTAMP as "createdAt"
        FROM json_array_elements(${JSON.stringify(correctVotes)}::json)
    ), smites AS (
      SELECT DISTINCT "targetPlayerId" as "userId", id, remaining
        FROM "NewOrderSmite"
        JOIN "NewOrderPlayer" p ON "targetPlayerId" = p."userId"
        JOIN votes v ON p."userId" = v."userId" AND v."createdAt" >= p."startAt"
        WHERE "cleansedAt" IS NULL
    )
    UPDATE "NewOrderSmite"
    SET "remaining" = "remaining" - 1
    WHERE id IN (
      SELECT id FROM smites
    )
    RETURNING id, "targetPlayerId" as "userId", remaining
  `;

  const cleansed = updated.filter((s) => s.remaining <= 0);
  await Promise.all(
    cleansed.map((s) =>
      cleanseSmite({
        id: s.id,
        cleansedReason: 'Smite expired',
        playerId: s.userId,
      })
    )
  );

  // Update counters and stats for players whose pending votes are now finalized
  await Promise.all(
    votes.map(async (vote) => {
      // Parallelize independent counter reads
      const [allJudgments, expCount] = await Promise.all([
        allJudgmentsCounter.getCount(vote.userId),
        expCounter.getCount(vote.userId),
      ]);

      // Conditionally increment or get correct judgments
      let correctJudgments: number;
      if (vote.rating === rating) {
        // Increment returns the new count - no separate getCount needed
        correctJudgments = await correctJudgmentsCounter.increment({ id: vote.userId });
      } else {
        // Only call getCount for incorrect votes
        correctJudgments = await correctJudgmentsCounter.getCount(vote.userId);
      }

      // Recalculate and update fervor based on new judgment counts
      const fervor = calculateFervor({ correctJudgments, allJudgments });
      await fervorCounter.reset({ id: vote.userId });
      const newFervor = await fervorCounter.increment({ id: vote.userId, value: fervor });

      // Emit signal to update player stats in real-time
      await signalClient
        .send({
          userId: vote.userId,
          target: SignalMessages.NewOrderPlayerUpdate,
          data: {
            action: NewOrderSignalActions.UpdateStats,
            stats: { exp: expCount, fervor: newFervor },
          },
        })
        .catch((e) => handleLogError(e, 'signals:new-order-update-pending-ratings'));
    })
  );
}

const PROCESS_MIN = 100; // number of items that will trigger early processing
const PROCESS_INTERVAL = 30; // seconds
export async function processFinalRatings() {
  if (!clickhouse || !sysRedis) throw throwInternalServerError('Not supported');

  // Increment process requests
  const [pendingCount, lastProcessedString, cutoffString] = await Promise.all([
    sysRedis.incr(REDIS_SYS_KEYS.NEW_ORDER.PROCESSING.PENDING_COUNT),
    sysRedis.get(REDIS_SYS_KEYS.NEW_ORDER.PROCESSING.LAST_PROCESSED_AT),
    sysRedis.get(REDIS_SYS_KEYS.NEW_ORDER.PROCESSING.BATCH_CUTOFF),
  ]);
  const lastProcessed = parseInt(lastProcessedString ?? '0', 10);

  // Determine if we should process now
  const timeSinceLastProcessed = Date.now() - lastProcessed;
  const shouldProcess =
    pendingCount >= PROCESS_MIN || timeSinceLastProcessed >= PROCESS_INTERVAL * 1000;
  if (!shouldProcess) return { status: 'not-needed', timeSinceLastProcessed, pendingCount };

  // Try to get a lock to process
  const [lockAcquired] = await sysRedis
    .multi()
    .setNX(REDIS_SYS_KEYS.NEW_ORDER.PROCESSING.LOCK, '1')
    .expire(REDIS_SYS_KEYS.NEW_ORDER.PROCESSING.LOCK, 10) // prevent deadlocks
    .exec();
  if (!lockAcquired) return { status: 'no-lock' }; // Another process is handling it

  try {
    // Get start and new end timeframe
    const updateStart = new Date(cutoffString ? parseInt(cutoffString) : 0);
    const [{ updateEnd: updateEndString }] = await clickhouse.$query<{ updateEnd: string }>`
      SELECT update_time as updateEnd
      FROM knights_rating_updates_batch
      ORDER BY update_time DESC
      LIMIT 1;
    `;
    const updateEnd = new Date(updateEndString);
    if (updateStart.getTime() === updateEnd.getTime()) return { status: 'no-new-data' };

    await clickhouse.$exec`
      INSERT INTO knights_new_order_image_rating
      WITH batch as (
        SELECT
            imageId,
            argMax(rating, update_time) as rating,  -- Latest rating wins
            max(update_time) as createdAt
        FROM knights_rating_updates_batch
        WHERE
          update_time > ${updateStart}
          AND update_time <= ${updateEnd}
        GROUP BY imageId
      )
      SELECT
          orig.userId,
          orig.imageId as imageId,
          orig.rating as rating,
          orig.damnedReason,
          CASE
              WHEN new.rating IS NULL THEN '${NewOrderImageRatingStatus.Inconclusive}'
              WHEN new.rating = orig.rating THEN '${NewOrderImageRatingStatus.Correct}'
              ELSE '${NewOrderImageRatingStatus.Failed}'
          END as status,
          orig.grantedExp,
          CASE
              WHEN new.rating = orig.rating THEN 1
              ELSE 0
          END as multiplier,
          new.createdAt as createdAt,
          orig.ip,
          orig.userAgent,
          orig.deviceId,
          orig.rank,
          orig.originalLevel
      FROM knights_new_order_image_rating orig
      JOIN batch new ON new.imageId = orig.imageId
      WHERE orig.imageId IN (SELECT imageId FROM batch) AND orig.rank != 'Acolyte';
    `;

    // Update last processed time and reset pending count
    await sysRedis
      .multi()
      .set(REDIS_SYS_KEYS.NEW_ORDER.PROCESSING.BATCH_CUTOFF, updateEnd.getTime().toString())
      .set(REDIS_SYS_KEYS.NEW_ORDER.PROCESSING.PENDING_COUNT, '0')
      .exec();

    // Log processing completion
    logToAxiom(
      {
        type: 'info',
        name: 'new-order-process-correct-ratings',
        details: {
          data: {
            lastProcessed,
            pendingCount,
            updateStart,
            updateEnd,
          },
        },
        message: `Processed correct ratings from ${updateStart.toISOString()} to ${updateEnd.toISOString()}`,
      },
      'clickhouse'
    ).catch();

    return {
      status: 'processed',
      start: updateStart,
      end: updateEnd,
    };
  } catch (e) {
    const error = e as Error;
    logToAxiom(
      {
        type: 'error',
        name: 'new-order-process-correct-ratings',
        details: {
          data: {
            lastProcessed,
            pendingCount,
          },
        },
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      },
      'clickhouse'
    ).catch();
    return { status: 'error', error: error.message };
  } finally {
    // Clear lock
    await sysRedis
      .multi()
      .set(REDIS_SYS_KEYS.NEW_ORDER.PROCESSING.LAST_PROCESSED_AT, Date.now().toString())
      .del(REDIS_SYS_KEYS.NEW_ORDER.PROCESSING.LOCK)
      .exec();
    console.log('Cleared processing lock');
  }
}

export async function updatePlayerStats({
  playerId,
  status,
  exp,
  updateAll,
}: {
  playerId: number;
  status: NewOrderImageRatingStatus;
  exp: number;
  updateAll?: boolean;
}) {
  const newExp =
    exp < 0
      ? await expCounter.decrement({ id: playerId, value: exp })
      : await expCounter.increment({ id: playerId, value: exp });
  let stats = {
    exp: newExp,
    fervor: 0,
    smites: 0,
    blessedBuzz: 0,
    pendingBlessedBuzz: 0,
    nextGrantDate: new Date(),
  };

  if (updateAll) {
    const allJudgments = await allJudgmentsCounter.increment({ id: playerId });
    const correctJudgments =
      status === NewOrderImageRatingStatus.Correct
        ? await correctJudgmentsCounter.increment({ id: playerId })
        : await correctJudgmentsCounter.getCount(playerId);

    const fervor = calculateFervor({ correctJudgments, allJudgments });
    await fervorCounter.reset({ id: playerId });
    const newFervor = await fervorCounter.increment({ id: playerId, value: fervor });
    const blessedBuzz = await blessedBuzzCounter.increment({ id: playerId, value: exp });

    // Get pending buzz from Redis counter (auto-queries ClickHouse on cache miss)
    const pendingBlessedBuzz = await pendingBuzzCounter.getCount(playerId);
    const nextGrantDate = dayjs().add(1, 'day').startOf('day').toDate();

    stats = { ...stats, fervor: newFervor, blessedBuzz, pendingBlessedBuzz, nextGrantDate };
  }

  await signalClient
    .send({
      userId: playerId,
      target: SignalMessages.NewOrderPlayerUpdate,
      data: { action: NewOrderSignalActions.UpdateStats, stats },
    })
    .catch((e) => handleLogError(e, 'signals:new-order-update-player-stats'));

  return stats;
}

export function calculateFervor({
  correctJudgments,
  allJudgments,
}: {
  correctJudgments: number;
  allJudgments: number;
}) {
  // New formula: number_of_ratings + (number_correct_ratings * 100)
  // This rewards both activity (total ratings) and accuracy (correct ratings)
  return allJudgments + correctJudgments * 100;
}

export function calculateVoteWeight({ level, smites }: { level: number; smites: number }): number {
  // Weight = 1 + ((level - 20) / 60) - (smites / 6)
  // Assumes Knights start at level 20+
  // Range: 1.0 (new Knight) to 2.0 (level 80, no smites)

  const levelBonus = (level - 20) / 60; // 0 to 1.0 (for levels 20-80)
  const smitePenalty = smites / 6; // 0 to 1.0 (for 0-6 smites)

  const weight = 1 + levelBonus - smitePenalty;

  // Round to 2 decimals for storage
  return Math.round(weight * 100) / 100;
}

type SanityCheck = {
  imageId: number;
  nsfwLevel: NsfwLevel;
  imageUrl: string;
  metadata?: ImageMetadata;
};

export async function getSanityCheckImage(): Promise<SanityCheck | null> {
  if (!sysRedis) return null;

  try {
    // Get all sanity checks from Redis set (format: "imageId:nsfwLevel")
    const allSanityChecks = await sysRedis.sMembers(REDIS_SYS_KEYS.NEW_ORDER.SANITY_CHECKS.POOL);
    if (!allSanityChecks || allSanityChecks.length === 0) {
      return null;
    }

    // Random selection from the pool
    const selected = shuffle(allSanityChecks)[0];
    const [imageIdStr, nsfwLevelStr] = selected.split(':');
    const imageId = Number(imageIdStr);
    const nsfwLevel = Number(nsfwLevelStr) as NsfwLevel;

    // Fetch image data from database (url, metadata)
    const imageData = await dbRead.image.findUnique({
      where: { id: imageId },
      select: { url: true, metadata: true },
    });
    if (!imageData) return null;

    return {
      imageId,
      nsfwLevel, // Use nsfwLevel from Redis, not DB
      imageUrl: imageData.url,
      metadata: imageData.metadata as ImageMetadata | undefined,
    };
  } catch (e) {
    const error = e as Error;
    handleLogError(error, 'new-order-sanity-check-get-image');
    return null;
  }
}

export async function handleSanityCheckFailure(playerId: number, imageId: number) {
  if (!sysRedis) return;

  try {
    // Increment failure counter (auto-expires after 24 hours from first failure)
    const failureCount = await sanityCheckFailuresCounter.increment({ id: playerId });

    if (failureCount === 1) {
      // First failure - warning only
      await createNotification({
        category: NotificationCategory.System,
        type: 'new-order-sanity-warning',
        key: `new-order-sanity-warning:${playerId}:${Date.now()}`,
        userId: playerId,
        details: {
          message: 'Careful! You failed a sanity check. Review your ratings to maintain accuracy.',
        },
      });

      // Emit signal with warning notification
      await signalClient
        .send({
          userId: playerId,
          target: SignalMessages.NewOrderPlayerUpdate,
          data: {
            action: NewOrderSignalActions.UpdateStats,
            stats: { smites: 0 }, // No smite increase yet
            notification: {
              type: 'warning',
              title: '⚠️ Sanity check failed',
              message:
                'You rated a validation image incorrectly. This is your warning - additional failures within 24 hours will result in penalties.',
            },
          },
        })
        .catch((e) => handleLogError(e, 'signals:new-order-sanity-warning'));
    } else {
      // Additional failure - apply smite
      await smitePlayer({
        playerId,
        modId: -1, // System
        reason:
          'You failed another sanity check within 24 hours. A smite penalty has been applied, reducing your vote weight.',
        size: newOrderConfig.smiteSize * 10,
      });
    }

    // Log for analytics
    await logToAxiom({
      type: 'info',
      name: 'new-order-sanity-check-failure',
      details: { playerId, imageId, failureCount },
    });
  } catch (e) {
    const error = e as Error;
    handleLogError(error, 'new-order-handle-sanity-check-failure');
  }
}

/**
 * Process sanity check rating - separate from regular image ratings
 * Validates against gold standard image and applies penalties for failures
 */
export async function addSanityCheckRating({
  playerId,
  imageId,
  rating,
}: {
  playerId: number;
  imageId: number;
  rating: NsfwLevel;
}) {
  if (!sysRedis) throw throwInternalServerError('Redis not available');

  // Check if the exact "imageId:rating" tuple exists in the pool (O(1) operation)
  const isCorrect = await sysRedis.sIsMember(
    REDIS_SYS_KEYS.NEW_ORDER.SANITY_CHECKS.POOL,
    `${imageId}:${rating}`
  );

  // Handle failure if incorrect
  if (!isCorrect) await handleSanityCheckFailure(playerId, imageId);

  // Return result (no XP, no stats update, no ClickHouse tracking)
  return { isCorrect };
}

/**
 * Check weighted consensus:
 * Winning rating has >= 60% weighted votes
 */
async function checkWeightedConsensus({
  imageId,
  voteCount,
}: {
  imageId: number;
  voteCount: number;
}): Promise<NsfwLevel | undefined> {
  try {
    const minForConsensus = voteCount * 0.6 * 100; // Minimum weighted votes to consider consensus
    const votes = await getImageRatingsCounter(imageId).getAll({ withCount: true });
    let winningRating: NsfwLevel | undefined;
    for (const vote of votes) {
      if (vote.score >= minForConsensus) {
        winningRating = Number(vote.value.split('-')[1]) as NsfwLevel;
        break;
      }
    }

    return winningRating;
  } catch (e) {
    const error = e as Error;
    handleLogError(error, 'new-order-check-weighted-consensus');
    return;
  }
}

export async function resetPlayer({
  playerId,
  withNotification,
  reason,
}: {
  playerId: number;
  withNotification?: boolean;
  reason?: string;
}) {
  await dbWrite.$transaction([
    // Reset player back to level 1
    dbWrite.newOrderPlayer.update({
      where: { userId: playerId },
      data: { rankType: NewOrderRankType.Acolyte, exp: 0, fervor: 0, startAt: new Date() },
    }),
    // Cleanse all smites
    dbWrite.newOrderSmite.updateMany({
      where: { targetPlayerId: playerId, cleansedAt: null },
      data: { cleansedAt: new Date(), cleansedReason: reason ?? 'Exceeded smite limit' },
    }),
  ]);

  // Reset all counters for player
  await Promise.all([
    smitesCounter.reset({ id: playerId }),
    correctJudgmentsCounter.reset({ id: playerId }),
    allJudgmentsCounter.reset({ id: playerId }),
    expCounter.reset({ id: playerId }),
    fervorCounter.reset({ id: playerId }),
    blessedBuzzCounter.reset({ id: playerId }),
    pendingBuzzCounter.reset({ id: playerId }),
  ]);

  // Clear rated images cache when player is reset
  await clearRatedImages(playerId);

  const acolyteRank = await getNewOrderRanks({ name: 'Acolyte' });
  await signalClient
    .send({
      userId: playerId,
      target: SignalMessages.NewOrderPlayerUpdate,
      data: {
        action: NewOrderSignalActions.Reset,
        rankType: NewOrderRankType.Acolyte,
        rank: acolyteRank,
        stats: {
          exp: 0,
          fervor: 0,
          smites: 0,
          blessedBuzz: 0,
        },
        notification: {
          type: 'reset',
          title: '🔄 Career Reset',
          message: reason ?? 'Your Knights of New Order career has been reset.',
        },
      },
    })
    .catch((e) => handleLogError(e, 'signals:new-order-reset-player'));

  if (withNotification)
    createNotification({
      category: NotificationCategory.System,
      type: 'new-order-game-over',
      key: `new-order-game-over:${playerId}:${new Date().getTime()}`,
      userId: playerId,
      details: { message: reason ?? 'Your New Order career has been reset.' },
    }).catch();
}

export async function getNewOrderRanks({ name }: { name: string }) {
  const ranks = await fetchThroughCache(
    REDIS_KEYS.CACHES.NEW_ORDER.RANKS,
    async () => {
      const ranks = await dbRead.newOrderRank.findMany({
        orderBy: { type: 'asc' },
        select: { type: true, name: true, minExp: true, iconUrl: true },
      });

      return ranks;
    },
    { ttl: CacheTTL.month }
  );

  const rank = ranks.find((r) => r.name === name);
  if (!rank) throw throwNotFoundError(`No rank found with name ${name}`);

  return rank;
}

async function getRatedImages({
  userId,
  startAt,
  rankType,
}: {
  userId: number;
  startAt: Date;
  rankType?: NewOrderRankType;
}) {
  if (!redis || !clickhouse) throw throwInternalServerError('Redis not available');

  const key = `${REDIS_KEYS.NEW_ORDER.RATED}:${userId}` as const;

  // Try to get from Redis Set first
  const cachedImageIds = await redis.sMembers(key);

  // If cache exists, return the cached image IDs as numbers
  if (cachedImageIds && cachedImageIds.length > 0) {
    return cachedImageIds.map(Number);
  }

  // Cache miss - fetch from ClickHouse
  const AND = [
    `userId = ${userId}`,
    `createdAt >= parseDateTimeBestEffort('${startAt.toISOString()}')`,
  ];
  if (rankType) AND.push(`rank = '${rankType}'`);

  const results = await clickhouse.$query<{ imageId: number }>`
    SELECT DISTINCT "imageId"
    FROM knights_new_order_image_rating
    WHERE ${AND.join(' AND ')}
  `;

  const imageIds = results.map((r) => r.imageId);

  // Store in Redis Set (only if we have results to avoid empty sets)
  if (imageIds.length > 0) {
    await redis.multi().sAdd(key, imageIds.map(String)).expire(key, CacheTTL.day).exec();
  }

  return imageIds;
}

// Helper function to add a newly rated image to the cache
async function addRatedImage(userId: number, imageId: number) {
  if (!redis) return;

  const key = `${REDIS_KEYS.NEW_ORDER.RATED}:${userId}` as const;
  // Add image ID to the set (O(1) operation)
  await redis.multi().sAdd(key, [imageId.toString()]).expire(key, CacheTTL.day).exec();
}

// Helper function to clear rated images cache for a player
export async function clearRatedImages(userId: number) {
  if (!redis) return;

  const key = `${REDIS_KEYS.NEW_ORDER.RATED}:${userId}` as const;
  await redis.del(key);
}

export async function addImageToQueue({
  imageIds,
  rankType,
  // Top is always 1. 3 is default priority
  priority = 3,
}: {
  imageIds: number | number[];
  rankType: NewOrderHighRankType;
  priority?: 1 | 2 | 3;
}) {
  imageIds = Array.isArray(imageIds) ? imageIds : [imageIds];
  if (imageIds.length === 0) return false;

  const images = await dbRead.image.findMany({
    where: { id: { in: imageIds } },
    select: { id: true, url: true, nsfwLevel: true, metadata: true },
  });
  if (images.length === 0) return false;

  // Get active filling slot for this rank
  const activeSlot = await getActiveSlot(rankType, 'filling');
  const pools = poolCounters[rankType][activeSlot];

  await Promise.all(
    images.map((image) => {
      const pool = pools[priority - 1];
      if (!pool) return Promise.resolve(0);
      return pool.getCount(image.id);
    })
  );

  // await signalClient
  //   .topicSend({
  //     topic: `${SignalTopic.NewOrderQueue}:${rankType}`,
  //     target: SignalMessages.NewOrderQueueUpdate,
  //     data: { images, action: NewOrderSignalActions.AddImage },
  //   })
  //   .catch();

  return true;
}

export async function getImagesQueue({
  playerId,
  imageCount = 100,
  queueType,
  isModerator,
}: GetImagesQueueSchema & {
  playerId: number;
  isModerator?: boolean;
}) {
  const player = await getPlayerById({ playerId });

  const validatedImages: Array<{
    id: number;
    url: string;
    nsfwLevel?: number;
    metadata: ImageMetadata & { isSanityCheck?: boolean };
  }> = [];

  // Moderators can specify queueType to test different queues (Acolyte or Knight only)
  // Regular players always use their current rank
  const effectiveRankType = isModerator && queueType ? queueType : player.rankType;

  // Get active rating slot for this rank
  const activeSlot = await getActiveSlot(effectiveRankType, 'rating');
  const rankPools = poolCounters[effectiveRankType][activeSlot];

  const ratedImages = await getRatedImages({
    userId: playerId,
    startAt: player.startAt,
    rankType: player.rankType,
  });
  const seenImageIds = new Set<number>(ratedImages);
  const isKnight = effectiveRankType === NewOrderRankType.Knight;

  const overflowLimit = imageCount * 2;

  for (const pool of rankPools) {
    let offset = 0;

    while (validatedImages.length < overflowLimit) {
      // Fetch images with offset to ensure we get enough images in case some are already rated.
      const poolImages = await pool.getAll({
        limit: overflowLimit,
        offset,
        withCount: true,
      });
      if (poolImages.length === 0) break;

      const imageIds = poolImages
        .filter(({ score }) => (isKnight ? score < newOrderConfig.limits.knightVotes : true))
        .map(({ value }) => Number(value));

      // Filter out already rated images and previously seen images before doing the DB query
      const unratedImageIds = imageIds.filter((id) => !seenImageIds.has(id));
      if (unratedImageIds.length === 0) {
        offset += overflowLimit;
        continue;
      }

      const images = await dbRead.image.findMany({
        where: {
          id: { in: unratedImageIds },
          type: MediaType.image,
          nsfwLevel: { notIn: [0, NsfwLevel.Blocked] },
          post: {
            publishedAt: { not: null, lt: new Date() },
          },
        },
        select: { id: true, url: true, nsfwLevel: true, metadata: true },
      });

      // Add new image IDs to the seen set
      images.forEach((image) => seenImageIds.add(image.id));

      validatedImages.push(
        ...images.map(({ nsfwLevel, ...image }) => ({
          ...image,
          nsfwLevel:
            effectiveRankType === NewOrderRankType.Acolyte || isModerator ? nsfwLevel : undefined,
          metadata: image.metadata as ImageMetadata,
        }))
      );

      if (validatedImages.length >= overflowLimit) break;

      offset += overflowLimit; // Increment offset for the next batch
    }

    if (validatedImages.length >= overflowLimit) break;
  }

  // Shuffle and slice to requested count
  const finalImages = shuffle(validatedImages).slice(0, imageCount);

  // OPTIMIZATION 3: Batch sanity check fetching (Knights only)
  // Skip sanity checks for moderators testing different queues
  if (effectiveRankType === NewOrderRankType.Knight && !isModerator) {
    try {
      // Fetch ALL sanity checks from Redis ONCE
      const allSanityChecks = await sysRedis!.sMembers(REDIS_SYS_KEYS.NEW_ORDER.SANITY_CHECKS.POOL);

      if (allSanityChecks && allSanityChecks.length > 0) {
        // Randomly select N sanity checks
        const selectedCheck = getRandom(allSanityChecks);
        // Extract image IDs for batch DB query
        const [sanityImageId, sanityImageNsfwLevel] = selectedCheck.split(':').map(Number);

        // Batch fetch image data from database
        const sanityImageData = await dbRead.image.findUnique({
          where: { id: sanityImageId },
          select: { id: true, url: true, metadata: true },
        });

        if (sanityImageData) {
          const sanityCheckImage = {
            id: sanityImageId,
            url: sanityImageData.url,
            nsfwLevel: sanityImageNsfwLevel as NsfwLevel,
            metadata: {
              ...(sanityImageData.metadata as ImageMetadata),
              isSanityCheck: true,
            } as ImageMetadata,
          };

          const randomPosition = Math.floor(Math.random() * finalImages.length);
          finalImages.splice(randomPosition, 0, sanityCheckImage);
        }
      }
    } catch (e) {
      const error = e as Error;
      handleLogError(error, 'new-order-sanity-check-batch-fetch');
    }
  }

  return finalImages;
}

export async function getImageRaters({ imageIds }: { imageIds: number[] }) {
  if (!clickhouse) throw throwInternalServerError('Not supported');
  if (imageIds.length === 0) return {};

  // Uses by_imageId projection via GROUP BY pattern (rank filter in HAVING to enable projection)
  const ratings = await clickhouse.$query<{
    userId: number;
    imageId: number;
    rating: NsfwLevel;
  }>`
    SELECT
      userId,
      imageId,
      argMax(rating, createdAt) as rating
    FROM knights_new_order_image_rating
    WHERE imageId IN (${imageIds})
    GROUP BY imageId, userId
    HAVING argMax(rank, createdAt) = '${NewOrderRankType.Knight}'
  `;

  const raters: Record<
    number,
    Partial<
      Record<
        NewOrderRankType,
        { player: Awaited<ReturnType<typeof getPlayerById>>; rating: NsfwLevel }[]
      >
    >
  > = {};

  for (const { userId, imageId, rating } of ratings) {
    if (!raters[imageId])
      raters[imageId] = {
        [NewOrderRankType.Knight]: [],
        [NewOrderRankType.Templar]: [],
      };

    const player = await getPlayerById({ playerId: userId });
    if (!player) continue;

    const rankType = player.rankType ?? NewOrderRankType.Knight;
    const arr = raters[imageId][rankType] ?? [];
    arr.push({ player, rating });
    raters[imageId][rankType] = arr;
  }

  return raters;
}

export async function isImageInQueue({
  imageId,
  rankType,
}: {
  imageId: number;
  rankType: NewOrderHighRankType | NewOrderHighRankType[];
}) {
  if (!Array.isArray(rankType)) rankType = [rankType];

  // Check both slots (a and b) for each rank
  const pools = rankType.flatMap((rank) => {
    const slots = poolCounters[rank];
    return [
      ...slots.a.map((pool) => ({ pool, rank, slot: 'a' as const })),
      ...slots.b.map((pool) => ({ pool, rank, slot: 'b' as const })),
    ];
  });

  const exists = await Promise.all(
    pools.map(async ({ pool, rank, slot }) => {
      const exists = await pool.exists(imageId);
      if (exists) {
        const value = await pool.getCount(imageId);
        return {
          pool,
          value,
          rank,
          slot,
        };
      }
      return null;
    })
  );

  return exists.find((x) => isDefined(x)) || null;
}

export async function getPlayerHistory({
  limit,
  playerId,
  status,
  cursor,
}: GetHistorySchema & { playerId: number }) {
  if (!clickhouse) throw throwInternalServerError('Not supported');

  const player = await getPlayerById({ playerId });
  if (!player) throw throwNotFoundError(`No player with id ${playerId}`);

  const AND = [
    `userId = ${playerId}`,
    `createdAt >= parseDateTimeBestEffort('${player.startAt.toISOString()}')`,
  ];
  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
  if (cursor) AND.push(`createdAt < '${cursor}'`);

  const HAVING = [];
  if (status?.length) HAVING.push(`status IN ('${status.join("','")}')`);

  const judgments = await clickhouse.$query<{
    imageId: number;
    rating: NsfwLevel;
    status: NewOrderImageRatingStatus;
    grantedExp: number;
    multiplier: number;
    originalLevel: NsfwLevel | null;
    lastCreatedAt: Date;
  }>`
    SELECT
      imageId,
      argMax(rating, createdAt)         AS rating,
      argMax(status, createdAt)         AS status,
      argMax(grantedExp, createdAt)     AS grantedExp,
      argMax(multiplier, createdAt)     AS multiplier,
      argMax(originalLevel, createdAt)  AS originalLevel,
      max(createdAt)                    AS lastCreatedAt
    FROM knights_new_order_image_rating
    WHERE ${AND.join(' AND ')}
    GROUP BY imageId
    ${HAVING.length > 0 ? `HAVING ${HAVING.join(' AND ')}` : ''}
    ORDER BY lastCreatedAt DESC
    LIMIT ${limit + 1}
  `;
  if (judgments.length === 0) return { items: [], nextCursor: null };

  let nextCursor: Date | null = null;
  if (judgments.length > limit) nextCursor = judgments.pop()?.lastCreatedAt ?? null;

  const imageIds = judgments.map((j) => j.imageId).sort();
  const images = await dbRead.image.findMany({
    where: {
      id: { in: imageIds },
      nsfwLevel: { notIn: [0, NsfwLevel.Blocked] },
      post: {
        publishedAt: { not: null, lt: new Date() },
      },
    },
    select: { id: true, url: true, nsfwLevel: true, metadata: true },
  });

  return {
    items: judgments
      .map(({ imageId, ...data }) => {
        const image = images.find((i) => i.id === imageId);
        if (!image) return null;

        return {
          ...data,
          image: { ...image, metadata: image.metadata as ImageMetadata },
        };
      })
      .filter(isDefined),
    nextCursor,
  };
}

export async function getPlayersInfinite({
  limit,
  cursor,
  query,
}: InfiniteQueryInput & { query?: string }) {
  const take = limit + 1;
  const players = await dbRead.user.findMany({
    select: userWithPlayerInfoSelect,
    where: {
      username: query ? { contains: query, mode: 'insensitive' } : undefined,
      deletedAt: null,
      bannedAt: null,
      playerInfo: { isNot: null },
      id: { not: -1 }, // Don't show the system user
    },
    cursor: cursor ? { id: cursor } : undefined,
    take,
    orderBy: { id: 'asc' },
  });
  if (players.length === 0) return { items: [], nextCursor: null };

  let nextCursor: number | null = null;
  if (players.length > limit) nextCursor = players.pop()?.id ?? null;

  const playerSmites = await getActiveSmites({ playerIds: players.map((p) => p.id) });

  const playersWithStats = await Promise.all(
    players.map(async (player) => {
      const { playerInfo, ...user } = player;
      if (!playerInfo) return null;

      const stats = await getPlayerStats({ playerId: user.id });
      const activeSmites = playerSmites[player.id] ?? [];
      return {
        ...user,
        ...playerInfo,
        stats,
        activeSmites,
      };
    })
  );

  return { items: playersWithStats.filter(isDefined), nextCursor };
}

async function getActiveSmites({ playerIds }: { playerIds: number[] }) {
  const smites = await dbRead.newOrderSmite.findMany({
    where: { targetPlayerId: { in: playerIds }, cleansedAt: null },
    select: {
      id: true,
      targetPlayerId: true,
      size: true,
      remaining: true,
      createdAt: true,
      reason: true,
    },
  });

  const smiteMap = smites.reduce((acc, smite) => {
    if (!acc[smite.targetPlayerId]) {
      acc[smite.targetPlayerId] = [];
    }
    acc[smite.targetPlayerId].push({
      id: smite.id,
      size: smite.size,
      remaining: smite.remaining,
      createdAt: smite.createdAt,
      reason: smite.reason,
    });
    return acc;
  }, {} as Record<number, { id: number; size: number; remaining: number; createdAt: Date; reason?: string | null }[]>);

  return smiteMap;
}

export async function manageSanityChecks({ add, remove }: { add?: number[]; remove?: number[] }) {
  try {
    const poolKey = REDIS_SYS_KEYS.NEW_ORDER.SANITY_CHECKS.POOL;

    // Process removals first
    if (remove && remove.length > 0) {
      // Convert imageIds to the format imageId:nsfwLevel and remove from Redis set
      // We need to find all members that match the imageIds
      const allMembers = await sysRedis.sMembers(poolKey);
      const toRemove = allMembers.filter((member) => {
        const [imageId] = member.split(':');
        return remove.includes(Number(imageId));
      });

      if (toRemove.length > 0) {
        await sysRedis.sRem(poolKey, toRemove);
      }
    }

    // Process additions
    if (add && add.length > 0) {
      // Fetch images from database to get their nsfwLevel
      const images = await dbRead.image.findMany({
        where: { id: { in: add } },
        select: { id: true, nsfwLevel: true },
      });

      // Convert to format imageId:nsfwLevel (using bitwise flag values)
      const members = images.map((img) => `${img.id}:${img.nsfwLevel}`);

      if (members.length > 0) {
        await sysRedis.sAdd(poolKey, members);
      }
    }

    // Return current pool state
    const currentPool = await sysRedis.sMembers(poolKey);
    const poolData = currentPool.map((member) => {
      const [imageId, nsfwLevel] = member.split(':');
      return {
        imageId: Number(imageId),
        nsfwLevel: Number(nsfwLevel),
      };
    });

    return {
      ok: true,
      added: add?.length ?? 0,
      removed: remove?.length ?? 0,
      totalInPool: poolData.length,
      pool: poolData,
    };
  } catch (e) {
    const error = e as Error;
    handleLogError(error, 'new-order-sanity-check-manage');
    throw throwInternalServerError(error);
  }
}

/**
 * Admin testing function for simulating votes in the Knights of New Order system.
 * Allows moderators to test consensus mechanics by submitting votes as different users.
 *
 * Key features:
 * - Vote as any user (auto-joins if needed)
 * - Auto-adds image to queue if not present
 * - Uses real voting logic for authentic testing
 * - Returns detailed consensus and queue state
 *
 * @param imageId - The image to vote on
 * @param rating - The NSFW level rating to submit
 * @param userId - Optional: The user to vote as (defaults to moderator's ID)
 * @param damnedReason - Optional: Reason for blocking content
 * @param moderatorId - The moderator performing the test
 */
export async function submitTestVote({
  imageId,
  rating,
  userId,
  damnedReason,
  moderatorId,
  level,
  smites,
}: {
  imageId: number;
  rating: NsfwLevel;
  userId?: number;
  damnedReason?: NewOrderDamnedReason;
  moderatorId: number;
  level?: number;
  smites?: number;
}) {
  try {
    // Determine which user to vote as
    const votingUserId = userId ?? moderatorId;

    // Get or create player for the voting user
    let player = await dbRead.newOrderPlayer.findUnique({
      where: { userId: votingUserId },
      select: playerInfoSelect,
    });

    if (!player) {
      // Auto-join the user if they're not in the game yet
      await joinGame({ userId: votingUserId });
      player = await dbRead.newOrderPlayer.findUnique({
        where: { userId: votingUserId },
        select: playerInfoSelect,
      });
      if (!player) throw throwInternalServerError('Failed to create player');
    }

    const { user, ...playerData } = player;
    const stats = await getPlayerStats({ playerId: votingUserId });
    const fullPlayer = { ...playerData, ...user, stats };

    // Get image details
    const image = await dbRead.image.findUnique({
      where: { id: imageId },
      select: { id: true, nsfwLevel: true, url: true },
    });

    if (!image) throw throwNotFoundError(`No image with id ${imageId}`);

    // Check which queue the image is in
    const valueInQueue = await isImageInQueue({
      imageId,
      rankType: [NewOrderRankType.Knight],
    });

    let currentQueue: NewOrderRankType | null = null;
    let currentVoteCount = 0;

    if (valueInQueue) {
      currentQueue = valueInQueue.rank as NewOrderRankType;
      currentVoteCount = valueInQueue.value;
    } else {
      // If not in queue, add it to Knight queue for testing
      await addImageToQueue({
        imageIds: imageId,
        rankType: NewOrderRankType.Knight,
        priority: 1,
      });
      currentQueue = NewOrderRankType.Knight;
      currentVoteCount = 0;
    }

    // If custom level/smites provided, use manual vote processing with custom weights
    // Otherwise use the standard processImageRating flow
    if (level !== undefined || smites !== undefined) {
      // Manual vote processing with custom vote weight
      const customLevel = level ?? getLevelProgression(fullPlayer.stats.exp).level;
      const customSmites = smites ?? fullPlayer.stats.smites;
      const customVoteWeight = Math.round(
        calculateVoteWeight({ level: customLevel, smites: customSmites }) * 100
      );

      // Increment vote count in queue
      const newVoteCount = await valueInQueue!.pool.increment({ id: imageId });

      // Increment vote weight for this rating
      await getImageRatingsCounter(imageId).increment({
        id: `${fullPlayer.rankType}-${rating}`,
        value: customVoteWeight,
      });

      // Record test vote in ClickHouse for audit trail
      if (clickhouse) {
        await clickhouse.$exec`
          INSERT INTO knights_new_order_image_rating (
            userId, imageId, rating, status, rank, grantedExp, multiplier, createdAt
          ) VALUES (
            ${votingUserId},
            ${imageId},
            ${rating},
            '${NewOrderImageRatingStatus.Pending}',
            '${fullPlayer.rankType}',
            100,
            1,
            now()
          )
        `;
      }

      // Check for blocked votes (≥200 weighted score)
      const blockedVotes = await getImageRatingsCounter(imageId).getCount(
        `${fullPlayer.rankType}-${NsfwLevel.Blocked}`
      );
      if (blockedVotes >= 200) {
        // Remove from queue (note: CSAM report should be created via regular flow, not test votes)
        console.log(
          `Test vote triggered block threshold for image ${imageId} with ${blockedVotes} weighted votes (removed from queue)`
        );
        await valueInQueue!.pool.reset({ id: imageId });
        await notifyQueueUpdate(valueInQueue!.rank, imageId, NewOrderSignalActions.RemoveImage);
      }

      // Check for consensus
      const consensus = await checkWeightedConsensus({ imageId, voteCount: newVoteCount });
      if (consensus !== undefined) {
        // Consensus reached - update image and remove from queue
        await updateImageNsfwLevel({
          id: imageId,
          nsfwLevel: consensus,
          userId: votingUserId,
          isModerator: false,
          status: 'Actioned',
        });
        await updatePendingImageRatings({ imageId, rating: consensus });
        await valueInQueue!.pool.reset({ id: imageId });
        await notifyQueueUpdate(valueInQueue!.rank, imageId, NewOrderSignalActions.RemoveImage);
      } else if (newVoteCount >= newOrderConfig.limits.knightVotes) {
        // Max votes reached without consensus - remove from queue
        await valueInQueue!.pool.reset({ id: imageId });
        await notifyQueueUpdate(valueInQueue!.rank, imageId, NewOrderSignalActions.RemoveImage);
      }
    } else {
      // Use standard vote processing (no custom weights)
      await processImageRating({
        playerId: votingUserId,
        imageId,
        rating,
        damnedReason,
        isModerator: false, // Process as regular vote to test consensus mechanics
      });
    }

    // Get updated vote counts and consensus state
    const updatedValueInQueue = await isImageInQueue({
      imageId,
      rankType: [NewOrderRankType.Knight],
    });

    const stillInQueue = updatedValueInQueue !== null;
    const newVoteCount = updatedValueInQueue?.value ?? currentVoteCount + 1;

    // Get current vote distribution (weighted)
    const voteDistribution = await getImageRatingsCounter(imageId).getAll({ withCount: true });

    // Check if consensus was reached (simplified API)
    let consensusData = null;
    if (currentQueue === NewOrderRankType.Knight) {
      if (!stillInQueue) {
        // Image removed from queue - consensus was reached or max votes hit
        const finalImage = await dbRead.image.findUnique({
          where: { id: imageId },
          select: { nsfwLevel: true },
        });

        consensusData = {
          reached: true,
          finalRating: finalImage?.nsfwLevel,
          method: newVoteCount >= newOrderConfig.limits.knightVotes ? 'consensus' : 'max_votes',
        };
      } else {
        // Check current consensus status (using simplified API)
        const consensus = await checkWeightedConsensus({ imageId, voteCount: newVoteCount });

        // Calculate total weighted votes
        const totalWeightedVotes = voteDistribution.reduce((sum, v) => sum + v.score, 0);

        consensusData = {
          reached: consensus !== undefined,
          currentLeader: consensus,
          totalWeightedVotes,
          votesRequired: newOrderConfig.limits.knightVotes,
          maxVotes: newOrderConfig.limits.maxKnightVotes,
          threshold: '60% of weighted votes',
        };
      }
    }

    // Calculate player vote weight for display (use custom values if provided)
    const displayLevel = level ?? getLevelProgression(fullPlayer.stats.exp).level;
    const displaySmites = smites ?? fullPlayer.stats.smites;
    const voteWeight = calculateVoteWeight({
      level: displayLevel,
      smites: displaySmites,
    });

    return {
      ok: true,
      vote: {
        votingUserId,
        votingUserRank: fullPlayer.rankType,
        votingUserLevel: displayLevel,
        votingUserSmites: displaySmites,
        voteWeight: voteWeight,
        imageId,
        rating,
        imageCurrentNsfwLevel: image.nsfwLevel,
        customWeightUsed: level !== undefined || smites !== undefined,
      },
      queue: {
        queueType: currentQueue,
        wasInQueue: valueInQueue !== null,
        stillInQueue,
        voteCount: newVoteCount,
        voteLimit:
          currentQueue === NewOrderRankType.Knight
            ? newOrderConfig.limits.knightVotes
            : newOrderConfig.limits.templarVotes,
      },
      consensus: consensusData,
      voteDistribution: voteDistribution.map(({ value, score }) => {
        const [rank, rating] = value.split('-');
        return {
          rank,
          rating: Number(rating),
          weightedScore: score,
          // Convert weighted score back to approximate vote count
          approximateVotes: Math.round(score / 100),
        };
      }),
      playerStats: {
        stats: fullPlayer.stats,
      },
    };
  } catch (e) {
    const error = e as Error;
    handleLogError(error, 'new-order-test-vote');
    throw error;
  }
}

/**
 * Helper function to get detailed queue state for testing and debugging.
 * Shows which images are in which queues and their current vote counts.
 */
export async function getQueueStateForTesting(imageId?: number) {
  try {
    const state: {
      knight: { imageId: number; voteCount: number; priority: number; slot: 'a' | 'b' }[];
      templar: { imageId: number; voteCount: number; priority: number; slot: 'a' | 'b' }[];
      totalImages: number;
    } = {
      knight: [],
      templar: [],
      totalImages: 0,
    };

    if (imageId) {
      // Check specific image across all queues and both slots
      for (const rankType of [NewOrderRankType.Knight]) {
        for (const slot of ['a', 'b'] as const) {
          for (let priority = 1; priority <= 3; priority++) {
            const pool = poolCounters[rankType][slot][priority - 1];
            const count = await pool.getCount(imageId);
            if (count !== null) {
              const queueData = { imageId, voteCount: count, priority, slot };

              if (rankType === NewOrderRankType.Knight) {
                state.knight.push(queueData);
              } else {
                state.templar.push(queueData);
              }
            }
          }
        }
      }
    } else {
      // Get all images from all queues and both slots
      for (const rankType of [NewOrderRankType.Knight]) {
        for (const slot of ['a', 'b'] as const) {
          for (let priority = 1; priority <= 3; priority++) {
            const pool = poolCounters[rankType][slot][priority - 1];
            const allValues = await pool.getAll({ withCount: true });

            const images = allValues.map(({ value, score }: { value: string; score: number }) => ({
              imageId: Number(value),
              voteCount: score,
              priority,
              slot,
            }));

            if (rankType === NewOrderRankType.Knight) {
              state.knight.push(...images);
            } else {
              state.templar.push(...images);
            }
          }
        }
      }
    }

    state.totalImages = state.knight.length + state.templar.length;

    return {
      ok: true,
      state,
      imageId: imageId ?? null,
    };
  } catch (e) {
    const error = e as Error;
    handleLogError(error, 'new-order-get-queue-state');
    throw error;
  }
}

/**
 * Helper function to get vote details for a specific image.
 * Shows all votes, weighted distribution, and consensus status.
 */
export async function getVoteDetailsForTesting(imageId: number) {
  try {
    // Get image details
    const image = await dbRead.image.findUnique({
      where: { id: imageId },
      select: { id: true, nsfwLevel: true, url: true },
    });

    if (!image) throw throwNotFoundError(`No image with id ${imageId}`);

    // Get all ratings from ClickHouse
    let allRatings: {
      userId: number;
      rating: NsfwLevel;
      status: string;
      rank: string;
      createdAt: Date;
    }[] = [];

    if (clickhouse) {
      allRatings = await clickhouse.$query<{
        userId: number;
        rating: NsfwLevel;
        status: string;
        rank: string;
        createdAt: Date;
      }>`
        SELECT 
          userId,
          rating,
          status,
          rank,
          createdAt
        FROM knights_new_order_image_rating
        WHERE imageId = ${imageId}
        ORDER BY createdAt ASC
      `;
    }

    // Get weighted vote distribution from Redis
    const voteDistribution = await getImageRatingsCounter(imageId).getAll({ withCount: true });

    // Check consensus if in Knight queue
    let consensusData = null;
    const valueInQueue = await isImageInQueue({
      imageId,
      rankType: NewOrderRankType.Knight,
    });

    if (valueInQueue) {
      const voteCount = valueInQueue.value;
      const consensus = await checkWeightedConsensus({ imageId, voteCount });

      // Calculate total and percentage for winning rating
      const totalWeightedVotes = voteDistribution.reduce((sum, v) => sum + v.score, 0);
      const winningVoteData = consensus
        ? voteDistribution.find((v) => v.value === `Knight-${consensus}`)
        : null;

      consensusData = {
        hasConsensus: consensus !== undefined,
        winningRating: consensus,
        winningPercentage: winningVoteData
          ? Math.round((winningVoteData.score / totalWeightedVotes) * 100)
          : 0,
        totalWeightedVotes,
        currentVotes: voteCount,
        voteLimit: newOrderConfig.limits.knightVotes,
        maxVotes: newOrderConfig.limits.maxKnightVotes,
        threshold: `${voteCount * 0.6 * 100} weighted votes (60%)`,
      };
    }

    return {
      ok: true,
      image: {
        id: image.id,
        currentNsfwLevel: image.nsfwLevel,
        url: image.url,
      },
      votes: {
        total: allRatings.length,
        details: allRatings,
      },
      distribution: voteDistribution.map(({ value, score }) => {
        const [rank, rating] = value.split('-');
        return {
          rank,
          rating: Number(rating),
          weightedScore: score,
          approximateVotes: Math.round(score / 100),
        };
      }),
      consensus: consensusData,
    };
  } catch (e) {
    const error = e as Error;
    handleLogError(error, 'new-order-get-vote-details');
    throw error;
  }
}

/**
 * Helper function to reset a specific image's vote state.
 * Useful for cleaning up test data and restarting test scenarios.
 */
export async function resetImageVotesForTesting(imageId: number) {
  try {
    // Remove from all queues and both slots
    for (const rankType of [NewOrderRankType.Knight]) {
      for (const slot of ['a', 'b'] as const) {
        for (let priority = 1; priority <= 3; priority++) {
          await poolCounters[rankType][slot][priority - 1].reset({ id: imageId });
        }
      }
    }

    // Clear weighted vote distribution counter
    const counter = getImageRatingsCounter(imageId);
    // Redis counters don't have a clear-all method, so we need to get all keys first
    const allVotes = await counter.getAll({ withCount: true });

    // Reset each vote type to 0
    for (const vote of allVotes) {
      await counter.decrement({ id: vote.value, value: vote.score });
    }

    // Note: We don't delete ClickHouse records as they're append-only
    // They serve as historical record of test votes

    return {
      ok: true,
      imageId,
      message: 'Image vote state reset (removed from queues and cleared Redis counters)',
      clearedVoteTypes: allVotes.length,
    };
  } catch (e) {
    const error = e as Error;
    handleLogError(error, 'new-order-reset-image-votes');
    throw error;
  }
}
