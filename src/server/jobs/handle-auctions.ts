import type { Dayjs } from 'dayjs';
import dayjs from '~/shared/utils/dayjs';
import * as z from 'zod';
import { NotificationCategory, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { dbKV } from '~/server/db/db-helpers';
import { createJob, getJobDate } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { purgeWeeklyEarnedStats } from '~/server/metrics/model.metrics';
import type {
  DetailsFailedRecurringBid,
  DetailsWonAuction,
} from '~/server/notifications/auction.notifications';
import { modelVersionResourceCache } from '~/server/redis/caches';
import { TransactionType } from '~/server/schema/buzz.schema';
import { modelsSearchIndex } from '~/server/search-index';
import {
  auctionBaseSelect,
  auctionSelect,
  prepareBids,
  type PrepareBidsReturn,
} from '~/server/services/auction.service';
import { createBuzzTransaction, refundTransaction } from '~/server/services/buzz.service';
import { homeBlockCacheBust } from '~/server/services/home-block-cache.service';
import { resourceDataCache } from '~/server/services/model-version.service';
import { bustFeaturedModelsCache, getTopWeeklyEarners } from '~/server/services/model.service';
import { createNotification } from '~/server/services/notification.service';
import { bustOrchestratorModelCache } from '~/server/services/orchestrator/models';
import { withRetries } from '~/server/utils/errorHandling';
import {
  AuctionType,
  BuzzAccountType,
  HomeBlockType,
  ModelType,
} from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';
import { isDefined } from '~/utils/type-guards';
import { commaDelimitedStringArray } from '~/utils/zod-helpers';

const jobName = 'handle-auctions';
const kvKey = `${jobName}-step`;

const log = createLogger(jobName, 'magenta');

type WinnerType = PrepareBidsReturn[number] & {
  userIds: number[];
  auctionId: number;
};

const schema = z.object({
  steps: commaDelimitedStringArray().optional().default([]),
  now: z.coerce.date().optional(),
});

export const handleAuctions = createJob(jobName, '1 0 * * *', async ({ req }) => {
  const { steps, now: n } = schema.parse(req?.query ?? {});
  const now = !!n ? dayjs.utc(n) : dayjs.utc();

  log('query now:', n?.toISOString());
  log('now:', now.format());
  log('start', dayjs().format());

  // steps implies a manual run
  if (steps.length > 0) {
    log('steps:', steps.join(', '));

    if (steps.includes('1')) {
      log('Running step 1');
      await cleanOldCollectionItems(now);
      log('-----------');
    }
    if (steps.includes('2') || steps.includes('2a') || steps.includes('2b')) {
      // pass 2 to run fully. pass 2a or 2b to run winners/losers respectively
      log('Running step 2');
      const runWinners = steps.includes('2a') || (!steps.includes('2a') && !steps.includes('2b'));
      const runLosers = steps.includes('2b') || (!steps.includes('2a') && !steps.includes('2b'));
      log('Running winners:', runWinners, ', losers:', runLosers);
      await handlePreviousAuctions(now, runWinners, runLosers);
      log('-----------');
    }
    if (steps.includes('3')) {
      log('Running step 3');
      await createRecurringBids(now);
      log('-----------');
    }
    if (steps.includes('4')) {
      log('Running step 4');
      await createNewAuctions(now);
      log('-----------');
    }
  } else {
    const [, setLastRun] = await getJobDate(jobName);

    const currentStep = (await dbKV.get(kvKey, 0)) ?? 0;
    log('currentStep', currentStep);

    try {
      if (currentStep <= 0) {
        await cleanOldCollectionItems(now);
        await dbKV.set(kvKey, 1);
        log('-----------');
      }

      if (currentStep <= 1) {
        await handlePreviousAuctions(now);
        await dbKV.set(kvKey, 2);
        log('-----------');
      }

      if (currentStep <= 2) {
        await createRecurringBids(now);
        await dbKV.set(kvKey, 3);
        log('-----------');
      }

      if (currentStep <= 3) {
        await createNewAuctions(now);
        await dbKV.set(kvKey, 4);
        log('-----------');
      }

      // TODO possibly send signals

      await dbKV.set(kvKey, 0);
      await setLastRun();
    } catch (e) {
      const error = e as Error;
      logToAxiom({
        name: 'handle-auctions',
        type: 'error',
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      }).catch();
      throw error;
    }
  }

  log('end', dayjs().format());
});

const cleanOldCollectionItems = async (now: Dayjs) => {
  const nowDate = now.subtract(1, 'day').toDate();
  const oldFeatured = await dbWrite.featuredModelVersion.findMany({
    where: {
      validFrom: { lte: nowDate },
      validTo: { gt: nowDate },
    },
    select: {
      modelVersionId: true,
    },
  });
  const oldIds = oldFeatured.map((f) => f.modelVersionId);

  await bustOrchestratorModelCache(oldIds);
  log(oldIds.length, 'busted old cache');
};

const handlePreviousAuctions = async (now: Dayjs, runWinners = true, runLosers = true) => {
  // Get the bids from previous auctions
  const allAuctionsWithBids = await _fetchAuctionsWithBids(now);

  // Insert the winners into the featured table
  // Refund people who didn't make the cutoff
  // Mark auctions as finalized

  for (const auctionRow of allAuctionsWithBids) {
    log('====== processing auction', auctionRow.id);

    let winnerSuccess = true;
    if (auctionRow.bids.length > 0) {
      const sortedBids = prepareBids(auctionRow, true);

      const { winners, losers } = sortedBids.reduce(
        (result, r) => {
          const matchUserIds = auctionRow.bids
            .filter((b) => b.entityId === r.entityId)
            .map((b) => b.userId);
          const bidDetails = { ...r, userIds: matchUserIds, auctionId: auctionRow.id };

          if (r.totalAmount >= auctionRow.minPrice && r.position <= auctionRow.quantity) {
            result.winners.push(bidDetails);
          } else {
            result.losers.push(bidDetails);
          }
          return result;
        },
        { winners: [] as WinnerType[], losers: [] as WinnerType[] }
      );

      log('winners', winners.length, 'losers', losers.length);
      log('winnerIds', winners.map((x) => `id:${x.entityId}|uids:${x.userIds.length}`).join(','));
      log('loserIds', losers.map((x) => `id:${x.entityId}|uids:${x.userIds.length}`).join(','));

      // Feature the winners
      if (winners.length > 0) {
        if (runWinners) {
          log('Running winners');
          winnerSuccess = await _handleWinnersForAuction(auctionRow, winners);
        }
      } else {
        log('No winners.');
      }

      // Refund the losers
      if (losers.length > 0) {
        if (runLosers) {
          log('Running losers');
          await _refundLosersForAuction(auctionRow, losers);
        }
      } else {
        log('No losers.');
      }
    } else {
      log('No bids, skipping.');
    }

    if (winnerSuccess) {
      // Mark the auction as finalized
      await dbWrite.auction.update({
        where: { id: auctionRow.id },
        data: { finalized: true },
      });
      log('finalized auction', auctionRow.id);
    } else {
      logToAxiom({
        name: 'handle-auctions',
        type: 'error',
        message: `Error running winners`,
        data: { auctionId: auctionRow.id },
      }).catch();
    }
  }
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
      auctionBase: {
        select: {
          ...auctionSelect.auctionBase.select,
          runForDays: true,
          validForDays: true,
        },
      },
    },
  });
};

const TOP_EARNER_LIMIT = 20;
const _handleWinnersForAuction = async (auctionRow: AuctionRow, winners: WinnerType[]) => {
  const winnerIds = winners.map((w) => w.entityId);
  const entityNames = Object.fromEntries(winnerIds.map((w) => [w, null as string | null]));

  if (auctionRow.auctionBase.type === AuctionType.Model) {
    try {
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
    } catch (e) {
      const err = e as Error;
      logToAxiom({
        name: 'handle-auctions',
        type: 'error',
        message: `Failed to create featured models`,
        error: err.message,
        cause: err.cause,
        stack: err.stack,
      }).catch();
      return false;
    }

    const modelVersionData = await dbWrite.modelVersion.findMany({
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
            type: true,
          },
        },
      },
    });

    // update entity names for notifications later
    modelVersionData.forEach((md) => {
      entityNames[md.id] = md.model.name;
    });

    if (!auctionRow.auctionBase.ecosystem) {
      // update checkpoint coverage
      const checkpoints = winners
        .map((w) => {
          const mv = modelVersionData.find((m) => m.id === w.entityId);
          return {
            model_id: mv?.modelId,
            version_id: mv?.id,
            type: mv?.model.type,
          };
        })
        .filter(
          (
            c
          ): c is {
            model_id: number;
            version_id: number;
            type: 'Checkpoint';
          } => !!c.model_id && !!c.version_id && c.type === ModelType.Checkpoint
        );

      try {
        // Add top earning checkpoints
        const topEarners = await getTopWeeklyEarners(true);
        checkpoints.push(
          ...topEarners.slice(0, TOP_EARNER_LIMIT).map((e) => ({
            model_id: e.modelId,
            version_id: e.modelVersionId,
            type: 'Checkpoint' as const,
          }))
        );

        if (checkpoints.length) {
          await dbWrite.$queryRaw`
            TRUNCATE TABLE "CoveredCheckpoint"
          `;

          await dbWrite.coveredCheckpoint.createMany({
            data: checkpoints.map((c) => ({
              model_id: c.model_id,
              version_id: c.version_id,
            })),
            skipDuplicates: true,
          });
        }
      } catch (error) {
        const err = error as Error;
        logToAxiom({
          name: 'handle-auctions',
          type: 'error',
          message: `Failed to update checkpoint coverage`,
          data: { checkpoints },
          error: err.message,
          cause: err.cause,
          stack: err.stack,
        }).catch();

        return false;
      }
    }

    // Clear related caches
    await modelsSearchIndex.updateSync(
      winners
        .map((w) => {
          const winMatch = modelVersionData.find((mv) => mv.id === w.entityId);
          return winMatch
            ? { id: winMatch.modelId, action: SearchIndexUpdateQueueAction.Update }
            : undefined;
        })
        .filter(isDefined)
    );
    await bustFeaturedModelsCache();
    await homeBlockCacheBust(HomeBlockType.FeaturedModelVersion, 'default');
    await resourceDataCache.bust(winnerIds);
    await modelVersionResourceCache.bust(winnerIds);
    await bustOrchestratorModelCache(winnerIds);

    log('busted cache', winnerIds.length);
  }

  // Send notifications to each auction's contributing winners
  for (const winner of winners) {
    const details: DetailsWonAuction = {
      name: entityNames[winner.entityId],
      position: winner.position,
      until: dayjs(auctionRow.validTo).format('MMM D YYYY'),
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

  return true;
};

const _refundLosersForAuction = async (auctionRow: AuctionRow, losers: WinnerType[]) => {
  const loserEntities = losers.map((l) => l.entityId);
  const lostBids = auctionRow.bids.filter((b) => !b.deleted && loserEntities.includes(b.entityId));

  const refundedBidIds: number[] = [];
  // TODO limit concurrency
  for (const lostBid of lostBids) {
    const refundResps = await Promise.all(
      lostBid.transactionIds.map((tid) => {
        try {
          return withRetries(async () => {
            try {
              return await refundTransaction(tid, 'Lost bid.');
            } catch (e) {
              const err = e as Error;
              logToAxiom({
                name: 'handle-auctions',
                type: 'error',
                message: `Failed to refund bid`,
                data: { tid },
                error: err.message,
                cause: err.cause,
                stack: err.stack,
              }).catch();
              return { transactionId: null };
            }
          });
        } catch (e) {
          const err = e as Error;
          logToAxiom({
            name: 'handle-auctions',
            type: 'error',
            message: `Failed to run refund`,
            data: { tid },
            error: err.message,
            cause: err.cause,
            stack: err.stack,
          }).catch();

          return { transactionId: null };
        }
      })
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

        // Check if a bid already exists for this auction, user, and entity
        const existingBid = await dbWrite.bid.findFirst({
          where: {
            auctionId: auctionMatch.id,
            userId: recurringBid.userId,
            entityId: recurringBid.entityId,
          },
          select: { id: true },
        });

        // If a bid already exists, skip this recurring bid
        if (existingBid) {
          log(`Skipping recurring bid, as it already exists:`, existingBid.id);
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
            }-${now.startOf('day').format()}`,
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
};

const createNewAuctions = async (now: Dayjs) => {
  const tomorrow = now.add(1, 'day');

  // Create new auctions for tomorrow
  const auctionBases = await dbWrite.auctionBase.findMany({
    where: {
      active: true,
      auctions: { none: { startAt: { lte: tomorrow.toDate() }, endAt: { gt: tomorrow.toDate() } } },
    },
    select: {
      ...auctionBaseSelect,
      quantity: true,
      minPrice: true,
      runForDays: true,
      validForDays: true,
    },
  });
  const newAuctions = await dbWrite.auction.createManyAndReturn({
    data: auctionBases.map((ab) => {
      const endAt = tomorrow.add(ab.runForDays, 'd');
      return {
        startAt: tomorrow.startOf('day').toDate(),
        endAt: endAt.startOf('day').toDate(),
        quantity: ab.quantity,
        minPrice: ab.minPrice,
        auctionBaseId: ab.id,
        validFrom: endAt.startOf('day').toDate(),
        validTo: endAt.add(ab.validForDays, 'd').startOf('day').toDate(),
      };
    }),
    select: { id: true, auctionBaseId: true },
    skipDuplicates: true,
  });
  log(newAuctions.length, 'new auctions');

  // If new checkpoint auction, clear prior week earned stats
  const checkpointAuctionBase = auctionBases.find((ab) => ab.slug === 'featured-checkpoints');
  const checkpointAuction = newAuctions.some((a) => a.auctionBaseId === checkpointAuctionBase?.id);
  if (checkpointAuction) {
    log('Checkpoint auction created, purging weekly stats');
    await purgeWeeklyEarnedStats(dbWrite);
    log('Purged weekly stats');
  }
};
