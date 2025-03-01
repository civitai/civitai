import dayjs from 'dayjs';
import { uniq } from 'lodash-es';
import { constants, FEATURED_MODEL_COLLECTION_ID } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { createJob, getJobDate } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { modelVersionResourceCache } from '~/server/redis/caches';
import { TransactionType } from '~/server/schema/buzz.schema';
import { auctionBaseSelect, auctionSelect, prepareBids } from '~/server/services/auction.service';
import { createBuzzTransaction, refundTransaction } from '~/server/services/buzz.service';
import { homeBlockCacheBust } from '~/server/services/home-block-cache.service';
import { bustFeaturedModelsCache } from '~/server/services/model.service';
import { withRetries } from '~/server/utils/errorHandling';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { AuctionType, BuzzAccountType, HomeBlockType } from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';

const jobName = 'handle-auctions';
const collectionNote = 'from auction';
const modelsToAddToCollection = 3;

const log = createLogger(jobName, 'magenta');

export const handleAuctions = createJob(jobName, '1 0 * * *', async () => {
  const [, setLastRun] = await getJobDate(jobName);
  const now = dayjs();

  try {
    // Remove old auction winners from collection
    const deletedFromCollection = await dbWrite.collectionItem.deleteMany({
      where: {
        collectionId: FEATURED_MODEL_COLLECTION_ID,
        note: collectionNote,
      },
    });
    log(deletedFromCollection.count, 'removed from collection');
    log('-----------');

    // Get the bids from previous auctions
    const allAuctionsWithBids = await dbWrite.auction.findMany({
      where: {
        finalized: false,
        endAt: { lte: now.toDate() },
      },
      select: {
        ...auctionSelect,
        validFrom: true,
        validTo: true,
        bids: {
          select: {
            ...auctionSelect.bids.select,
            id: true,
            userId: true,
            transactionId: true,
          },
        },
      },
    });

    // Insert the winners into the featured table and the collection
    //   Refund people who didn't make the cutoff
    //   Mark auctions as finalized
    for (const auctionRow of allAuctionsWithBids) {
      log('====== processing auction', auctionRow.id);
      if (auctionRow.bids.length === 0) continue;

      const sortedBids = prepareBids(auctionRow);

      const { winners, losers } = sortedBids.reduce(
        (result, r) => {
          if (r.totalAmount >= auctionRow.minPrice) {
            result.winners.push(r);
          } else {
            result.losers.push(r);
          }
          return result;
        },
        { winners: [] as typeof sortedBids, losers: [] as typeof sortedBids }
      );

      log('winners', winners.length, 'losers', losers.length);

      // Feature the winners
      if (winners.length > 0) {
        const winnerIds = winners.map((w) => w.entityId);

        const thisAuctionType = auctionRow.auctionBase.type;
        if (thisAuctionType === AuctionType.Model) {
          const createdFeatured = await dbWrite.featuredModelVersion.createMany({
            data: winners.map((w) => {
              return {
                modelVersionId: w.entityId,
                position: w.position,
                validFrom: auctionRow.validFrom,
                validTo: auctionRow.validTo,
              };
            }),
            skipDuplicates: true,
          });
          log(createdFeatured.count, 'featured models');

          // insert winners into collection
          const modelData = await dbWrite.modelVersion.findMany({
            where: {
              id: { in: winnerIds },
            },
            select: {
              id: true,
              nsfwLevel: true,
              modelId: true,
            },
          });
          // get top matching models
          const modelIds = uniq(
            modelData
              .filter((m) => getIsSafeBrowsingLevel(m.nsfwLevel))
              .sort((a, b) => {
                const matchA = winners.find((w) => w.entityId === a.id);
                const matchB = winners.find((w) => w.entityId === b.id);

                if (!matchA) return 1;
                if (!matchB) return -1;

                return matchB.position - matchA.position;
              })
              .map((m) => m.modelId)
              .slice(0, modelsToAddToCollection)
          );
          if (modelIds.length > 0) {
            const createdCollection = await dbWrite.collectionItem.createMany({
              data: modelIds.map((m) => {
                return {
                  collectionId: FEATURED_MODEL_COLLECTION_ID,
                  modelId: m,
                  note: collectionNote,
                  addedById: constants.system.user.id,
                };
              }),
            });
            log(createdCollection.count, 'featured models in collection');
          }

          await homeBlockCacheBust(HomeBlockType.Collection, FEATURED_MODEL_COLLECTION_ID);
          await bustFeaturedModelsCache();
          await modelVersionResourceCache.bust(winnerIds);
        }
      }

      // Refund the losers
      if (losers.length > 0) {
        const loserEntities = losers.map((l) => l.entityId);
        const lostBids = auctionRow.bids.filter(
          (b) => !b.deleted && loserEntities.includes(b.entityId)
        );
        const refundedBidIds: number[] = [];

        for (const lostBid of lostBids) {
          const refundResp = await withRetries(() =>
            refundTransaction(lostBid.transactionId, 'Lost bid.')
          );
          if (!refundResp.transactionId) {
            logToAxiom({
              name: 'handle-auctions',
              type: 'warning',
              message: `Failed to refund user for lost bid`,
              data: { lostBid },
            }).catch();
          } else {
            // mark refunded
            refundedBidIds.push(lostBid.id);
          }
        }

        log(refundedBidIds.length, 'refunded bids');

        await dbWrite.bid.updateMany({
          where: { id: { in: refundedBidIds } },
          data: {
            isRefunded: true,
          },
        });
      }

      dbWrite.auction.update({
        where: { id: auctionRow.id },
        data: {
          finalized: true,
        },
      });

      log('finalized auction', auctionRow.id);
    }

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
    });

    log('-----------');
    log(newAuctions.length, 'new auctions');

    // Insert recurring bids into those auctions
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

    for (const recurringBid of recurringBids) {
      try {
        const auctionMatch = newAuctions.find(
          (auction) => auction.auctionBaseId === recurringBid.auctionBase.id
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
          continue;
        }

        // Insert a new bid row that matches the new auctions
        await dbWrite.bid.create({
          data: {
            auctionId: auctionMatch.id,
            userId: recurringBid.userId,
            entityId: recurringBid.entityId,
            amount: recurringBid.amount,
            transactionId,
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
  }
});
