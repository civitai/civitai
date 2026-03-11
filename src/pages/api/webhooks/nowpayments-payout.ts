import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { trackWebhookEvent } from '~/server/clickhouse/client';
import client from '~/server/http/nowpayments/nowpayments.caller';
import { logToAxiom } from '~/server/logging/client';

export const config = {
  api: {
    bodyParser: true,
  },
};

const log = (data: MixedObject) => {
  logToAxiom({ name: 'nowpayments-payout-webhook', type: 'info', ...data }).catch();
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  const sig = req.headers['x-nowpayments-sig'];
  const webhookSecret = env.NOW_PAYMENTS_IPN_KEY;

  // Track to ClickHouse (fire and forget)
  trackWebhookEvent('nowpayments-payout', JSON.stringify(req.body)).catch(() => {});

  try {
    if (!sig || !webhookSecret) {
      await logToAxiom({
        name: 'nowpayments-payout-webhook',
        type: 'error',
        message: 'Invalid request: Missing signature or secret',
      });
      return res.status(400).send({
        error: 'Invalid Request. Signature or Secret not found',
      });
    }

    const { isValid } = client.validateWebhookEvent(sig as string, req.body);
    if (!isValid) {
      await logToAxiom({
        name: 'nowpayments-payout-webhook',
        type: 'error',
        message: 'Invalid signature',
      });
      return res.status(400).send({
        error: 'Invalid Request. Could not validate Webhook signature',
      });
    }

    // Log the payout status update
    await log({
      message: 'Payout status update',
      payload: req.body,
    });
  } catch (error: any) {
    await logToAxiom({
      name: 'nowpayments-payout-webhook',
      type: 'error',
      message: `Webhook error: ${error.message}`,
      error: error.stack,
    });
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  return res.status(200).json({ received: true });
}
