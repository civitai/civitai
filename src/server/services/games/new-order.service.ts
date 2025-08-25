import type { Tracker } from '~/server/clickhouse/client';
import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL, newOrderConfig } from '~/server/common/constants';
import {
  NewOrderImageRatingStatus,
  NsfwLevel,
  SignalTopic,
  SignalMessages,
  NewOrderSignalActions,
  NotificationCategory,
  NewOrderDamnedReason,
} from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  acolyteFailedJudgments,
  allJudgmentsCounter,
  blessedBuzzCounter,
  correctJudgmentsCounter,
  expCounter,
  fervorCounter,
  getImageRatingsCounter,
  poolCounters,
  smitesCounter,
} from '~/server/games/new-order/utils';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS } from '~/server/redis/client';
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
import {
  handleLogError,
  throwBadRequestError,
  throwInternalServerError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { getLevelProgression } from '~/server/utils/game-helpers';
import { Flags } from '~/shared/utils/flags';
import { MediaType, NewOrderRankType } from '~/shared/utils/prisma/enums';
import { shuffle } from '~/utils/array-helpers';
import { signalClient } from '~/utils/signal-client';
import { isDefined } from '~/utils/type-guards';

type NewOrderHighRankType = NewOrderRankType | 'Inquisitor';

const FERVOR_COEFFICIENT = -0.0025;
const ACOLYTE_WRONG_ANSWER_LIMIT = 5;

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
  if (activeSmiteCount >= 3) return resetPlayer({ playerId, withNotification: true });

  const newSmiteCount = await smitesCounter.increment({ id: playerId });
  await signalClient
    .send({
      userId: playerId,
      target: SignalMessages.NewOrderPlayerUpdate,
      data: { action: NewOrderSignalActions.UpdateStats, stats: { smites: newSmiteCount } },
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
      data: { action: NewOrderSignalActions.UpdateStats, stats: { smites: smiteCount } },
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

  const player = await dbRead.newOrderPlayer.findUnique({
    where: { userId: playerId },
    select: playerInfoSelect,
  });
  if (!player) throw throwNotFoundError(`No player with id ${playerId}`);

  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: { id: true, nsfwLevel: true },
  });

  if (!image) throw throwNotFoundError(`No image with id ${imageId}`);

  const valueInQueue = await isImageInQueue({
    imageId,
    rankType: isModerator
      ? ['Inquisitor', NewOrderRankType.Templar, NewOrderRankType.Knight]
      : player.rankType === NewOrderRankType.Templar
      ? [NewOrderRankType.Templar, NewOrderRankType.Knight]
      : player.rankType,
  });

  if (!valueInQueue) {
    //  We won't error out cause technically it might've already be cleared as an image.
    return false;
  }

  if (
    valueInQueue.value >= newOrderConfig.limits.knightVotes &&
    valueInQueue.rank === NewOrderRankType.Knight
  ) {
    // Ignore this vote, was rated by enough players. Remove the image from the queue since it has enough votes
    await valueInQueue.pool.reset({ id: imageId });

    await signalClient
      .topicSend({
        topic: `${SignalTopic.NewOrderQueue}:Knight`,
        target: SignalMessages.NewOrderQueueUpdate,
        data: { imageId, action: NewOrderSignalActions.RemoveImage },
      })
      .catch();

    return false;
  }

  if (
    valueInQueue.value >= newOrderConfig.limits.templarVotes &&
    valueInQueue.rank === NewOrderRankType.Templar
  ) {
    // Ignore this vote, was rated by enough players. Remove the image from the queue since it has enough votes
    await valueInQueue.pool.reset({ id: imageId });
    await signalClient
      .topicSend({
        topic: `${SignalTopic.NewOrderQueue}:Templar`,
        target: SignalMessages.NewOrderQueueUpdate,
        data: { imageId, action: NewOrderSignalActions.RemoveImage },
      })
      .catch();

    return false;
  }

  // Update image nsfw level if the player is a mod
  if (isModerator) {
    await updateImageNsfwLevel({ id: imageId, nsfwLevel: rating, userId: playerId, isModerator });
    await updatePendingImageRatings({ imageId, rating });
    await valueInQueue.pool.reset({ id: imageId });

    if (rating === NsfwLevel.Blocked) {
      await handleBlockImages({ ids: [imageId] });
    }

    await signalClient
      .topicSend({
        topic: `${SignalTopic.NewOrderQueue}:Inquisitor`,
        target: SignalMessages.NewOrderQueueUpdate,
        data: { imageId, action: NewOrderSignalActions.RemoveImage },
      })
      .catch();

    // Finish the rating process for mods
    return true;
  }

  let currentNsfwLevel: NsfwLevel | undefined = image.nsfwLevel;
  let movedQueue = false; // Used to track if the image was processed already
  // Increase rating count
  await getImageRatingsCounter(imageId).increment({ id: `${player.rank.name}-${rating}` });
  // Increase rating count for the image in the queue.
  await valueInQueue.pool.increment({ id: imageId });

  const reachedKnightVoteLimit =
    valueInQueue.rank === NewOrderRankType.Knight &&
    valueInQueue.value + 1 >= newOrderConfig.limits.knightVotes;
  const reachedTemplarVoteLimit =
    valueInQueue.rank === NewOrderRankType.Templar &&
    valueInQueue.value + 1 >= newOrderConfig.limits.templarVotes;

  // Now, process what to do with the image:
  if (reachedKnightVoteLimit) {
    // Image is now rated by enough players, we can process it.
    const _ratings = await getImageRatingsCounter(imageId).getAll();
    // Ensure we only consider ratings that are not zero:
    const ratings = _ratings.filter((r) => Number(r.split('-')[1]) !== 0);
    let processed = false;

    if (ratings.length === 0) {
      throw throwBadRequestError('No ratings found for image');
    }

    // Check if they all voted damned:
    if (ratings.length === 1 && ratings[0].endsWith(`${NsfwLevel.Blocked}`)) {
      processed = true;
      movedQueue = true;
      await addImageToQueue({
        imageIds: imageId,
        rankType: 'Inquisitor',
        priority: 1,
      });
    }

    if (ratings.length > 1 && !processed) {
      processed = true;

      const majorityAgreeVote = (
        await Promise.all(
          ratings.map(async (r) => {
            if (!r.startsWith(NewOrderRankType.Knight)) return null;

            const amount = await getImageRatingsCounter(imageId).getCount(r);
            return amount >= newOrderConfig.limits.minKnightVotes ? r : null;
          })
        )
      ).filter(isDefined)[0];

      let majorityAgreeRating: NsfwLevel | undefined;
      if (majorityAgreeVote) {
        // If majority agrees on a rating, we can update the image nsfw level:
        majorityAgreeRating = Number(majorityAgreeVote.split('-')[1]) as NsfwLevel;
      }

      // There are multiple entries, so we either uptake to templars, or, if 4 knights agree, update:
      // Add to templars queue:
      if (
        !majorityAgreeRating ||
        (majorityAgreeRating < currentNsfwLevel &&
          Flags.distance(majorityAgreeRating, currentNsfwLevel) > 1)
      ) {
        movedQueue = true;
        await addImageToQueue({
          imageIds: imageId,
          rankType: NewOrderRankType.Templar,
          priority: 1,
        });
      } else {
        // Else, we're good :)
        currentNsfwLevel = await updateImageNsfwLevel({
          id: imageId,
          nsfwLevel: majorityAgreeRating,
          userId: playerId,
          isModerator: true,
          activity: 'setNsfwLevelKono',
        });
      }
    }

    const rating = Number(ratings[0].split('-')[1]);

    if (rating !== currentNsfwLevel && !processed && !!currentNsfwLevel) {
      // Raise to templars because the diff is more than 1 level down
      if (rating < currentNsfwLevel && Flags.distance(rating, currentNsfwLevel) > 1) {
        movedQueue = true;
        await addImageToQueue({
          imageIds: imageId,
          rankType: NewOrderRankType.Templar,
          priority: 1,
        });
      } else {
        // Else, we're good :)
        currentNsfwLevel = await updateImageNsfwLevel({
          id: imageId,
          nsfwLevel: rating,
          userId: playerId,
          isModerator: true,
          activity: 'setNsfwLevelKono',
        });
      }
    }

    if (!movedQueue) await updatePendingImageRatings({ imageId, rating });
    // Clear image from the pool:
    await valueInQueue.pool.reset({ id: imageId });

    await signalClient
      .topicSend({
        topic: `${SignalTopic.NewOrderQueue}:Knight`,
        target: SignalMessages.NewOrderQueueUpdate,
        data: { imageId, action: NewOrderSignalActions.RemoveImage },
      })
      .catch();
  }

  // Process Templar rating:
  if (reachedTemplarVoteLimit) {
    // Image is now rated by enough players, we can process it.
    const _ratings = await getImageRatingsCounter(imageId).getAll();
    // Ensure we only consider ratings that are not zero:
    const ratings = _ratings.filter((r) => Number(r.split('-')[1]) !== 0);
    let processed = false;

    if (ratings.length === 0) {
      throw throwBadRequestError('No ratings found for image');
    }

    const templarKeys = ratings.filter((k) => k.startsWith(NewOrderRankType.Templar));

    // Check if they all voted damned or have a disparity in ratings:
    if (
      (templarKeys.length === 1 && ratings[0].endsWith(`${NsfwLevel.Blocked}`)) ||
      templarKeys.length > 1
    ) {
      processed = true;
      movedQueue = true;
      await addImageToQueue({
        imageIds: imageId,
        rankType: 'Inquisitor',
        priority: 1,
      });
    }

    const rating = Number(ratings[0].split('-')[1]);

    if (rating !== currentNsfwLevel && !processed) {
      // Else, we're good :)
      currentNsfwLevel = await updateImageNsfwLevel({
        id: imageId,
        nsfwLevel: rating,
        userId: playerId,
        isModerator: true,
        activity: 'setNsfwLevelKono',
      });
    }

    if (!movedQueue) await updatePendingImageRatings({ imageId, rating });
    // Clear image from the pool:
    await valueInQueue.pool.reset({ id: imageId });

    signalClient
      .topicSend({
        topic: `${SignalTopic.NewOrderQueue}:Templar`,
        target: SignalMessages.NewOrderQueueUpdate,
        data: { imageId, action: NewOrderSignalActions.RemoveImage },
      })
      .catch();
  }

  const isAcolyte = player.rankType === NewOrderRankType.Acolyte;
  let status: NewOrderImageRatingStatus;

  if (isAcolyte) {
    status =
      currentNsfwLevel === rating
        ? NewOrderImageRatingStatus.AcolyteCorrect
        : NewOrderImageRatingStatus.AcolyteFailed;
  } else if (!movedQueue && (reachedKnightVoteLimit || reachedTemplarVoteLimit)) {
    status =
      currentNsfwLevel === rating
        ? NewOrderImageRatingStatus.Correct
        : NewOrderImageRatingStatus.Failed;
  } else {
    // Knights / Templars leave the image in the pending status until their vote is confirmed.
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

  // Failsafe to clear the image from the queue if it was rated by enough players
  if (reachedKnightVoteLimit || reachedTemplarVoteLimit) {
    await valueInQueue.pool.reset({ id: imageId });
    signalClient
      .topicSend({
        topic: `${SignalTopic.NewOrderQueue}:${player.rankType}`,
        target: SignalMessages.NewOrderQueueUpdate,
        data: { imageId, action: NewOrderSignalActions.RemoveImage },
      })
      .catch();
  }

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

  await clickhouse.exec({
    query: `
      ALTER TABLE knights_new_order_image_rating
      UPDATE
        status = CASE
          WHEN rating = ${rating} THEN '${NewOrderImageRatingStatus.Correct}'
          ELSE '${NewOrderImageRatingStatus.Failed}'
        END,
        multiplier = CASE
          WHEN rating = ${rating} THEN 1
          ELSE -1
        END
      WHERE "imageId" = ${imageId}
        AND status = '${NewOrderImageRatingStatus.Pending}'
        AND rank != '${NewOrderRankType.Acolyte}'
    `,
  });

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
  let stats = { exp: newExp, fervor: 0, blessedBuzz: 0 };

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
  const correctPercentage = correctJudgments / (allJudgments || 1);
  return Math.round(
    correctJudgments * correctPercentage * Math.pow(Math.E, allJudgments * FERVOR_COEFFICIENT)
  );
}

export async function resetPlayer({
  playerId,
  withNotification,
}: {
  playerId: number;
  withNotification?: boolean;
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
      data: { cleansedAt: new Date(), cleansedReason: 'Exceeded smite limit' },
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
      },
    })
    .catch((e) => handleLogError(e, 'signals:new-order-reset-player'));

  if (withNotification)
    createNotification({
      category: NotificationCategory.Other,
      type: 'new-order-game-over',
      key: `new-order-game-over:${playerId}:${new Date().getTime()}`,
      userId: playerId,
      details: {},
    }).catch(handleLogError);
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
    nsfwLevel: number;
    metadata: ImageMetadata;
  }> = [];
  const rankPools = isModerator
    ? queueType
      ? poolCounters[queueType]
      : poolCounters.Inquisitor
    : player.rankType === NewOrderRankType.Templar
    ? [...poolCounters.Templar, ...poolCounters.Knight]
    : poolCounters[player.rankType];

  const ratedImages = await getRatedImages({
    userId: playerId,
    startAt: player.startAt,
    rankType: player.rankType,
  });
  const seenImageIds = isModerator ? new Set<number>() : new Set<number>(ratedImages);
  const rankTypeKey = player.rankType.toLowerCase() as 'knight' | 'templar';
  const knightOrTemplar = ['knight', 'templar'].includes(rankTypeKey);
  const overflowLimit = imageCount * 10; // We fetch more images to ensure we have enough to choose from

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
        .filter(({ score }) =>
          knightOrTemplar ? score < newOrderConfig.limits[`${rankTypeKey}Votes`] : true
        )
        .map(({ value }) => Number(value));

      // Filter out already rated images and previously seen images before doing the DB query
      const unratedImageIds = imageIds.filter((id) => !seenImageIds.has(id));
      if (unratedImageIds.length === 0) {
        offset += overflowLimit;
        continue;
      }

      // Query the database for each batch with all conditions
      const images = await dbRead.image.findMany({
        where: {
          id: { in: unratedImageIds },
          type: MediaType.image,
          post: !isModerator ? { publishedAt: { lt: new Date() } } : undefined,
          nsfwLevel: isModerator ? undefined : { notIn: [0, NsfwLevel.Blocked] },
        },
        select: { id: true, url: true, nsfwLevel: true, metadata: true },
      });

      // Add new image IDs to the seen set
      images.forEach((image) => seenImageIds.add(image.id));

      validatedImages.push(
        ...images.map((image) => ({
          ...image,
          metadata: image.metadata as ImageMetadata,
        }))
      );

      if (validatedImages.length >= overflowLimit) break;

      offset += overflowLimit; // Increment offset for the next batch
    }

    if (validatedImages.length >= overflowLimit) break;
  }

  return shuffle(validatedImages).slice(0, imageCount);
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
