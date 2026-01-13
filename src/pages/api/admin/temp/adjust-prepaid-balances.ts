import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { z } from 'zod';
import { booleanString } from '~/utils/zod-helpers';
import { chunk } from 'lodash-es';
import { dbWrite } from '~/server/db/client';
import type { SubscriptionMetadata } from '~/server/schema/subscriptions.schema';
import dayjs from 'dayjs';

// Configurable constants
const BATCH_SIZE = 50;
const CONCURRENCY = 5;

const querySchema = z.object({
  dryRun: booleanString().default(true),
  userId: z.coerce.number().optional(),
});

type SubscriptionData = {
  id: string;
  userId: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  metadata: SubscriptionMetadata;
  tier: string;
  priceId: string;
};

type RedemptionData = {
  userId: number;
  unitValue: number;
  redeemedAt: Date;
  priceId: string;
};

type AdjustmentCalculation = {
  adjustedPrepaidBalance: number;
  isRolloverCase: boolean;
  monthsRolled: number;
  monthsRemaining: number;
};

type AffectedSubscription = SubscriptionData &
  AdjustmentCalculation & {
    currentPrepaidBalance: number;
    needsAdjustment: boolean;
  };

type AdjustmentResult = {
  subscriptionId: string;
  userId: number;
  tier: string;
  previousBalance: number;
  newBalance: number;
  adjustment: number;
  isRolloverCase: boolean;
  monthsRolled: number;
  success: boolean;
  error?: string;
};

// Fetch subscriptions with basic data (no complex calculations)
async function fetchSubscriptions(userId?: number): Promise<SubscriptionData[]> {
  const userFilter = userId ? Prisma.sql`AND cs."userId" = ${userId}` : Prisma.empty;

  const results = await dbWrite.$queryRaw<any[]>`
    SELECT
      cs.id,
      cs."userId",
      cs."currentPeriodStart",
      cs."currentPeriodEnd",
      cs.metadata,
      cs."priceId",
      (p.metadata->>'tier')::text as tier
    FROM "CustomerSubscription" cs
    JOIN "Product" p ON p.id = cs."productId"
    WHERE cs.status = 'active'
      AND cs.metadata->'prepaids' IS NOT NULL
      AND cs."currentPeriodEnd" > CURRENT_DATE
      ${userFilter}
  `;

  return results.map((row) => ({
    id: row.id,
    userId: row.userId,
    currentPeriodStart: new Date(row.currentPeriodStart),
    currentPeriodEnd: new Date(row.currentPeriodEnd),
    metadata: row.metadata as SubscriptionMetadata,
    tier: row.tier,
    priceId: row.priceId,
  }));
}

// Fetch redemption history
async function fetchRedemptions(userIds: number[]): Promise<RedemptionData[]> {
  if (userIds.length === 0) return [];

  // Use IN clause with Prisma.join for array parameters
  const results = await dbWrite.$queryRaw<any[]>`
    SELECT
      "userId",
      "unitValue",
      "redeemedAt",
      "priceId"
    FROM "RedeemableCode"
    WHERE type = 'Membership'
      AND "redeemedAt" IS NOT NULL
      AND "userId" IN (${Prisma.join(userIds)})
    ORDER BY "userId", "redeemedAt"
  `;

  return results.map((row) => ({
    userId: row.userId,
    unitValue: row.unitValue,
    redeemedAt: new Date(row.redeemedAt),
    priceId: row.priceId,
  }));
}

// Calculate adjustment for a single subscription
function calculateAdjustment(
  subscription: SubscriptionData,
  allRedemptions: RedemptionData[]
): AdjustmentCalculation {
  const today = dayjs();
  const periodEnd = dayjs(subscription.currentPeriodEnd);
  const periodStart = dayjs(subscription.currentPeriodStart);

  // Calculate months remaining from today to period end
  const monthsRemaining = Math.max(0, periodEnd.diff(today, 'month'));

  // Get redemptions for this subscription's tier (matching priceId)
  const tierRedemptions = allRedemptions.filter(
    (r) => r.userId === subscription.userId && r.priceId === subscription.priceId
  );

  // ROLLOVER DETECTION:
  // If user has redemptions, check if period start is suspiciously late
  if (tierRedemptions.length > 0) {
    const firstRedemption = dayjs(tierRedemptions[0].redeemedAt);
    const totalMonths = tierRedemptions.reduce((sum, r) => sum + r.unitValue, 0);

    // If period start is more than totalMonths after first redemption, it rolled over
    const expectedLatestStart = firstRedemption.add(totalMonths - 1, 'month');

    if (periodStart.isAfter(expectedLatestStart, 'day')) {
      // ROLLOVER CASE: Period start rolled into future, set prepaid to 0
      return {
        adjustedPrepaidBalance: 0,
        isRolloverCase: true,
        monthsRolled: periodStart.diff(expectedLatestStart, 'month'),
        monthsRemaining,
      };
    }
  }

  // NORMAL CASE: Set prepaid to match months remaining
  return {
    adjustedPrepaidBalance: monthsRemaining,
    isRolloverCase: false,
    monthsRolled: 0,
    monthsRemaining,
  };
}

// Process a batch of subscriptions
async function processBatch(
  batch: AffectedSubscription[],
  dryRun: boolean
): Promise<AdjustmentResult[]> {
  const results: AdjustmentResult[] = [];

  for (const subscription of batch) {
    try {
      if (!dryRun) {
        // Update the subscription metadata
        await dbWrite.customerSubscription.update({
          where: { id: subscription.id },
          data: {
            metadata: {
              ...subscription.metadata,
              prepaids: {
                ...subscription.metadata.prepaids,
                [subscription.tier]: subscription.adjustedPrepaidBalance,
              },
            },
            updatedAt: new Date(),
          },
        });
      }

      results.push({
        subscriptionId: subscription.id,
        userId: subscription.userId,
        tier: subscription.tier,
        previousBalance: subscription.currentPrepaidBalance,
        newBalance: subscription.adjustedPrepaidBalance,
        adjustment: subscription.currentPrepaidBalance - subscription.adjustedPrepaidBalance,
        isRolloverCase: subscription.isRolloverCase,
        monthsRolled: subscription.monthsRolled,
        success: true,
      });
    } catch (error) {
      results.push({
        subscriptionId: subscription.id,
        userId: subscription.userId,
        tier: subscription.tier,
        previousBalance: subscription.currentPrepaidBalance,
        newBalance: subscription.adjustedPrepaidBalance,
        adjustment: subscription.currentPrepaidBalance - subscription.adjustedPrepaidBalance,
        isRolloverCase: subscription.isRolloverCase,
        monthsRolled: subscription.monthsRolled,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return results;
}

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const log = (msg: string) => console.log(`[AdjustPrepaidBalances] ${msg}`);

  // Parse query parameters
  const queryResult = querySchema.safeParse(req.query);
  if (!queryResult.success) {
    return res.status(400).json({ error: 'Invalid query parameters', details: queryResult.error });
  }

  const { dryRun, userId } = queryResult.data;

  log(`Starting prepaid balance adjustment... (dryRun: ${dryRun})`);
  if (userId) {
    log(`Targeting specific user: ${userId}`);
  }

  // Step 1: Fetch subscriptions
  log('Fetching subscriptions...');
  const subscriptions = await fetchSubscriptions(userId);
  log(`Found ${subscriptions.length} subscriptions`);

  if (subscriptions.length === 0) {
    return res.status(200).json({
      success: true,
      dryRun,
      message: 'No subscriptions found',
      summary: {
        totalAffected: 0,
        totalProcessed: 0,
        rolloverCases: 0,
        normalCases: 0,
        totalIncreases: 0,
        totalDecreases: 0,
        byTier: { bronze: 0, silver: 0, gold: 0 },
      },
      details: [],
    });
  }

  // Step 2: Fetch redemptions
  log('Fetching redemption history...');
  const userIds = [...new Set(subscriptions.map((s) => s.userId))];
  const redemptions = await fetchRedemptions(userIds);
  log(`Found ${redemptions.length} redemptions`);

  // Step 3: Calculate adjustments in JavaScript
  log('Calculating adjustments...');
  const affectedSubscriptions = subscriptions
    .map((sub) => {
      const calculation = calculateAdjustment(sub, redemptions);
      const currentPrepaid = sub.metadata.prepaids?.[sub.tier as 'bronze' | 'silver' | 'gold'] ?? 0;

      return {
        ...sub,
        ...calculation,
        currentPrepaidBalance: currentPrepaid,
        needsAdjustment: currentPrepaid !== calculation.adjustedPrepaidBalance,
      };
    })
    .filter((sub) => sub.needsAdjustment);

  log(`Found ${affectedSubscriptions.length} subscriptions needing adjustment`);

  if (affectedSubscriptions.length === 0) {
    return res.status(200).json({
      success: true,
      dryRun,
      message: 'No affected subscriptions found',
      summary: {
        totalAffected: 0,
        totalProcessed: 0,
        rolloverCases: 0,
        normalCases: 0,
        totalIncreases: 0,
        totalDecreases: 0,
        byTier: { bronze: 0, silver: 0, gold: 0 },
      },
      details: [],
    });
  }

  // Step 4: Process in batches
  log(
    `Processing ${affectedSubscriptions.length} subscriptions with BATCH_SIZE=${BATCH_SIZE}, CONCURRENCY=${CONCURRENCY}`
  );

  const allResults: AdjustmentResult[] = [];
  const batches = chunk(affectedSubscriptions, BATCH_SIZE);

  // Process batches with concurrency
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const concurrentBatches = batches.slice(i, i + CONCURRENCY);
    log(
      `Processing batches ${i + 1}-${Math.min(i + CONCURRENCY, batches.length)} of ${
        batches.length
      }`
    );

    const batchPromises = concurrentBatches.map((batch) => processBatch(batch, dryRun));
    const batchResults = await Promise.all(batchPromises);

    for (const results of batchResults) {
      allResults.push(...results);
    }
  }

  // Step 5: Calculate summary statistics
  const summary = {
    totalAffected: affectedSubscriptions.length,
    totalProcessed: allResults.length,
    rolloverCases: allResults.filter((r) => r.isRolloverCase).length,
    normalCases: allResults.filter((r) => !r.isRolloverCase).length,
    totalIncreases: allResults.filter((r) => r.adjustment < 0).length,
    totalDecreases: allResults.filter((r) => r.adjustment > 0).length,
    byTier: {
      bronze: allResults.filter((r) => r.tier === 'bronze').length,
      silver: allResults.filter((r) => r.tier === 'silver').length,
      gold: allResults.filter((r) => r.tier === 'gold').length,
    },
    failedUpdates: allResults.filter((r) => !r.success).length,
  };

  log(`Adjustment complete.`);
  log(`Rollover cases: ${summary.rolloverCases}, Normal cases: ${summary.normalCases}`);
  log(`Increases: ${summary.totalIncreases}, Decreases: ${summary.totalDecreases}`);
  log(`Failed updates: ${summary.failedUpdates}`);

  return res.status(200).json({
    success: true,
    dryRun,
    summary,
    details: allResults,
  });
});
