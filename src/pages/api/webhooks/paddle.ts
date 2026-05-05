import type { EventEntity } from '@paddle/paddle-node-sdk';
import { EventName } from '@paddle/paddle-node-sdk';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Readable } from 'node:stream';
import { env } from '~/env/server';
import { trackWebhookEvent } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { getPaddle } from '~/server/paddle/client';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { getUserCapCache } from '~/server/services/creator-program.service';
import {
  getBuzzPurchaseItem,
  manageSubscriptionTransactionComplete,
  processCompleteBuzzTransaction,
  upsertPriceRecord,
  upsertProductRecord,
  upsertSubscription,
} from '~/server/services/paddle.service';
import {
  paddleTransactionContainsSubscriptionItem,
  syncFreshdeskMembership,
} from '~/server/services/subscriptions.service';

// Stripe requires the raw body to construct the event.
export const config = {
  api: {
    bodyParser: false,
  },
};

async function buffer(readable: Readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Paddle is a legacy/deprecated payment provider as of 2026-04. We keep this
// webhook live to continue servicing existing annual subscriptions, but no new
// signups flow through Paddle and the Referral Program (v2) does not attribute
// rewards to Paddle events. If you are wiring new functionality, use Stripe
// instead. See src/pages/api/webhooks/stripe.ts for the primary flow.
const relevantEvents = new Set([
  EventName.TransactionCompleted,
  EventName.ProductCreated,
  EventName.ProductUpdated,
  EventName.PriceCreated,
  EventName.PriceUpdated,
  EventName.SubscriptionActivated,
  EventName.SubscriptionUpdated,
  EventName.SubscriptionCanceled,
]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    const paddle = getPaddle();
    const sig = req.headers['paddle-signature'];
    const webhookSecret = env.PADDLE_WEBHOOK_SECRET;
    const buf = await buffer(req);
    const rawPayload = buf.toString();
    let event: EventEntity | null;

    // Track to ClickHouse (fire and forget, never throws)
    trackWebhookEvent('paddle', rawPayload).catch(() => null);

    try {
      if (!sig || !webhookSecret) {
        // only way this is false is if we forgot to include our secret or paddle decides to suddenly not include their signature
        return res.status(400).send({
          error: 'Invalid Request',
        });
      }

      event = paddle.webhooks.unmarshal(rawPayload, webhookSecret, sig as string);
      if (!event) {
        throw new Error('Invalid Request');
      }
    } catch (error: any) {
      console.log(`❌ Error message: ${error.message}`);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    let customerId: string | null = null;
    let serviceTier: string | null = null;

    if (relevantEvents.has(event.eventType)) {
      try {
        switch (event.eventType) {
          case EventName.TransactionCompleted:
            const data = event.data;
            const buzzPurchaseItem = getBuzzPurchaseItem(data);
            const containsProductMemberships = await paddleTransactionContainsSubscriptionItem(
              data
            );

            if (!buzzPurchaseItem && !containsProductMemberships) {
              return res
                .status(200)
                .json({ received: true, message: 'No relevant items found to process' });
            }

            if (
              data.subscriptionId &&
              (['subscription_recurring', 'subscription_update'].includes(data.origin) ||
                containsProductMemberships)
            ) {
              await manageSubscriptionTransactionComplete(event.data, {
                notificationId: event.eventId,
              });
            } else if (buzzPurchaseItem || data.origin === 'subscription_charge') {
              await processCompleteBuzzTransaction(event.data, {
                notificationId: event.eventId,
              });
            }

            serviceTier = 'Buzz Purchaser';
            customerId = data.customerId;
            break;
          case EventName.ProductCreated:
          case EventName.ProductUpdated: {
            const data = event.data;
            const meta = data.customData as SubscriptionProductMetadata;
            if (!meta?.tier && !('one_time' in meta)) {
              break;
            }

            await upsertProductRecord(data);
            break;
          }
          case EventName.PriceCreated:
          case EventName.PriceUpdated: {
            const data = event.data;
            await upsertPriceRecord(data);
            break;
          }
          case EventName.SubscriptionActivated:
          case EventName.SubscriptionUpdated:
          case EventName.SubscriptionCanceled: {
            const data = event.data;
            await upsertSubscription(data, new Date(event.occurredAt), event.eventType);
            customerId = data.customerId;

            break;
          }
          default:
            throw new Error('Unhandled relevant event!');
        }

        if (customerId) {
          // This runs whenever there's a transaction or a subscription event.
          const user = await dbWrite.user.findFirst({
            where: { paddleCustomerId: customerId },
            select: {
              id: true,
              paddleCustomerId: true,
            },
          });

          if (user) {
            await syncFreshdeskMembership({ userId: user.id, fallbackTier: serviceTier });

            getUserCapCache()?.bust(user.id);
          }
        }

        return res.status(200).json({ received: true });
      } catch (error: any) {
        return res.status(400).send({
          error: error.message,
        });
      }
    }

    return res.status(200).json({ received: true });
  } else {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }
}
