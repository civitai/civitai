import type { NextApiRequest, NextApiResponse } from 'next';
import type { Readable } from 'node:stream';
import { env } from '~/env/server';
import { EmerchantPayCaller } from '~/server/http/emerchantpay/emerchantpay.caller';
import { logToAxiom } from '~/server/logging/client';
import { processBuzzOrder } from '~/server/services/emerchantpay.service';

export const config = {
  api: {
    bodyParser: false,
  },
};

const log = async (data: MixedObject) => {
  try {
    await logToAxiom({ name: 'emerchantpay-webhook', type: 'error', ...data }, 'webhooks');
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

  // Get signature from headers (EmerchantPay typically uses a different header)
  const sig = req.headers['x-signature'] || req.headers['signature'];
  const webhookSecret = env.EMERCHANTPAY_WEBHOOK_SECRET;
  const buf = await buffer(req);

  try {
    if (!sig || !webhookSecret) {
      return res.status(400).send({
        error: 'Invalid Request. Signature or Secret not found',
        sig,
      });
    }

    const isValid = EmerchantPayCaller.verifyWebhookSignature(sig as string, buf, webhookSecret);

    if (!isValid) {
      return res.status(400).send({
        error: 'Invalid signature',
        sig,
      });
    }

    // Parse the XML body
    const xmlPayload = buf.toString('utf8');
    const notification = await EmerchantPayCaller.parseWebhookNotification(xmlPayload);

    // Process based on notification type
    if (notification.payment_transaction?.status === 'approved') {
      // Handle approved payment -> Grant buzz
      await processBuzzOrder(notification);
    } else {
      await log({
        message: 'Notification received but payment not approved',
        status: notification.payment_transaction?.status,
        notificationData: notification,
      });
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.log(`❌ Error message: ${errorMessage}`);
    return res.status(400).send(`Webhook Error: ${errorMessage}`);
  }

  return res.status(200).json({ received: true });
}
