import dayjs from '~/shared/utils/dayjs';
import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { constants, newOrderConfig } from '~/server/common/constants';
import { NewOrderImageRatingStatus, NsfwLevel } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  allJudgmentsCounter,
  blessedBuzzCounter,
  correctJudgmentsCounter,
  expCounter,
  fervorCounter,
  getActiveSlot,
  getVotingRateLimitConfig,
  pendingBuzzCounter,
  poolCounters,
  recentlyGrantedBuzzCounter,
  setActiveSlot,
} from '~/server/games/new-order/utils';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import {
  calculateFervor,
  cleanseSmite,
  clearRatedImages,
  processFinalRatings,
  smitePlayer,
} from '~/server/services/games/new-order.service';
import { moderatorApp } from '~/server/services/moderator-app.service';
import {
  ABUSE_SCAN_WINDOW_HOURS,
  buildAbuseReport,
  type AbuseSuspect,
} from '~/server/services/new-order-abuse-detection/report';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { handleLogError } from '~/server/utils/errorHandling';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';

const log = createLogger('new-order-jobs');

const newOrderGrantBlessedBuzz = createJob('new-order-grant-bless-buzz', '0 0 * * *', async () => {
  if (!clickhouse) return;
  log('BlessedBuzz :: Granting Blessed Buzz');

  // date range is 3 days ago
  const startDate = dayjs().subtract(3, 'day').startOf('day').toDate();
  const endDate = dayjs().subtract(3, 'day').endOf('day').toDate();

  // Get all judgments from exactly 3 days ago
  log(
    `BlessedBuzz :: Getting judgments from ${startDate.toISOString()} to ${endDate.toISOString()}`
  );
  const judgments = await clickhouse.$query<{ userId: number; balance: number; totalExp: number }>`
    SELECT
      userId,
      floor(SUM(grantedExp * multiplier) * ${newOrderConfig.blessedBuzzConversionRatio}) as balance,
      SUM(grantedExp * multiplier) as totalExp
    FROM knights_new_order_image_rating FINAL
    WHERE createdAt BETWEEN ${startDate} AND ${endDate}
      AND status IN ('${NewOrderImageRatingStatus.Correct}', '${NewOrderImageRatingStatus.Failed}')
    GROUP BY userId
  `;

  // Step 1: Grant buzz for judgments from 3 days ago
  if (judgments.length) {
    log(`BlessedBuzz :: Found ${judgments.length} correct judgments`);

    // Get current player data for knights and templars only
    const players = await dbRead.newOrderPlayer.findMany({
      where: {
        userId: { in: judgments.map((j) => j.userId) },
        rankType: { not: NewOrderRankType.Acolyte },
      },
      select: { userId: true },
    });

    const validPlayers = judgments.filter((j) => players.some((p) => p.userId === j.userId));

    if (validPlayers.length) {
      // Create buzz transactions in batches
      const batches = chunk(validPlayers, 100);
      let loopCount = 1;
      for (const batch of batches) {
        log(`BlessedBuzz :: Creating buzz transactions :: ${loopCount} of ${batches.length}`);

        const grantedPlayers = batch.filter((player) => player.balance > 0);
        const ungrantedPlayers = batch.filter((player) => player.balance <= 0);

        const transactions = grantedPlayers.map((validPlayer) => ({
          fromAccountId: 0,
          toAccountId: validPlayer.userId,
          amount: validPlayer.balance,
          type: TransactionType.Reward,
          description: 'Content Moderation Correct Judgment',
          externalTransactionId: `new-order-${validPlayer.userId}-${startDate.toISOString()}`,
        }));

        if (transactions.length > 0) await createBuzzTransactionMany(transactions);

        // Deduct the actual EXP from the blessed buzz counter only for players who received buzz.
        // Players with balance <= 0 (< 10 correct votes) keep their EXP so it rolls over
        // and accumulates until the next payout threshold is reached.
        // Counter stores EXP values, not converted buzz, so we deduct totalExp.
        // Reset pending buzz counter so it recalculates the new day on next fetch.
        await Promise.all(
          grantedPlayers.map((player) => {
            return Promise.all([
              blessedBuzzCounter.decrement({ id: player.userId, value: player.totalExp }),
              pendingBuzzCounter.reset({ id: player.userId }),
              recentlyGrantedBuzzCounter.reset({ id: player.userId }),
            ]);
          })
        );

        // For ungranted players, only reset the pending buzz counter
        // so it recalculates next cycle — but preserve their blessed buzz EXP
        if (ungrantedPlayers.length > 0) {
          await Promise.all(
            ungrantedPlayers.map((player) => pendingBuzzCounter.reset({ id: player.userId }))
          );
        }
        log(
          `BlessedBuzz :: Creating buzz transactions :: ${loopCount} of ${batches.length} :: done`
        );
        loopCount++;
      }
    } else {
      log('BlessedBuzz :: No valid players found');
    }
  } else {
    log('BlessedBuzz :: No correct judgments found');
  }

  log('BlessedBuzz :: Granting Blessed Buzz :: done');

  // Step 2: Reconcile stale blessedBuzz counters for inactive users
  // Only reset users with no voting activity in the last 3 days,
  // so we don't interfere with in-flight increments from active voting.
  // Wrapped in try/catch so a reconciliation failure doesn't mark the grant job as failed.
  try {
    log('BlessedBuzz :: Starting stale counter reconciliation');

    const allBlessedBuzzEntries = await blessedBuzzCounter.getAll({ withCount: true });
    const nonZeroUserIds = allBlessedBuzzEntries
      .filter((entry) => entry.score > 0)
      .map((entry) => Number(entry.value));

    if (nonZeroUserIds.length > 0) {
      log(`BlessedBuzz :: Found ${nonZeroUserIds.length} non-zero counters to check`);

      // Find which of these users have had ANY activity in the last 3 days
      const recentActivityUserIds = new Set<number>();
      const userIdBatches = chunk(nonZeroUserIds, 500);

      for (const batch of userIdBatches) {
        const activeUsers = await clickhouse!.$query<{ userId: number }>`
          SELECT DISTINCT userId
          FROM knights_new_order_image_rating
          WHERE userId IN (${batch.join(',')})
            AND createdAt >= subtractDays(now(), 3)
            AND status IN ('${NewOrderImageRatingStatus.Correct}', '${
          NewOrderImageRatingStatus.Failed
        }')
        `;
        for (const row of activeUsers) recentActivityUserIds.add(row.userId);
      }

      // Reset counters for users with NO recent activity — their Redis value is stale
      const staleUserIds = nonZeroUserIds.filter((id) => !recentActivityUserIds.has(id));

      if (staleUserIds.length > 0) {
        log(
          `BlessedBuzz :: Resetting ${staleUserIds.length} stale counters (no activity in 3 days)`
        );
        // reset() accepts an array of IDs and issues a single hDel call
        const staleBatches = chunk(staleUserIds, 200);
        for (const batch of staleBatches) {
          await Promise.all([
            blessedBuzzCounter.reset({ id: batch }),
            pendingBuzzCounter.reset({ id: batch }),
          ]);
        }
        log('BlessedBuzz :: Stale counter reconciliation complete');
      } else {
        log('BlessedBuzz :: No stale counters found');
      }
    } else {
      log('BlessedBuzz :: No non-zero counters to reconcile');
    }
  } catch (error: unknown) {
    log(`BlessedBuzz :: Stale counter reconciliation failed, will retry next run: ${error}`);
  }
});

type DailyResetQueryResult = {
  userId: number;
  exp: number;
  correctJudgments: number;
  failedJudgments: number;
  totalJudgments: number;
  fervor?: number;
};

// Updated to sync PostgreSQL from Redis counters instead of ClickHouse
// This is more efficient and respects the real-time counter updates
const newOrderDailyReset = createJob('new-order-daily-reset', '0 0 * * *', async () => {
  log('DailyReset:: Starting fervor recalculation and PostgreSQL sync');

  // Get all players to sync their stats
  const allPlayers = await dbRead.newOrderPlayer.findMany({
    select: { userId: true },
  });

  if (!allPlayers.length) {
    log('DailyReset:: No players found');
    return;
  }

  log(`DailyReset:: Processing ${allPlayers.length} players`);

  // Process in batches of 200 for optimal performance
  const batches = chunk(allPlayers, 200);
  let batchCount = 1;

  for (const batch of batches) {
    log(`DailyReset:: Processing batch ${batchCount} of ${batches.length}`);

    const batchUserIds = batch.map((p) => p.userId);

    // Step 1: Batch fetch all counters efficiently (checks cache first, then batched DB queries)
    const [correctCounts, allCounts, expCounts, fervorCounts] = await Promise.all([
      correctJudgmentsCounter.getCountBatch(batchUserIds),
      allJudgmentsCounter.getCountBatch(batchUserIds),
      expCounter.getCountBatch(batchUserIds),
      fervorCounter.getCountBatch(batchUserIds),
    ]);

    // Step 2: Build player stats from the batch-fetched data
    const playerStats = batch.map((player) => {
      const correctJudgments = correctCounts.get(player.userId) ?? 0;
      const allJudgments = allCounts.get(player.userId) ?? 0;
      const exp = expCounts.get(player.userId) ?? 0;
      const oldFervor = fervorCounts.get(player.userId) ?? 0;

      // Recalculate fervor using same formula as service
      const newFervor = calculateFervor({ correctJudgments, allJudgments });

      return {
        userId: player.userId,
        exp,
        fervor: newFervor,
        oldFervor,
        needsUpdate: newFervor !== oldFervor,
      };
    });

    // Step 3: Update Redis fervor counter for players whose fervor changed
    await Promise.all(
      playerStats.map(async ({ userId, fervor, oldFervor, needsUpdate }) => {
        if (!needsUpdate) return;

        if (fervor === 0) {
          // Player has no activity in 7-day window - remove from leaderboard
          await fervorCounter.reset({ id: userId });
          log(`DailyReset:: Removed inactive player ${userId} (fervor: ${oldFervor} → 0)`);
        } else {
          // Update fervor value (reset + increment pattern)
          await fervorCounter.reset({ id: userId });
          await fervorCounter.increment({ id: userId, value: fervor });

          if (Math.abs(fervor - oldFervor) > 100) {
            log(`DailyReset:: Large fervor change for player ${userId}: ${oldFervor} → ${fervor}`);
          }
        }
      })
    );

    // Step 4: Bulk update PostgreSQL with exp and recalculated fervor
    await dbWrite.$queryRaw`
      WITH affected AS (
        SELECT
          (value ->> 'userId')::int as "userId",
          (value ->> 'exp')::int as "exp",
          (value ->> 'fervor')::int as "fervor"
        FROM json_array_elements(${JSON.stringify(playerStats)}::json)
      )
      UPDATE "NewOrderPlayer"
      SET
        "exp" = affected.exp,
        "fervor" = affected.fervor
      FROM affected
      WHERE "NewOrderPlayer"."userId" = affected."userId"
    `;

    // Step 5: Clear rated images cache for all players in this batch
    await Promise.all(batch.map((player) => clearRatedImages(player.userId)));

    log(`DailyReset:: Batch ${batchCount} of ${batches.length} complete`);
    batchCount++;
  }

  log(`DailyReset:: PostgreSQL sync complete - ${allPlayers.length} players updated`);
});

// Templar selection job removed as part of Knights of New Order redesign
// Templars rank has been eliminated, keeping only Acolyte and Knight ranks

// Cleanse smites that are older than 7 days
const newOrderCleanseSmites = createJob('new-order-cleanse-smites', '0 0 * * *', async () => {
  log('CleanseSmites :: Cleansing smites');
  const smites = await dbRead.newOrderSmite.findMany({
    where: { cleansedAt: null, createdAt: { lte: dayjs().subtract(7, 'days').toDate() } },
    select: { id: true, targetPlayerId: true },
  });
  if (!smites.length) {
    log('CleanseSmites :: No smites found');
    return;
  }
  log(`CleanseSmites :: Found ${smites.length} smites`);

  const cleanseTasks = smites.map((smite, index) => () => {
    log(`CleanseSmites :: Cleansing smite ${index + 1} of ${smites.length}`);

    return cleanseSmite({
      id: smite.id,
      cleansedReason: 'Smite expired',
      playerId: smite.targetPlayerId,
    });
  });

  await limitConcurrency(cleanseTasks, 5);

  log(`CleanseSmites :: Cleansing smites :: done`);
});

const ranksToClean = [NewOrderRankType.Knight, NewOrderRankType.Templar, 'Inquisitor'] as const;
const newOrderCleanupQueues = createJob('new-order-cleanup-queues', '*/10 * * * *', async () => {
  log('CleanupQueues :: Cleaning up queues');

  for (const rank of ranksToClean) {
    log(`CleanupQueues :: Cleaning up ${rank} queues`);

    // Clean up both slots (a and b)
    for (const slot of ['a', 'b'] as const) {
      log(`CleanupQueues :: Cleaning up ${rank} slot ${slot}`);

      // Fetch current image IDs from the rankType queue slot
      const currentImageIds = (
        await Promise.all(poolCounters[rank][slot].map((pool) => pool.getAll()))
      )
        .flat()
        .map((value) => Number(value));

      if (currentImageIds.length === 0) {
        log(`CleanupQueues :: No images found for ${rank} slot ${slot}`);
        continue;
      }

      const chunks = chunk(currentImageIds, 1000);
      for (const chunkData of chunks) {
        // Check against the database to find non-existing image IDs
        const existingImages = await dbRead.image.findMany({
          where: { id: { in: chunkData } },
          select: { id: true, nsfwLevel: true },
        });
        const existingImageIds = new Set(existingImages.map((image) => image.id));
        const blockedImageIds = new Set(
          existingImages
            .filter((image) => image.nsfwLevel === NsfwLevel.Blocked)
            .map((image) => image.id)
        );
        const imageIdsToRemove = chunkData.filter(
          (id) => !existingImageIds.has(id) || blockedImageIds.has(id)
        );
        if (imageIdsToRemove.length === 0) continue;

        // Remove non-existing images from the queue slot
        await Promise.all(
          poolCounters[rank][slot].map((pool) => pool.reset({ id: imageIdsToRemove }))
        );
      }
    }
  }
  log('CleanupQueues :: Cleaning up queues :: done');
});

// Rotate filling slot at 22:00 UTC daily
// All new images will be added to the new slot
const newOrderChangeFillTarget = createJob(
  'new-order-change-fill-target',
  '0 22 * * *',
  async () => {
    log('ChangeFillTarget :: Starting fill slot rotation');

    // Only Knight rank uses slot rotation; other ranks remain on a single slot
    const ranksToRotate = [NewOrderRankType.Knight] as const;

    for (const rank of ranksToRotate) {
      const currentSlot = await getActiveSlot(rank, 'filling');
      const newSlot = currentSlot === 'a' ? 'b' : 'a';

      await setActiveSlot(rank, 'filling', newSlot);
      log(`ChangeFillTarget :: ${rank} filling slot rotated: ${currentSlot} → ${newSlot}`);
    }

    log('ChangeFillTarget :: Fill slot rotation complete');
  }
);

// Rotate rating slot and purge old slot at 00:00 UTC daily
// Players will now rate from the new slot, old slot gets purged
const newOrderChangeRateTarget = createJob(
  'new-order-change-rate-target',
  '0 0 * * *',
  async () => {
    if (!clickhouse) {
      log('ChangeRateTarget :: ClickHouse not available, skipping');
      return;
    }

    log('ChangeRateTarget :: Starting rate slot rotation and purge');

    // Only Knight rank uses slot rotation; other ranks remain on a single slot
    const ranksToRotate = [NewOrderRankType.Knight] as const;

    for (const rank of ranksToRotate) {
      const currentSlot = await getActiveSlot(rank, 'rating');
      const newSlot = currentSlot === 'a' ? 'b' : 'a';

      // Rotate to the new slot
      await setActiveSlot(rank, 'rating', newSlot);
      log(`ChangeRateTarget :: ${rank} rating slot rotated: ${currentSlot} → ${newSlot}`);

      log(`ChangeRateTarget :: ${rank} - Purging old slot ${currentSlot} before rotation`);

      // Get all image IDs from the current (soon to be old) rating slot
      // No limit - process all images in the slot
      const imagesToPurge = (
        await Promise.all(poolCounters[rank][currentSlot].map((pool) => pool.getAll()))
      )
        .flat()
        .map((value) => Number(value));

      if (imagesToPurge.length > 0) {
        log(
          `ChangeRateTarget :: ${rank} - Found ${imagesToPurge.length} images to purge from slot ${currentSlot}`
        );

        // Mark images as Inconclusive by inserting NULL ratings into buffer
        // Images still in queue at purge time legitimately didn't reach consensus
        // (images with consensus were already removed via removeImageFromQueue)
        log(`ChangeRateTarget :: ${rank} - Inserting NULL ratings into buffer for processing`);

        const batches = chunk(imagesToPurge, 10000);
        for (const batch of batches) {
          // Insert NULL ratings into buffer - these will be marked as Inconclusive by processFinalRatings
          const bufferRecords = batch.map((imageId) => ({
            imageId,
            rating: null,
          }));

          await clickhouse.insert({
            table: 'knights_rating_updates_buffer',
            values: bufferRecords,
            format: 'JSONEachRow',
          });
        }

        log(
          `ChangeRateTarget :: ${rank} - Inserted ${imagesToPurge.length} NULL ratings into buffer`
        );

        // Process the ratings through the standard pipeline
        // This will mark them as Inconclusive using the same logic as regular ratings
        const result = await processFinalRatings();
        log(
          `ChangeRateTarget :: ${rank} - processFinalRatings result: ${JSON.stringify(
            result,
            null,
            2
          )}`
        );

        log(
          `ChangeRateTarget :: ${rank} - Processed ${imagesToPurge.length} images as Inconclusive`
        );

        // Clear all pools in the old slot
        await Promise.all(poolCounters[rank][currentSlot].map((pool) => pool.reset({ all: true })));

        log(`ChangeRateTarget :: ${rank} - Cleared all pools in slot ${currentSlot}`);
      } else {
        log(`ChangeRateTarget :: ${rank} - No images to purge from slot ${currentSlot}`);
      }
    }

    log('ChangeRateTarget :: Rate slot rotation and purge complete');
  }
);

// Periodic abuse detection: identify users with suspicious rating patterns.
// Runs daily at 23:00 UTC, logs to Axiom, files every suspect on the moderator
// app's abuse-detection board, and (when `autoSmiteAbusers` is enabled in Redis
// config) auto-smites suspects matching strict signals via the system actor.
//
// 🔴 THE BOARD POST HAPPENS AFTER THE SMITE LOOP, AND THE ORDER IS LOAD-BEARING.
// Each finding carries the contract's `actioned`/`action` pair, which is a claim
// about what this run already DID — so the findings cannot be built until the
// smiting is over and it is known which accounts it actually succeeded on. The
// contract rejects a mispaired finding on the producer's side of the wire, and
// one rejection loses the whole batch, not the offending row.
//
// Replaces the Discord webhook this scan used to post to: the board is durable,
// reviewable, and the only surface that can represent "detected and deliberately
// not acted on", which is most of what this scan produces.
export async function runAbuseDetectionScan() {
  // Captured before the first await so the board's "when did this run" reading is
  // the producer's own start, not the instant the report happened to be built.
  const startedAt = new Date();
  if (!clickhouse) return;
  log('AbuseDetection :: Scanning for suspicious rating patterns');

  // All tunable thresholds live in Redis so the operational values aren't
  // visible to anyone reading the public source tree. Defaults below are a
  // first-boot fallback; once ops seeds the config, those take precedence.
  // Every value is coerced to a finite number before being interpolated into
  // the ClickHouse query because `formatSqlType` passes strings through
  // unquoted — a non-numeric value sneaking into the config blob would
  // otherwise be a SQL-injection vector. Zod already validates writes via
  // the mod endpoint; this is defense-in-depth for direct Redis edits.
  const config = await getVotingRateLimitConfig();
  const det = config?.abuseDetection ?? {};
  const asFinite = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const minTotalRatings = asFinite(det.minTotalRatings, 10);
  const havingDominantPct = asFinite(det.havingDominantPct, 10);
  const havingAvgPerMinute = asFinite(det.havingAvgPerMinute, 10);
  const smiteDominantPct = asFinite(det.smiteDominantPct, 100);
  const smiteMaxUniqueRatings = asFinite(det.smiteMaxUniqueRatings, 1);

  const suspects = await clickhouse.$query<AbuseSuspect>`
      WITH user_dominant AS (
        SELECT
          userId,
          topK(1)(rating)[1] as dominantRating
        FROM knights_new_order_image_rating FINAL
        WHERE createdAt >= now() - INTERVAL ${ABUSE_SCAN_WINDOW_HOURS} HOUR
          AND rank != 'Acolyte'
        GROUP BY userId
      )
      SELECT
        r.userId,
        count() as totalRatings,
        uniq(r.rating) as uniqueRatings,
        d.dominantRating,
        countIf(r.rating = d.dominantRating) / count() * 100 as dominantPct,
        count() / greatest(uniq(toStartOfMinute(r.createdAt)), 1) as avgPerMinute
      FROM knights_new_order_image_rating r FINAL
      JOIN user_dominant d ON r.userId = d.userId
      WHERE r.createdAt >= now() - INTERVAL ${ABUSE_SCAN_WINDOW_HOURS} HOUR
        AND r.rank != 'Acolyte'
      GROUP BY r.userId, d.dominantRating
      HAVING totalRatings >= ${minTotalRatings}
        AND (uniqueRatings <= ${smiteMaxUniqueRatings} OR dominantPct >= ${havingDominantPct} OR avgPerMinute > ${havingAvgPerMinute})
      ORDER BY totalRatings DESC
      LIMIT 50
    `;

  // The accounts the smite loop actually succeeded on — MEMBERSHIP, not selection. The loop below
  // swallows a per-player failure and carries on, so a target that threw is still an open case and
  // must not be filed on the board as one that was dealt with.
  const smitedUserIds = new Set<number>();

  if (suspects.length > 0) {
    log(`AbuseDetection :: Found ${suspects.length} suspicious users`);
    await logToAxiom({
      type: 'warning',
      name: 'new-order-abuse-detection-scan',
      details: {
        suspectCount: suspects.length,
        suspects: suspects.map((s) => ({
          userId: s.userId,
          totalRatings: s.totalRatings,
          uniqueRatings: s.uniqueRatings,
          dominantRating: s.dominantRating,
          dominantPct: Math.round(s.dominantPct),
          avgPerMinute: Math.round(s.avgPerMinute * 10) / 10,
        })),
      },
      message: `Abuse detection scan found ${suspects.length} suspicious users in the last ${ABUSE_SCAN_WINDOW_HOURS} hours`,
    }).catch(() => null);

    // Auto-smite branch: gated by Redis config flag (off by default). Smite
    // filter applies the tighter `smite*` thresholds against the broader
    // detection pool; the `having*` thresholds (looser) feed the alert path
    // but don't auto-smite alone. The avgPerMinute signal is intentionally
    // excluded from the smite filter — power users can spike during bursts.
    // The 3-active-smites rule in `smitePlayer` chains into the existing
    // `resetPlayer` flow on the third strike.
    if (config?.autoSmiteAbusers === true) {
      const isStrictSignal = (s: (typeof suspects)[number]) =>
        s.uniqueRatings <= smiteMaxUniqueRatings || s.dominantPct >= smiteDominantPct;
      const targets = suspects.filter(isStrictSignal);
      log(`AbuseDetection :: Auto-smiting ${targets.length} strict-signal suspect(s)`);

      for (const s of targets) {
        const reasonParts: string[] = [];
        if (s.uniqueRatings <= smiteMaxUniqueRatings)
          reasonParts.push(`only ${s.uniqueRatings} unique rating value(s)`);
        if (s.dominantPct >= smiteDominantPct)
          reasonParts.push(`${Math.round(s.dominantPct)}% same rating value`);
        const reason = `Auto-smite from abuse detection scan: ${reasonParts.join(', ')}.`;

        try {
          await smitePlayer({
            playerId: s.userId,
            modId: constants.system.user.id,
            reason,
            size: newOrderConfig.smiteSize * 50,
          });
          // Recorded only past the await, so a throw leaves the account out of the set and its
          // board finding reads `actioned: false` — which is what actually happened.
          smitedUserIds.add(s.userId);
          await logToAxiom({
            type: 'warning',
            name: 'new-order-auto-smite',
            details: { playerId: s.userId, source: 'detection-job', reason },
            message: `Auto-smite issued for player ${s.userId}`,
          }).catch(() => null);
        } catch (e) {
          handleLogError(e as Error, `auto-smite failed for player ${s.userId}`);
        }
      }
    }
  } else {
    log('AbuseDetection :: No suspicious users found');
  }

  // Filed even with no suspects: a run row with zero findings is how the board says "this detector
  // ran and found nothing", which is a different and necessary claim from the detector having gone
  // quiet — and the counters carry the population it looked at either way.
  //
  // 🔴 Caught, not propagated. Every smite above has already been written to the database; throwing
  // here would mark the job failed and invite the scheduler to retry a run whose enforcement half
  // already happened. The failure is still loud: a network/HTTP failure goes to Axiom through the
  // client's own `onFailure`, and a contract rejection is logged here by name.
  try {
    await moderatorApp.abuseReport(
      buildAbuseReport({ suspects, smitedUserIds, startedAt, finishedAt: new Date() })
    );
    log(
      `AbuseDetection :: Filed ${suspects.length} finding(s) on the abuse board ` +
        `(${smitedUserIds.size} auto-smited)`
    );
  } catch (e) {
    handleLogError(e as Error, 'new-order abuse detection failed to file its board report');
  }
}

const newOrderAbuseDetection = createJob(
  'new-order-abuse-detection',
  '0 23 * * *',
  runAbuseDetectionScan,
  // 🔴 The only thing standing between a slow run and a duplicate concurrent one. Two runs of this
  // scan do not merely double the work: each files its own board report, and the receiving table's
  // idempotency key is `(detector, started_at)` — two runs have different start instants, so the
  // second APPENDS a near-identical run rather than replacing the first, and a moderator sees the
  // same cohort twice. Sized well past the query plus a 50-account smite loop.
  { lockExpiration: 10 * 60 }
);

export const newOrderJobs = [
  newOrderGrantBlessedBuzz,
  newOrderDailyReset,
  newOrderCleanseSmites,
  // newOrderCleanupQueues,
  newOrderChangeFillTarget,
  newOrderChangeRateTarget,
  newOrderAbuseDetection,
];
