import * as z from 'zod';
import dayjs from '~/shared/utils/dayjs';
import { dbWrite } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type {
  SubscriptionMetadata,
  SubscriptionProductMetadata,
} from '~/server/schema/subscriptions.schema';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

const schema = z.object({
  userIds: commaDelimitedNumberArray(),
  date: z.string().optional(), // Format: YYYY-MM, defaults to current month
});

type DeliveryResult = {
  userId: number;
  subscriptionId: string;
  status: 'success' | 'error' | 'skipped';
  tier?: string;
  buzzAmount?: number;
  externalTransactionId?: string;
  prepaidsRemaining?: number;
  error?: string;
};

export default WebhookEndpoint(async (req, res) => {
  try {
    const { userIds: targetUserIds, date: dateOverride } = schema.parse(req.query);

    if (targetUserIds.length === 0) {
      return res.status(400).json({ error: 'userIds is required' });
    }

    // Use provided date or current month
    const date = dateOverride || dayjs().format('YYYY-MM');

    // Find all subscriptions for the given user IDs
    const subscriptions = await dbWrite.customerSubscription.findMany({
      where: {
        userId: { in: targetUserIds },
        buzzType: 'yellow',
        status: 'active',
        product: {
          provider: 'Civitai',
        },
      },
      include: {
        product: {
          select: {
            id: true,
            metadata: true,
            provider: true,
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

    // Create a map for quick lookup
    const subscriptionsByUserId = new Map(subscriptions.map((s) => [s.userId, s]));

    const results: DeliveryResult[] = [];

    for (const targetUserId of targetUserIds) {
      const subscription = subscriptionsByUserId.get(targetUserId);

      if (!subscription) {
        results.push({
          userId: targetUserId,
          subscriptionId: '',
          status: 'error',
          error: 'No active Civitai subscription found',
        });
        continue;
      }

      if (subscription.currentPeriodEnd <= new Date()) {
        results.push({
          userId: targetUserId,
          subscriptionId: subscription.id,
          status: 'error',
          error: 'Subscription has expired',
        });
        continue;
      }

      const productMetadata = subscription.product.metadata as SubscriptionProductMetadata;
      const subscriptionMetadata = (subscription.metadata as SubscriptionMetadata) || {};
      const tier = productMetadata.tier;
      const monthlyBuzz = Number(productMetadata.monthlyBuzz ?? 5000);
      const buzzType = productMetadata.buzzType ?? 'yellow';

      if (!tier) {
        results.push({
          userId: targetUserId,
          subscriptionId: subscription.id,
          status: 'error',
          error: 'Subscription product has no tier defined',
        });
        continue;
      }

      const currentPrepaids = subscriptionMetadata.prepaids?.[tier] ?? 0;

      // Check if user has prepaids remaining
      if (currentPrepaids <= 0) {
        results.push({
          userId: targetUserId,
          subscriptionId: subscription.id,
          status: 'skipped',
          error: 'No prepaids remaining',
        });
        continue;
      }

      const externalTransactionId = `civitai-membership:${date}:${subscription.userId}:${subscription.product.id}:v3`;

      // Check if this bonus was already delivered
      const existingTransactionIds = subscriptionMetadata.buzzTransactionIds ?? [];
      if (existingTransactionIds.includes(externalTransactionId)) {
        results.push({
          userId: targetUserId,
          subscriptionId: subscription.id,
          status: 'skipped',
          externalTransactionId,
          error: 'Bonus for this period was already delivered',
        });
        continue;
      }

      try {
        // Deliver the buzz
        await createBuzzTransaction({
          fromAccountId: 0,
          toAccountId: subscription.userId,
          toAccountType: buzzType as any,
          type: TransactionType.Purchase,
          externalTransactionId,
          amount: monthlyBuzz,
          description: 'Membership Bonus',
          details: {
            type: 'civitai-membership-payment',
            date,
            productId: subscription.product.id,
            interval: subscription.price.interval,
            tier,
            subscriptionId: subscription.id,
            manualDelivery: true,
          },
        });

        // Update subscription metadata: decrement prepaids (if > 0) and record transaction
        const newPrepaids = Math.max(0, currentPrepaids - 1);
        const updatedMetadata = {
          ...subscriptionMetadata,
          prepaids: {
            ...subscriptionMetadata.prepaids,
            [tier]: newPrepaids,
          },
          buzzTransactionIds: [...existingTransactionIds, externalTransactionId],
        };

        await dbWrite.customerSubscription.update({
          where: { id: subscription.id },
          data: {
            metadata: updatedMetadata as any,
            updatedAt: new Date(),
          },
        });

        results.push({
          userId: targetUserId,
          subscriptionId: subscription.id,
          status: 'success',
          tier,
          buzzAmount: monthlyBuzz,
          externalTransactionId,
          prepaidsRemaining: newPrepaids,
        });
      } catch (err) {
        results.push({
          userId: targetUserId,
          subscriptionId: subscription.id,
          status: 'error',
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const successful = results.filter((r) => r.status === 'success');
    const skipped = results.filter((r) => r.status === 'skipped');
    const failed = results.filter((r) => r.status === 'error');

    return res.status(200).json({
      message: `Processed ${targetUserIds.length} users`,
      date,
      summary: {
        total: targetUserIds.length,
        successful: successful.length,
        skipped: skipped.length,
        failed: failed.length,
      },
      results,
    });
  } catch (error) {
    console.error('Error delivering prepaid buzz:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});
