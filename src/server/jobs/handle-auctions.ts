import dayjs, { Dayjs } from 'dayjs';
import { uniq } from 'lodash-es';
import { constants, FEATURED_MODEL_COLLECTION_ID } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { dbKV } from '~/server/db/db-helpers';
import { createJob, getJobDate } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import type {
  DetailsFailedRecurringBid,
  DetailsWonAuction,
} from '~/server/notifications/auction.notifications';
import { modelVersionResourceCache } from '~/server/redis/caches';
import { TransactionType } from '~/server/schema/buzz.schema';
import {
  auctionBaseSelect,
  auctionSelect,
  prepareBids,
  type PrepareBidsReturn,
} from '~/server/services/auction.service';
import { createBuzzTransaction, refundTransaction } from '~/server/services/buzz.service';
import { homeBlockCacheBust } from '~/server/services/home-block-cache.service';
import { bustFeaturedModelsCache } from '~/server/services/model.service';
import { createNotification } from '~/server/services/notification.service';
import { withRetries } from '~/server/utils/errorHandling';
import { hasSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { AuctionType, BuzzAccountType, HomeBlockType } from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';

const jobName = 'handle-auctions';
const kvKey = `${jobName}-step`;
const collectionNote = 'from auction';
const modelsToAddToCollection = 3;

const log = createLogger(jobName, 'magenta');

type WinnerType = PrepareBidsReturn[number] & {
  userIds: number[];
  auctionId: number;
};

// TODO allow setting dates for chunks

export const handleAuctions = createJob(jobName, '1 0 * * *', async () => {
  const [, setLastRun] = await getJobDate(jobName);
  const now = dayjs();

  log('start', now.toDate());

  const currentStep = (await dbKV.get(kvKey, 0)) ?? 0;
  log('currentStep', currentStep);

  try {
    if (currentStep <= 0) {
      await cleanOldCollectionItems();
      log('-----------');
    }

    if (currentStep <= 1) {
      await handlePreviousAuctions(now);
      log('-----------');
    }

    if (currentStep <= 2) {
      await createRecurringBids(now);
      log('-----------');
    }

    if (currentStep <= 3) {
      await createNewAuctions(now);
      log('-----------');
    }

    log('end', dayjs().toDate());

    await dbKV.set(kvKey, 0);
    await setLastRun();
  } catch (e) {
    const error = e as Error;
    logToAxiom({
      type: 'error',
      name: 'Failed to handle auctions',
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    }).catch();
    throw error;
  }
});

const cleanOldCollectionItems = async () => {
  // Remove old auction winners from collection
  const deletedFromCollection = await dbWrite.collectionItem.deleteMany({
    where: {
      collectionId: FEATURED_MODEL_COLLECTION_ID,
      note: collectionNote,
    },
  });

  log(deletedFromCollection.count, 'removed from collection');

  await dbKV.set(kvKey, 1);
};

const handlePreviousAuctions = async (now: Dayjs) => {
  // Get the bids from previous auctions
  const allAuctionsWithBids = await _fetchAuctionsWithBids(now);

  // Track creators across all auctions
  const creatorsSeen = new Set<number>();

  // Insert the winners into the featured table and the collection
  // Refund people who didn't make the cutoff
  // Mark auctions as finalized
  for (const auctionRow of allAuctionsWithBids) {
    log('====== processing auction', auctionRow.id);
    if (auctionRow.bids.length > 0) {
      const sortedBids = prepareBids(auctionRow);

      const { winners, losers } = sortedBids.reduce(
        (result, r) => {
          const matchUserIds = auctionRow.bids
            .filter((b) => b.entityId === r.entityId)
            .map((b) => b.userId);
          const bidDetails = { ...r, userIds: matchUserIds, auctionId: auctionRow.id };

          if (r.totalAmount >= auctionRow.minPrice) {
            result.winners.push(bidDetails);
          } else {
            result.losers.push(bidDetails);
          }
          return result;
        },
        { winners: [] as WinnerType[], losers: [] as WinnerType[] }
      );

      log('winners', winners.length, 'losers', losers.length);

      // Feature the winners
      if (winners.length > 0) {
        await _handleWinnersForAuction(auctionRow, winners, creatorsSeen);
      }

      // Refund the losers
      if (losers.length > 0) {
        await _refundLosersForAuction(auctionRow, losers);
      }
    } else {
      log('No bids, skipping.');
    }

    // Mark the auction as finalized
    await dbWrite.auction.update({
      where: { id: auctionRow.id },
      data: { finalized: true },
    });
    log('finalized auction', auctionRow.id);
  }

  await dbKV.set(kvKey, 2);
};

type AuctionRow = Awaited<ReturnType<typeof _fetchAuctionsWithBids>>[number];
const _fetchAuctionsWithBids = async (now: Dayjs) => {
  return dbWrite.auction.findMany({
    where: { finalized: false, endAt: { lte: now.toDate() } },
    select: {
      ...auctionSelect,
      validFrom: true,
      validTo: true,
      bids: {
        select: {
          ...auctionSelect.bids.select,
          id: true,
          userId: true,
          transactionIds: true,
        },
      },
    },
  });
};

const _handleWinnersForAuction = async (
  auctionRow: AuctionRow,
  winners: WinnerType[],
  creatorsSeen: Set<number>
) => {
  const winnerIds = winners.map((w) => w.entityId);
  const entityNames = Object.fromEntries(winnerIds.map((w) => [w, null as string | null]));

  if (auctionRow.auctionBase.type === AuctionType.Model) {
    const createdFeatured = await dbWrite.featuredModelVersion.createMany({
      data: winners.map((w) => ({
        modelVersionId: w.entityId,
        position: w.position,
        validFrom: auctionRow.validFrom,
        validTo: auctionRow.validTo,
      })),
      skipDuplicates: true,
    });
    log(createdFeatured.count, 'featured models');

    // Insert winners into the collection
    const modelData = await dbWrite.modelVersion.findMany({
      where: { id: { in: winnerIds } },
      select: {
        id: true,
        nsfwLevel: true,
        modelId: true,
        model: {
          select: {
            name: true,
            poi: true,
            nsfw: true,
            userId: true,
          },
        },
      },
    });

    // update entity names for notifications later
    modelData.forEach((md) => {
      entityNames[md.id] = md.model.name;
    });

    // Filter only safe models
    const validModelData = modelData.filter(
      (m) => hasSafeBrowsingLevel(m.nsfwLevel) && !m.model.nsfw && !m.model.poi
    );

    const filteredModelData: typeof validModelData = [];
    validModelData.forEach((md) => {
      if (!creatorsSeen.has(md.model.userId)) {
        validModelData.push(md);
        creatorsSeen.add(md.model.userId);
      }
    });

    const modelIds = uniq(
      filteredModelData
        .sort((a, b) => {
          const matchA = winners.find((w) => w.entityId === a.id);
          const matchB = winners.find((w) => w.entityId === b.id);
          if (!matchA) return 1;
          if (!matchB) return -1;
          return matchB.position - matchA.position;
        })
        // Pick top models to add to the collection
        .map((m) => m.modelId)
    ).slice(0, modelsToAddToCollection);

    // Add them to the collection
    if (modelIds.length > 0) {
      const createdCollection = await dbWrite.collectionItem.createMany({
        data: modelIds.map((m) => ({
          collectionId: FEATURED_MODEL_COLLECTION_ID,
          modelId: m,
          note: collectionNote,
          addedById: constants.system.user.id,
        })),
        skipDuplicates: true,
      });
      log(createdCollection.count, 'featured models in collection');
    } else {
      log('No featured models in collection!');
    }

    // Clear related caches
    await homeBlockCacheBust(HomeBlockType.Collection, FEATURED_MODEL_COLLECTION_ID);
    await bustFeaturedModelsCache();
    await modelVersionResourceCache.bust(winnerIds);
  }

  // Send notifications to each auction's contributing winners
  for (const winner of winners) {
    const details: DetailsWonAuction = {
      name: entityNames[winner.entityId],
      position: winner.position,
      until: 'tomorrow', // TODO hardcoded for now
    };
    await createNotification({
      userIds: winner.userIds,
      category: NotificationCategory.System,
      type: 'won-auction',
      key: `won-auction:${winner.auctionId}:${winner.entityId}`,
      details,
    });
  }
  log('Sent notifications to', winners.length, 'winners');
};

const _refundLosersForAuction = async (auctionRow: AuctionRow, losers: WinnerType[]) => {
  const loserEntities = losers.map((l) => l.entityId);
  const lostBids = auctionRow.bids.filter((b) => !b.deleted && loserEntities.includes(b.entityId));

  const refundedBidIds: number[] = [];
  // TODO limit concurrency
  for (const lostBid of lostBids) {
    const refundResps = await Promise.all(
      lostBid.transactionIds.map((tid) => withRetries(() => refundTransaction(tid, 'Lost bid.')))
    );
    if (refundResps.some((t) => !t.transactionId)) {
      logToAxiom({
        name: 'handle-auctions',
        type: 'warning',
        message: `Failed to refund user for lost bid`,
        data: { lostBid },
      }).catch();
    } else {
      // Mark refunded
      refundedBidIds.push(lostBid.id);
    }
  }

  log(refundedBidIds.length, 'refunded bids');
  await dbWrite.bid.updateMany({
    where: { id: { in: refundedBidIds } },
    data: { isRefunded: true },
  });
};

const createRecurringBids = async (now: Dayjs) => {
  // Insert recurring bids today's auction
  const recurringBids = await dbWrite.bidRecurring.findMany({
    where: {
      isPaused: false,
      startAt: { lte: now.toDate() },
      OR: [{ endAt: { gt: now.toDate() } }, { endAt: null }],
    },
    select: {
      id: true,
      userId: true,
      entityId: true,
      amount: true,
      auctionBase: {
        select: {
          id: true,
          type: true,
        },
      },
    },
  });

  log(recurringBids.length, 'recurring bids');

  if (recurringBids.length) {
    const todaysAuctions = await dbWrite.auction.findMany({
      where: {
        startAt: { lte: now.toDate() },
        endAt: { gt: now.toDate() },
      },
      select: {
        id: true,
        auctionBase: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    for (const recurringBid of recurringBids) {
      try {
        const auctionMatch = todaysAuctions.find(
          (auction) => auction.auctionBase.id === recurringBid.auctionBase.id
        );
        if (!auctionMatch) {
          logToAxiom({
            name: 'handle-auctions',
            type: 'warning',
            message: `Failed to find auction for recurring bid`,
            data: { recurringBid },
          }).catch();
          continue;
        }

        // Charge the user the relevant bid amount
        const { transactionId } = await withRetries(() =>
          createBuzzTransaction({
            type: TransactionType.Bid,
            fromAccountType: BuzzAccountType.user,
            fromAccountId: recurringBid.userId,
            toAccountId: 0,
            amount: recurringBid.amount,
            description: 'Recurring bid',
            details: {
              auctionId: auctionMatch.id,
              entityId: recurringBid.entityId,
              entityType: recurringBid.auctionBase.type,
            },
            externalTransactionId: `recurring-bid-${recurringBid.userId}-${
              recurringBid.entityId
            }-${now.startOf('day').toDate()}`,
          })
        );
        if (!transactionId) {
          logToAxiom({
            name: 'handle-auctions',
            type: 'warning',
            message: `Failed to charge user for recurring bid`,
            data: { recurringBid },
          }).catch();

          await createNotification({
            userId: recurringBid.userId,
            category: NotificationCategory.System,
            type: 'failed-recurring-bid-auction',
            key: `failed-recurring-bid-auction:${recurringBid.id}:${now.format('YYYY-MM-DD')}`,
            details: {
              auctionName: auctionMatch.auctionBase.name,
            } as DetailsFailedRecurringBid,
          });

          continue;
        }

        // Insert a new bid row that matches the new auctions
        await dbWrite.bid.create({
          data: {
            auctionId: auctionMatch.id,
            userId: recurringBid.userId,
            entityId: recurringBid.entityId,
            amount: recurringBid.amount,
            transactionIds: [transactionId],
            fromRecurring: true,
          },
        });
      } catch (error) {
        const err = error as Error;
        logToAxiom({
          name: 'handle-auctions',
          type: 'error',
          message: `Failed to handle recurring bid`,
          data: { recurringBid },
          error: err.message,
          cause: err.cause,
          stack: err.stack,
        }).catch();
      }
    }
  }

  await dbKV.set(kvKey, 3);
};

const createNewAuctions = async (now: Dayjs) => {
  // Create new auctions for tomorrow
  const auctionBases = await dbWrite.auctionBase.findMany({
    where: {
      active: true,
    },
    select: {
      ...auctionBaseSelect,
      quantity: true,
      minPrice: true,
    },
  });
  const newAuctions = await dbWrite.auction.createManyAndReturn({
    data: auctionBases.map((ab) => {
      return {
        startAt: now.add(1, 'd').startOf('day').toDate(),
        endAt: now.add(2, 'd').startOf('day').toDate(),
        quantity: ab.quantity,
        minPrice: ab.minPrice,
        auctionBaseId: ab.id,
        validFrom: now.add(2, 'd').startOf('day').toDate(),
        validTo: now.add(3, 'd').startOf('day').toDate(),
      };
    }),
    select: { id: true, auctionBaseId: true },
    skipDuplicates: true,
  });

  log(newAuctions.length, 'new auctions');

  await dbKV.set(kvKey, 4);
};
