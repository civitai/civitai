import { chunk } from 'lodash-es';
import dayjs from '~/shared/utils/dayjs';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { createJob } from './job';
import { TransactionType } from '~/server/schema/buzz.schema';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { deliverMonthlyCosmetics } from '../services/subscriptions.service';
import type {
  SubscriptionMetadata,
  SubscriptionProductMetadata,
} from '~/server/schema/subscriptions.schema';

const schema = z.object({
  date: z.coerce.date().optional(),
});

export const deliverPrepaidMembershipBuzz = createJob(
  'deliver-civitai-membership-buzz',
  '0 1 * * *', // We should run this after the expire not before.
  async (ctx) => {
    const now = dayjs();
    const date = now.format('YYYY-MM');

    // Get the current day of the month
    let currentDay = now.date();
    const parseResult = schema.safeParse(ctx.req?.query);
    const dateOverride =
      parseResult.success && parseResult.data.date ? parseResult.data.date : undefined;
    if (dateOverride) {
      // Override currentDay with the parsed date's day
      currentDay = dateOverride.getDate();
    }

    const data = await dbWrite.$queryRaw<
      {
        id: string;
        userId: number;
        buzzAmount: number | string;
        productId: string;
        priceId: string;
        interval: string;
        tier: string;
      }[]
    >`
      SELECT
        cs.id as "id",
        "userId",
        pr.metadata->>'monthlyBuzz' as "buzzAmount",
        pr.id as "productId",
        p.id as "priceId",
        p.interval as "interval",
        pr.metadata->>'tier' as "tier"
      FROM "CustomerSubscription" cs
      JOIN "Product" pr ON pr.id = cs."productId"
      JOIN "Price" p ON p.id = cs."priceId"
      WHERE (
        -- Exact day match (normal case)
        EXTRACT(day from cs."currentPeriodStart") = ${currentDay}
        OR
        -- Handle month-end edge cases (e.g., Jan 30th -> Feb 28th, Jan 31st -> Apr 30th)
        (
          EXTRACT(day from cs."currentPeriodStart") > EXTRACT(day from (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day'))
          AND ${currentDay} = EXTRACT(day from (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day'))
        )
      )
      AND cs."createdAt" < NOW()::date -- Don't grant on the first day (already granted when membership started)
      AND cs.status = 'active'
      AND cs."currentPeriodEnd" > NOW()
      AND cs."currentPeriodEnd"::date > NOW()::date -- Don't grant buzz on the expiration day
      AND pr.provider = 'Civitai'
      AND pr.metadata->>'monthlyBuzz' IS NOT NULL
      AND COALESCE((cs.metadata->'prepaids'->(pr.metadata->>'tier'))::int, 0) > 0
    `;

    if (!data.length) {
      console.log('No Civitai membership holders found for buzz delivery today');
      return;
    }

    const buzzTransactions = data
      .map((d) => {
        const buzzAmount = Number(d.buzzAmount);

        // For yearly subscriptions, we grant monthly buzz, not the full year amount
        // Monthly subscriptions get their full monthly buzz
        const amount = d.interval === 'year' ? buzzAmount : buzzAmount;

        return {
          fromAccountId: 0,
          toAccountId: d.userId,
          type: TransactionType.Purchase,
          externalTransactionId: `civitai-membership:${date}:${d.userId}:${d.productId}`,
          amount: amount,
          description: `Membership Bonus`,
          details: {
            type: 'civitai-membership-payment',
            date: date,
            productId: d.productId,
            interval: d.interval,
          },
        };
      })
      .filter((d) => d.amount > 0);

    // Process in batches to avoid overwhelming the database
    const batches = chunk(buzzTransactions, 100);
    for (const batch of batches) {
      await createBuzzTransactionMany(batch);
    }

    // Decrement prepaid counts for each user who received buzz
    if (data.length > 0) {
      console.log(`Decrementing prepaid counts for ${data.length} users`);

      await dbWrite.$executeRaw`
        UPDATE "CustomerSubscription"
        SET
          "metadata" = jsonb_set(
            "metadata",
            ARRAY['prepaids', (updates.data ->> 'tier')],
            (COALESCE(("metadata"->'prepaids'->>(updates.data ->> 'tier'))::int, 0) - 1)::text::jsonb
          ),
          "updatedAt" = NOW()
        FROM (
          SELECT
            (value ->> 'id')::text AS "id",
            value AS data
          FROM json_array_elements(${JSON.stringify(
            data.map((d) => ({
              id: d.id,
              tier: d.tier,
            }))
          )}::json)
        ) AS updates
        WHERE "CustomerSubscription"."id" = updates."id"
      `;
    }

    // Grant cosmetics for Civitai membership holders
    await deliverMonthlyCosmetics({ dateOverride });

    console.log(`Delivered buzz to ${data.length} Civitai membership holders`);
  }
);

export const processPrepaidMembershipTransitions = createJob(
  'process-prepaid-membership-transitions',
  '0 0 * * *', // Run daily at midnight
  async () => {
    const now = dayjs();

    // Pre-fetch all tier products to avoid repeated queries
    const tierProducts = await dbWrite.product.findMany({
      where: {
        provider: 'Civitai',
      },
      include: {
        prices: {
          where: {
            active: true,
            interval: 'month',
          },
          take: 1,
        },
      },
    });

    // Create a map for quick tier lookup
    const productsByTier = new Map<string, (typeof tierProducts)[0]>();
    tierProducts.forEach((product) => {
      const meta = product.metadata as SubscriptionProductMetadata;
      if (meta?.tier && ['bronze', 'silver', 'gold'].includes(meta.tier)) {
        productsByTier.set(meta.tier, product);
      }
    });

    // Find all Civitai memberships expiring today
    const expiringMemberships = await dbWrite.customerSubscription.findMany({
      where: {
        status: 'active',
        currentPeriodEnd: {
          gte: now.startOf('day').toDate(),
          lt: now.endOf('day').toDate(),
        },
        product: {
          provider: 'Civitai',
        },
      },
      select: {
        id: true,
        userId: true,
        metadata: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        product: {
          select: {
            id: true,
            metadata: true,
          },
        },
        price: {
          select: {
            id: true,
            interval: true,
          },
        },
      },
    });

    if (!expiringMemberships.length) {
      console.log('No prepaid memberships expiring today');
      return;
    }

    console.log(`Processing ${expiringMemberships.length} expiring memberships`);

    // Process memberships and prepare updates for batching
    const membershipUpdates: Array<{
      id: string;
      productId?: string;
      priceId?: string;
      currentPeriodStart?: Date;
      currentPeriodEnd?: Date;
      metadata?: any;
      status?: string;
      canceledAt?: Date;
      endedAt?: Date;
    }> = [];

    for (const membership of expiringMemberships) {
      try {
        const subscriptionMeta = (membership.metadata as SubscriptionMetadata) || {};
        const productMeta = (membership.product.metadata as SubscriptionProductMetadata) || {};
        const currentTier = productMeta.tier;

        // Get prepaid memberships and prorated days
        const prepaids = subscriptionMeta.prepaids || {};
        const proratedDays = subscriptionMeta.proratedDays || {};

        // Find the best available prepaid membership tier
        let nextTier: string | null = null;
        let nextMonths = 0;
        let nextProratedDays = 0;

        // Check all paid tiers in order of priority (best to lowest: gold → silver → bronze)
        // Only check paid tiers that can have prepaid months
        // Example: If user has { bronze: 2, silver: 1 }, they get silver (better tier)
        const paidTiers = ['bronze', 'silver', 'gold'];
        for (let i = paidTiers.length - 1; i >= 0; i--) {
          const tier = paidTiers[i];
          const remainingMonths = prepaids[tier as keyof typeof prepaids] || 0;
          const proratedDaysForTier = proratedDays[tier as keyof typeof proratedDays] || 0;
          console.log({ proratedDaysForTier });

          if (remainingMonths > 0 || proratedDaysForTier > 0) {
            nextTier = tier;
            nextMonths = remainingMonths;
            nextProratedDays = proratedDaysForTier;
            break; // Take the first (best) tier found
          }
        }

        if (!nextTier || (nextMonths <= 0 && nextProratedDays <= 0)) {
          // No prepaid memberships left, cancel the subscription
          console.log(
            `User ${membership.userId}: No prepaid memberships left, canceling subscription`
          );

          membershipUpdates.push({
            id: membership.id,
            status: 'canceled',
            canceledAt: now.toDate(),
            endedAt: now.toDate(),
          });
          continue;
        }

        // Find the product for the next tier (from pre-fetched products)
        const nextTierProduct = productsByTier.get(nextTier);

        if (!nextTierProduct || !nextTierProduct.prices.length) {
          console.log(`User ${membership.userId}: Could not find product for tier ${nextTier}`);
          continue;
        }

        // Calculate the new period end date
        const newPeriodStart = now;
        const newPeriodEnd = newPeriodStart.add(nextMonths, 'month').add(nextProratedDays, 'day');

        // Clear prorated days for this tier since we're using them
        const updatedProratedDays = { ...proratedDays };
        delete updatedProratedDays[nextTier as keyof typeof updatedProratedDays];

        // Prepare the subscription update
        membershipUpdates.push({
          id: membership.id,
          productId: nextTierProduct.id,
          priceId: nextTierProduct.prices[0].id,
          currentPeriodStart: newPeriodStart.toDate(),
          currentPeriodEnd: newPeriodEnd.toDate(),
          metadata: {
            ...subscriptionMeta,
            // We do not update prepaids here, they are decremented in the buzz processing job above.
            proratedDays: updatedProratedDays,
          },
        });

        console.log(
          `User ${membership.userId}: Transitioned from ${currentTier} to ${nextTier} tier. ` +
            `New period ends: ${newPeriodEnd.format(
              'YYYY-MM-DD'
            )}. Prepaid ${nextTier} months will be decremented by buzz delivery job.`
        );
      } catch (error) {
        console.error(
          `Error processing membership transition for user ${membership.userId}:`,
          error
        );
      }
    }

    // Batch update all memberships using a single SQL query
    if (membershipUpdates.length > 0) {
      console.log(`Applying ${membershipUpdates.length} membership updates`);

      await dbWrite.$executeRaw`
        UPDATE "CustomerSubscription"
        SET
          "productId" = CASE
            WHEN (updates.data ->> 'productId') IS NOT NULL
            THEN (updates.data ->> 'productId')
            ELSE "CustomerSubscription"."productId"
          END,
          "priceId" = CASE
            WHEN (updates.data ->> 'priceId') IS NOT NULL
            THEN (updates.data ->> 'priceId')
            ELSE "CustomerSubscription"."priceId"
          END,
          "currentPeriodStart" = CASE
            WHEN (updates.data ->> 'currentPeriodStart') IS NOT NULL
            THEN (updates.data ->> 'currentPeriodStart')::timestamp
            ELSE "CustomerSubscription"."currentPeriodStart"
          END,
          "currentPeriodEnd" = CASE
            WHEN (updates.data ->> 'currentPeriodEnd') IS NOT NULL
            THEN (updates.data ->> 'currentPeriodEnd')::timestamp
            ELSE "CustomerSubscription"."currentPeriodEnd"
          END,
          "metadata" = CASE
            WHEN (updates.data ->> 'metadata') IS NOT NULL
            THEN (updates.data ->> 'metadata')::jsonb
            ELSE "CustomerSubscription"."metadata"
          END,
          "status" = CASE
            WHEN (updates.data ->> 'status') IS NOT NULL
            THEN (updates.data ->> 'status')
            ELSE "CustomerSubscription"."status"
          END,
          "canceledAt" = CASE
            WHEN (updates.data ->> 'canceledAt') IS NOT NULL
            THEN (updates.data ->> 'canceledAt')::timestamp
            ELSE "CustomerSubscription"."canceledAt"
          END,
          "endedAt" = CASE
            WHEN (updates.data ->> 'endedAt') IS NOT NULL
            THEN (updates.data ->> 'endedAt')::timestamp
            ELSE "CustomerSubscription"."endedAt"
          END,
          "updatedAt" = NOW()
        FROM (
          SELECT
            (value ->> 'id') AS id,
            value AS data
          FROM json_array_elements(${JSON.stringify(
            membershipUpdates.map((update) => ({
              id: update.id,
              productId: update.productId || null,
              priceId: update.priceId || null,
              currentPeriodStart: update.currentPeriodStart?.toISOString() || null,
              currentPeriodEnd: update.currentPeriodEnd?.toISOString() || null,
              metadata: update.metadata ? JSON.stringify(update.metadata) : null,
              status: update.status || null,
              canceledAt: update.canceledAt?.toISOString() || null,
              endedAt: update.endedAt?.toISOString() || null,
            }))
          )}::json)
        ) AS updates
        WHERE "CustomerSubscription".id = updates.id
      `;
    }

    console.log(`Processed ${expiringMemberships.length} prepaid membership transitions`);
  }
);

export const prepaidMembershipJobs = [
  deliverPrepaidMembershipBuzz,
  processPrepaidMembershipTransitions,
];
