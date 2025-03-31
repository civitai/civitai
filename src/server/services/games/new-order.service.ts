import { clickhouse, Tracker } from '~/server/clickhouse/client';
import {
  NewOrderImageRating,
  NewOrderImageRatingStatus,
  ImageSort,
  NsfwLevel,
  SignalTopic,
  SignalMessages,
} from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  allJudmentsCounter,
  blessedBuzzCounter,
  correctJudgementsCounter,
  expCounter,
  fervorCounter,
  poolCounters,
  smitesCounter,
} from '~/server/games/new-order/utils';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { InfiniteQueryInput } from '~/server/schema/base.schema';
import {
  AddImageRatingInput,
  CleanseSmiteInput,
  SmitePlayerInput,
} from '~/server/schema/games/new-order.schema';
import { playerInfoSelect } from '~/server/selectors/user.selector';
import { getAllImagesIndex } from '~/server/services/image.service';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import {
  throwBadRequestError,
  throwInternalServerError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { MetricTimeframe, NewOrderRankType } from '~/shared/utils/prisma/enums';
import { shuffle } from '~/utils/array-helpers';
import { signalClient } from '~/utils/signal-client';

export async function joinGame({ userId }: { userId: number }) {
  const user = await dbRead.user.findUnique({
    where: { id: userId },
    select: {
      playerInfo: {
        select: {
          ...playerInfoSelect,
          // Might not be necessary
          _count: { select: { smiteReceived: { where: { cleansedAt: null } } } },
        },
      },
    },
  });

  if (!user) throw throwNotFoundError(`No user with id ${userId}`);
  if (user.playerInfo) {
    // User is already in game
    const stats = await getPlayerStats({ playerId: userId });
    return { ...user.playerInfo, stats };
  }

  const player = await dbWrite.newOrderPlayer.create({
    data: { userId, rankType: NewOrderRankType.Accolyte, startAt: new Date() },
    select: playerInfoSelect,
  });

  return { ...player, stats: { exp: 0, fervor: 0, smites: 0, blessedBuzz: 0 } };
}

function getPlayerById({ playerId }: { playerId: number }) {
  return dbRead.newOrderPlayer.findUnique({
    where: { userId: playerId },
    select: playerInfoSelect,
  });
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
  if (activeSmiteCount >= 3) return resetPlayer({ playerId });

  const newSmiteCount = await smitesCounter.increment({ id: playerId, value: size });
  signalClient.topicSend({
    topic: `${SignalTopic.NewOrderPlayer}:${playerId}`,
    target: SignalMessages.NewOrderPlayerUpdate,
    data: { playerId, smites: newSmiteCount },
  });

  return smite;
}

export async function cleanseSmite({ id, cleansedReason, playerId }: CleanseSmiteInput) {
  const smite = await dbWrite.newOrderSmite.update({
    where: { id },
    data: { cleansedAt: new Date(), cleansedReason },
  });

  const smiteCount = await smitesCounter.decrement({ id: playerId, value: smite.size });
  signalClient.topicSend({
    topic: `${SignalTopic.NewOrderPlayer}:${playerId}`,
    target: SignalMessages.NewOrderPlayerUpdate,
    data: { playerId, smites: smiteCount },
  });

  return smite;
}

const NewOrderImageRatingToNsfwLevel: Record<NewOrderImageRating, NsfwLevel> = {
  [NewOrderImageRating.Sanctified]: NsfwLevel.PG,
  [NewOrderImageRating.Blessed]: NsfwLevel.PG13,
  [NewOrderImageRating.Virtuous]: NsfwLevel.R,
  [NewOrderImageRating.Tempted]: NsfwLevel.X,
  [NewOrderImageRating.Tainted]: NsfwLevel.XXX,
  [NewOrderImageRating.Damned]: NsfwLevel.Blocked,
};

export async function addImageRating({
  playerId,
  imageId,
  rating,
  damnedReason,
  chTracker,
}: AddImageRatingInput & { chTracker?: Tracker }) {
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

  // TODO.newOrder: check if image is already rated
  const ratingCount = await sysRedis.hGetAll(`${REDIS_SYS_KEYS.NEW_ORDER.RATINGS}:${imageId}`);

  // TODO.newOrder: adjust status based on rating distance
  const status =
    image.nsfwLevel === NewOrderImageRatingToNsfwLevel[rating]
      ? NewOrderImageRatingStatus.Correct
      : NewOrderImageRatingStatus.Failed;

  // TODO.newOrder: grantedExp and multiplier
  const grantedExp = 100;
  const multiplier = status === NewOrderImageRatingStatus.Correct ? 1 : -1;

  // TODO.newOrder: should we await this?
  // TODO.newOrder: replace with clickhouse tracker
  if (chTracker) {
    try {
      await chTracker.newOrderImageRating({
        playerId,
        imageId,
        rating,
        status:
          player.rank.name === 'Acolyte'
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
          name: 'Failed to track new order image rating',
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
  await sysRedis.hIncrBy(
    `${REDIS_SYS_KEYS.NEW_ORDER.RATINGS}:${imageId}`,
    `${player.rank.name}-${rating}`,
    1
  );

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
  const stats = await updatePlayerStats({ playerId, status, exp: grantedExp * multiplier });
  signalClient.topicSend({
    topic: `${SignalTopic.NewOrderPlayer}:${playerId}`,
    target: SignalMessages.NewOrderPlayerUpdate,
    data: { ...stats, playerId },
  });

  // TODO.newOrder: what else can we return here?
  return { stats };
}

export async function updatePlayerStats({
  playerId,
  status,
  exp,
  writeToDb,
}: {
  playerId: number;
  status: NewOrderImageRatingStatus;
  exp: number;
  writeToDb?: boolean;
}) {
  const allJudgements = await allJudmentsCounter.increment({ id: playerId });
  const correctJudgements =
    status === NewOrderImageRatingStatus.Correct
      ? await correctJudgementsCounter.increment({ id: playerId })
      : await correctJudgementsCounter.getCount(playerId);

  const correctPercentage = correctJudgements / (allJudgements || 1);
  const fervor = correctJudgements * correctPercentage * Math.E ** (allJudgements * -1);

  const newFervor = await fervorCounter.increment({ id: playerId, value: fervor });
  const newExp = await expCounter.increment({ id: playerId, value: exp });
  // TODO.newOrder: adjust buzz based on conversion rate
  const blessedBuzz = await blessedBuzzCounter.increment({ id: playerId, value: exp });

  if (writeToDb) {
    await dbWrite.newOrderPlayer.update({
      where: { userId: playerId },
      data: { exp: newExp, fervor: newFervor },
    });
  }

  const stats = { exp: newExp, fervor: newFervor, blessedBuzz };

  signalClient.topicSend({
    topic: `${SignalTopic.NewOrderPlayer}:${playerId}`,
    target: SignalMessages.NewOrderPlayerUpdate,
    data: { ...stats, playerId },
  });

  return { ...stats };
}

export function calculateFervor({
  correctJudgements,
  allJudgements,
}: {
  correctJudgements: number;
  allJudgements: number;
}) {
  const correctPercentage = correctJudgements / (allJudgements || 1);
  return correctJudgements * correctPercentage * Math.E ** (allJudgements * -1);
}

async function resetPlayer({ playerId }: { playerId: number }) {
  await dbWrite.$transaction([
    // Reset player back to level 1
    dbWrite.newOrderPlayer.update({
      where: { userId: playerId },
      data: { rankType: NewOrderRankType.Accolyte, exp: 0, fervor: 0 },
    }),
    // Cleanse all smites
    dbWrite.newOrderSmite.updateMany({
      where: { targetPlayerId: playerId, cleansedAt: null },
      data: { cleansedAt: new Date(), cleansedReason: 'Exceeded smite limit' },
    }),
  ]);

  // Reset all counters
  await Promise.all([
    smitesCounter.reset({ id: playerId }),
    correctJudgementsCounter.reset({ id: playerId }),
    allJudmentsCounter.reset({ id: playerId }),
    expCounter.reset({ id: playerId }),
    fervorCounter.reset({ id: playerId }),
    blessedBuzzCounter.reset({ id: playerId }),
  ]);

  signalClient.topicSend({
    topic: `${SignalTopic.NewOrderPlayer}:${playerId}`,
    target: SignalMessages.NewOrderPlayerUpdate,
    data: {
      playerId,
      rankId: 1,
      exp: 0,
      fervor: 0,
      smites: 0,
      blessedBuzz: 0,
    },
  });

  // TODO.newOrder: Cleanup clickhouse data?
}

export async function getNewOrderRank({ name }: { name: string }) {
  const ranks = await fetchThroughCache(
    REDIS_KEYS.CACHES.NEW_ORDER.RANKS,
    async () => {
      const ranks = await dbRead.newOrderRank.findMany({
        orderBy: { type: 'asc' },
        select: { type: true, name: true, minExp: true },
      });

      return ranks;
    },
    { ttl: 0 } // TODO.newOrder: set a proper TTL
  );

  const rank = ranks.find((r) => r.name === name);
  if (!rank) throw throwNotFoundError(`No rank found with name ${name}`);

  return rank;
}

export async function getImagesQueue({
  playerId,
  imageCount,
}: {
  playerId: number;
  imageCount: number;
}) {
  const player = await dbRead.newOrderPlayer.findUnique({
    where: { userId: playerId },
    select: {
      userId: true,
      rankType: true,
    },
  });

  if (!player) throw throwNotFoundError(`No player with id ${playerId}`);

  const imageIds: number[] = [];
  const rankPools =
    player.rankType === NewOrderRankType.Templar
      ? [...poolCounters.Templar, ...poolCounters.Knight]
      : poolCounters[player.rankType];

  for (const pool of rankPools) {
    const images = await pool.getAll(imageCount);
    if (images.length === 0) continue;

    imageIds.push(...images);

    if (imageIds.length >= imageCount) break;
  }

  return shuffle(imageIds.slice(0, imageCount));
}
