import type { NextApiRequest, NextApiResponse } from 'next';
import type { Readable } from 'node:stream';
import { env } from '~/env/server';
import { trackWebhookEvent } from '~/server/clickhouse/client';
import { CoinbaseCaller } from '~/server/http/coinbase/coinbase.caller';
import type { Coinbase } from '~/server/http/coinbase/coinbase.schema';
import { logToAxiom } from '~/server/logging/client';
import { processBuzzOrder } from '~/server/services/coinbase.service';

export const config = {
  api: {
    bodyParser: false,
  },
};

const log = async (data: MixedObject) => {
  try {
    await logToAxiom({ name: 'coinbase-webhook', type: 'error', ...data }, 'webhooks');
  } catch (error) {
    console.error('Failed to log to Axiom:', error);
  }
};

async function buffer(readable: Readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  const sig =
    req.headers['x-cc-webhook-signature'] ||
    req.headers['X-CC-Webhook-Signature'] ||
    req.headers['x-cc-webhook-signature'.toLowerCase()];
  const webhookSecret = env.COINBASE_WEBHOOK_SECRET;
  const buf = await buffer(req);
  const rawPayload = buf.toString('utf8');

  // Track to ClickHouse (fire and forget, never throws)
  trackWebhookEvent('coinbase', rawPayload).catch(() => {});

  try {
    if (!sig || !webhookSecret) {
      return res.status(400).send({
        error: 'Invalid Request. Signature or Secret not found',
        sig,
      });
    }

    const isValid = CoinbaseCaller.verifyWebhookSignature(sig as string, buf, webhookSecret);

    if (!isValid) {
      return res.status(400).send({
        error: 'Invalid signature',
        sig,
      });
    }

    // Parse the JSON body
    const { event } = JSON.parse(rawPayload) as Coinbase.WebhookEventSchema;

    switch (event.type) {
      case 'charge:confirmed':
        // handle confirmed charge -> Grant buzz
        await processBuzzOrder(event.data);
        break;
      default: {
        if (event.type !== 'charge:created')
          await log({
            message: 'Unhandled event type',
            eventType: event.type,
            eventData: event.data,
          });
      }
    }
  } catch (error: any) {
    console.log(`❌ Error message: ${error.message}`);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  return res.status(200).json({ received: true });
}
