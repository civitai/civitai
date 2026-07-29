import {
  manageCheckoutPayment,
  manageInvoicePaid,
  toDateTime,
  upsertPriceRecord,
  upsertProductRecord,
  upsertSubscription,
} from '~/server/services/stripe.service';
import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { getServerStripe } from '~/server/utils/get-server-stripe';
import { env } from '~/env/server';
import type Stripe from 'stripe';
import type { Readable } from 'node:stream';
import { paymentIntentMetadataSchema } from '~/server/schema/stripe.schema';
import { completeStripeBuzzTransaction } from '~/server/services/buzz.service';
import { STRIPE_PROCESSING_AWAIT_TIME } from '~/server/common/constants';
import { notifyAir } from '~/server/services/integration.service';
import { isDev } from '~/env/other';
import { trackWebhookEvent } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import { syncFreshdeskMembership } from '~/server/services/subscriptions.service';
import {
  recordBuzzPurchaseKickback,
  recordMembershipPaymentReward,
  revokeForChargeback,
} from '~/server/services/referral.service';
import {
  AttributionAppMissingError,
  recordAttribution,
  voidAttributionsForPayment,
  voidSubscriptionAttributionsForInvoice,
} from '~/server/services/blocks/buzz-attribution.service';
import { extractAttribution } from '~/server/schema/blocks/attribution.schema';

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
  // Count any 5xx this webhook emits into civitai_app_http_errors_total — these
  // handlers bypass the endpoint wrappers, so their 500s were counter-blind.
  // Listener-only (res.once('finish')); no behavior/response change.
  instrumentApiResponse(req, res);
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
          case 'customer.subscription.deleted': {
            const subscription = event.data.object as Stripe.Subscription;
            const customerId = subscription.customer as string;
            await upsertSubscription(
              subscription,
              customerId,
              toDateTime(event.created),
              event.type
            );

            await syncFreshdeskMembership({ customerId }).catch((err) =>
              log({
                type: 'error',
                stage: 'freshdesk-sync',
                message: 'failed to sync Freshdesk service tier',
                error: err instanceof Error ? err.message : String(err),
              })
            );
            break;
          }
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
            // payment_intent.succeeded fires for every successful PaymentIntent — including
            // subscription invoice payments and any other Stripe-managed flows that don't
            // carry our `type` discriminator. Bail before schema validation so we don't 400
            // Stripe into a retry loop for payments we were never going to process here.
            const metadataType = paymentIntent.metadata?.type;
            if (metadataType !== 'buzzPurchase') {
              break;
            }
            // Stripe serializes all PaymentIntent.metadata values as strings, so a raw cast
            // would leak string userId/buzzAmount into downstream `$queryRaw` IN clauses and
            // hit "integer = text". Parse through the schema (which uses z.coerce.number) to
            // guarantee numeric types at runtime. Throwing on parse failure routes the event
            // into the outer catch, which logs to Axiom and returns 400 so Stripe retries —
            // we never want to 200 a payment we can't process.
            const parsedMetadata = paymentIntentMetadataSchema.safeParse(paymentIntent.metadata);
            if (!parsedMetadata.success) {
              throw new Error(
                `payment_intent.succeeded metadata failed schema validation: ${
                  parsedMetadata.error.message
                } | rawMetadata=${JSON.stringify(paymentIntent.metadata)}`
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

              // App Blocks revenue-share attribution. Skipped silently when
              // metadata doesn't carry block fields (the steady-state for
              // every non-block buzz purchase). Also skipped for test-mode
              // events so dashboard tinkering doesn't pollute revenue.
              //
              // Order matters: the buzz credit lands first (line 215) —
              // attribution is a derived audit/payout artifact and a failed
              // write here MUST NOT block the buzz grant. Stripe retries
              // the entire webhook on a non-2xx, and both
              // completeStripeBuzzTransaction (via metadata.transactionId)
              // and recordAttribution (via UNIQUE on
              // payment_transaction_id + app_block_id) are idempotent, so
              // a retry is safe.
              if (event.livemode !== false) {
                const attribution = extractAttribution(
                  metadata as Record<string, string | number | null | undefined>
                );
                if (attribution) {
                  try {
                    // Pull the actual Stripe fee off the balance
                    // transaction. We only fetch when attribution is
                    // present to avoid the extra round-trip for the 99% of
                    // non-block buzz purchases. Falls back to 0 when the
                    // expansion path is unavailable (rare; the row's
                    // share-sum CHECK still holds because providerFee+
                    // platformShare+publisherShare = gross by construction).
                    let providerFeeCents = 0;
                    const chargeId =
                      typeof paymentIntent.latest_charge === 'string'
                        ? paymentIntent.latest_charge
                        : paymentIntent.latest_charge?.id;
                    if (chargeId) {
                      try {
                        const charge = await stripe.charges.retrieve(chargeId, {
                          expand: ['balance_transaction'],
                        });
                        const balanceTx = charge.balance_transaction;
                        if (balanceTx && typeof balanceTx !== 'string') {
                          providerFeeCents = balanceTx.fee ?? 0;
                        }
                      } catch {
                        // Best-effort; leaving the fee at 0 means the
                        // publisher gets a slightly higher share than
                        // Stripe's actual net. Acceptable for v1; revisit
                        // if reconciliation surfaces material drift.
                      }
                    }
                    await recordAttribution({
                      userId: metadata.userId,
                      buzzAmount: metadata.buzzAmount,
                      buzzType: metadata.buzzType,
                      usdAmountCents: paymentIntent.amount ?? metadata.unitAmount,
                      providerFeeCents,
                      paymentProvider: 'stripe',
                      paymentTransactionId: paymentIntent.id,
                      buzzTransactionId: metadata.transactionId ?? null,
                      attribution,
                    });
                  } catch (attrErr) {
                    // Never fail the webhook on an attribution write —
                    // the buzz credit has already happened. Log loudly so
                    // ops notices, then continue. AttributionAppMissingError
                    // specifically is expected when an app is deleted
                    // between purchase and webhook delivery.
                    const isExpected = attrErr instanceof AttributionAppMissingError;
                    log({
                      type: isExpected ? 'warning' : 'error',
                      stage: 'block-attribution-write',
                      eventType: event.type,
                      eventId: event.id,
                      paymentIntentId: paymentIntent.id,
                      attribution,
                      error: (attrErr as Error)?.message,
                      stack: (attrErr as Error)?.stack,
                    });
                  }
                }
              }
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
              // Also void any App Blocks attribution row that referenced
              // this payment. If the row had already paid out, the row
              // flips to voided here and the payout reconciliation job
              // claws back from the publisher's NEXT payout (the row
              // stamps payout_id for audit). Always-livemode is enforced
              // upstream — refund webhooks for test-mode events still
              // can't match any attribution row because we never wrote
              // one in the first place.
              await voidAttributionsForPayment({
                paymentProvider: 'stripe',
                paymentTransactionId: sourceEventId,
                reason: event.type === 'charge.refunded' ? 'refund' : 'chargeback',
              }).catch((err) => {
                log({
                  type: 'error',
                  stage: 'block-attribution-void',
                  eventType: event.type,
                  sourceEventId,
                  error: (err as Error)?.message,
                });
                return 0;
              });

              // W3 flow C — also void/clawback any membership (subscription)
              // attribution row keyed on this invoice. block_buzz_attribution
              // is keyed on the PI id, but block_subscription_attribution is
              // keyed on the invoice_id (the per-period anchor). The loop
              // already resolves the parent invoiceId from the PI, so this
              // matches both keys. Like the buzz void: paid_out rows write a
              // negative clawback that nets out of the publisher's next
              // payout; pending/confirmed rows just void.
              await voidSubscriptionAttributionsForInvoice({
                paymentProvider: 'stripe',
                invoiceId: sourceEventId,
                reason: event.type === 'charge.refunded' ? 'refund' : 'chargeback',
              }).catch((err) => {
                log({
                  type: 'error',
                  stage: 'block-subscription-attribution-void',
                  eventType: event.type,
                  sourceEventId,
                  error: (err as Error)?.message,
                });
                return 0;
              });
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
