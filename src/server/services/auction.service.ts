import { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { uniq } from 'lodash-es';
import { getModelTypesForAuction, miscAuctionName } from '~/components/Auction/auction.utils';
import { NotificationCategory, SignalMessages, SignalTopic } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import type {
  DetailsCanceledBid,
  DetailsDroppedOutAuction,
} from '~/server/notifications/auction.notifications';
import type {
  CreateBidInput,
  DeleteBidInput,
  GetAuctionBasesInput,
  GetAuctionBySlugInput,
  TogglePauseRecurringBidInput,
  UpdateAuctionBaseInput,
} from '~/server/schema/auction.schema';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type { ModelMeta } from '~/server/schema/model.schema';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  createMultiAccountBuzzTransaction,
  getUserBuzzAccount,
  refundMultiAccountTransaction,
  refundTransaction,
} from '~/server/services/buzz.service';
import { imagesForModelVersionsCache } from '~/server/services/image.service';
import { createNotification } from '~/server/services/notification.service';
import {
  throwBadRequestError,
  throwDbError,
  throwInsufficientFundsError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { AuctionType, Availability, ModelStatus } from '~/shared/utils/prisma/enums';
import { getBuzzTransactionSupportedAccountTypes } from '~/utils/buzz';
import { formatDate } from '~/utils/date-helpers';
import { withRetries } from '~/utils/errorHandling';
import { signalClient } from '~/utils/signal-client';
import { isDefined } from '~/utils/type-guards';

export const getAuctionTransactionPrefix = (auctionId: number, userId: number) =>
  `auction-${auctionId}-${userId}-${new Date().getTime()}`;

export const isAuctionTransactionPrefix = (prefix: string) => {
  return prefix.startsWith('auction-') && prefix.split('-').length >= 4;
};

export const auctionBaseSelect = Prisma.validator<Prisma.AuctionBaseSelect>()({
  id: true,
  type: true,
  ecosystem: true,
  name: true,
  slug: true,
  description: true,
});

export const auctionWithoutBidsSelect = Prisma.validator<Prisma.AuctionSelect>()({
  id: true,
  startAt: true,
  endAt: true,
  validFrom: true,
  validTo: true,
  quantity: true,
  minPrice: true,
  auctionBase: {
    select: auctionBaseSelect,
  },
});

export const auctionSelect = Prisma.validator<Prisma.AuctionSelect>()({
  ...auctionWithoutBidsSelect,
  bids: {
    select: {
      entityId: true,
      amount: true,
      createdAt: true,
      deleted: true,
      auctionId: true,
    },
  },
});
const auctionValidator = Prisma.validator<Prisma.AuctionFindFirstArgs>()({
  select: auctionSelect,
});
type AuctionSelectType = Prisma.AuctionGetPayload<typeof auctionValidator>;

export type GetAllAuctionsReturn = AsyncReturnType<typeof getAllAuctions>;

// The origin (uncached) fetch: reduces each active auction to
// `{ id, auctionBase, lowestBidRequired }`. The output is fully user-independent
// (no `ctx`/`userId`) — the requiredScope on the router gates ACCESS, not the
// payload — so a single global cache entry is correct for every caller. Kept as a
// separate export so tests can assert cache-hit skips it.
export async function getAllAuctionsUncached() {
  const now = new Date();

  const aData = await dbRead.auction.findMany({
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

// Never busted, so callers can be up to 30s stale. Safe because the active set is
// time-windowed, and because `lowestBidRequired` is a display hint that `createBid`
// re-validates — a stale value can't let an under-minimum bid through.
export async function getAllAuctions() {
  return fetchThroughCache(REDIS_KEYS.CACHES.ACTIVE_AUCTIONS, getAllAuctionsUncached, {
    ttl: 30,
  });
}

export type PrepareBidsReturn = ReturnType<typeof prepareBids>;
export const prepareBids = (
  a: Pick<AuctionSelectType, 'bids' | 'quantity'> & {
    bids: Pick<AuctionSelectType['bids'][number], 'deleted' | 'entityId' | 'amount'>[];
  },
  returnAll = false
) => {
  return (
    Object.values(
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
      // The entityId tiebreak has to match the `ranked` CTE in getMyBids, or the same tied
      // bid gets a different position on the auction page than in My Bids. It currently
      // holds either way — integer-like keys make Object.values return entityId-ascending
      // and sort is stable — but only by accident, and a Map here would silently break it.
      .sort((a, b) => b.totalAmount - a.totalAmount || b.count - a.count || a.entityId - b.entityId)
      .slice(0, returnAll ? undefined : a.quantity)
      .map((b, idx) => ({
        ...b,
        position: idx + 1,
      }))
  );
};

// Image metadata is the largest field in the auction payload and no card reads it. The
// annotation keeps the field's declared type — inferring `null` narrows it and rejects
// callers that build this shape from a real image (e.g. ResourceSelectCard).
const stripMetadata = <T extends { metadata: unknown }>(entity: T) => ({
  ...entity,
  metadata: null as T['metadata'],
});

// { entityId: number; totalAmount: number; count: number; position: number }
const getAuctionMVData = async <T extends { entityId: number }>(data: T[]) => {
  const entityIds = data.map((x) => x.entityId);

  const mvData = await dbRead.modelVersion.findMany({
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
          nsfw: true,
          poi: true,
          minor: true,
          meta: true,
          user: {
            select: userWithCosmeticsSelect,
          },
        },
      },
    },
  });
  // The tag-attaching wrapper (`getImagesForModelVersionCache`) costs a second cache
  // round-trip for tags no auction card reads.
  const imageData = await imagesForModelVersionsCache.fetch(entityIds);
  const mvById = new Map(mvData.map((d) => [d.id, d]));

  return data.map((b) => {
    const mvMatch = mvById.get(b.entityId);

    if (!mvMatch) {
      return {
        ...b,
        entityData: undefined,
      };
    }

    const { meta, user, ...modelData } = mvMatch.model;
    const firstImage = imageData[b.entityId]?.images?.[0];

    return {
      ...b,
      entityData: {
        ...mvMatch,
        model: {
          ...modelData,
          user: {
            ...user,
            profilePicture: user.profilePicture
              ? stripMetadata(user.profilePicture)
              : user.profilePicture,
          },
          cannotPromote: (meta as ModelMeta | null | undefined)?.cannotPromote ?? false,
        },
        image: firstImage ? stripMetadata(firstImage) : undefined,
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

  const auction = await dbRead.auction.findFirst({
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

// Past bids are shown indefinitely otherwise; the heaviest bidder has 4.7k bids
// across 1.5k auctions, and every one of them drags in that auction's whole bid set.
export const MY_BIDS_HISTORY_DAYS = 90;

type MyBidRow = {
  id: number;
  entityId: number;
  amount: number;
  createdAt: Date;
  fromRecurring: boolean;
  isRefunded: boolean;
  accountType: string;
  auctionId: number;
  position: number | null;
  totalAmount: number | null;
  winners: number;
  lowestWinning: number | null;
};

export type GetMyBidsReturn = AsyncReturnType<typeof getMyBids>;
export const getMyBids = async ({ userId }: { userId: number }) => {
  try {
    // The per-entity totals, ranking and winning threshold are computed in SQL so we
    // ship one row per bid the user placed, rather than every bid of every auction
    // they ever participated in.
    const rows = await dbRead.$queryRaw<MyBidRow[]>`
      WITH "myBids" AS (
        SELECT b.id, b."entityId", b.amount, b."createdAt", b."fromRecurring",
               b."isRefunded", b."accountType", b."auctionId"
        FROM "Bid" b
        JOIN "Auction" a ON a.id = b."auctionId"
        WHERE b."userId" = ${userId}
          AND b.deleted = false
          AND a."endAt" > now() - ${`${MY_BIDS_HISTORY_DAYS} days`}::interval
      ),
      "myAuctionIds" AS (SELECT DISTINCT "auctionId" FROM "myBids"),
      "entityTotals" AS (
        SELECT b."auctionId", b."entityId",
               SUM(b.amount)::int AS "totalAmount",
               COUNT(*)::int AS "bidCount"
        FROM "Bid" b
        JOIN "myAuctionIds" ON "myAuctionIds"."auctionId" = b."auctionId"
        WHERE b.deleted = false
        GROUP BY 1, 2
      ),
      -- Ordering must match prepareBids, including the entityId tiebreak.
      "ranked" AS (
        SELECT "entityTotals".*,
               ROW_NUMBER() OVER (
                 PARTITION BY "auctionId"
                 ORDER BY "totalAmount" DESC, "bidCount" DESC, "entityId"
               )::int AS position
        FROM "entityTotals"
      ),
      "winningThresholds" AS (
        SELECT r."auctionId",
               COUNT(*)::int AS winners,
               MIN(r."totalAmount")::int AS "lowestWinning"
        FROM "ranked" r
        JOIN "Auction" a ON a.id = r."auctionId"
        WHERE r."totalAmount" >= a."minPrice" AND r.position <= a.quantity
        GROUP BY 1
      )
      SELECT m.*, r.position, r."totalAmount",
             COALESCE(t.winners, 0) AS winners, t."lowestWinning"
      FROM "myBids" m
      LEFT JOIN "ranked" r ON r."auctionId" = m."auctionId" AND r."entityId" = m."entityId"
      LEFT JOIN "winningThresholds" t ON t."auctionId" = m."auctionId"
    `;

    if (!rows.length) return [];

    const auctions = await dbRead.auction.findMany({
      where: { id: { in: uniq(rows.map((r) => r.auctionId)) } },
      select: auctionWithoutBidsSelect,
    });
    const auctionsById = new Map(auctions.map((a) => [a.id, a]));

    const now = new Date();
    const enhancedData = rows
      .map(({ auctionId, position, totalAmount, winners, lowestWinning, ...bid }) => {
        const auction = auctionsById.get(auctionId);
        if (!auction) return null;

        if (position === null || totalAmount === null) {
          return {
            ...bid,
            auction,
            position: 0,
            aboveThreshold: false,
            additionalPriceNeeded: 0,
            totalAmount: 0,
            isActive: false,
          };
        }

        const aboveThreshold = totalAmount >= auction.minPrice;
        const lowestPrice =
          winners >= auction.quantity && lowestWinning !== null
            ? lowestWinning + 1
            : auction.minPrice ?? 1;

        return {
          ...bid,
          auction,
          position,
          aboveThreshold,
          additionalPriceNeeded: aboveThreshold ? 0 : lowestPrice - totalAmount,
          totalAmount,
          isActive: auction.startAt <= now && auction.endAt > now,
        };
      })
      .filter(isDefined);

    const enhancedBids = await getAuctionMVData(enhancedData);

    return enhancedBids.sort(
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
        accountType: true,
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
  accountTypes,
}: CreateBidInput & { userId: number; accountTypes: BuzzSpendType[] }) => {
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
          accountType: accountTypes[0] ?? 'yellow',
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
    const mv = await dbRead.modelVersion.findFirst({
      where: { id: entityId },
      select: {
        baseModel: true,
        availability: true,
        nsfwLevel: true,
        status: true,
        model: {
          select: {
            type: true,
            meta: true,
            poi: true,
            minor: true,
            status: true,
            nsfwLevel: true,
            nsfw: true,
            availability: true,
          },
        },
      },
    });
    if (!mv) throw throwBadRequestError('Could not find model version.');

    if (mv.availability === Availability.Private)
      throw throwBadRequestError('Invalid model version.');

    if (mv.status !== ModelStatus.Published) throw throwBadRequestError('Invalid model version.');

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

    if (accountTypes.includes('green')) {
      if (mv.model.nsfw || mv.model.poi || mv.model.minor) {
        throw throwBadRequestError('Cannot bid on this content from this domain.');
      }
    }
  }

  // - Go
  const balanceData = await getUserBuzzAccount({ accountId: userId, accountTypes });
  const balance = balanceData.reduce((acc, b) => acc + (b.balance ?? 0), 0);
  if ((balance ?? 0) < amount) {
    throw throwInsufficientFundsError();
  }

  const transactionPrefix = getAuctionTransactionPrefix(auctionId, userId);

  const createdTransactions = await createMultiAccountBuzzTransaction({
    type: TransactionType.Bid,
    fromAccountTypes: accountTypes,
    fromAccountId: userId,
    toAccountId: 0,
    amount,
    description: 'Regular bid',
    details: {
      auctionId,
      entityId,
      entityType: auctionData.auctionBase.type,
    },
    externalTransactionIdPrefix: transactionPrefix,
  });

  if (!createdTransactions || createdTransactions.transactionCount === 0) {
    throw throwBadRequestError('Could not complete transaction');
  }

  const transactionIds = createdTransactions.transactionIds.map((t) => t.transactionId);

  // Snapshot the winning set *before* this bid so we can notify anyone that this
  // bid knocks out of a winning position. Note: `auctionData.bids` is scoped to
  // the current user+entity (see the query above), so we must fetch the full set
  // of bids for the auction to compute winners. This is best-effort and must never
  // break the bid itself, so failures degrade to "no drop-out notifications".
  const getWinningEntityIds = (bids: { entityId: number; amount: number }[]) =>
    new Set(
      prepareBids({
        bids: bids.map((b) => ({ ...b, deleted: false, auctionId, createdAt: now })),
        quantity: auctionData.quantity,
      })
        .filter((b) => b.totalAmount >= auctionData.minPrice)
        .map((b) => b.entityId)
    );

  let allBidsBefore: { entityId: number; userId: number; amount: number }[] = [];
  let previousWinnerEntityIds = new Set<number>();
  try {
    allBidsBefore = await dbWrite.bid.findMany({
      where: { auctionId, deleted: false },
      select: { entityId: true, userId: true, amount: true },
    });
    previousWinnerEntityIds = getWinningEntityIds(allBidsBefore);
  } catch (e) {
    const err = e as Error;
    logToAxiom({
      name: 'auction-dropped-out',
      type: 'warning',
      message: 'Failed to snapshot pre-bid winners',
      details: { auctionId, entityId, userId },
      stack: err.stack,
      cause: err.cause,
    }).catch();
  }

  if (auctionData.bids?.length > 0) {
    // if there already exists a bid, either add to it or remove the deleted status
    const previousBid = auctionData.bids[0];
    if (!previousBid.deleted) {
      await dbWrite.bid.update({
        where: { id: previousBid.id },
        data: {
          amount: { increment: amount },
          transactionIds: [...previousBid.transactionIds, ...transactionIds],
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
          transactionIds: transactionIds,
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
          transactionIds: transactionIds,
          accountType: accountTypes[0] ?? 'yellow',
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
      await withRetries(() =>
        refundMultiAccountTransaction({
          externalTransactionIdPrefix: transactionPrefix,
          description: 'Failed to create bid.',
        })
      );
    }
  }

  if (!!recurringUntil) {
    await dbWrite.bidRecurring.upsert({
      where: {
        auctionBaseId_userId_entityId_accountType: {
          auctionBaseId: auctionData.auctionBase.id,
          entityId,
          userId,
          accountType: accountTypes[0] ?? 'yellow',
        },
      },
      create: {
        userId,
        entityId,
        amount,
        startAt: now,
        endAt: recurringUntil === 'forever' ? null : recurringUntil,
        auctionBaseId: auctionData.auctionBase.id,
        accountType: accountTypes[0] ?? 'yellow',
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

  // Notify anyone this bid knocked out of a winning position (best-effort).
  // The new bid only raises this entity's total, so we can derive the post-bid
  // winning set in-memory by appending the delta rather than re-querying.
  try {
    if (previousWinnerEntityIds.size > 0) {
      const currentWinnerEntityIds = getWinningEntityIds([
        ...allBidsBefore,
        { entityId, userId, amount },
      ]);
      const droppedEntityIds = [...previousWinnerEntityIds].filter(
        (id) => !currentWinnerEntityIds.has(id)
      );

      for (const droppedId of droppedEntityIds) {
        const userIds = uniq(
          allBidsBefore.filter((b) => b.entityId === droppedId).map((b) => b.userId)
        );
        if (userIds.length === 0) continue;

        const details: DetailsDroppedOutAuction = {
          name:
            signalData.bids.find((b) => b.entityId === droppedId)?.entityData?.model?.name ?? null,
        };
        // Keyed per entity per auction (auctionId is unique to the day) so a bidder
        // gets at most one drop-out notification per entity per day.
        await createNotification({
          userIds,
          category: NotificationCategory.System,
          type: 'dropped-out-auction',
          key: `dropped-out-auction:${auctionId}:${droppedId}`,
          details,
        });
      }
    }
  } catch (e) {
    const err = e as Error;
    logToAxiom({
      name: 'auction-dropped-out',
      type: 'warning',
      message: 'Failed to send drop-out notifications',
      details: { auctionId, entityId, userId },
      stack: err.stack,
      cause: err.cause,
    }).catch();
  }

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
    await withRetries(async () => {
      if (isAuctionTransactionPrefix(transactionId)) {
        await refundMultiAccountTransaction({
          externalTransactionIdPrefix: transactionId,
          description: 'Deleted bid.',
        });

        return;
      } else {
        await refundTransaction(transactionId, 'Deleted bid.');
        return;
      }
    });
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

export const deleteBidsForModel = async ({
  modelId,
  tx,
}: {
  modelId: number;
  tx?: Prisma.TransactionClient;
}) => {
  const db = tx ?? dbWrite;
  const now = new Date();

  const model = await db.model.findFirst({
    where: { id: modelId },
    select: { name: true, modelVersions: { select: { id: true } } },
  });

  if (!model) throw throwNotFoundError('Model not found.');
  const versionIds = model.modelVersions.map((mv) => mv.id);
  if (!versionIds.length) {
    // early return if no versions
    return { bidsDeleted: [], recurringBidsDeleted: [] };
  }

  const aData = await db.auction.findMany({
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
    const deleted = await db.bid.updateManyAndReturn({
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
          await withRetries(async () => {
            if (isAuctionTransactionPrefix(transactionId)) {
              await refundMultiAccountTransaction({
                externalTransactionIdPrefix: transactionId,
                description: 'Deleted bid - model not available.',
              });
            }

            await refundTransaction(transactionId, 'Deleted bid - model not available.');

            return;
          });
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

  const recToDelete = await db.bidRecurring.findMany({
    where: { entityId: { in: versionIds } },
    select: { id: true, userId: true },
  });

  if (recToDelete.length > 0) {
    await db.bidRecurring.deleteMany({
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

export const deleteBidsForModelVersion = async ({
  modelVersionId,
  tx,
}: {
  modelVersionId: number;
  tx?: Prisma.TransactionClient;
}) => {
  const dbClient = tx ?? dbWrite;
  // TODO combine this function with one above
  const now = new Date();

  const aData = await dbClient.auction.findMany({
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
    const deleted = await dbClient.bid.updateManyAndReturn({
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
          await withRetries(async () => {
            if (isAuctionTransactionPrefix(transactionId)) {
              await refundMultiAccountTransaction({
                externalTransactionIdPrefix: transactionId,
                description: 'Deleted bid - model not available.',
              });
            } else {
              await refundTransaction(transactionId, 'Deleted bid - model not available.');
            }

            return;
          });
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

  const recToDelete = await dbClient.bidRecurring.findMany({
    where: { entityId: modelVersionId },
    select: { id: true, userId: true },
  });

  if (recToDelete.length > 0) {
    await dbClient.bidRecurring.deleteMany({
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

export type GetAuctionBasesReturn = AsyncReturnType<typeof getAuctionBases>;
export async function getAuctionBases({ page, limit }: GetAuctionBasesInput) {
  const now = new Date();
  const skip = (page - 1) * limit;

  const [items, totalCount] = await Promise.all([
    dbWrite.auctionBase.findMany({
      skip,
      take: limit,
      orderBy: { id: 'asc' },
      select: {
        id: true,
        type: true,
        ecosystem: true,
        name: true,
        slug: true,
        quantity: true,
        minPrice: true,
        active: true,
        runForDays: true,
        validForDays: true,
        description: true,
        _count: {
          select: {
            auctions: {
              where: { startAt: { lte: now }, endAt: { gt: now } },
            },
          },
        },
        auctions: {
          where: { startAt: { lte: now }, endAt: { gt: now } },
          select: {
            id: true,
            quantity: true,
            minPrice: true,
            startAt: true,
            endAt: true,
            _count: { select: { bids: { where: { deleted: false } } } },
          },
          take: 1,
        },
      },
    }),
    dbWrite.auctionBase.count(),
  ]);

  const mapped = items.map(({ _count, auctions, ...base }) => {
    const currentAuction = auctions[0] ?? null;
    return {
      ...base,
      currentAuction: currentAuction
        ? {
            id: currentAuction.id,
            quantity: currentAuction.quantity,
            minPrice: currentAuction.minPrice,
            startAt: currentAuction.startAt,
            endAt: currentAuction.endAt,
            bidCount: currentAuction._count.bids,
          }
        : null,
    };
  });

  return {
    items: mapped,
    totalCount,
    totalPages: Math.ceil(totalCount / limit),
    page,
  };
}

export async function updateAuctionBase({ id, ...data }: UpdateAuctionBaseInput) {
  return dbWrite.auctionBase.update({
    where: { id },
    data,
    select: {
      id: true,
      type: true,
      ecosystem: true,
      name: true,
      slug: true,
      quantity: true,
      minPrice: true,
      active: true,
      runForDays: true,
      validForDays: true,
      description: true,
    },
  });
}

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
