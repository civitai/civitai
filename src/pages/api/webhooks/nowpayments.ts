import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { trackWebhookEvent } from '~/server/clickhouse/client';
import client from '~/server/http/nowpayments/nowpayments.caller';
import { NOWPayments } from '~/server/http/nowpayments/nowpayments.schema';
import { logToAxiom } from '~/server/logging/client';
import { processBuzzOrder } from '~/server/services/nowpayments.service';

export const config = {
  api: {
    bodyParser: true,
  },
};

// Since these are stripe connect related, makes sense to log for issues for visibility.
const log = (data: MixedObject) => {
  logToAxiom({ name: 'nowpayments-webhook', type: 'error', ...data }).catch();
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    const sig = req.headers['x-nowpayments-sig'];
    const webhookSecret = env.NOW_PAYMENTS_IPN_KEY;

    // Track to ClickHouse (fire and forget, never throws)
    trackWebhookEvent('nowpayments', JSON.stringify(req.body)).catch(() => {});

    try {
      if (!sig || !webhookSecret) {
        await log({
          message: 'Invalid request: Missing signature or secret',
        });
        // only way this is false is if we forgot to include our secret or paddle decides to suddenly not include their signature
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
          webhookSecret,
          data,
        });
        console.log('❌ Invalid signature');
        return res.status(400).send({
          error: 'Invalid Request. Could not validate Webhook signature',
          data,
        });
      }

      const event = NOWPayments.webhookSchema.parse(req.body);

      switch (event.payment_status) {
        case 'finished':
        case 'partially_paid':
        default: // temporary as we test
          await processBuzzOrder(
            event.payment_id as string | number,
            event.payment_status as string
          );
          break;
        // throw new Error('Unhandled relevant event!');
      }
    } catch (error: any) {
      console.log(`❌ Error message: ${error.message}`);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    return res.status(200).json({ received: true });
  } else {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }
}
