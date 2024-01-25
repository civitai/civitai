import { NextApiRequest, NextApiResponse } from 'next';
import { getServerStripe } from '~/server/utils/get-server-stripe';
import { env } from '~/env/server.mjs';
import Stripe from 'stripe';
// import { buffer } from 'micro';
import { Readable } from 'node:stream';
import { updateByStripeConnectAccount } from '../../../server/services/user-stripe-connect.service';

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

const relevantEvents = new Set(['account.updated', 'transfer.created']);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    const stripe = await getServerStripe();

    const buf = await buffer(req);
    console.log(req.headers, req.env);
    const sig = req.headers['stripe-signature'];
    const webhookSecret = env.STRIPE_CONNECT_WEBHOOK_SECRET;
    let event: Stripe.Event;

    try {
      if (!sig || !webhookSecret) return; // only way this is false is if we forgot to include our secret or stripe decides to suddenly not include their signature
      event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
    } catch (error: any) {
      console.log(`❌ Error message: ${error.message}`);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    if (relevantEvents.has(event.type)) {
      try {
        switch (event.type) {
          case 'account.updated':
            const data = event.data.object as Stripe.Account;
            await updateByStripeConnectAccount({ stripeAccount: data });
            break;
          case 'transfer.created':
            // TODO: Close transfer request.
            console.log('transfer created');
            break;
          default:
            throw new Error('Unhandled relevant event!');
        }
      } catch (error: any) {
        return res.status(400).send({
          error: error.message,
        });
      }
    }

    res.json({ received: true });
  } else {
    res.setHeader('Allow', 'POST');
    res.status(405).end('Method Not Allowed');
  }
}
