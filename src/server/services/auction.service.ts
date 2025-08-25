import { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { uniq } from 'lodash-es';
import { getModelTypesForAuction, miscAuctionName } from '~/components/Auction/auction.utils';
import { NotificationCategory, SignalMessages, SignalTopic } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { DetailsCanceledBid } from '~/server/notifications/auction.notifications';
import type {
  CreateBidInput,
  DeleteBidInput,
  GetAuctionBySlugInput,
  TogglePauseRecurringBidInput,
} from '~/server/schema/auction.schema';
import { TransactionType } from '~/server/schema/buzz.schema';
import type { ModelMeta } from '~/server/schema/model.schema';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  createBuzzTransaction,
  getUserBuzzAccount,
  refundTransaction,
} from '~/server/services/buzz.service';
import { getImagesForModelVersionCache } from '~/server/services/image.service';
import { createNotification } from '~/server/services/notification.service';
import {
  throwBadRequestError,
  throwDbError,
  throwInsufficientFundsError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  AuctionType,
  Availability,
  BuzzAccountType,
  ModelStatus,
} from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { withRetries } from '~/utils/errorHandling';
import { signalClient } from '~/utils/signal-client';

export const auctionBaseSelect = Prisma.validator<Prisma.AuctionBaseSelect>()({
  id: true,
  type: true,
  ecosystem: true,
  name: true,
  slug: true,
  description: true,
});

export const auctionSelect = Prisma.validator<Prisma.AuctionSelect>()({
  id: true,
  startAt: true,
  endAt: true,
  validFrom: true,
  validTo: true,
  quantity: true,
  minPrice: true,
  bids: {
    select: {
      entityId: true,
      amount: true,
      createdAt: true,
      deleted: true,
    },
  },
  auctionBase: {
    select: auctionBaseSelect,
  },
});
const auctionValidator = Prisma.validator<Prisma.AuctionFindFirstArgs>()({
  select: auctionSelect,
});
type AuctionSelectType = Prisma.AuctionGetPayload<typeof auctionValidator>;

// TODO surround all in try catch

export type GetAllAuctionsReturn = AsyncReturnType<typeof getAllAuctions>;

export async function getAllAuctions() {
  const now = new Date();

  const aData = await dbWrite.auction.findMany({
    where: { startAt: { lte: now }, endAt: { gt: now } },
    select: auctionSelect,
    orderBy: { auctionBase: { ecosystem: { sort: 'asc', nulls: 'first' } } },
  });

  aData.sort((a, b) => {
    if (
      a.auctionBase.ecosystem === miscAuctionName &&
      b.auctionBase.ecosystem !== miscAuctionName
    ) {
      return 1;
    } else if (
      a.auctionBase.ecosystem !== miscAuctionName &&
      b.auctionBase.ecosystem === miscAuctionName
    ) {
      return -1;
    }
    return 0;
  });

  return aData.map((ad) => {
    const bids = prepareBids(ad);
    const winningBids = bids.filter((w) => w.totalAmount >= ad.minPrice);
    const lowestBidRequired =
      winningBids.length > 0
        ? winningBids.length >= ad.quantity
          ? winningBids[winningBids.length - 1].totalAmount + 1
          : ad.minPrice
        : ad.minPrice;
    return {
      id: ad.id,
      auctionBase: ad.auctionBase,
      lowestBidRequired,
    };
  });
}

export type PrepareBidsReturn = ReturnType<typeof prepareBids>;
export const prepareBids = (
  a: Pick<AuctionSelectType, 'bids' | 'quantity'> & {
    bids: Pick<AuctionSelectType['bids'][number], 'deleted' | 'entityId' | 'amount'>[];
  },
  returnAll = false
) => {
  return Object.values(
    a.bids
      .filter((bid) => !bid.deleted)
      .reduce((acc, { entityId, amount }) => {
        if (!acc[entityId]) {
          acc[entityId] = { entityId, totalAmount: 0, count: 0 };
        }
        acc[entityId].totalAmount += amount;
        acc[entityId].count += 1;

        return acc;
      }, {} as Record<string, { entityId: number; totalAmount: number; count: number }>)
  )
    .sort((a, b) => b.totalAmount - a.totalAmount || b.count - a.count)
    .slice(0, returnAll ? undefined : a.quantity)
    .map((b, idx) => ({
      ...b,
      position: idx + 1,
    }));
};

// { entityId: number; totalAmount: number; count: number; position: number }
const getAuctionMVData = async <T extends { entityId: number }>(data: T[]) => {
  const entityIds = data.map((x) => x.entityId);

  // TODO switch back to dbRead
  const mvData = await dbWrite.modelVersion.findMany({
    where: { id: { in: entityIds } },
    select: {
      id: true,
      name: true,
      baseModel: true,
      nsfwLevel: true,
      model: {
        select: {
          id: true,
          name: true,
          type: true,
          meta: true,
          user: {
            select: userWithCosmeticsSelect,
          },
        },
      },
    },
  });
  const imageData = await getImagesForModelVersionCache(entityIds);

  return data.map((b) => {
    const mvMatch = mvData.find((d) => d.id === b.entityId);

    if (!mvMatch) {
      return {
        ...b,
        entityData: undefined,
      };
    }

    const { meta, ...modelData } = mvMatch.model;
    const firstImage =
      imageData[b.entityId]?.images?.length > 0 ? imageData[b.entityId]?.images?.[0] : undefined;

    return {
      ...b,
      entityData: {
        ...mvMatch,
        model: {
          ...modelData,
          cannotPromote: (meta as ModelMeta | null | undefined)?.cannotPromote ?? false,
        },
        image: firstImage,
      },
    };
  });
};

export type GetAuctionBySlugReturn = AsyncReturnType<typeof getAuctionBySlug>;
export async function getAuctionBySlug({ slug, d }: GetAuctionBySlugInput) {
  const now = dayjs
    .utc()
    .add(d ?? 0, 'day')
    .startOf('day')
    .toDate();

  const auction = await dbWrite.auction.findFirst({
    where: { startAt: { lte: now }, endAt: { gt: now }, auctionBase: { slug } },
    select: auctionSelect,
  });

  if (!auction) throw throwNotFoundError('Auction not found.');

  const sortedBids = prepareBids(auction, true);

  // TODO typescript is driving me crazy, but we need an if (auction.auctionBase.type === AuctionType.Model)
  //  and then conditionally return the relevant entity data
  //  for now I'm just hardcoding this since typescript can't seem to figure it out

  // const enhancedBids =
  //   auction.auctionBase.type === AuctionType.Model
  //     ? await getAuctionMVData(sortedCompressedBids)
  //     : sortedCompressedBids;

  const enhancedBids = await getAuctionMVData(sortedBids);

  return {
    ...auction,
    bids: enhancedBids,
  };
}

export type GetMyBidsReturn = AsyncReturnType<typeof getMyBids>;
export const getMyBids = async ({ userId }: { userId: number }) => {
  try {
    const bids = await dbWrite.bid.findMany({
      where: { userId, deleted: false },
      select: {
        id: true,
        entityId: true,
        amount: true,
        createdAt: true,
        fromRecurring: true,
        isRefunded: true,
        auction: {
          select: auctionSelect,
        },
      },
    });

    const now = new Date();
    const enhancedData = bids.map((b) => {
      const sortedBids = prepareBids(b.auction, true);
      const match = sortedBids.find((sb) => sb.entityId === b.entityId);

      let position, aboveThreshold, additionalPriceNeeded, totalAmount, isActive;
      if (!match) {
        position = 0;
        aboveThreshold = false;
        additionalPriceNeeded = 0;
        totalAmount = 0;
        isActive = false;
      } else {
        position = match.position;
        aboveThreshold = match.totalAmount >= b.auction.minPrice;

        const bidsAbove = sortedBids
          .slice(0, b.auction.quantity)
          .filter((sb) => sb.totalAmount >= b.auction.minPrice);

        const lowestPrice =
          bidsAbove.length > 0
            ? bidsAbove.length >= b.auction.quantity
              ? bidsAbove[bidsAbove.length - 1].totalAmount + 1
              : b.auction.minPrice ?? 1
            : b.auction.minPrice ?? 1;
        additionalPriceNeeded = aboveThreshold ? 0 : lowestPrice - match.totalAmount;

        totalAmount = match.totalAmount;

        isActive = b.auction.startAt <= now && b.auction.endAt > now;
      }

      return {
        ...b,
        position,
        aboveThreshold,
        additionalPriceNeeded,
        totalAmount,
        isActive,
      };
    });

    const enhancedBids = await getAuctionMVData(enhancedData);

    return enhancedBids
      .map(({ auction: { bids, ...auctionRest }, ...rest }) => ({
        ...rest,
        auction: auctionRest,
      }))
      .sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.totalAmount - a.totalAmount
      );
  } catch (error) {
    throw throwDbError(error);
  }
};

export type GetMyRecurringBidsReturn = AsyncReturnType<typeof getMyRecurringBids>;
export const getMyRecurringBids = async ({ userId }: { userId: number }) => {
  try {
    const now = new Date();

    // TODO add active check on auctionBase
    const bids = await dbWrite.bidRecurring.findMany({
      where: {
        userId,
        startAt: { lte: now },
        OR: [{ endAt: { gt: now } }, { endAt: null }],
      },
      select: {
        id: true,
        entityId: true,
        amount: true,
        createdAt: true,
        endAt: true,
        isPaused: true,
        auctionBase: {
          select: auctionBaseSelect,
        },
      },
    });

    const enhancedBids = await getAuctionMVData(bids);

    return enhancedBids.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.amount - a.amount
    );
  } catch (error) {
    throw throwDbError(error);
  }
};

export const createBid = async ({
  userId,
  auctionId,
  entityId,
  amount,
  recurringUntil,
}: CreateBidInput & { userId: number }) => {
  if (!amount || amount < 0) {
    throw throwBadRequestError('Must bid a positive amount.');
  }

  const now = new Date();

  const auctionData = await dbWrite.auction.findFirst({
    where: { id: auctionId },
    select: {
      ...auctionSelect,
      bids: {
        where: {
          userId,
          entityId,
        },
        select: {
          ...auctionSelect.bids.select,
          id: true,
          transactionIds: true,
          // userId: true,
        },
      },
    },
  });
  if (!auctionData) {
    throw throwBadRequestError('Could not find a valid base auction for this recurring bid.');
  }
  if (!(auctionData.startAt <= now && auctionData.endAt > now)) {
    throw throwBadRequestError('Cannot bid on an auction from a different day.');
  }

  // - Check if entityId is valid for this auction type

  if (auctionData.auctionBase.type === AuctionType.Model) {
    // TODO switch back to dbRead
    const mv = await dbWrite.modelVersion.findFirst({
      where: { id: entityId },
      select: {
        baseModel: true,
        availability: true,
        model: {
          select: {
            type: true,
            meta: true,
            poi: true,
            status: true,
          },
        },
      },
    });
    if (!mv) throw throwBadRequestError('Could not find model version.');

    if (mv.availability === Availability.Private)
      throw throwBadRequestError('Invalid model version.');

    if (mv.model.status !== ModelStatus.Published)
      throw throwBadRequestError('Invalid model version.');

    if ((mv.model.meta as ModelMeta | null)?.cannotPromote === true)
      throw throwBadRequestError('Invalid model version.');

    if (mv.model.poi) throw throwBadRequestError('Invalid model version.');

    const allowedTypeData = getModelTypesForAuction(auctionData.auctionBase);
    const matchAllowed = allowedTypeData.find((a) => a.type === mv.model.type);
    if (!matchAllowed) throw throwBadRequestError('Invalid model type for this auction.');

    if (
      !!auctionData.auctionBase.ecosystem &&
      auctionData.auctionBase.ecosystem !== miscAuctionName
    ) {
      if (!(matchAllowed.baseModels ?? []).includes(mv.baseModel))
        throw throwBadRequestError('Invalid model ecosystem for this auction.');
    }
  }

  // - Go

  const account = await getUserBuzzAccount({ accountId: userId });
  if ((account.balance ?? 0) < amount) {
    throw throwInsufficientFundsError();
  }

  const { transactionId } = await createBuzzTransaction({
    type: TransactionType.Bid,
    fromAccountType: BuzzAccountType.user,
    fromAccountId: userId,
    toAccountId: 0,
    amount,
    description: 'Regular bid',
    details: {
      auctionId,
      entityId,
      entityType: auctionData.auctionBase.type,
    },
  });
  if (transactionId === null) {
    throw throwBadRequestError('Could not complete transaction');
  }

  // For notifications...
  // const previousBidsSorted = prepareBids(auctionData).filter(
  //   (w) => w.totalAmount >= auctionData.minPrice
  // );
  // const previousWinners = previousBidsSorted.map((pb) => {
  //   const matchUserIds = auctionData.bids
  //     .filter((b) => b.entityId === pb.entityId)
  //     .map((b) => b.userId);
  //   return { ...pb, userIds: matchUserIds };
  // });

  if (auctionData.bids?.length > 0) {
    // if there already exists a bid, either add to it or remove the deleted status
    const previousBid = auctionData.bids[0];
    if (!previousBid.deleted) {
      await dbWrite.bid.update({
        where: { id: previousBid.id },
        data: {
          amount: { increment: amount },
          transactionIds: [...previousBid.transactionIds, transactionId],
        },
      });
    } else {
      await dbWrite.bid.update({
        where: { id: previousBid.id },
        data: {
          amount,
          deleted: false,
          isRefunded: false,
          createdAt: now,
          transactionIds: [transactionId],
        },
      });
    }
  } else {
    // otherwise, create the bid
    try {
      await dbWrite.bid.create({
        data: {
          userId,
          auctionId,
          entityId,
          amount,
          transactionIds: [transactionId],
        },
      });
    } catch (e) {
      const err = e as Error;
      logToAxiom({
        name: 'Failed to insert bid',
        type: 'error',
        details: {
          userId,
          auctionId,
          entityId,
          amount,
        },
        message: err.message,
        stack: err.stack,
        cause: err.cause,
      }).catch();
      await withRetries(() => refundTransaction(transactionId, 'Failed to create bid.'));
    }
  }

  if (!!recurringUntil) {
    await dbWrite.bidRecurring.upsert({
      where: {
        auctionBaseId_userId_entityId: {
          auctionBaseId: auctionData.auctionBase.id,
          entityId,
          userId,
        },
      },
      create: {
        userId,
        entityId,
        amount,
        startAt: now,
        endAt: recurringUntil === 'forever' ? null : recurringUntil,
        auctionBaseId: auctionData.auctionBase.id,
      },
      update: {
        amount: { increment: amount },
      },
    });
  }

  // TODO there is probably a better way to do this that avoids refetching everything, but we need to update all positions and numbers
  const signalData = await getAuctionBySlug({ slug: auctionData.auctionBase.slug });
  signalClient
    .topicSend({
      topic: `${SignalTopic.Auction}:${auctionId}`,
      target: SignalMessages.AuctionBidChange,
      data: signalData,
    })
    .catch();

  // TODO fetch the entity that was knocked out (if any)
  //  get all the bids userIds

  // const currentBidsSorted = prepareBids(signalData);
  // const currentWinners = currentBidsSorted.map((pb) => {
  //   const matchUserIds = auctionData.bids
  //     .filter((b) => b.entityId === pb.entityId)
  //     .map((b) => b.userId);
  //   return { ...pb, userIds: matchUserIds };
  // });
  // const losers = previousWinners.filter((w) => !currentWinners.find((pw) => pw.entityId === w.entityId));

  // await createNotification({
  //   userIds: loser.userIds,
  //   category: NotificationCategory.System,
  //   type: 'dropped-out-auction',
  //   key: `dropped-out-auction:${auctionId}:${loser.entityId}`,
  //   details: {
  //     name: loser.entityName,
  //   } as DetailsDroppedOutAuction,
  // });

  // improve return?
  return {
    slug: auctionData.auctionBase.slug,
  };
};

export const deleteBid = async ({ userId, bidId }: DeleteBidInput & { userId: number }) => {
  const now = new Date();

  const bid = await dbWrite.bid.findFirst({
    where: { id: bidId },
    select: {
      userId: true,
      transactionIds: true,
      auction: {
        select: {
          id: true,
          startAt: true,
          endAt: true,
          auctionBase: {
            select: { slug: true },
          },
        },
      },
    },
  });
  if (!bid || bid.userId !== userId) throw throwNotFoundError('Bid not found.');

  const isActive = bid.auction.startAt <= now && bid.auction.endAt > now;
  if (!isActive) throw throwBadRequestError('Cannot delete a bid from a different day.');

  for (const transactionId of bid.transactionIds) {
    await withRetries(() => refundTransaction(transactionId, 'Deleted bid.'));
  }

  await dbWrite.bid.update({
    where: { id: bidId },
    data: {
      deleted: true,
    },
  });

  const signalData = await getAuctionBySlug({ slug: bid.auction.auctionBase.slug });
  signalClient
    .topicSend({
      topic: `${SignalTopic.Auction}:${bid.auction.id}`,
      target: SignalMessages.AuctionBidChange,
      data: signalData,
    })
    .catch();
};

export const deleteBidsForModel = async ({ modelId }: { modelId: number }) => {
  const now = new Date();

  const model = await dbWrite.model.findFirst({
    where: { id: modelId },
    select: { name: true, modelVersions: { select: { id: true } } },
  });

  if (!model) throw throwNotFoundError('Model not found.');
  const versionIds = model.modelVersions.map((mv) => mv.id);
  if (!versionIds.length) {
    // early return if no versions
    return { bidsDeleted: [], recurringBidsDeleted: [] };
  }

  const aData = await dbWrite.auction.findMany({
    where: { startAt: { lte: now }, endAt: { gt: now } },
    select: {
      id: true,
      auctionBase: {
        select: {
          slug: true,
        },
      },
    },
  });
  const aIds = aData.map((a) => a.id);

  let deletedIds: number[] = [];
  let deletedRecurringIds: number[] = [];

  if (aIds.length > 0) {
    // we could reverse the logic here and refund first
    const deleted = await dbWrite.bid.updateManyAndReturn({
      where: { auctionId: { in: aIds }, entityId: { in: versionIds } },
      data: {
        deleted: true,
      },
      select: {
        id: true,
        userId: true,
        transactionIds: true,
      },
    });

    for (const bid of deleted) {
      for (const transactionId of bid.transactionIds) {
        try {
          await withRetries(() =>
            refundTransaction(transactionId, 'Deleted bid - model not available.')
          );
        } catch (e) {
          const error = e as Error;
          logToAxiom({
            name: 'handle-auctions',
            type: 'error',
            message: `Failed to refund user for removed bid`,
            stack: error.stack,
            cause: error.cause,
            data: { transactionId, message: error.message },
          }).catch();
        }
      }
    }

    if (deleted.length > 0) {
      const details: DetailsCanceledBid = {
        name: model?.name ?? null,
        reason: 'Model not available',
        recurring: false,
      };
      await createNotification({
        userIds: uniq(deleted.map((d) => d.userId)),
        category: NotificationCategory.System,
        type: 'canceled-bid-auction',
        key: `canceled-bid-auction:${modelId}:${formatDate(now, 'YYYY-MM-DD')}`,
        details,
      });

      deletedIds = deleted.map((d) => d.id);
    }
  }

  const recToDelete = await dbWrite.bidRecurring.findMany({
    where: { entityId: { in: versionIds } },
    select: { id: true, userId: true },
  });

  if (recToDelete.length > 0) {
    await dbWrite.bidRecurring.deleteMany({
      where: { id: { in: recToDelete.map((r) => r.id) } },
    });
    const details: DetailsCanceledBid = {
      name: model?.name ?? null,
      reason: 'Model no longer available',
      recurring: true,
    };
    await createNotification({
      userIds: uniq(recToDelete.map((d) => d.userId)),
      category: NotificationCategory.System,
      type: 'canceled-bid-auction',
      key: `canceled-bid-auction:recurring:${modelId}:${formatDate(now, 'YYYY-MM-DD')}`,
      details,
    });

    deletedRecurringIds = recToDelete.map((d) => d.id);
  }

  for (const a of aData) {
    const signalData = await getAuctionBySlug({ slug: a.auctionBase.slug });
    signalClient
      .topicSend({
        topic: `${SignalTopic.Auction}:${a.id}`,
        target: SignalMessages.AuctionBidChange,
        data: signalData,
      })
      .catch();
  }

  return {
    bidsDeleted: deletedIds,
    recurringBidsDeleted: deletedRecurringIds,
  };
};

export const deleteBidsForModelVersion = async ({ modelVersionId }: { modelVersionId: number }) => {
  // TODO combine this function with one above
  const now = new Date();

  const aData = await dbWrite.auction.findMany({
    where: { startAt: { lte: now }, endAt: { gt: now } },
    select: {
      id: true,
      auctionBase: {
        select: {
          slug: true,
        },
      },
    },
  });
  const aIds = aData.map((a) => a.id);

  let deletedIds: number[] = [];
  let deletedRecurringIds: number[] = [];

  if (aIds.length > 0) {
    // we could reverse the logic here and refund first
    const deleted = await dbWrite.bid.updateManyAndReturn({
      where: { auctionId: { in: aIds }, entityId: modelVersionId },
      data: {
        deleted: true,
      },
      select: {
        id: true,
        userId: true,
        transactionIds: true,
      },
    });

    for (const bid of deleted) {
      for (const transactionId of bid.transactionIds) {
        try {
          await withRetries(() =>
            refundTransaction(transactionId, 'Deleted bid - model not available.')
          );
        } catch (e) {
          const error = e as Error;
          logToAxiom({
            name: 'handle-auctions',
            type: 'error',
            message: `Failed to refund user for removed bid`,
            stack: error.stack,
            cause: error.cause,
            data: { transactionId, message: error.message },
          }).catch();
        }
      }
    }

    if (deleted.length > 0) {
      const details: DetailsCanceledBid = {
        name: 'a model',
        reason: 'Model not available',
        recurring: false,
      };
      await createNotification({
        userIds: uniq(deleted.map((d) => d.userId)),
        category: NotificationCategory.System,
        type: 'canceled-bid-auction',
        key: `canceled-bid-auction:${modelVersionId}:${formatDate(now, 'YYYY-MM-DD')}`,
        details,
      });

      deletedIds = deleted.map((d) => d.id);
    }
  }

  const recToDelete = await dbWrite.bidRecurring.findMany({
    where: { entityId: modelVersionId },
    select: { id: true, userId: true },
  });

  if (recToDelete.length > 0) {
    await dbWrite.bidRecurring.deleteMany({
      where: { id: { in: recToDelete.map((r) => r.id) } },
    });
    const details: DetailsCanceledBid = {
      name: 'a model',
      reason: 'Model no longer available',
      recurring: true,
    };
    await createNotification({
      userIds: uniq(recToDelete.map((d) => d.userId)),
      category: NotificationCategory.System,
      type: 'canceled-bid-auction',
      key: `canceled-bid-auction:recurring:${modelVersionId}:${formatDate(now, 'YYYY-MM-DD')}`,
      details,
    });

    deletedRecurringIds = recToDelete.map((d) => d.id);
  }

  for (const a of aData) {
    const signalData = await getAuctionBySlug({ slug: a.auctionBase.slug });
    signalClient
      .topicSend({
        topic: `${SignalTopic.Auction}:${a.id}`,
        target: SignalMessages.AuctionBidChange,
        data: signalData,
      })
      .catch();
  }

  return {
    bidsDeleted: deletedIds,
    recurringBidsDeleted: deletedRecurringIds,
  };
};

export const deleteRecurringBid = async ({
  userId,
  bidId,
}: DeleteBidInput & { userId: number }) => {
  const bid = await dbWrite.bidRecurring.findFirst({
    where: { id: bidId },
    select: {
      userId: true,
    },
  });
  if (!bid || bid.userId !== userId) throw throwNotFoundError('Bid not found.');

  await dbWrite.bidRecurring.delete({
    where: { id: bidId },
  });
};

export const togglePauseRecurringBid = async ({
  userId,
  bidId,
}: TogglePauseRecurringBidInput & {
  userId: number;
}) => {
  const bid = await dbWrite.bidRecurring.findFirst({
    where: { id: bidId },
    select: {
      userId: true,
      isPaused: true,
    },
  });
  if (!bid || bid.userId !== userId) throw throwNotFoundError('Bid not found.');

  return dbWrite.bidRecurring.update({
    where: { id: bidId },
    data: {
      isPaused: !bid.isPaused,
    },
    select: {
      id: true,
      isPaused: true,
    },
  });
};

export async function getLastAuctionReset() {
  const auctionReset = await dbWrite.$queryRaw<{ since_date: Date }[]>`
    SELECT
    a."validFrom" as since_date
    FROM "Auction" a
    JOIN "AuctionBase" ab ON ab.id = a."auctionBaseId"
    WHERE ab.slug = 'featured-checkpoints' AND a.finalized
    ORDER BY "endAt" DESC
    LIMIT 1;
  `;

  return auctionReset[0]?.since_date ?? null;
}
