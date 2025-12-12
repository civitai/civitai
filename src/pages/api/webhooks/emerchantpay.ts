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

  const buf = await buffer(req);

  try {
    // Parse the form-encoded body first to get signature and unique_id
    const formPayload = buf.toString('utf8');
    const notification = EmerchantPayCaller.parseWebhookNotification(formPayload);

    // Verify signature using EmerchantPay's method: SHA Hash of <unique_id><API password>
    const apiPassword = env.EMERCHANTPAY_PASSWORD;
    if (!apiPassword) {
      return res.status(400).send({
        error: 'Missing API password for signature verification',
      });
    }

    const isValid = EmerchantPayCaller.verifyWebhookSignature(notification, apiPassword);

    if (!isValid) {
      await log({
        message: 'Invalid webhook signature',
        expected_computation: 'SHA-512(unique_id + api_password) for WPF notifications',
        notification_type: notification.notification_type,
        unique_id: notification.unique_id,
        received_signature: notification.signature,
      });

      return res.status(400).send({
        error: 'Invalid signature',
      });
    }

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
