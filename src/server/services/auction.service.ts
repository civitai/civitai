import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  CreateBidInput,
  DeleteBidInput,
  GetAuctionBySlugInput,
  TogglePauseRecurringBidInput,
} from '~/server/schema/auction.schema';
import { TransactionType } from '~/server/schema/buzz.schema';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  createBuzzTransaction,
  getUserBuzzAccount,
  refundTransaction,
} from '~/server/services/buzz.service';
import { getImagesForModelVersionCache } from '~/server/services/image.service';
import {
  throwBadRequestError,
  throwDbError,
  throwInsufficientFundsError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';

const auctionBaseSelect = Prisma.validator<Prisma.AuctionBaseSelect>()({
  id: true,
  type: true,
  ecosystem: true,
  name: true,
  slug: true,
});

const auctionSelect = Prisma.validator<Prisma.AuctionSelect>()({
  id: true,
  startAt: true,
  endAt: true,
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
type AuctionType = Prisma.AuctionGetPayload<typeof auctionValidator>;

// TODO surround all in try catch

export type GetAllAuctionsReturn = AsyncReturnType<typeof getAllAuctions>;
export async function getAllAuctions() {
  const now = new Date();

  const aData = await dbRead.auction.findMany({
    where: { startAt: { lte: now }, endAt: { gt: now } },
    select: auctionSelect,
    orderBy: { auctionBase: { ecosystem: { sort: 'asc', nulls: 'first' } } },
  });

  return aData.map((ad) => {
    const bids = prepareBids(ad);
    const lowestBidRequired =
      bids.length > 0
        ? bids.length >= ad.quantity
          ? bids[bids.length - 1].totalAmount + 1
          : ad.minPrice
        : ad.minPrice;
    return {
      id: ad.id,
      auctionBase: ad.auctionBase,
      lowestBidRequired,
    };
  });
}

const prepareBids = (a: AuctionType) => {
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
    .slice(0, a.quantity)
    .map((b, idx) => ({
      ...b,
      position: idx + 1,
    }));
};

// { entityId: number; totalAmount: number; count: number; position: number }
const getAuctionMVData = async <T extends { entityId: number }>(data: T[]) => {
  const entityIds = data.map((x) => x.entityId);

  const mvData = await dbRead.modelVersion.findMany({
    where: { id: { in: entityIds } },
    select: {
      id: true,
      name: true,
      baseModel: true,
      model: {
        select: {
          id: true,
          name: true,
          type: true,
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
    const firstImage =
      imageData[b.entityId]?.images?.length > 0 ? imageData[b.entityId]?.images?.[0] : undefined;

    return {
      ...b,
      entityData: !!mvMatch
        ? {
            ...mvMatch,
            image: firstImage,
          }
        : undefined,
    };
  });
};

export type GetAuctionBySlugReturn = AsyncReturnType<typeof getAuctionBySlug>;
export async function getAuctionBySlug({ slug }: GetAuctionBySlugInput) {
  const now = new Date();

  const auction = await dbRead.auction.findFirst({
    where: { startAt: { lte: now }, endAt: { gt: now }, auctionBase: { slug } },
    select: auctionSelect,
  });

  if (!auction) throw throwNotFoundError('Auction not found.');

  const sortedBids = prepareBids(auction);

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
    const bids = await dbRead.bid.findMany({
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
      const sortedBids = prepareBids(b.auction);
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

        const bidsAbove = sortedBids.filter((sb) => sb.totalAmount >= b.auction.minPrice);
        const lowestPrice =
          (bidsAbove?.[(bidsAbove?.length ?? 1) - 1]?.totalAmount ?? b.auction.minPrice - 1) + 1;
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
    const bids = await dbRead.bidRecurring.findMany({
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

  const auctionData = await dbRead.auction.findFirst({
    where: { id: auctionId },
    select: {
      startAt: true,
      endAt: true,
      auctionBase: {
        select: {
          id: true,
          type: true,
          ecosystem: true,
          slug: true,
        },
      },
      bids: {
        where: {
          userId,
          entityId,
        },
        select: {
          id: true,
          amount: true,
          deleted: true,
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
  // TODO check if entityId is valid for this auction type

  // Go

  const account = await getUserBuzzAccount({ accountId: userId });
  if ((account.balance ?? 0) < amount) {
    throw throwInsufficientFundsError();
  }

  const { transactionId } = await createBuzzTransaction({
    fromAccountId: userId,
    toAccountId: 0,
    amount,
    type: TransactionType.Bid,
    details: {
      entityId,
      entityType: auctionData.auctionBase.type,
    },
  });
  if (transactionId === null) {
    throw throwBadRequestError('Could not complete transaction');
  }

  if (auctionData.bids?.length > 0) {
    // if there already exists a bid, either add to it or remove the deleted status

    const previousBid = auctionData.bids[0];
    if (!previousBid.deleted) {
      await dbWrite.bid.update({
        where: { id: previousBid.id },
        data: {
          amount: { increment: amount },
        },
      });
    } else {
      await dbWrite.bid.update({
        where: { id: previousBid.id },
        data: {
          amount,
          deleted: false,
          createdAt: now,
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
          transactionId,
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
      await refundTransaction(transactionId, 'Failed to create bid.');
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

  // TODO improve return

  return {
    slug: auctionData.auctionBase.slug,
  };
};

export const deleteBid = async ({ userId, bidId }: DeleteBidInput & { userId: number }) => {
  const now = new Date();

  const bid = await dbRead.bid.findFirst({
    where: { id: bidId },
    select: {
      userId: true,
      auction: {
        select: {
          startAt: true,
          endAt: true,
        },
      },
    },
  });
  if (!bid || bid.userId !== userId) throw throwNotFoundError('Bid not found.');

  const isActive = bid.auction.startAt <= now && bid.auction.endAt > now;
  if (!isActive) throw throwBadRequestError('Cannot delete a bid from a different day.');

  await dbWrite.bid.update({
    where: { id: bidId },
    data: {
      deleted: true,
    },
  });
};

export const deleteRecurringBid = async ({
  userId,
  bidId,
}: DeleteBidInput & { userId: number }) => {
  const bid = await dbRead.bidRecurring.findFirst({
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
}: TogglePauseRecurringBidInput & { userId: number }) => {
  const bid = await dbRead.bidRecurring.findFirst({
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
