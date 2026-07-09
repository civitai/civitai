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
  computePoolTargets,
  correctJudgmentsCounter,
  DEFAULT_POOL_QUOTAS,
  expCounter,
  fervorCounter,
  getActiveSlot,
  getImageRatingsCounter,
  getVotingCooldownUntil,
  getVotingRateLimitConfig,
  pendingBuzzCounter,
  recentlyGrantedBuzzCounter,
  poolCounters,
  sanityCheckFailuresCounter,
  smitesCounter,
} from '~/server/games/new-order/utils';
import { logToAxiom } from '~/server/logging/client';
import { redis, REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import type { InfiniteQueryInput } from '~/server/schema/base.schema';
import type {
  AddImageRatingInput,
  CleanseSmiteInput,
  GetHistorySchema,
  GetImagesQueueSchema,
  SmitePlayerInput,
} from '~/server/schema/games/new-order.schema';
import type { ImageMetadata } from '~/server/schema/media.schema';
import { ReportEntity } from '~/shared/utils/report-helpers';
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
  throwRateLimitError,
} from '~/server/utils/errorHandling';
import { getLevelProgression } from '~/server/utils/game-helpers';
import { withSpan } from '~/server/utils/otel-helpers';
import {
  MediaType,
  NewOrderRankType,
  ReportReason,
  ReportStatus,
} from '~/shared/utils/prisma/enums';
import { Flags } from '~/shared/utils/flags';
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
    const [stats, cooldownUntil] = await Promise.all([
      getPlayerStats({ playerId: userId }),
      getVotingCooldownUntil(userId),
    ]);
    const { user: userInfo, ...playerData } = user.playerInfo;
    return { ...userInfo, ...playerData, stats, cooldownUntil };
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
      recentlyGrantedBuzz: 0,
      nextGrantDate: dayjs().add(1, 'day').startOf('day').toDate(),
    },
    cooldownUntil: null,
  };
}

export async function getPlayerById({ playerId }: { playerId: number }) {
  const player = await dbRead.newOrderPlayer.findUnique({
    where: { userId: playerId },
    select: playerInfoSelect,
  });
  if (!player) throw throwNotFoundError(`No player with id ${playerId}`);

  const { user, ...playerData } = player;
  const [stats, cooldownUntil] = await Promise.all([
    getPlayerStats({ playerId }),
    getVotingCooldownUntil(playerId),
  ]);

  return { ...playerData, ...user, stats, cooldownUntil };
}

async function getPlayerStats({ playerId }: { playerId: number }) {
  const [exp, fervor, smites, blessedBuzz, pendingBlessedBuzz, recentlyGrantedBuzz] =
    await Promise.all([
      expCounter.getCount(playerId),
      fervorCounter.getCount(playerId),
      smitesCounter.getCount(playerId),
      blessedBuzzCounter.getCount(playerId),
      pendingBuzzCounter.getCount(playerId),
      recentlyGrantedBuzzCounter.getCount(playerId),
    ]);
  const nextGrantDate = dayjs().add(1, 'day').startOf('day').toDate(); // Next 00:00 UTC

  return {
    exp,
    fervor,
    smites,
    blessedBuzz,
    pendingBlessedBuzz,
    recentlyGrantedBuzz,
    nextGrantDate,
  };
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

  await createNotification({
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

  if (data.count === 0) return; // Nothing done :shrug:

  await signalClient
    .send({
      userId: playerId,
      target: SignalMessages.NewOrderPlayerUpdate,
      data: { action: NewOrderSignalActions.UpdateStats, stats: { smites: 0 } },
    })
    .catch((e) => handleLogError(e, 'signals:new-order-smite-cleansed-all'));

  await createNotification({
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

  await createNotification({
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
  const result = await withSpan('games:newOrder:addRating', () =>
    withDistributedLock(
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
    )
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
  // Validate player and image existence before consuming rate limit budget
  const player = await getPlayerById({ playerId });
  if (!player) throw throwNotFoundError(`No player with id ${playerId}`);

  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: { id: true, nsfwLevel: true, metadata: true },
  });
  if (!image) throw throwNotFoundError(`No image with id ${imageId}`);

  // Rate limiting — before sanity check detection so that all votes
  // (regular and sanity) are counted and rate-limited uniformly
  if (!isModerator) {
    const rateLimitResult = await withSpan('games:newOrder:rateLimit', () =>
      checkVotingRateLimit(playerId)
    );

    if (!rateLimitResult.allowed) {
      if (Math.random() < 0.1) {
        logToAxiom({
          type: 'info',
          name: 'new-order-rate-limit',
          details: {
            playerId,
            cooldownUntil: rateLimitResult.cooldownUntil,
          },
          message: `Player ${playerId} hit rate limit cooldown`,
        }).catch(() => null);
      }

      const waitSeconds = rateLimitResult.cooldownUntil
        ? Math.max(1, Math.ceil((rateLimitResult.cooldownUntil - Date.now()) / 1000))
        : 60;
      throw throwRateLimitError(`Voting cooldown active. Try again in ${waitSeconds}s.`);
    }
  }

  // Intercept sanity check images — the client doesn't know which images are sanity checks,
  // so we detect it server-side and route to the sanity check handler transparently
  if (sysRedis) {
    const exactMatch = await sysRedis.sIsMember(
      REDIS_SYS_KEYS.NEW_ORDER.SANITY_CHECKS.POOL,
      `${imageId}:${rating}`
    );
    let isSanityImage = !!exactMatch;
    // Also check if imageId exists with ANY level (in case the rating is wrong)
    if (!isSanityImage) {
      const possibleLevels = [
        NsfwLevel.PG,
        NsfwLevel.PG13,
        NsfwLevel.R,
        NsfwLevel.X,
        NsfwLevel.XXX,
      ];
      const memberChecks = await Promise.all(
        possibleLevels.map((level) =>
          sysRedis.sIsMember(REDIS_SYS_KEYS.NEW_ORDER.SANITY_CHECKS.POOL, `${imageId}:${level}`)
        )
      );
      isSanityImage = memberChecks.some(Boolean);
    }

    if (isSanityImage) {
      await addSanityCheckRating({ playerId, imageId, rating });
      return { stats: player.stats };
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
      // Guard against excessive down-rating: allow down-rating by at most 1 level,
      // escalate to Inquisitor (mod) queue if the distance is greater
      const isExcessiveDownRating =
        consensus && consensus < image.nsfwLevel && Flags.distance(image.nsfwLevel, consensus) > 1;

      if (isExcessiveDownRating) {
        // No decision made yet — keep all votes (including this one) Pending until mod acts
        currentNsfwLevel = undefined;

        // Remove from Knight queue and escalate to Inquisitor queue for mod review
        await removeImageFromQueue({ imageId, valueInQueue });
        await addImageToQueue({
          imageIds: imageId,
          rankType: 'Inquisitor' as NewOrderHighRankType,
          priority: 1,
        });

        logToAxiom({
          type: 'info',
          name: 'new-order-down-rating-escalated',
          details: {
            imageId,
            currentLevel: image.nsfwLevel,
            consensusLevel: consensus,
            distance: Flags.distance(image.nsfwLevel, consensus),
            voteCount: newVoteCount,
          },
          message: `Image ${imageId} down-rating consensus (${
            image.nsfwLevel
          } → ${consensus}, distance ${Flags.distance(
            image.nsfwLevel,
            consensus
          )}) escalated to Inquisitor queue`,
        }).catch(() => null);
      } else {
        // Apply the consensus decision (same level, up-rating, or down-rating by 1 level)
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
  const stats = await withSpan('games:newOrder:updateStats', () =>
    updatePlayerStats({
      playerId,
      status,
      exp: newOrderConfig.baseExp * multiplier,
      updateAll: player.rankType !== NewOrderRankType.Acolyte,
    })
  );

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

    // Fire-and-forget: don't block the response waiting for signal delivery
    signalClient
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
    recentlyGrantedBuzz: 0,
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

    // Get pending buzz and recently granted from Redis counters (auto-query ClickHouse on cache miss)
    const [pendingBlessedBuzz, recentlyGrantedBuzz] = await Promise.all([
      pendingBuzzCounter.getCount(playerId),
      recentlyGrantedBuzzCounter.getCount(playerId),
    ]);
    const nextGrantDate = dayjs().add(1, 'day').startOf('day').toDate();

    stats = {
      ...stats,
      fervor: newFervor,
      blessedBuzz,
      pendingBlessedBuzz,
      recentlyGrantedBuzz,
      nextGrantDate,
    };
  }

  // Fire-and-forget: don't block the response waiting for signal delivery
  signalClient
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
  // Formula: correct_ratings * 100 * accuracy_ratio
  // The accuracy multiplier penalizes spammers: a user with 20% accuracy gets only 20% of
  // the fervor they would otherwise earn. Legitimate users with 80%+ correct barely notice.
  // Floor at 0.1 to avoid zeroing out completely.
  // Examples:
  //   Legitimate (500 total, 400 correct, 80%): 400 * 100 * 0.8 = 32,000
  //   Spammer (5000 total, 1000 correct, 20%): 1000 * 100 * 0.2 = 20,000
  const accuracyRatio = allJudgments > 0 ? correctJudgments / allJudgments : 0;
  const accuracyMultiplier = Math.max(0.1, accuracyRatio);
  return Math.floor(correctJudgments * 100 * accuracyMultiplier);
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
    const allSanityChecks = (
      await sysRedis.sMembers(REDIS_SYS_KEYS.NEW_ORDER.SANITY_CHECKS.POOL)
    ).map((m) => decodeRedisString(m));
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

export async function handleSanityCheckFailure({
  playerId,
  imageId,
  submittedRating,
  correctNsfwLevel,
}: {
  playerId: number;
  imageId: number;
  submittedRating: NsfwLevel;
  correctNsfwLevel: NsfwLevel;
}) {
  if (!sysRedis) return;

  try {
    // Increment failure counter (auto-expires after 24 hours from first failure)
    const failureCount = await sanityCheckFailuresCounter.increment({ id: playerId });

    // Severe under-rating: rating content 2+ levels below its actual level (e.g., XXX→PG)
    // Uses Flags.distance() for safe bitwise-flag comparison
    const isSevereUnderRating =
      submittedRating < correctNsfwLevel && Flags.distance(correctNsfwLevel, submittedRating) >= 2;

    if (failureCount === 1 && !isSevereUnderRating) {
      // First failure (non-severe) - warning only
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
      // Severe under-rating OR additional failure - apply smite immediately
      await smitePlayer({
        playerId,
        modId: -1, // System
        reason: isSevereUnderRating
          ? 'You severely under-rated a sanity check image. A smite penalty has been applied.'
          : 'You failed another sanity check within 24 hours. A smite penalty has been applied, reducing your vote weight.',
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

  // Handle failure if incorrect — look up the correct level for penalty severity
  if (!isCorrect) {
    // Probe all possible NSFW levels via O(1) sIsMember checks instead of fetching the whole set
    const possibleLevels = [NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX];
    const memberChecks = await Promise.all(
      possibleLevels.map((level) =>
        sysRedis.sIsMember(REDIS_SYS_KEYS.NEW_ORDER.SANITY_CHECKS.POOL, `${imageId}:${level}`)
      )
    );
    const matchIndex = memberChecks.findIndex(Boolean);
    const correctNsfwLevel = matchIndex >= 0 ? possibleLevels[matchIndex] : rating; // fallback to submitted rating (won't trigger severe penalty)

    await handleSanityCheckFailure({
      playerId,
      imageId,
      submittedRating: rating,
      correctNsfwLevel,
    });
  }

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
    sanityCheckFailuresCounter.reset({ id: playerId }),
    correctJudgmentsCounter.reset({ id: playerId }),
    allJudgmentsCounter.reset({ id: playerId }),
    expCounter.reset({ id: playerId }),
    fervorCounter.reset({ id: playerId }),
    blessedBuzzCounter.reset({ id: playerId }),
    pendingBuzzCounter.reset({ id: playerId }),
    recentlyGrantedBuzzCounter.reset({ id: playerId }),
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
          pendingBlessedBuzz: 0,
          recentlyGrantedBuzz: 0,
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
    await createNotification({
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

/**
 * Ensures the rated images cache is populated for a user.
 * On cache miss, fetches from ClickHouse and populates the Redis set.
 * Returns the Redis key for subsequent SMISMEMBER checks.
 *
 * Uses a sentinel member '0' (no real image has ID 0) to distinguish
 * "cache populated but user has no ratings" from "cache not populated".
 */
async function ensureRatedImagesCache({
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

  // Check if cache is already populated (O(1))
  const exists = await redis.exists(key);
  if (exists) return key;

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

  // Always populate the set with a sentinel '0' so EXISTS returns true on next call.
  // Real image IDs are always > 0, so the sentinel never interferes with SMISMEMBER checks.
  const members = imageIds.length > 0 ? ['0', ...imageIds.map(String)] : ['0'];

  // Chunk the SADD so a heavy rater (>100K rated images) doesn't block the Redis shard
  // for tens of ms. Each chunk is its own command (NOT inside MULTI/EXEC) so Redis can
  // interleave other clients' commands between chunks. Sequential await keeps the burst
  // small and predictable.
  const CHUNK_SIZE = 1000;
  for (let i = 0; i < members.length; i += CHUNK_SIZE) {
    await redis.sAdd(key, members.slice(i, i + CHUNK_SIZE));
  }
  await redis.expire(key, CacheTTL.day);

  return key;
}

/**
 * Check which image IDs have already been rated using SMISMEMBER (O(N) where N = candidates).
 * This replaces the old SMEMBERS approach which was O(M) where M = total rated images (up to 141K).
 */
async function filterUnratedImages(key: string, imageIds: number[]): Promise<number[]> {
  if (!redis || imageIds.length === 0) return imageIds;

  const membership = await redis.smIsMember(key, imageIds.map(String));
  return imageIds.filter((_, i) => !membership[i]);
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
  // UNLINK is non-blocking: returns immediately, frees memory in a background thread.
  // Daily-reset job fans this across all players via Promise.all; with DEL on
  // 100K-element sets that stampedes the shard.
  await redis.unlink(key);
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
    metadata: ImageMetadata;
  }> = [];

  // Moderators can specify queueType to test different queues (Acolyte or Knight only)
  // Regular players always use their current rank
  const effectiveRankType = isModerator && queueType ? queueType : player.rankType;

  // Get active rating slot for this rank
  const activeSlot = await getActiveSlot(effectiveRankType, 'rating');
  const rankPools = poolCounters[effectiveRankType][activeSlot];

  // Ensure the rated images cache is populated (O(1) EXISTS check, ClickHouse on miss).
  // Uses SMISMEMBER per-batch instead of SMEMBERS on the full set (which was 39K-141K members
  // for active users, taking 10-38ms and blocking the Redis shard).
  const ratedKey = await ensureRatedImagesCache({
    userId: playerId,
    startAt: player.startAt,
    rankType: player.rankType,
  });
  const seenImageIds = new Set<number>();
  const isKnight = effectiveRankType === NewOrderRankType.Knight;

  const overflowLimit = imageCount * 2;

  // Per-rank pool weights drive a stratified fetch instead of the legacy
  // strict-sequential drain. Knight1/Knight2/Knight3 are content-tier
  // buckets in practice (see image-scan-result.ts), so reading Knight1
  // until full starved Knight2 (NSFW) entirely. Resolve weights from
  // Redis (ops-tunable) with a built-in fallback; missing rank → legacy.
  const rateLimitConfig = await getVotingRateLimitConfig();
  // `sysRedis.packed.get` returns untrusted runtime data: if the Redis blob
  // is hand-edited or corrupted, `poolQuotas[rank]` could be a string, an
  // object, or `null` — passing that through to `computePoolTargets` would
  // produce `NaN` targets or throw. Validate the shape (array of finite
  // numbers) and fall back to the in-code default (or sequential drain) when
  // it's wrong, instead of trusting the cast on `VotingRateLimitConfig`.
  const isValidWeights = (w: unknown): w is number[] =>
    Array.isArray(w) && w.every((v) => typeof v === 'number' && Number.isFinite(v));
  const redisWeights = rateLimitConfig?.poolQuotas?.[effectiveRankType];
  const poolWeights = isValidWeights(redisWeights)
    ? redisWeights
    : DEFAULT_POOL_QUOTAS[effectiveRankType] ?? null;

  const poolOffsets = rankPools.map(() => 0);
  const poolExhausted = rankPools.map(() => false);

  // Pull up to `target` images from `rankPools[poolIdx]`, appending to
  // `validatedImages` and updating shared state. Returns the count actually
  // added so callers can compute deficits for redistribution.
  const fetchFromPool = async (poolIdx: number, target: number): Promise<number> => {
    if (target <= 0 || poolExhausted[poolIdx]) return 0;
    const pool = rankPools[poolIdx];
    if (!pool) return 0;

    const before = validatedImages.length;
    const goal = before + target;
    // Read 2× target per batch to absorb already-rated / already-seen misses,
    // but cap at `overflowLimit` so the legacy sequential-drain path (target
    // = overflowLimit) doesn't double the Redis payload vs the original
    // implementation. Floor at 20 so very small per-pool quotas still pull
    // enough headroom to skip past already-rated images.
    const step = Math.min(Math.max(target * 2, 20), overflowLimit);

    while (validatedImages.length < goal) {
      const poolImages = await pool.getAll({
        limit: step,
        offset: poolOffsets[poolIdx],
        withCount: true,
      });
      if (poolImages.length === 0) {
        poolExhausted[poolIdx] = true;
        break;
      }
      poolOffsets[poolIdx] += step;

      const imageIds = poolImages
        .filter(({ score }) => (isKnight ? score < newOrderConfig.limits.knightVotes : true))
        .map(({ value }) => Number(value));

      const unseenImageIds = imageIds.filter((id) => !seenImageIds.has(id));
      if (unseenImageIds.length === 0) continue;

      const unratedImageIds = await filterUnratedImages(ratedKey, unseenImageIds);
      if (unratedImageIds.length === 0) continue;

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

      // Don't overshoot the target — pass 2 redistribution relies on
      // per-pool quotas being respected during pass 1. We mark `seenImageIds`
      // AFTER slicing so the discarded tail stays eligible for the same
      // pool's pass-2 redistribution call. Marking before the slice would
      // permanently poison the IDs we never served.
      const needed = goal - validatedImages.length;
      const sliced = needed >= images.length ? images : images.slice(0, needed);

      sliced.forEach((image) => seenImageIds.add(image.id));

      validatedImages.push(
        ...sliced.map(({ nsfwLevel, ...image }) => ({
          ...image,
          nsfwLevel:
            effectiveRankType === NewOrderRankType.Acolyte || isModerator ? nsfwLevel : undefined,
          metadata: image.metadata as ImageMetadata,
        }))
      );
    }

    return validatedImages.length - before;
  };

  const sequentialDrain = async () => {
    for (let i = 0; i < rankPools.length; i++) {
      if (validatedImages.length >= overflowLimit) break;
      await fetchFromPool(i, overflowLimit - validatedImages.length);
    }
  };

  if (!poolWeights) {
    await sequentialDrain();
  } else {
    // Probe pool sizes (ZCARD) only for pools with non-zero weight so an
    // empty Knight3 can be skipped without wasting reads.
    const poolSizes = await Promise.all(
      rankPools.map(async (pool, idx) => {
        const w = poolWeights[idx] ?? 0;
        if (w <= 0) return 0;
        try {
          return await sysRedis.zCard(pool.key);
        } catch {
          return 0;
        }
      })
    );

    const { targets, activeIdxs } = computePoolTargets({
      weights: poolWeights,
      poolSizes,
      overflowLimit,
    });

    if (activeIdxs.length === 0) {
      // Weights point at empty pools only → fall back to sequential drain
      // so the request still gets *something* instead of returning empty.
      await sequentialDrain();
    } else {
      // Pass 1: quota fill.
      for (const idx of activeIdxs) {
        await fetchFromPool(idx, targets[idx]);
      }

      // Pass 2: redistribute deficit from exhausted pools to survivors.
      // Single pass — survivors that exhaust during redistribution just stop.
      let deficit = overflowLimit - validatedImages.length;
      if (deficit > 0) {
        const survivors = activeIdxs.filter((idx) => !poolExhausted[idx]);
        for (const idx of survivors) {
          if (deficit <= 0) break;
          const added = await fetchFromPool(idx, deficit);
          deficit -= added;
        }
      }
    }
  }

  // Shuffle and slice to requested count
  const finalImages = shuffle(validatedImages).slice(0, imageCount);

  // OPTIMIZATION 3: Batch sanity check fetching (Knights only)
  // Skip sanity checks for moderators testing different queues
  if (effectiveRankType === NewOrderRankType.Knight && !isModerator) {
    try {
      // Fetch ALL sanity checks from Redis ONCE
      const allSanityChecks = (
        await sysRedis!.sMembers(REDIS_SYS_KEYS.NEW_ORDER.SANITY_CHECKS.POOL)
      ).map((m) => decodeRedisString(m));

      if (allSanityChecks && allSanityChecks.length > 0) {
        // Insert sanity checks scaled to queue size (~2 per 20 images, ~10 per 100)
        // At least 1 even if the queue is tiny, scaling up for larger fetches
        const sanityCheckCount = Math.max(1, Math.ceil(finalImages.length / 10));

        // Stratify selection: bias toward non-PG sanity images to catch under-raters
        const pgChecks: string[] = [];
        const nonPgChecks: string[] = [];
        for (const entry of allSanityChecks) {
          const nsfwLevel = Number(entry.split(':')[1]);
          if (nsfwLevel <= NsfwLevel.PG13) {
            pgChecks.push(entry);
          } else {
            nonPgChecks.push(entry);
          }
        }

        // Select with bias: at least 40% non-PG if available
        const shuffledNonPg = shuffle(nonPgChecks);
        const shuffledPg = shuffle(pgChecks);
        const minNonPg = Math.min(Math.ceil(sanityCheckCount * 0.4), shuffledNonPg.length);
        const selectedChecks = [
          ...shuffledNonPg.slice(0, minNonPg),
          ...shuffle([...shuffledNonPg.slice(minNonPg), ...shuffledPg]),
        ].slice(0, sanityCheckCount);

        // Batch fetch image data for all selected sanity checks
        const sanityImageIds = selectedChecks.map((entry) => Number(entry.split(':')[0]));
        const sanityImagesData = await dbRead.image.findMany({
          where: { id: { in: sanityImageIds } },
          select: { id: true, url: true, metadata: true },
        });
        const sanityImageMap = new Map(sanityImagesData.map((img) => [img.id, img]));

        for (const entry of selectedChecks) {
          const [imageIdStr] = entry.split(':');
          const sanityImageId = Number(imageIdStr);
          const imageData = sanityImageMap.get(sanityImageId);
          if (!imageData) continue;

          const sanityCheckImage = {
            id: sanityImageId,
            url: imageData.url,
            nsfwLevel: undefined, // Never leak correct level to the client
            metadata: imageData.metadata as ImageMetadata,
          };

          const randomPosition = Math.floor(Math.random() * (finalImages.length + 1));
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
  const HAVING = [];
  if (status?.length) HAVING.push(`status IN ('${status.join("','")}')`);
  // Keyset pagination on the AGGREGATE sort key (max(createdAt), imageId) via
  // HAVING — NOT a raw-row `createdAt < cursor` in WHERE. Filtering raw rows by the
  // cursor corrupts the per-image max(createdAt): it SKIPS a boundary image whose
  // only rating is at the cursor second, and DUPLICATES a re-rated image whose
  // older rows survive the prune (reappearing with a stale max). The tuple compare
  // + matching (lastCreatedAt, imageId) ORDER BY gives gap/dup-free paging incl.
  // same-second ties. Both cursor fields are schema-validated (Date + number) so
  // this is injection-safe. (Cost: each page aggregates the player's window like
  // page 1 — acceptable for a history view.)
  if (cursor)
    HAVING.push(
      `(max(createdAt), imageId) < (parseDateTimeBestEffort('${cursor.createdAt.toISOString()}'), ${cursor.imageId})`
    );

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
    ORDER BY lastCreatedAt DESC, imageId DESC
    LIMIT ${limit + 1}
  `;
  if (judgments.length === 0) return { items: [], nextCursor: null };

  // Cursor = the LAST KEPT row's (createdAt, imageId), not the popped probe row —
  // next page is HAVING (max(createdAt), imageId) < cursor, so it resumes strictly
  // after this row with no skip/dup.
  const hasMore = judgments.length > limit;
  if (hasMore) judgments.pop();
  const lastKept = judgments[judgments.length - 1];
  const nextCursor =
    hasMore && lastKept ? { createdAt: lastKept.lastCreatedAt, imageId: lastKept.imageId } : null;

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
      const allMembers = (await sysRedis.sMembers(poolKey)).map((m) => decodeRedisString(m));
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
    const currentPool = (await sysRedis.sMembers(poolKey)).map((m) => decodeRedisString(m));
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
