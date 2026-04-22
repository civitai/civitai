import { chunk } from 'lodash-es';
import dayjs from '~/shared/utils/dayjs';
import { dbWrite } from '~/server/db/client';
import { createJob } from './job';
import {
  deliverMonthlyCosmetics,
  unlockPrepaidTokensForDate,
} from '../services/subscriptions.service';
import { refreshSession } from '~/server/auth/session-invalidation';
import type {
  SubscriptionMetadata,
  SubscriptionProductMetadata,
} from '~/server/schema/subscriptions.schema';

/**
 * Unlock prepaid tokens based on the subscription's currentPeriodStart day-of-month matching today.
 * On a matching day, unlocks ONE locked token per subscription matching the user's current tier.
 * Users must claim unlocked tokens manually via the membership page.
 */
export const unlockPrepaidTokens = createJob(
  'unlock-prepaid-tokens',
  '0 1 * * *', // Run daily at 1 AM UTC (same schedule as before)
  async () => {
    const result = await unlockPrepaidTokensForDate({ date: new Date() });
    console.log(result.message);

    // Still deliver monthly cosmetics on the same schedule
    await deliverMonthlyCosmetics({});
  }
);

export const processPrepaidMembershipTransitions = createJob(
  'process-prepaid-membership-transitions',
  '0 0 * * *', // Run daily at midnight
  async () => {
    const { getPrepaidTokens } = await import('~/server/utils/subscription.utils');
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

    // Find all Civitai memberships expiring today. Referral-granted subs use
    // buzzType='referral' and live on their own queue (see
    // advanceReferralSubscriptions) — exclude them here to avoid the prepaid
    // cron canceling them for having no prepaid tokens.
    const expiringMemberships = await dbWrite.customerSubscription.findMany({
      where: {
        status: 'active',
        currentPeriodEnd: {
          gte: now.startOf('day').toDate(),
          lt: now.endOf('day').toDate(),
        },
        buzzType: { not: 'referral' },
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

        // Use getPrepaidTokens for backwards compat — handles both new tokens and legacy prepaids
        const allTokens = getPrepaidTokens({ metadata: subscriptionMeta });
        // Only locked tokens count as future months. Unlocked tokens represent already-occurred
        // months (buzz available to claim) and should NOT extend the new period.
        const futureTokens = allTokens.filter((t) => t.status === 'locked');
        const proratedDays = subscriptionMeta.proratedDays || {};
        const hasAnyProratedDays = Object.values(proratedDays).some((v) => (v ?? 0) > 0);

        if (futureTokens.length === 0 && !hasAnyProratedDays) {
          console.log(
            `User ${membership.userId}: No remaining tokens or prorated days, canceling subscription`
          );
          membershipUpdates.push({
            id: membership.id,
            status: 'canceled',
            canceledAt: now.toDate(),
            endedAt: now.toDate(),
          });
          continue;
        }

        // For tier TRANSITIONS (period expired), find the best available tier to switch to.
        // Check both tokens AND prorated days per tier — a tier with only prorated days
        // still wins over a lower tier with tokens (e.g., 10 Silver prorated days > 2 Bronze tokens).
        const paidTiers = ['bronze', 'silver', 'gold'];
        let nextTier: string | null = null;
        let nextMonths = 0;
        let nextProratedDays = 0;

        for (let i = paidTiers.length - 1; i >= 0; i--) {
          const tier = paidTiers[i];
          const tierTokenCount = futureTokens.filter((t) => t.tier === tier).length;
          const tierProratedDays = proratedDays[tier as keyof typeof proratedDays] || 0;

          if (tierTokenCount > 0 || tierProratedDays > 0) {
            nextTier = tier;
            nextMonths = tierTokenCount;
            nextProratedDays = tierProratedDays;
            break;
          }
        }

        if (!nextTier || (nextMonths <= 0 && nextProratedDays <= 0)) {
          console.log(
            `User ${membership.userId}: No prepaid tokens left, canceling subscription`
          );
          membershipUpdates.push({
            id: membership.id,
            status: 'canceled',
            canceledAt: now.toDate(),
            endedAt: now.toDate(),
          });
          continue;
        }

        const nextTierProduct = productsByTier.get(nextTier);
        if (!nextTierProduct || !nextTierProduct.prices.length) {
          console.log(`User ${membership.userId}: Could not find product for tier ${nextTier}`);
          continue;
        }

        const newPeriodStart = now;
        const newPeriodEnd = newPeriodStart
          .add(nextMonths, 'month')
          .add(nextProratedDays, 'day');

        // Clear prorated days for this tier since we're using them
        const updatedProratedDays = { ...proratedDays };
        delete updatedProratedDays[nextTier as keyof typeof updatedProratedDays];

        // Persist the tokens array (migrates legacy prepaids to new format on transition)
        const updatedMeta = {
          ...subscriptionMeta,
          tokens: allTokens, // Write full token array so future runs use new format
          proratedDays: updatedProratedDays,
        };

        membershipUpdates.push({
          id: membership.id,
          productId: nextTierProduct.id,
          priceId: nextTierProduct.prices[0].id,
          currentPeriodStart: newPeriodStart.toDate(),
          currentPeriodEnd: newPeriodEnd.toDate(),
          metadata: updatedMeta,
        });

        console.log(
          `User ${membership.userId}: Transitioned from ${currentTier} to ${nextTier} tier. ` +
            `New period ends: ${newPeriodEnd.format('YYYY-MM-DD')}.`
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

export const cancelExpiredPrepaidMemberships = createJob(
  'cancel-expired-prepaid-memberships',
  '0 2 * * *', // Run daily at 2:00 AM
  async () => {
    const { getPrepaidTokens } = await import('~/server/utils/subscription.utils');
    const now = dayjs();

    // Find all active Civitai memberships where currentPeriodEnd has passed.
    // Exclude referral-granted subs — those are owned by advanceReferralSubscriptions.
    const expiredMemberships = await dbWrite.customerSubscription.findMany({
      where: {
        status: { in: ['active', 'expired_claimable'] },
        currentPeriodEnd: {
          lt: now.toDate(),
        },
        buzzType: { not: 'referral' },
        product: {
          provider: 'Civitai',
        },
      },
      select: {
        id: true,
        userId: true,
        status: true,
        metadata: true,
        currentPeriodEnd: true,
      },
    });

    if (!expiredMemberships.length) {
      console.log('No expired prepaid memberships to process');
      return;
    }

    // Split into two groups:
    // 1. Has unclaimed tokens (locked or unlocked) → set to 'expired_claimable'
    //    Also unlock all locked tokens since the unlock job won't run for non-active subs.
    // 2. No unclaimed tokens → fully cancel
    const toExpireClaimable: Array<{ id: string; userId: number; metadata: SubscriptionMetadata }> = [];
    const toCancel: string[] = [];
    const allUserIds: number[] = [];

    for (const m of expiredMemberships) {
      const meta = (m.metadata ?? {}) as SubscriptionMetadata;
      const tokens = getPrepaidTokens({ metadata: meta });
      const hasUnclaimedTokens = tokens.some(
        (t) => t.status === 'locked' || t.status === 'unlocked'
      );

      if (hasUnclaimedTokens) {
        // Only transition active → expired_claimable (don't re-process ones already in that state)
        if (m.status !== 'expired_claimable') {
          // Unlock all locked tokens so the user can claim them — the unlock job
          // won't run for non-active subscriptions, so we must do it here.
          const nowIso = now.toISOString();
          const updatedTokens = tokens.map((t) => {
            if (t.status === 'locked') {
              return { ...t, status: 'unlocked' as const, unlockedAt: nowIso };
            }
            return t;
          });

          toExpireClaimable.push({
            id: m.id,
            userId: m.userId,
            metadata: { ...meta, tokens: updatedTokens },
          });
          allUserIds.push(m.userId);
        }
      } else {
        toCancel.push(m.id);
        allUserIds.push(m.userId);
      }
    }

    // Set expired_claimable and unlock all locked tokens for each membership
    for (const m of toExpireClaimable) {
      await dbWrite.customerSubscription.update({
        where: { id: m.id },
        data: {
          status: 'expired_claimable',
          metadata: m.metadata as any,
          updatedAt: now.toDate(),
        },
      });
    }
    if (toExpireClaimable.length > 0) {
      console.log(
        `Set ${toExpireClaimable.length} memberships to expired_claimable (all locked tokens unlocked)`
      );
    }

    // Fully cancel memberships with no unclaimed tokens
    if (toCancel.length > 0) {
      console.log(`Canceling ${toCancel.length} expired prepaid memberships`);
      await dbWrite.customerSubscription.updateMany({
        where: { id: { in: toCancel } },
        data: {
          status: 'canceled',
          canceledAt: now.toDate(),
          endedAt: now.toDate(),
          updatedAt: now.toDate(),
        },
      });
    }

    // Invalidate sessions for all affected users
    const uniqueUserIds = [...new Set(allUserIds)];
    if (uniqueUserIds.length > 0) {
      console.log(`Invalidating sessions for ${uniqueUserIds.length} users`);
      await Promise.all(uniqueUserIds.map((userId) => refreshSession(userId)));
    }

    console.log(
      `Processed ${expiredMemberships.length} expired memberships: ` +
        `${toExpireClaimable.length} set to expired_claimable, ${toCancel.length} canceled`
    );
  }
);

export const prepaidMembershipJobs = [
  unlockPrepaidTokens,
  processPrepaidMembershipTransitions,
  cancelExpiredPrepaidMemberships,
];
