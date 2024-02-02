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
import { PaymentIntentMetadataSchema } from '~/server/schema/stripe.schema';
import { completeStripeBuzzTransaction } from '~/server/services/buzz.service';
import { STRIPE_PROCESSING_AWAIT_TIME } from '~/server/common/constants';
import { completeClubMembershipCharge } from '~/server/services/clubMembership.service';
import { notifyAir } from '~/server/services/integration.service';
import { isDev } from '~/env/other';

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
  'payment_intent.succeeded',
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
              toDateTime(event.created),
              event.type
            );
            break;
          case 'checkout.session.completed':
            const checkoutSession = event.data.object as Stripe.Checkout.Session;
            if (checkoutSession.mode === 'subscription') {
              // do nothing
            } else if (checkoutSession.mode === 'payment') {
              // First, check if this payment is for Civitai AIR

              if (
                env.AIR_PAYMENT_LINK_ID &&
                checkoutSession.payment_link === env.AIR_PAYMENT_LINK_ID
              ) {
                // For AIR stuff...
                const email =
                  checkoutSession.customer_details?.email || checkoutSession.customer_email;
                const name = checkoutSession.customer_details?.name ?? 'Stripe Customer';

                if (!email || isDev) {
                  return;
                }

                await notifyAir({ email, name });
                return;
              }

              await manageCheckoutPayment(checkoutSession.id, checkoutSession.customer as string);
            }
            break;
          case 'payment_intent.succeeded':
            const paymentIntent = event.data.object as Stripe.PaymentIntent;
            const metadata = paymentIntent.metadata as PaymentIntentMetadataSchema;

            // Wait the processing time on the FE to avoid racing conditions and granting double buzz.

            if (metadata.type === 'buzzPurchase') {
              await completeStripeBuzzTransaction({
                amount: metadata.buzzAmount,
                stripePaymentIntentId: paymentIntent.id,
                details: metadata,
                userId: metadata.userId,
              });
            }

            if (metadata.type === 'clubMembershipPayment') {
              // First, grant the user their buzz. We need this to keep a realisitc
              // transaction history. We purchase buzz from Civit,then we pay the club.
              await completeStripeBuzzTransaction({
                amount: metadata.buzzAmount,
                stripePaymentIntentId: paymentIntent.id,
                details: metadata,
                userId: metadata.userId,
              });

              await completeClubMembershipCharge({
                stripePaymentIntentId: paymentIntent.id,
              });
            }

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
