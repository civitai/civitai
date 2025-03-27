import { clickhouse } from '~/server/clickhouse/client';
import {
  NewOrderDamnedReason,
  NewOrderImageRating,
  NewOrderImageRatingStatus,
  ImageSort,
  NsfwLevel,
} from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  allJudmentsCounter,
  blessedBuzzCounter,
  correctJudgementsCounter,
  expCounter,
  fervorCounter,
  smitesCounter,
} from '~/server/games/new-order/utils';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { playerInfoSelect } from '~/server/selectors/user.selector';
import { getAllImagesIndex } from '~/server/services/image.service';
import { throwInternalServerError, throwNotFoundError } from '~/server/utils/errorHandling';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

export async function joinGame({ userId }: { userId: number }) {
  const user = await dbRead.user.findUnique({
    where: { id: userId },
    select: {
      playerInfo: {
        select: {
          ...playerInfoSelect,
          _count: { select: { smiteReceived: { where: { cleansedAt: null } } } },
        },
      },
    },
  });

  if (!user) throw throwNotFoundError(`No user with id ${userId}`);
  if (user.playerInfo) return user.playerInfo; // User is already in game

  // TODO.newOrder: determine how to get ranks
  const player = await dbWrite.newOrderPlayer.create({
    data: { userId, rankId: 1, startAt: new Date() },
    select: playerInfoSelect,
  });

  return player;
}

export async function getImagesQueue() {
  const images = await getAllImagesIndex({
    limit: 1000,
    browsingLevel: allBrowsingLevelsFlag,
    sort: ImageSort.Newest,
    period: MetricTimeframe.AllTime,
    periodMode: 'published',
    include: ['meta'],
  });

  return images;
}

export async function smitePlayer({
  playerId,
  modId,
  reason,
  size,
}: {
  playerId: number;
  modId: number;
  reason: string;
  size: number;
}) {
  const smite = await dbWrite.newOrderSmite.create({
    data: {
      targetPlayerId: playerId,
      givenById: modId,
      reason,
      size,
      remaining: size,
    },
  });

  const smiteCount = await dbWrite.newOrderSmite.count({
    where: { targetPlayerId: playerId, cleansedAt: null },
  });
  if (smiteCount >= 3) return resetPlayer({ playerId });

  await smitesCounter.increment({ id: playerId, value: size });

  return smite;
}

export async function cleanseSmite({
  id,
  cleansedReason,
  playerId,
}: {
  id: number;
  cleansedReason: string;
  playerId: number;
}) {
  const smite = await dbWrite.newOrderSmite.update({
    where: { id },
    data: { cleansedAt: new Date(), cleansedReason },
  });

  await smitesCounter.decrement({ id: playerId, value: smite.size });

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
}: {
  playerId: number;
  imageId: number;
  rating: NewOrderImageRating;
  damnedReason?: NewOrderDamnedReason;
}) {
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
  await clickhouse.insert<{
    userId: number;
    imageId: number;
    rating: NewOrderImageRating;
    status: NewOrderImageRatingStatus;
  }>({
    table: 'holy_order_image_rating',
    values: [
      {
        userId: playerId,
        imageId,
        rating,
        status: player.rank.name === 'Acolyte' ? `Acolyte${status}` : status,
        createdAt: new Date(),
        damnedReason,
        grantedExp,
        multiplier,
      },
    ],
    format: 'JSONEachRow',
  });

  // Increase rating count
  await sysRedis.hIncrBy(
    `${REDIS_SYS_KEYS.NEW_ORDER.RATINGS}:${imageId}`,
    `${player.rank.name}-${rating}`,
    1
  );

  // Increase all counters
  const stats = await updatePlayerStats({ playerId, status, exp: grantedExp * multiplier });

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

  return { exp: newExp, fervor: newFervor, blessedBuzz };
}

async function resetPlayer({ playerId }: { playerId: number }) {
  await dbWrite.$transaction([
    // Reset player back to level 1
    dbWrite.newOrderPlayer.update({
      where: { userId: playerId },
      data: { rankId: 1, exp: 0, fervor: 0 },
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

  // TODO.newOrder: Cleanup clickhouse data?
}
