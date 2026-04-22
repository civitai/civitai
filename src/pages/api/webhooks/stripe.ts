import {
  manageCheckoutPayment,
  manageInvoicePaid,
  toDateTime,
  upsertPriceRecord,
  upsertProductRecord,
  upsertSubscription,
} from '~/server/services/stripe.service';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerStripe } from '~/server/utils/get-server-stripe';
import { env } from '~/env/server';
import type Stripe from 'stripe';
import type { Readable } from 'node:stream';
import { paymentIntentMetadataSchema } from '~/server/schema/stripe.schema';
import { completeStripeBuzzTransaction } from '~/server/services/buzz.service';
import { STRIPE_PROCESSING_AWAIT_TIME } from '~/server/common/constants';
import { completeClubMembershipCharge } from '~/server/services/clubMembership.service';
import { notifyAir } from '~/server/services/integration.service';
import { isDev } from '~/env/other';
import { trackWebhookEvent } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import {
  recordBuzzPurchaseKickback,
  recordMembershipPaymentReward,
  revokeForChargeback,
} from '~/server/services/referral.service';

const log = (data: MixedObject) =>
  logToAxiom({ name: 'stripe-webhook', ...data }, 'webhooks').catch(() => null);

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
  'charge.refunded',
  'charge.dispute.created',
]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    const stripe = await getServerStripe();
    if (!stripe) {
      return;
    }

    const buf = await buffer(req);
    const rawPayload = buf.toString('utf8');
    const sig = req.headers['stripe-signature'];
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    let event: Stripe.Event;

    // Track to ClickHouse (fire and forget, never throws)
    trackWebhookEvent('stripe', rawPayload).catch(() => null);

    try {
      if (!sig || !webhookSecret) return; // only way this is false is if we forgot to include our secret or stripe decides to suddenly not include their signature
      event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
    } catch (error: any) {
      log({
        type: 'error',
        stage: 'signature-verification',
        message: `Signature verification failed: ${error.message}`,
        error: error.message,
      });
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
              // Capture the referral code custom field if present and stash it
              // on the new Subscription's metadata so the invoice.paid handler
              // (manageInvoicePaid) picks it up via subscription_details.metadata.
              const refCodeField = (checkoutSession.custom_fields ?? []).find(
                (f) => f.key === 'ref_code'
              );
              const enteredCode = refCodeField?.text?.value?.trim().toUpperCase();
              const subId =
                typeof checkoutSession.subscription === 'string'
                  ? checkoutSession.subscription
                  : checkoutSession.subscription?.id;
              if (enteredCode && subId) {
                await stripe.subscriptions
                  .update(subId, { metadata: { ref_code: enteredCode } })
                  .catch((err: unknown) =>
                    log({
                      type: 'error',
                      stage: 'checkout-session-completed-ref-code-update',
                      message: 'failed to patch subscription metadata with ref_code',
                      error: err instanceof Error ? err.message : String(err),
                    })
                  );
              }
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
            // Stripe serializes all PaymentIntent.metadata values as strings, so a raw cast
            // would leak string userId/buzzAmount into downstream `$queryRaw` IN clauses and
            // hit "integer = text". Parse through the schema (which uses z.coerce.number) to
            // guarantee numeric types at runtime. Throwing on parse failure routes the event
            // into the outer catch, which logs to Axiom and returns 400 so Stripe retries —
            // we never want to 200 a payment we can't process.
            const parsedMetadata = paymentIntentMetadataSchema.safeParse(paymentIntent.metadata);
            if (!parsedMetadata.success) {
              throw new Error(
                `payment_intent.succeeded metadata failed schema validation: ${parsedMetadata.error.message}`
              );
            }
            const metadata = parsedMetadata.data;

            // Wait the processing time on the FE to avoid racing conditions and granting double buzz.

            if (metadata.type === 'buzzPurchase') {
              await completeStripeBuzzTransaction({
                amount: metadata.buzzAmount,
                stripePaymentIntentId: paymentIntent.id,
                details: metadata,
                userId: metadata.userId,
              });

              const pmFingerprint =
                typeof paymentIntent.payment_method === 'string'
                  ? undefined
                  : paymentIntent.payment_method?.card?.fingerprint ?? undefined;

              // No swallowed catch — let a transient DB error propagate so
              // Stripe retries the webhook. Both completeStripeBuzzTransaction
              // and recordBuzzPurchaseKickback are idempotent on
              // stripePaymentIntentId / sourceEventId, so a retry won't
              // double-grant.
              await recordBuzzPurchaseKickback({
                refereeId: metadata.userId,
                buzzAmount: metadata.buzzAmount,
                sourceEventId: paymentIntent.id,
                payment: {
                  paymentProvider: 'Stripe',
                  stripePaymentIntentId: paymentIntent.id,
                  stripeChargeId:
                    typeof paymentIntent.latest_charge === 'string'
                      ? paymentIntent.latest_charge
                      : paymentIntent.latest_charge?.id ?? undefined,
                  paymentMethodFingerprint: pmFingerprint,
                },
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
          case 'charge.refunded':
          case 'charge.dispute.created': {
            const charge = event.data.object as Stripe.Charge | Stripe.Dispute;
            const paymentIntentId =
              typeof charge.payment_intent === 'string'
                ? charge.payment_intent
                : charge.payment_intent?.id;
            let invoiceId: string | undefined;
            try {
              if (paymentIntentId) {
                const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
                if (pi.invoice) {
                  invoiceId = typeof pi.invoice === 'string' ? pi.invoice : pi.invoice.id;
                }
              }
            } catch {
              // lookup failed — still try with PI id so buzz-purchase path revokes
            }
            for (const sourceEventId of [paymentIntentId, invoiceId].filter(Boolean) as string[]) {
              await revokeForChargeback({
                sourceEventId,
                reason: event.type,
              }).catch(() => null);
            }
            break;
          }
          default:
            throw new Error('Unhandled relevant event!');
        }
      } catch (error: any) {
        const object = (event.data?.object ?? {}) as { id?: string; metadata?: MixedObject };
        log({
          type: 'error',
          stage: 'event-handler',
          eventType: event.type,
          eventId: event.id,
          objectId: object.id,
          metadata: object.metadata,
          message: `Event handler threw: ${error.message}`,
          error: error.message,
          stack: error.stack,
        });
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
