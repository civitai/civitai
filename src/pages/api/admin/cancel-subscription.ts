import type { AxiomAPIRequest } from '@civitai/next-axiom';
import type { NextApiResponse } from 'next';
import * as z from 'zod';
import dayjs from '~/shared/utils/dayjs';
import { dbWrite } from '~/server/db/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { PaymentProvider } from '~/shared/utils/prisma/enums';
import { refreshSession } from '~/server/auth/session-invalidation';
import type { SubscriptionMetadata } from '~/server/schema/subscriptions.schema';

const cancelSubscriptionSchema = z.object({
  userId: z.coerce.number(),
  immediate: z.boolean().default(false),
  reason: z.string().optional(),
});

export default WebhookEndpoint(async function (req: AxiomAPIRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed. Use POST.');

  try {
    const input = cancelSubscriptionSchema.parse(req.body);
    const { userId, immediate, reason } = input;

    // Find active Civitai subscription for the user
    const subscription = await dbWrite.customerSubscription.findFirst({
      where: {
        userId,
        product: {
          provider: PaymentProvider.Civitai,
        },
      },
      include: {
        product: {
          select: { metadata: true, provider: true },
        },
      },
    });

    // Validate subscription exists
    if (!subscription) {
      return res.status(404).json({
        error: 'User has no Civitai subscription',
      });
    }

    // Check if already canceled
    if (subscription.status === 'canceled') {
      return res.status(400).json({
        error: 'Subscription is already canceled',
        subscription: {
          id: subscription.id,
          userId: subscription.userId,
          status: subscription.status,
          canceledAt: subscription.canceledAt,
          endedAt: subscription.endedAt,
        },
      });
    }

    const now = dayjs();
    const cancellationReason = reason || 'Cancelled by moderator';

    if (immediate) {
      // Immediate cancellation - end subscription now
      const updated = await dbWrite.customerSubscription.update({
        where: { id: subscription.id },
        data: {
          status: 'canceled',
          canceledAt: now.toDate(),
          endedAt: now.toDate(),
          cancelAt: null,
          cancelAtPeriodEnd: false,
          metadata: {
            ...(subscription.metadata as object),
            cancellationReason,
          },
          updatedAt: now.toDate(),
        },
      });

      // Invalidate user session to reflect subscription change
      await refreshSession(userId);

      return res.status(200).json({
        message: 'Subscription canceled immediately',
        subscription: {
          id: updated.id,
          userId: updated.userId,
          status: updated.status,
          canceledAt: updated.canceledAt,
          endedAt: updated.endedAt,
        },
      });
    } else {
      // Period-end cancellation - subscription remains active until currentPeriodEnd
      const updated = await dbWrite.customerSubscription.update({
        where: { id: subscription.id },
        data: {
          cancelAtPeriodEnd: true,
          cancelAt: subscription.currentPeriodEnd,
          metadata: {
            ...(subscription.metadata as SubscriptionMetadata),
            cancellationReason,
          },
          updatedAt: now.toDate(),
        },
      });

      // Invalidate user session to reflect subscription change
      await refreshSession(userId);

      return res.status(200).json({
        message: 'Subscription will cancel at period end',
        subscription: {
          id: updated.id,
          userId: updated.userId,
          status: updated.status,
          cancelAtPeriodEnd: updated.cancelAtPeriodEnd,
          cancelAt: updated.cancelAt,
          currentPeriodEnd: updated.currentPeriodEnd,
        },
      });
    }
  } catch (error) {
    console.error('Error canceling subscription:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});
