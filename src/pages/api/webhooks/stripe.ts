import {
  manageCheckoutPayment,
  manageInvoicePaid,
  toDateTime,
  upsertPriceRecord,
  upsertProductRecord,
  upsertSubscription,
} from '~/server/services/stripe.service';
import { NextApiRequest, NextApiResponse } from 'next';
import { getServerStripe } from '~/server/utils/get-server-stripe';
import { env } from '~/env/server.mjs';
import Stripe from 'stripe';
// import { buffer } from 'micro';
import { Readable } from 'node:stream';

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
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.deleted',
  'customer.subscription.updated',
  'price.created',
  'price.deleted',
  'price.updated',
  'product.created',
  'product.deleted',
  'product.updated',
  'invoice.paid',
]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    const stripe = await getServerStripe();

    const buf = await buffer(req);
    const sig = req.headers['stripe-signature'];
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
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
          case 'invoice.paid':
            const invoice = event.data.object as Stripe.Invoice;
            await manageInvoicePaid(invoice);
            break;
          case 'product.created':
          case 'product.updated':
          case 'product.deleted':
            await upsertProductRecord(event.data.object as Stripe.Product);
            break;
          case 'price.created':
          case 'price.updated':
          case 'price.deleted':
            await upsertPriceRecord(event.data.object as Stripe.Price);
            break;
          case 'customer.subscription.created':
          case 'customer.subscription.updated':
          case 'customer.subscription.deleted':
            const subscription = event.data.object as Stripe.Subscription;
            await upsertSubscription(
              subscription,
              subscription.customer as string,
              toDateTime(event.created)
            );
            break;
          case 'checkout.session.completed':
            const checkoutSession = event.data.object as Stripe.Checkout.Session;
            if (checkoutSession.mode === 'subscription') {
              // do nothing
            } else if (checkoutSession.mode === 'payment') {
              await manageCheckoutPayment(checkoutSession.id, checkoutSession.customer as string);
            }
            break;
          default:
            throw new Error('Unhandled relevant event!');
        }
      } catch (error: any) {
        return res.status(400).send('Webhook error: "Webhook handler failed. View logs."');
      }
    }

    res.json({ received: true });
  } else {
    res.setHeader('Allow', 'POST');
    res.status(405).end('Method Not Allowed');
  }
}
