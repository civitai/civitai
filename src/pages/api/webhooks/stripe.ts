import { manageSubscriptionStatusChange } from '~/server/services/stripe.service';
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
  // 'product.created',
  // 'product.updated',
  // 'price.created',
  // 'price.updated',
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    const stripe = await getServerStripe();

    // console.log('----------------');
    // console.log({ req });
    // console.log('----------------');

    try {
      const buf = await buffer(req);
      const sig = req.headers['stripe-signature'];
      const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
      let event: Stripe.Event;

      try {
        if (!sig || !webhookSecret) {
          console.log('----------------');
          console.log('!sig || !webhookSecret');
          console.log('----------------');
          return;
        }
        event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
      } catch (error: any) {
        console.log(`❌ Error message: ${error.message}`);
        return res.status(400).send(`Webhook Error: ${error.message}`);
      }

      if (relevantEvents.has(event.type)) {
        try {
          switch (event.type) {
            case 'customer.subscription.created':
            case 'customer.subscription.updated':
            case 'customer.subscription.deleted':
              console.log('----------------');
              console.log({ type: event.type });
              console.log('----------------');
              const subscription = event.data.object as Stripe.Subscription;
              await manageSubscriptionStatusChange(
                subscription.id,
                subscription.customer as string
              );
              break;
            case 'checkout.session.completed':
              const checkoutSession = event.data.object as Stripe.Checkout.Session;
              if (checkoutSession.mode === 'subscription') {
                console.log('----------------');
                console.log({ type: event.type });
                console.log('----------------');
                const subscriptionId = checkoutSession.subscription;
                await manageSubscriptionStatusChange(
                  subscriptionId as string,
                  checkoutSession.customer as string
                );
              }
              break;
            default:
              throw new Error('Unhandled relevant event!');
          }
        } catch (error: any) {
          console.log(error);
          return res.status(400).send('Webhook error: "Webhook handler failed. View logs."');
        }
      }
    } catch (error: any) {
      console.log(`❌ Error message: ${error.message}`);
    }

    res.json({ received: true });
  } else {
    res.setHeader('Allow', 'POST');
    res.status(405).end('Method Not Allowed');
  }
}
