import { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server.mjs';
import { Readable } from 'node:stream';
import { getPaddle } from '~/server/paddle/client';
import {
  EventEntity,
  EventName,
  Transaction,
  TransactionCompletedEvent,
} from '@paddle/paddle-node-sdk';
import { TransactionMetadataSchema } from '~/server/schema/paddle.schema';
import { processCompleteBuzzTransaction } from '~/server/services/paddle.service';

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
            if (!data.customData) {
              throw new Error('Invalid Request');
            }
            const customData = data.customData as TransactionMetadataSchema;

            if (customData.type === 'buzzPurchase') {
              await processCompleteBuzzTransaction(event.data as Transaction);
            }

            break;
          case EventName.ProductCreated:
          case EventName.ProductUpdated:
            break;
          default:
            throw new Error('Unhandled relevant event!');
        }

        return res.status(200);
      } catch (error: any) {
        return res.status(400).send({
          error: error.message,
        });
      }
    }

    return res.status(200);
  } else {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }
}
