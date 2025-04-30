import { clickhouse, Tracker } from '~/server/clickhouse/client';
import { CacheTTL } from '~/server/common/constants';
import {
  NewOrderImageRatingStatus,
  NsfwLevel,
  SignalTopic,
  SignalMessages,
  NewOrderSignalActions,
  NotificationCategory,
} from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  allJudmentsCounter,
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
import { InfiniteQueryInput } from '~/server/schema/base.schema';
import {
  AddImageRatingInput,
  CleanseSmiteInput,
  GetHistorySchema,
  SmitePlayerInput,
} from '~/server/schema/games/new-order.schema';
import { ImageMetadata } from '~/server/schema/media.schema';
import { playerInfoSelect, userWithPlayerInfoSelect } from '~/server/selectors/user.selector';
import { updateImageNsfwLevel } from '~/server/services/image.service';
import { createNotification } from '~/server/services/notification.service';
import { bustFetchThroughCache, fetchThroughCache } from '~/server/utils/cache-helpers';
import {
  handleLogError,
  throwBadRequestError,
  throwInternalServerError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { Flags } from '~/shared/utils';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import { shuffle } from '~/utils/array-helpers';
import { signalClient } from '~/utils/signal-client';
import { isDefined } from '~/utils/type-guards';

const FERVOR_COEFFICIENT = -0.0025;

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
  signalClient.topicSend({
    topic: `${SignalTopic.NewOrderPlayer}:${playerId}`,
    target: SignalMessages.NewOrderPlayerUpdate,
    data: { action: NewOrderSignalActions.UpdateStats, stats: { smites: newSmiteCount } },
  });

  createNotification({
    category: NotificationCategory.Other,
    type: 'new-order-smite-received',
    key: `new-order-smite-received:${playerId}`,
    userId: playerId,
    details: {},
  });

  return smite;
}

export async function cleanseSmite({ id, cleansedReason, playerId }: CleanseSmiteInput) {
  const smite = await dbWrite.newOrderSmite.update({
    where: { id, cleansedAt: null },
    data: { cleansedAt: new Date(), cleansedReason },
  });

  const smiteCount = await smitesCounter.decrement({ id: playerId });
  signalClient.topicSend({
    topic: `${SignalTopic.NewOrderPlayer}:${playerId}`,
    target: SignalMessages.NewOrderPlayerUpdate,
    data: { action: NewOrderSignalActions.UpdateStats, stats: { smites: smiteCount } },
  });

  createNotification({
    category: NotificationCategory.Other,
    type: 'new-order-smite-cleansed',
    key: `new-order-smite-cleansed:${playerId}`,
    userId: playerId,
    details: { cleansedReason },
  });

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

  // Update image nsfw level if the player is a mod
  if (isModerator) {
    await updateImageNsfwLevel({ id: imageId, nsfwLevel: rating, userId: playerId, isModerator });
    await updatePendingImageRatings({ imageId, rating });

    signalClient.topicSend({
      topic: `${SignalTopic.NewOrderQueue}:Inquisitor`,
      target: SignalMessages.NewOrderQueueUpdate,
      data: { imageId, action: NewOrderSignalActions.RemoveImage },
    });

    return true;
  }

  const valueInQueue = await isImageInQueue({
    imageId,
    rankType:
      player.rankType === NewOrderRankType.Templar
        ? [NewOrderRankType.Templar, NewOrderRankType.Knight]
        : player.rankType,
  });

  if (!valueInQueue) {
    //  We won't error out cause technically it might've already be cleared as an image.
    return false;
  }

  if (valueInQueue.value >= 5 && valueInQueue.rank === NewOrderRankType.Knight) {
    // Ignore this vote, was rated by enough players.
    return false;
  }

  if (valueInQueue.value >= 2 && valueInQueue.rank === NewOrderRankType.Templar) {
    // Ignore this vote, was rated by enough players.
    return false;
  }

  const status =
    player.rankType === NewOrderRankType.Acolyte
      ? image.nsfwLevel === rating
        ? NewOrderImageRatingStatus.Correct
        : NewOrderImageRatingStatus.Failed
      : // Knights / Templars leave the image in the pending status until their vote is confirmed.
        NewOrderImageRatingStatus.Pending;

  // TODO.newOrder: grantedExp and multiplier
  const grantedExp = 100;
  const multiplier = status === NewOrderImageRatingStatus.Failed ? -1 : 1;

  if (chTracker) {
    try {
      await chTracker.newOrderImageRating({
        userId: playerId,
        imageId,
        rating,
        status:
          player.rankType === NewOrderRankType.Acolyte
            ? status === NewOrderImageRatingStatus.Correct
              ? NewOrderImageRatingStatus.AcolyteCorrect
              : NewOrderImageRatingStatus.AcolyteFailed
            : status,
        damnedReason,
        grantedExp,
        multiplier,
      });
    } catch (e) {
      const error = e as Error;
      logToAxiom(
        {
          type: 'error',
          name: 'new-order-image-rating',
          details: {
            data: { playerId, imageId, rating, status, damnedReason, grantedExp, multiplier },
          },
          message: error.message,
          stack: error.stack,
          cause: error.cause,
        },
        'clickhouse'
      ).catch();
    }
  }

  // Increase rating count
  await getImageRatingsCounter(imageId).increment({ id: `${player.rank.name}-${rating}` });

  // No need to await mainly cause it makes no difference as the user has a queue in general.
  bustFetchThroughCache(`${REDIS_KEYS.NEW_ORDER.RATED}:${playerId}`);

  // Increase rating count for the image in the queue.
  await valueInQueue.pool.increment({ id: imageId, value: 1 });

  if (status === NewOrderImageRatingStatus.Correct) {
    // Reduce gainedExp from oldest smite remaining score
    const smite = await dbWrite.newOrderSmite.findFirst({
      where: { targetPlayerId: playerId, remaining: { gt: 0 } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, remaining: true },
    });

    if (smite) {
      const updatedSmite = await dbWrite.newOrderSmite.update({
        where: { id: smite.id },
        data: { remaining: smite.remaining - grantedExp * multiplier },
      });

      if (updatedSmite.remaining <= 0)
        await cleanseSmite({ id: updatedSmite.id, cleansedReason: 'Smite expired', playerId });
    }
  }

  // Increase all counters
  const stats = await updatePlayerStats({
    playerId,
    status,
    exp: grantedExp * multiplier,
    updateAll: player.rankType !== NewOrderRankType.Acolyte,
  });

  // Check if player should be promoted
  const knightRank = await getNewOrderRanks({ name: 'Knight' });
  if (knightRank && knightRank.minExp <= stats.exp) {
    await dbWrite.newOrderPlayer.update({
      where: { userId: playerId },
      data: { rankType: knightRank.type },
    });

    signalClient.topicSend({
      topic: `${SignalTopic.NewOrderPlayer}:${playerId}`,
      target: SignalMessages.NewOrderPlayerUpdate,
      data: {
        action: NewOrderSignalActions.RankUp,
        rankType: knightRank.type,
        rank: { ...knightRank },
      },
    });
  }

  // Now, process what to do with the image:
  if (valueInQueue.rank === NewOrderRankType.Knight && ++valueInQueue.value >= 5) {
    // Image is now rated by enough players, we can process it.
    const ratings = await getImageRatingsCounter(imageId).getAll();
    const keys = Object.keys(ratings);
    let processed = false;

    if (keys.length === 0) {
      throw throwBadRequestError('No ratings found for image');
    }

    // Check if they all voted damned:
    if (keys.length === 1 && keys[0].endsWith(`${NsfwLevel.Blocked}`)) {
      processed = true;
      await addImageToQueue({
        imageIds: imageId,
        rankType: 'Inquisitor',
        priority: 1,
      });
    }

    if (keys.length > 1 && !processed) {
      // Means there are multiple entries for this image. We must raise this to the Templars:
      // Add to templars queue:
      await addImageToQueue({
        imageIds: imageId,
        rankType: NewOrderRankType.Templar,
        priority: 1,
      });
    }

    const rating = Number(keys[0].split('-')[1]);
    const currentNsfwLevel = image.nsfwLevel;

    if (rating !== currentNsfwLevel && !processed) {
      // Check if lower:
      if (rating < currentNsfwLevel) {
        // Raise to templars because they lowered the rating.
        await addImageToQueue({
          imageIds: imageId,
          rankType: NewOrderRankType.Templar,
          priority: 1,
        });
      } else if (rating > currentNsfwLevel && Flags.increaseByBits(rating) !== currentNsfwLevel) {
        // Raise to templars because the diff. is more than 1 level up:
        await addImageToQueue({
          imageIds: imageId,
          rankType: NewOrderRankType.Templar,
          priority: 1,
        });
      } else {
        // Else, we're good :)
        await updateImageNsfwLevel({ id: imageId, nsfwLevel: rating, userId: playerId });
      }

      // Clear image from the pool:
      valueInQueue.pool.reset({ id: imageId });

      signalClient.topicSend({
        topic: `${SignalTopic.NewOrderQueue}:Knight`,
        target: SignalMessages.NewOrderQueueUpdate,
        data: { imageId, action: NewOrderSignalActions.RemoveImage },
      });
    }
  }

  // Process Templar rating:
  if (valueInQueue.rank === NewOrderRankType.Templar && ++valueInQueue.value >= 2) {
    // Image is now rated by enough players, we can process it.
    const ratings = await getImageRatingsCounter(imageId).getAll();
    const keys = Object.keys(ratings);
    let processed = false;

    if (keys.length === 0) {
      throw throwBadRequestError('No ratings found for image');
    }

    const templarKeys = keys.filter((k) => k.startsWith(NewOrderRankType.Templar));

    // Check if they all voted damned or have a disparity in ratings:
    if (
      (templarKeys.length === 1 && keys[0].endsWith(`${NsfwLevel.Blocked}`)) ||
      templarKeys.length > 1
    ) {
      processed = true;
      await addImageToQueue({
        imageIds: imageId,
        rankType: 'Inquisitor',
        priority: 1,
      });
    }

    const rating = Number(keys[0].split('-')[1]);
    const currentNsfwLevel = image.nsfwLevel;

    if (rating !== currentNsfwLevel && !processed) {
      // Else, we're good :)
      await updateImageNsfwLevel({ id: imageId, nsfwLevel: rating, userId: playerId });
      await updatePendingImageRatings({ imageId, rating });
    }

    // Clear image from the pool:
    valueInQueue.pool.reset({ id: imageId });

    signalClient.topicSend({
      topic: `${SignalTopic.NewOrderQueue}:Templar`,
      target: SignalMessages.NewOrderQueueUpdate,
      data: { imageId, action: NewOrderSignalActions.RemoveImage },
    });
  }

  return { stats };
}

async function updatePendingImageRatings({
  imageId,
  rating,
}: {
  imageId: number;
  rating: NsfwLevel;
}) {
  if (!clickhouse) throw throwInternalServerError('Not supported');

  await clickhouse.exec({
    query: `
      ALTER TABLE knights_new_order_image_rating
      UPDATE status = CASE
        WHEN rating = ${rating} THEN ${NewOrderImageRatingStatus.Correct}
        ELSE ${NewOrderImageRatingStatus.Failed}
      END
      WHERE "imageId" = ${imageId}
        AND status = ${NewOrderImageRatingStatus.Pending}
        AND rank != '${NewOrderRankType.Acolyte}'
    `,
  });
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
  const newExp = await expCounter.increment({ id: playerId, value: exp });
  let stats = { exp: newExp, fervor: 0, blessedBuzz: 0 };

  if (updateAll) {
    const allJudgments = await allJudmentsCounter.increment({ id: playerId });
    const correctJudgments =
      status === NewOrderImageRatingStatus.Correct
        ? await correctJudgmentsCounter.increment({ id: playerId })
        : await correctJudgmentsCounter.getCount(playerId);

    const fervor = calculateFervor({ correctJudgments, allJudgments });

    const newFervor = await fervorCounter.increment({ id: playerId, value: fervor });
    // TODO.newOrder: adjust buzz based on conversion rate
    const blessedBuzz = await blessedBuzzCounter.increment({ id: playerId, value: exp });

    stats = { ...stats, fervor: newFervor, blessedBuzz };
  }

  signalClient
    .topicSend({
      topic: `${SignalTopic.NewOrderPlayer}:${playerId}`,
      target: SignalMessages.NewOrderPlayerUpdate,
      data: { action: NewOrderSignalActions.UpdateStats, stats },
    })
    .catch(handleLogError);

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
    allJudmentsCounter.reset({ id: playerId }),
    expCounter.reset({ id: playerId }),
    fervorCounter.reset({ id: playerId }),
    blessedBuzzCounter.reset({ id: playerId }),
  ]);

  bustFetchThroughCache(`${REDIS_KEYS.NEW_ORDER.RATED}:${playerId}`);

  signalClient.topicSend({
    topic: `${SignalTopic.NewOrderPlayer}:${playerId}`,
    target: SignalMessages.NewOrderPlayerUpdate,
    data: {
      action: NewOrderSignalActions.Reset,
      rankType: NewOrderRankType.Acolyte,
      stats: {
        exp: 0,
        fervor: 0,
        smites: 0,
        blessedBuzz: 0,
      },
    },
  });

  if (withNotification)
    createNotification({
      category: NotificationCategory.Other,
      type: 'new-order-game-over',
      key: `new-order-fame-over:${playerId}`,
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
        select: { type: true, name: true, minExp: true },
      });

      return ranks;
    },
    { ttl: CacheTTL.month }
  );

  const rank = ranks.find((r) => r.name === name);
  if (!rank) throw throwNotFoundError(`No rank found with name ${name}`);

  return rank;
}

async function getRatedImages({ userId, startAt }: { userId: number; startAt: Date }) {
  const images = await fetchThroughCache(
    REDIS_KEYS.NEW_ORDER.RATED,
    async () => {
      const results = await clickhouse!.$query<{ imageId: number }>`
        SELECT 
          DISTINCT "imageId"
        FROM knights_new_order_image_rating
        WHERE "userId" = ${userId} AND "createdAt" >= ${startAt}
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
  rankType: NewOrderRankType | 'Inquisitor';
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
      const pool = pools[priority - 1] ?? pools[0];
      return pool.getCount(image.id);
    })
  );

  if (rankType === 'Inquisitor') {
    const imageRaters = await getImageRaters({ imageIds });
    const imagesWithRaters = images.map((image) => ({
      ...image,
      ratings: imageRaters[image.id],
    }));

    signalClient.topicSend({
      topic: `${SignalTopic.NewOrderQueue}:${rankType}`,
      target: SignalMessages.NewOrderQueueUpdate,
      data: { images: imagesWithRaters, action: NewOrderSignalActions.AddImage },
    });

    return true;
  }

  signalClient.topicSend({
    topic: `${SignalTopic.NewOrderQueue}:${rankType}`,
    target: SignalMessages.NewOrderQueueUpdate,
    data: { images, action: NewOrderSignalActions.AddImage },
  });

  return true;
}

export async function getImagesQueue({
  playerId,
  imageCount = 100,
  isModerator,
}: {
  playerId: number;
  imageCount?: number;
  isModerator?: boolean;
}) {
  const player = await getPlayerById({ playerId });

  const imageIds: number[] = [];
  const rankPools = isModerator
    ? poolCounters.Inquisitor
    : player.rankType === NewOrderRankType.Templar
    ? [...poolCounters.Templar, ...poolCounters.Knight]
    : poolCounters[player.rankType];

  const ratedImages = await getRatedImages({ userId: playerId, startAt: player.startAt });

  for (const pool of rankPools) {
    // We multiply by 10 to ensure we get enough images in case some are already rated.
    const images = (await pool.getAll({ limit: imageCount * 10 })).map(Number);
    if (images.length === 0) continue;

    // Allow mods to see all images regardless of rating.
    // imageIds.push(...images.filter((i) => !ratedImages.includes(i)));
    if (!isModerator) imageIds.push(...images.filter((i) => !ratedImages.includes(i)));
    else imageIds.push(...images);

    if (imageIds.length >= imageCount) break;
  }

  const imageRaters = await getImageRaters({ imageIds });
  const images = await dbRead.image.findMany({
    where: { id: { in: imageIds } },
    select: { id: true, url: true, nsfwLevel: true, metadata: true },
  });

  return shuffle(
    images.slice(0, imageCount).map(({ metadata, ...i }) => {
      const ratings = isModerator ? imageRaters[i.id] : null;

      return { ...i, ratings, metadata: metadata as ImageMetadata };
    })
  );
}

async function getImageRaters({ imageIds }: { imageIds: number[] }) {
  if (!clickhouse) throw throwInternalServerError('Not supported');
  if (imageIds.length === 0) return {};

  const ratings = await clickhouse.$query<{
    userId: number;
    imageId: number;
    rating: NsfwLevel;
  }>`
    SELECT "userId", "imageId", any("rating") as "rating"
    FROM knights_new_order_image_rating
    WHERE "imageId" IN (${imageIds})
    GROUP BY "userId", "imageId"
  `;

  const raters: Record<
    number,
    { player: Awaited<ReturnType<typeof getPlayerById>>; rating: NsfwLevel }[]
  > = {};

  for (const { userId, imageId, rating } of ratings) {
    if (!raters[imageId]) raters[imageId] = [];

    const player = await getPlayerById({ playerId: userId });
    if (!player) continue;

    raters[imageId].push({ player, rating });
  }

  return raters;
}

async function isImageInQueue({
  imageId,
  rankType,
}: {
  imageId: number;
  rankType: NewOrderRankType | NewOrderRankType[];
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
    createdAt: Date;
  }>`
    SELECT imageId, rating, status, grantedExp, multiplier, "createdAt"
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
    where: { id: { in: imageIds } },
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
