import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { trackWebhookEvent } from '~/server/clickhouse/client';
import client from '~/server/http/nowpayments/nowpayments.caller';
import { NOWPayments } from '~/server/http/nowpayments/nowpayments.schema';
import { logToAxiom } from '~/server/logging/client';
import { processDeposit } from '~/server/services/nowpayments.service';

export const config = {
  api: {
    bodyParser: true,
  },
};

const log = (data: MixedObject) => {
  logToAxiom({ name: 'nowpayments-webhook', type: 'error', ...data }).catch();
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  const sig = req.headers['x-nowpayments-sig'];
  const webhookSecret = env.NOW_PAYMENTS_IPN_KEY;

  // Track to ClickHouse (fire and forget, never throws)
  trackWebhookEvent('nowpayments', JSON.stringify(req.body)).catch(() => {});

  try {
    if (!sig || !webhookSecret) {
      await log({
        message: 'Invalid request: Missing signature or secret',
      });
      return res.status(400).send({
        error: 'Invalid Request. Signature or Secret not found',
        sig,
      });
    }

    const { isValid, ...data } = client.validateWebhookEvent(sig as string, req.body);
    if (!isValid) {
      await log({
        message: 'Invalid signature',
        sig,
        data,
      });
      return res.status(400).send({
        error: 'Invalid Request. Could not validate Webhook signature',
        data,
      });
    }

    const event = NOWPayments.webhookSchema.parse(req.body);
    const paymentStatus = event.payment_status;

    if (!paymentStatus || !event.payment_id) {
      await log({
        message: 'Webhook missing payment_status or payment_id',
        event,
      });
      return res.status(400).send({ error: 'Missing payment_status or payment_id' });
    }

    // Process actionable statuses (partially_paid treated like finished for buzz grant)
    if (['confirming', 'finished', 'partially_paid'].includes(paymentStatus)) {
      await processDeposit(event.payment_id, paymentStatus, event);
    }
  } catch (error: any) {
    await log({
      message: `Webhook error: ${error.message}`,
      error: error.stack,
    });
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  return res.status(200).json({ received: true });
}
