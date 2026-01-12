import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { dbWrite } from '~/server/db/client';
import { z } from 'zod';
import { booleanString } from '~/utils/zod-helpers';
import { chunk } from 'lodash-es';
import type { SubscriptionMetadata } from '~/server/schema/subscriptions.schema';

// Configuration
const BATCH_SIZE = 50; // Process 50 users per batch
const CONCURRENCY = 5; // 5 batches in parallel

const querySchema = z.object({
  dryRun: booleanString().default(true),
  userId: z.coerce.number().optional(), // For testing specific user
});

type AffectedUser = {
  userId: number;
  subscriptionId: string;
  currentTier: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  currentPrepaidBalance: number;
  firstRedemption: Date;
  totalMonthsPurchased: number;
  redemptionCount: number;
  extraMonthsRolled: number;
  correctedPrepaidBalance: number;
  expectedEndDate: Date;
};

async function identifyAffectedUsers(userId?: number): Promise<AffectedUser[]> {
  const results = await dbWrite.$queryRaw<
    Array<{
      userId: number;
      subscription_id: string;
      currentPeriodStart: Date;
      currentPeriodEnd: Date;
      current_tier: string;
      current_prepaid_balance: number;
      first_redemption: Date;
      total_months_purchased: number;
      redemption_count: number;
      extra_months_rolled: number;
    }>
  >`
    WITH redemption_summary AS (
      -- Get all membership redemptions before bug fix
      SELECT
        rc."userId",
        rc."redeemedAt",
        rc."unitValue",
        pr.metadata->>'tier' as tier,
        p."interval"
      FROM "RedeemableCode" rc
      JOIN "Price" p ON p.id = rc."priceId"
      JOIN "Product" pr ON pr.id = p."productId"
        AND pr.provider = 'Civitai'
      WHERE rc."type" = 'Membership'
        AND rc."redeemedAt" IS NOT NULL
        AND rc."userId" IS NOT NULL
    ),
    user_tier_redemptions AS (
      -- Sum total months purchased per user per tier
      SELECT
        "userId",
        tier,
        MIN("redeemedAt") as first_redemption,
        SUM("unitValue") as total_months_purchased,
        COUNT(*) as redemption_count
      FROM redemption_summary
      GROUP BY "userId", tier
    )
    SELECT
      cs."userId",
      cs.id as subscription_id,
      cs."currentPeriodStart",
      cs."currentPeriodEnd",
      pr.metadata->>'tier' as current_tier,
      COALESCE((cs.metadata->'prepaids'->(pr.metadata->>'tier'))::int, 0) as current_prepaid_balance,
      utr.first_redemption,
      utr.total_months_purchased,
      utr.redemption_count,
      GREATEST(0,
        EXTRACT(MONTH FROM AGE(
          cs."currentPeriodEnd",
          utr.first_redemption + (utr.total_months_purchased || ' month')::interval
        ))
      ) as extra_months_rolled
    FROM "CustomerSubscription" cs
    JOIN "Product" pr ON pr.id = cs."productId"
    JOIN user_tier_redemptions utr ON utr."userId" = cs."userId"
      AND utr.tier = (pr.metadata->>'tier')
    WHERE cs.status = 'active'
      AND pr.provider = 'Civitai'
      AND cs."currentPeriodEnd" > (utr.first_redemption + (utr.total_months_purchased || ' month')::interval)
      ${userId ? Prisma.sql`AND cs."userId" = ${userId}` : Prisma.empty}
    ORDER BY extra_months_rolled DESC;
  `;

  // Transform results and calculate corrections
  return results.map((row) => {
    const extraMonths = Number(row.extra_months_rolled);
    const correctedBalance = Math.max(0, row.current_prepaid_balance - extraMonths);
    const expectedEndDate = new Date(row.first_redemption);
    expectedEndDate.setMonth(expectedEndDate.getMonth() + Number(row.total_months_purchased));

    return {
      userId: row.userId,
      subscriptionId: row.subscription_id,
      currentTier: row.current_tier,
      currentPeriodStart: row.currentPeriodStart,
      currentPeriodEnd: row.currentPeriodEnd,
      currentPrepaidBalance: row.current_prepaid_balance,
      firstRedemption: row.first_redemption,
      totalMonthsPurchased: Number(row.total_months_purchased),
      redemptionCount: Number(row.redemption_count),
      extraMonthsRolled: extraMonths,
      correctedPrepaidBalance: correctedBalance,
      expectedEndDate,
    };
  });
}

async function processBatch(
  batch: AffectedUser[],
  dryRun: boolean,
  log: (msg: string) => void
): Promise<void> {
  if (dryRun) return; // Skip updates in dry run

  // Update each subscription's metadata in the batch
  for (const user of batch) {
    // Fetch current metadata to preserve other fields
    const subscription = await dbWrite.customerSubscription.findUnique({
      where: { id: user.subscriptionId },
      select: { metadata: true },
    });

    if (!subscription) {
      log(`Warning: Subscription ${user.subscriptionId} not found for user ${user.userId}`);
      continue;
    }

    const metadata = subscription.metadata as SubscriptionMetadata | null;
    const prepaids = (metadata?.prepaids || {}) as SubscriptionMetadata['prepaids'];

    // Update only the prepaid balance for the current tier
    const updatedPrepaids = {
      ...prepaids,
      [user.currentTier]: user.correctedPrepaidBalance,
    };

    await dbWrite.customerSubscription.update({
      where: { id: user.subscriptionId },
      data: {
        metadata: {
          ...metadata,
          prepaids: updatedPrepaids,
        },
      },
    });

    log(
      `Updated user ${user.userId}: ${user.currentTier} prepaids ${user.currentPrepaidBalance} → ${user.correctedPrepaidBalance}`
    );
  }
}

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const log = (msg: string) => console.log(`[FixPrepaidMetadata] ${msg}`);

  // Parse query parameters
  const queryResult = querySchema.safeParse(req.query);
  if (!queryResult.success) {
    return res.status(400).json({ error: 'Invalid query parameters', details: queryResult.error });
  }

  const { dryRun, userId } = queryResult.data;

  log(`Starting prepaid metadata fix... (dryRun: ${dryRun}${userId ? `, userId: ${userId}` : ''})`);

  // 1. Identify affected users
  const affectedUsers = await identifyAffectedUsers(userId);
  log(`Found ${affectedUsers.length} affected users`);

  if (affectedUsers.length === 0) {
    return res.status(200).json({
      success: true,
      dryRun,
      message: 'No affected users found',
      summary: {
        totalUsers: 0,
        totalExtraMonths: 0,
        byTier: { bronze: 0, silver: 0, gold: 0 },
      },
    });
  }

  // 2. Calculate summary statistics
  const summary = {
    totalUsers: affectedUsers.length,
    totalExtraMonths: affectedUsers.reduce((sum, u) => sum + u.extraMonthsRolled, 0),
    byTier: {
      bronze: affectedUsers.filter((u) => u.currentTier === 'bronze').length,
      silver: affectedUsers.filter((u) => u.currentTier === 'silver').length,
      gold: affectedUsers.filter((u) => u.currentTier === 'gold').length,
    },
  };

  log(
    `Summary: ${summary.totalUsers} users, ${summary.totalExtraMonths} extra months (Bronze: ${summary.byTier.bronze}, Silver: ${summary.byTier.silver}, Gold: ${summary.byTier.gold})`
  );

  // 3. If dry run, return preview
  if (dryRun) {
    log('DRY RUN MODE - No changes will be applied');
    return res.status(200).json({
      success: true,
      dryRun: true,
      summary,
      sampleUsers: affectedUsers.slice(0, 10).map((u) => ({
        userId: u.userId,
        subscriptionId: u.subscriptionId,
        currentTier: u.currentTier,
        currentPeriodEnd: u.currentPeriodEnd,
        expectedEndDate: u.expectedEndDate,
        currentPrepaidBalance: u.currentPrepaidBalance,
        extraMonthsRolled: u.extraMonthsRolled,
        correctedPrepaidBalance: u.correctedPrepaidBalance,
        redemptionCount: u.redemptionCount,
        totalMonthsPurchased: u.totalMonthsPurchased,
      })),
      fullDetails: affectedUsers,
    });
  }

  // 4. Process updates in batches
  const batches = chunk(affectedUsers, BATCH_SIZE);
  let processedCount = 0;

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const concurrentBatches = batches.slice(i, i + CONCURRENCY);
    log(
      `Processing batches ${i + 1}-${Math.min(i + CONCURRENCY, batches.length)} of ${
        batches.length
      }`
    );

    await Promise.all(concurrentBatches.map((batch) => processBatch(batch, dryRun, log)));

    processedCount += concurrentBatches.reduce((sum, batch) => sum + batch.length, 0);
    log(`Progress: ${processedCount}/${affectedUsers.length} users updated`);
  }

  log(`Fix complete! Updated ${affectedUsers.length} users`);

  return res.status(200).json({
    success: true,
    dryRun: false,
    summary,
    message: `Successfully updated ${affectedUsers.length} users`,
    details: affectedUsers.map((u) => ({
      userId: u.userId,
      subscriptionId: u.subscriptionId,
      currentTier: u.currentTier,
      currentPrepaidBalance: u.currentPrepaidBalance,
      correctedPrepaidBalance: u.correctedPrepaidBalance,
      extraMonthsRolled: u.extraMonthsRolled,
    })),
  });
});
