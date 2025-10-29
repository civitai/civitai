import type { Tracker } from '~/server/clickhouse/client';
import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL, newOrderConfig } from '~/server/common/constants';
import {
  NewOrderImageRatingStatus,
  NewOrderSignalActions,
  NotificationCategory,
  NsfwLevel,
  SignalMessages,
  SignalTopic,
} from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import type { NewOrderCounter } from '~/server/games/new-order/utils';
import {
  acolyteFailedJudgments,
  allJudgmentsCounter,
  blessedBuzzCounter,
  checkVotingRateLimit,
  correctJudgmentsCounter,
  expCounter,
  fervorCounter,
  getImageRatingsCounter,
  poolCounters,
  sanityCheckFailuresCounter,
  smitesCounter,
} from '~/server/games/new-order/utils';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { InfiniteQueryInput } from '~/server/schema/base.schema';
import type {
  AddImageRatingInput,
  CleanseSmiteInput,
  GetHistorySchema,
  GetImagesQueueSchema,
  SmitePlayerInput,
} from '~/server/schema/games/new-order.schema';
import type { ImageMetadata } from '~/server/schema/media.schema';
import { playerInfoSelect, userWithPlayerInfoSelect } from '~/server/selectors/user.selector';
import { handleBlockImages, updateImageNsfwLevel } from '~/server/services/image.service';
import { createNotification } from '~/server/services/notification.service';
import { claimCosmetic } from '~/server/services/user.service';
import { bustFetchThroughCache, fetchThroughCache } from '~/server/utils/cache-helpers';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import {
  handleLogError,
  throwBadRequestError,
  throwInternalServerError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { getLevelProgression } from '~/server/utils/game-helpers';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import { shuffle } from '~/utils/array-helpers';
import { signalClient } from '~/utils/signal-client';
import { isDefined } from '~/utils/type-guards';

type NewOrderHighRankType = NewOrderRankType | 'Inquisitor';

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
  return { ...playerData, ...userInfo, stats: { exp: 0, fervor: 0, smites: 0, blessedBuzz: 0 } };
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
  const [exp, fervor, smites, blessedBuzz] = await Promise.all([
    expCounter.getCount(playerId),
    fervorCounter.getCount(playerId),
    smitesCounter.getCount(playerId),
    blessedBuzzCounter.getCount(playerId),
  ]);

  return { exp, fervor, smites, blessedBuzz };
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
          title: '⚡ You Have Been Smitten',
          message: reason || 'A moderator has applied a smite penalty to your account.',
        },
      },
    })
    .catch((e) => handleLogError(e, 'signals:new-order-smite-player'));

  createNotification({
    category: NotificationCategory.Other,
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

  if (data.count === 0) return; // Nothing done :shrug:

  await signalClient
    .send({
      userId: playerId,
      target: SignalMessages.NewOrderPlayerUpdate,
      data: { action: NewOrderSignalActions.UpdateStats, stats: { smites: 0 } },
    })
    .catch((e) => handleLogError(e, 'signals:new-order-smite-cleansed-all'));

  createNotification({
    category: NotificationCategory.Other,
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
  await signalClient
    .send({
      userId: playerId,
      target: SignalMessages.NewOrderPlayerUpdate,
      data: {
        action: NewOrderSignalActions.UpdateStats,
        stats: { smites: smiteCount },
        notification: {
          type: 'cleanse',
          title: '✨ Smite Cleansed',
          message:
            'One of your smites has been removed! Keep up the good work with accurate ratings.',
        },
      },
    })
    .catch((e) => handleLogError(e, 'signals:new-order-smite-cleansed'));

  createNotification({
    category: NotificationCategory.Other,
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
  if (!valueInQueue) return false; // Image not found in any valid queue for this player

  // Check if vote limits have been reached (using consistent logic)
  const currentVoteCount = valueInQueue.value;
  const voteLimit = getVoteLimitForRank(valueInQueue.rank);

  if (currentVoteCount >= voteLimit && valueInQueue.rank !== NewOrderRankType.Acolyte) {
    // Vote limit already reached, remove from queue
    await valueInQueue.pool.reset({ id: imageId });
    await notifyQueueUpdate(valueInQueue.rank, imageId, NewOrderSignalActions.RemoveImage);
    return false;
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
    await valueInQueue.pool.reset({ id: imageId });

    if (rating === NsfwLevel.Blocked) {
      await handleBlockImages({ ids: [imageId] });
    }

    await notifyQueueUpdate('Inquisitor', imageId, NewOrderSignalActions.RemoveImage);

    // Finish the rating process for mods
    return true;
  }

  // Atomically increment vote count and check limits
  const newVoteCount = await valueInQueue.pool.increment({ id: imageId });
  await getImageRatingsCounter(imageId).increment({ id: `${player.rank.name}-${rating}` });

  let currentNsfwLevel: NsfwLevel | undefined = image.nsfwLevel;

  // Check if we've reached vote limits after the atomic increment
  const reachedKnightVoteLimit =
    player.rankType === NewOrderRankType.Knight &&
    valueInQueue.rank === NewOrderRankType.Knight &&
    newVoteCount >= newOrderConfig.limits.knightVotes;

  // Now, process what to do with the image:
  if (reachedKnightVoteLimit) {
    // Check weighted consensus with new 3-requirement system
    const consensus = await checkWeightedConsensus({ imageId });

    if (!consensus.hasConsensus) {
      // No consensus reached after 5 votes - remove from queue
      await handleNoConsensus({
        imageId,
        rankType: NewOrderRankType.Knight,
        pool: valueInQueue.pool,
      });
    } else {
      // We have consensus - apply the decision directly (no escalation)
      const finalRating = consensus.winningRating!;

      // Apply the consensus decision
      currentNsfwLevel = await updateImageNsfwLevel({
        id: imageId,
        nsfwLevel: finalRating,
        userId: playerId,
        isModerator: true,
        activity: 'setNsfwLevelKono',
        status: 'Actioned',
      });

      // Process rewards/penalties for all Knights who voted
      await processConsensusRewards({ imageId, finalRating });

      // Update pending ratings
      await updatePendingImageRatings({ imageId, rating: finalRating });

      // Clear image from the pool
      await valueInQueue.pool.reset({ id: imageId });
      await notifyQueueUpdate(NewOrderRankType.Knight, imageId, NewOrderSignalActions.RemoveImage);
    }
  }

  const isAcolyte = player.rankType === NewOrderRankType.Acolyte;
  let status: NewOrderImageRatingStatus;

  if (isAcolyte) {
    status =
      currentNsfwLevel === rating
        ? NewOrderImageRatingStatus.AcolyteCorrect
        : NewOrderImageRatingStatus.AcolyteFailed;
  } else if (reachedKnightVoteLimit) {
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

  // Calculate vote weight for this rating
  const playerLevel = getLevelProgression(player.stats.exp).level;
  const playerSmites = player.stats.smites;
  const voteWeight = calculateVoteWeight({ level: playerLevel, smites: playerSmites });

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
        voteWeight,
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
              size: 10,
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

  // No need to await mainly cause it makes no difference as the user has a queue in general.
  bustFetchThroughCache(`${REDIS_KEYS.NEW_ORDER.RATED}:${playerId}`);

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

export async function updatePendingImageRatings({
  imageId,
  rating,
}: {
  imageId: number;
  rating: NsfwLevel;
}) {
  if (!clickhouse) throw throwInternalServerError('Not supported');

  // Get players that rated this image:
  const votes = await clickhouse.$query<{ userId: number; createdAt: Date; rating: number }>`
    SELECT
      DISTINCT "userId",
      ir."createdAt",
      ir.rating
    FROM knights_new_order_image_rating ir
    WHERE "imageId" = ${imageId}
      AND status = '${NewOrderImageRatingStatus.Pending}'
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
}

const PROCESS_MIN = 100; // number of items that will trigger early processing
const PROCESS_INTERVAL = 30; // seconds
async function processFinalRatings() {
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
              WHEN new.rating = orig.rating THEN 'Correct'
              ELSE 'Failed'
          END as status,
          orig.grantedExp,
          CASE
              WHEN new.rating = orig.rating THEN 1
              ELSE -1
          END as multiplier,
          new.createdAt as createdAt,
          orig.ip,
          orig.userAgent,
          orig.deviceId,
          orig.rank,
          orig.originalLevel
      FROM knights_new_order_image_rating orig
      JOIN batch new ON new.imageId = orig.imageId
      WHERE orig.imageId IN (SELECT imageId FROM batch);
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
  let stats = { exp: newExp, fervor: 0, smites: 0, blessedBuzz: 0 };

  if (updateAll) {
    const allJudgments =
      status !== NewOrderImageRatingStatus.Pending
        ? await allJudgmentsCounter.increment({ id: playerId })
        : await allJudgmentsCounter.getCount(playerId);
    const correctJudgments =
      status === NewOrderImageRatingStatus.Correct
        ? await correctJudgmentsCounter.increment({ id: playerId })
        : await correctJudgmentsCounter.getCount(playerId);

    const fervor = calculateFervor({ correctJudgments, allJudgments });
    await fervorCounter.reset({ id: playerId });
    const newFervor = await fervorCounter.increment({ id: playerId, value: fervor });
    const blessedBuzz = await blessedBuzzCounter.increment({ id: playerId, value: exp });

    stats = { ...stats, fervor: newFervor, blessedBuzz };
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
        category: NotificationCategory.Other,
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
              title: '⚠️ Sanity Check Failed',
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
        size: 10,
      });
    }

    // Log for analytics
    await logToAxiom(
      {
        type: 'info',
        name: 'new-order-sanity-check-failure',
        details: { playerId, imageId, failureCount },
      },
      'new-order'
    );
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

  // Bust player cache
  // bustFetchThroughCache(`${REDIS_KEYS.NEW_ORDER.RATED}:${playerId}`);

  // Return result (no XP, no stats update, no ClickHouse tracking)
  return { isCorrect };
}

/**
 * Handle no consensus situation when 5 Knights vote but don't reach agreement
 * Removes image from queue without penalties or rewards
 */
async function handleNoConsensus({
  imageId,
  rankType,
  pool,
}: {
  imageId: number;
  rankType: NewOrderRankType;
  pool: NewOrderCounter;
}) {
  try {
    // Remove from queue
    await pool.reset({ id: imageId });
    await notifyQueueUpdate(rankType, imageId, NewOrderSignalActions.RemoveImage);

    // Log for analytics
    await logToAxiom(
      {
        type: 'info',
        name: 'new-order-no-consensus',
        details: { imageId, rankType },
        message: `Image ${imageId} removed after 5 votes with no consensus`,
      },
      'new-order'
    );
  } catch (e) {
    const error = e as Error;
    handleLogError(error, 'handleNoConsensus');
  }
}

/**
 * Process rewards/penalties after consensus is reached
 * Deducts XP from Knights who voted incorrectly
 */
async function processConsensusRewards({
  imageId,
  finalRating,
}: {
  imageId: number;
  finalRating: NsfwLevel;
}) {
  if (!clickhouse) return;

  try {
    // Query all Knight votes for this image
    const votes = await clickhouse.$query<{
      userId: number;
      rating: number;
      grantedExp: number;
    }>`
      SELECT userId, rating, grantedExp
      FROM knights_new_order_image_rating
      WHERE imageId = ${imageId}
        AND rank = 'Knight'
        AND status = 'Pending'
    `;

    // Process each vote
    for (const vote of votes) {
      const wasCorrect = vote.rating === finalRating;

      if (!wasCorrect) {
        // Deduct the XP that was granted
        const xpToDeduct = -(vote.grantedExp || newOrderConfig.baseExp);
        await updatePlayerStats({
          playerId: vote.userId,
          status: NewOrderImageRatingStatus.Failed,
          exp: xpToDeduct,
          updateAll: true,
        });
      } else {
        // Update status to Correct for proper fervor tracking
        // No XP change needed (already granted when they voted)
        await updatePlayerStats({
          playerId: vote.userId,
          status: NewOrderImageRatingStatus.Correct,
          exp: 0,
          updateAll: true,
        });
      }

      // Update the vote status in ClickHouse
      // Note: This requires a separate update query since ClickHouse doesn't support UPDATE directly
      // We'll handle this through the next tracking call for this user
    }

    // Log for analytics
    await logToAxiom(
      {
        type: 'info',
        name: 'new-order-consensus-rewards',
        details: {
          imageId,
          finalRating,
          totalVotes: votes.length,
          correctVotes: votes.filter((v) => v.rating === finalRating).length,
        },
      },
      'new-order'
    );
  } catch (e) {
    const error = e as Error;
    handleLogError(error, 'processConsensusRewards');
  }
}

/**
 * Check weighted consensus with 3 requirements:
 * 1. Winning rating has >3.0 weighted votes
 * 2. Winning rating has >50% of total weighted votes
 * 3. At least 5 individual Knights voted
 */
async function checkWeightedConsensus({ imageId }: { imageId: number }): Promise<{
  hasConsensus: boolean;
  winningRating?: NsfwLevel;
  weightedTotals: Record<number, { weighted: number; count: number }>;
  totalWeightedVotes: number;
  totalKnights: number;
}> {
  if (!clickhouse) throw throwInternalServerError('Not supported');

  try {
    // Query all Knight votes for this image
    const votes = await clickhouse.$query<{
      rating: number;
      voteWeight: number;
      userId: number;
    }>`
      SELECT rating, voteWeight, userId
      FROM knights_new_order_image_rating
      WHERE imageId = ${imageId}
        AND rank = 'Knight'
        AND status = 'Pending'
    `;

    if (votes.length === 0) {
      return {
        hasConsensus: false,
        weightedTotals: {},
        totalWeightedVotes: 0,
        totalKnights: 0,
      };
    }

    // Calculate weighted totals by rating
    const weightedTotals: Record<number, { weighted: number; count: number }> = {};
    let totalWeightedVotes = 0;
    const uniqueKnights = new Set<number>();

    for (const vote of votes) {
      const rating = vote.rating;
      const weight = vote.voteWeight || 1.0;

      if (!weightedTotals[rating]) {
        weightedTotals[rating] = { weighted: 0, count: 0 };
      }

      weightedTotals[rating].weighted += weight;
      weightedTotals[rating].count += 1;
      totalWeightedVotes += weight;
      uniqueKnights.add(vote.userId);
    }

    const totalKnights = uniqueKnights.size;

    // Requirement 3: At least 5 Knights
    if (totalKnights < 5) {
      return {
        hasConsensus: false,
        weightedTotals,
        totalWeightedVotes,
        totalKnights,
      };
    }

    // Find highest weighted rating
    let maxWeighted = 0;
    let winningRating: NsfwLevel | undefined;

    for (const [rating, totals] of Object.entries(weightedTotals)) {
      if (totals.weighted > maxWeighted) {
        maxWeighted = totals.weighted;
        winningRating = Number(rating) as NsfwLevel;
      }
    }

    // Requirement 1: >3.0 weighted votes
    const meetsWeightThreshold = maxWeighted > 3.0;
    // Requirement 2: >50% majority
    const meetsMajority = maxWeighted / totalWeightedVotes > 0.5;
    const hasConsensus = meetsWeightThreshold && meetsMajority;

    return {
      hasConsensus,
      winningRating: hasConsensus ? winningRating : undefined,
      weightedTotals,
      totalWeightedVotes,
      totalKnights,
    };
  } catch (e) {
    const error = e as Error;
    handleLogError(error, 'new-order-check-weighted-consensus');
    return {
      hasConsensus: false,
      weightedTotals: {},
      totalWeightedVotes: 0,
      totalKnights: 0,
    };
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
  ]);

  bustFetchThroughCache(`${REDIS_KEYS.NEW_ORDER.RATED}:${playerId}`);

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
      category: NotificationCategory.Other,
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
  const AND = [
    `userId = ${userId}`,
    `createdAt >= parseDateTimeBestEffort('${startAt.toISOString()}')`,
  ];
  if (rankType) AND.push(`rank = '${rankType}'`);

  const images = await fetchThroughCache(
    `${REDIS_KEYS.NEW_ORDER.RATED}:${userId}`,
    async () => {
      const results = await clickhouse!.$query<{ imageId: number }>`
        SELECT
          DISTINCT "imageId"
        FROM knights_new_order_image_rating
        WHERE ${AND.join(' AND ')}
      `;
      return results.map((r) => r.imageId);
    },
    { ttl: CacheTTL.xs }
  );

  return images;
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

  const pools = poolCounters[rankType];
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
  const rankPools = poolCounters[effectiveRankType];

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
          nsfwLevel: { not: 0, notIn: [NsfwLevel.Blocked] },
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
    const sanityCheckCount = Math.max(1, Math.ceil(imageCount * 0.01));

    try {
      // Fetch ALL sanity checks from Redis ONCE
      const allSanityChecks = await sysRedis!.sMembers(REDIS_SYS_KEYS.NEW_ORDER.SANITY_CHECKS.POOL);

      if (allSanityChecks && allSanityChecks.length > 0) {
        // Randomly select N sanity checks
        const selectedChecks = shuffle(allSanityChecks).slice(0, sanityCheckCount);

        // Extract image IDs for batch DB query
        const sanityImageIds = selectedChecks.map((check) => Number(check.split(':')[0]));

        // Batch fetch image data from database
        const sanityImageData = await dbRead.image.findMany({
          where: { id: { in: sanityImageIds } },
          select: { id: true, url: true, metadata: true },
        });

        // Create a map for quick lookup
        const imageDataMap = new Map(sanityImageData.map((img) => [img.id, img]));

        // Insert sanity checks into final images
        selectedChecks.forEach((check) => {
          const [imageIdStr, nsfwLevelStr] = check.split(':');
          const imageId = Number(imageIdStr);
          const imageData = imageDataMap.get(imageId);

          if (imageData) {
            const sanityCheckImage = {
              id: imageId,
              url: imageData.url,
              nsfwLevel: Number(nsfwLevelStr) as NsfwLevel,
              metadata: {
                ...(imageData.metadata as ImageMetadata),
                isSanityCheck: true,
              } as ImageMetadata,
            };

            // Insert at random position
            const randomPosition = Math.floor(Math.random() * finalImages.length);
            finalImages.splice(randomPosition, 0, sanityCheckImage);
          }
        });
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

  const ratings = await clickhouse.$query<{
    userId: number;
    imageId: number;
    rating: NsfwLevel;
  }>`
    SELECT "userId", "imageId", any("rating") as "rating"
    FROM (
      SELECT
        "userId",
        "imageId",
        "rating",
        row_number() OVER (PARTITION BY "imageId" ORDER BY "createdAt" DESC) as rn
      FROM knights_new_order_image_rating
      WHERE "imageId" IN (${imageIds})
        AND rank IN ('${NewOrderRankType.Knight}', '${NewOrderRankType.Templar}')
    )
    WHERE rn <= 7 -- max 5 knights + 2 templars
    GROUP BY "userId", "imageId"
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
  const pools = rankType
    .map((rank) =>
      poolCounters[rank].map((pool) => ({
        pool,
        rank,
      }))
    )
    .flat();

  const exists = await Promise.all(
    pools.map(async ({ pool, rank }) => {
      const exists = await pool.exists(imageId);
      if (exists) {
        const value = await pool.getCount(imageId);
        return {
          pool,
          value,
          rank,
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
    `"userId" = ${playerId}`,
    `"createdAt" >= parseDateTimeBestEffort('${player.startAt.toISOString()}')`,
  ];
  // Ignoring error since we format the clickhouse params in custom $query
  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
  if (cursor) AND.push(`"createdAt" < '${cursor}'`);
  if (status?.length) AND.push(`status IN ('${status.join("','")}')`);

  const judgments = await clickhouse.$query<{
    imageId: number;
    rating: NsfwLevel;
    status: NewOrderImageRatingStatus;
    grantedExp: number;
    multiplier: number;
    originalLevel: NsfwLevel | null;
    createdAt: Date;
  }>`
    SELECT imageId, rating, status, grantedExp, multiplier, originalLevel, "createdAt"
    FROM knights_new_order_image_rating
    WHERE ${AND.join(' AND ')}
    ORDER BY createdAt DESC
    LIMIT ${limit + 1}
  `;
  if (judgments.length === 0) return { items: [], nextCursor: null };

  let nextCursor: Date | null = null;
  if (judgments.length > limit) nextCursor = judgments.pop()?.createdAt ?? null;

  const imageIds = judgments.map((j) => j.imageId).sort();
  const images = await dbRead.image.findMany({
    where: { id: { in: imageIds }, nsfwLevel: { notIn: [0, NsfwLevel.Blocked] } },
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
