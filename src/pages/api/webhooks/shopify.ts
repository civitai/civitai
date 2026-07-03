import crypto from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Readable } from 'node:stream';
import { env } from '~/env/server';
import { trackWebhookEvent } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { processShopifyOrderPaid, shopifyOrderPaidSchema } from '~/server/services/merch.service';

// Shopify HMAC is computed over the raw request body — disable Next's parser.
export const config = {
  api: {
    bodyParser: false,
  },
};

const log = (data: MixedObject) =>
  logToAxiom({ name: 'shopify-webhook', type: 'error', ...data }).catch(() => null);

async function buffer(readable: Readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function isValidHmac(rawBody: Buffer, hmacHeader: string, secret: string) {
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false; // length mismatch
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  instrumentApiResponse(req, res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  const secret = env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    log({ message: 'SHOPIFY_WEBHOOK_SECRET not configured' });
    return res.status(503).send('Shopify webhook not configured');
  }

  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const topic = (req.headers['x-shopify-topic'] as string) ?? '';

  let rawBody: Buffer;
  try {
    rawBody = await buffer(req);
  } catch (error: any) {
    log({ message: `Failed to read body: ${error.message}` });
    return res.status(400).send('Bad Request');
  }

  if (typeof hmacHeader !== 'string' || !isValidHmac(rawBody, hmacHeader, secret)) {
    log({ message: 'Invalid HMAC', topic });
    return res.status(401).send('Unauthorized');
  }

  trackWebhookEvent('shopify', rawBody.toString('utf8')).catch(() => null);

  try {
    // We only act on paid orders; ack everything else so Shopify stops retrying.
    if (topic !== 'orders/paid') return res.status(200).json({ ignored: topic });

    const order = shopifyOrderPaidSchema.parse(JSON.parse(rawBody.toString('utf8')));
    const result = await processShopifyOrderPaid(order);
    return res.status(200).json({ received: true, ...result });
  } catch (error: any) {
    log({ message: `Webhook error: ${error.message}`, error: error.stack, topic });
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }
}
