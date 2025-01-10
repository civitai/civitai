import { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { Readable } from 'node:stream';
import { getPaddle } from '~/server/paddle/client';
import {
  EventEntity,
  EventName,
  Transaction,
  TransactionCompletedEvent,
  ProductNotification,
  ProductCreatedEvent,
  PriceCreatedEvent,
  SubscriptionActivatedEvent,
  SubscriptionNotification,
  TransactionNotification,
} from '@paddle/paddle-node-sdk';
import { TransactionMetadataSchema } from '~/server/schema/paddle.schema';
import {
  getBuzzPurchaseItem,
  manageSubscriptionTransactionComplete,
  processCompleteBuzzTransaction,
  upsertPriceRecord,
  upsertProductRecord,
  upsertSubscription,
} from '~/server/services/paddle.service';
import { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { paddleTransactionContainsSubscriptionItem } from '~/server/services/subscriptions.service';
import { isDev } from '~/env/other';

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

const relevantEvents = new Set([
  EventName.TransactionCompleted,
  EventName.ProductCreated,
  EventName.ProductUpdated,
  EventName.PriceCreated,
  EventName.PriceUpdated,
  // Let's try these main ones:
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
    let event: EventEntity | null;
    try {
      if (!sig || !webhookSecret) {
        // only way this is false is if we forgot to include our secret or paddle decides to suddenly not include their signature
        return res.status(400).send({
          error: 'Invalid Request',
        });
      }

      event = paddle.webhooks.unmarshal(buf.toString(), webhookSecret, sig as string);
      if (!event) {
        throw new Error('Invalid Request');
      }
    } catch (error: any) {
      console.log(`❌ Error message: ${error.message}`);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    if (relevantEvents.has(event.eventType)) {
      try {
        switch (event.eventType) {
          case EventName.TransactionCompleted:
            const data = (event as TransactionCompletedEvent).data;
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
              await manageSubscriptionTransactionComplete(event.data as TransactionNotification, {
                notificationId: event.eventId,
              });
            } else if (buzzPurchaseItem || data.origin === 'subscription_charge') {
              await processCompleteBuzzTransaction(event.data as Transaction, {
                notificationId: event.eventId,
              });
            }

            break;
          case EventName.ProductCreated:
          case EventName.ProductUpdated: {
            const data = (event as ProductCreatedEvent).data;
            const meta = data.customData as SubscriptionProductMetadata;
            if (!meta?.tier) {
              break;
            }

            await upsertProductRecord(data);
            break;
          }
          case EventName.PriceCreated:
          case EventName.PriceUpdated: {
            const data = (event as PriceCreatedEvent).data;
            await upsertPriceRecord(data);
            break;
          }
          case EventName.SubscriptionActivated:
          case EventName.SubscriptionUpdated:
          case EventName.SubscriptionCanceled: {
            const data = event.data;
            upsertSubscription(
              data as SubscriptionNotification,
              new Date(event.occurredAt),
              event.eventType
            );
            break;
          }
          default:
            throw new Error('Unhandled relevant event!');
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
