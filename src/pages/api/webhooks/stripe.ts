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
import { constants, STRIPE_PROCESSING_AWAIT_TIME } from '~/server/common/constants';
import { BanReasonCode } from '~/server/common/enums';
import { notifyAir } from '~/server/services/integration.service';
import { isDev } from '~/env/other';
import { trackWebhookEvent } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import { syncFreshdeskMembership } from '~/server/services/subscriptions.service';
import { dbWrite } from '~/server/db/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
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

// Well past Stripe's retry window.
const AIR_NOTIFIED_TTL_SECONDS = 30 * 24 * 60 * 60;

const relevantEvents = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
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
  'charge.dispute.closed',
]);

const idOf = (ref: string | { id: string } | null | undefined) =>
  typeof ref === 'string' ? ref : ref?.id;

type DisputeBanOutcome =
  | 'banned'
  | 'already-banned'
  | 'already-recorded'
  | 'skipped-moderator'
  | 'skipped-test-mode'
  | 'no-user'
  | 'failed';
// No dispute id here: the payer's ModActivity row is the one place it is kept.
const logDisputeBan = (data: {
  eventId: string;
  outcome: DisputeBanOutcome;
  userId?: number;
  error?: string;
}) =>
  log({
    type: data.outcome === 'banned' || data.outcome === 'already-recorded' ? 'info' : 'warning',
    stage: 'dispute-ban',
    ...data,
  });

// One row per lost dispute on the payer's account history. It is also what makes a redelivery, or a
// resend after a moderator lifts the ban, a no-op, so an unban does not remove it.
async function settleLostDispute(userId: number, disputeId: string): Promise<DisputeBanOutcome> {
  const key = `chargeback:${disputeId}:`;
  const recorded = await dbWrite.modActivity.findFirst({
    where: { entityType: 'user', entityId: userId, activity: { startsWith: key } },
    select: { id: true },
  });
  if (recorded) return 'already-recorded';

  const record = async (outcome: 'already-banned' | 'skipped-moderator') => {
    await dbWrite.modActivity.create({
      data: {
        userId: constants.system.user.id,
        entityType: 'user',
        entityId: userId,
        activity: key + outcome,
      },
    });
    return outcome;
  };
  const user = await dbWrite.user.findUnique({
    where: { id: userId },
    select: { bannedAt: true, isModerator: true },
  });
  if (!user) return 'no-user';
  if (user.bannedAt) return record('already-banned');
  if (user.isModerator) return record('skipped-moderator');

  const { toggleBan, AlreadyBannedError } = await import('~/server/services/user.service');
  try {
    await toggleBan({
      id: userId,
      userId: constants.system.user.id,
      reasonCode: BanReasonCode.Chargeback,
      detailsInternal: 'Lost payment dispute',
      detailsExternal: 'A payment on this account was reversed.',
      removeMedia: false,
      removeModels: false,
      removeComments: false,
      // A disputed charge can be a family member's or a mistake, and an unban restores no links.
      keepProfileLinks: true,
      // Writes only while the account is unbanned, so a ban that lands first is kept as it is.
      onlyBan: true,
      banActivity: key + 'banned',
    });
    return 'banned';
  } catch (err) {
    if (err instanceof AlreadyBannedError) return record('already-banned');
    throw err;
  }
}

// The payer is the Stripe customer on the PaymentIntent: every checkout creates it for the paying
// user, so for a gift it is the gifter, not the recipient.
async function banPayerForLostDispute({
  customerId,
  disputeId,
  eventId,
}: {
  customerId: string | undefined;
  disputeId: string;
  eventId: string;
}) {
  const payer = customerId
    ? await dbWrite.user.findUnique({ where: { customerId }, select: { id: true } })
    : null;
  if (!payer) return logDisputeBan({ eventId, outcome: 'no-user' });

  try {
    const outcome = await settleLostDispute(payer.id, disputeId);
    logDisputeBan({ eventId, outcome, userId: payer.id });
  } catch (err) {
    logDisputeBan({ eventId, outcome: 'failed', userId: payer.id, error: (err as Error).message });
    throw err;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Count any 5xx this webhook emits into civitai_app_http_errors_total — these
  // handlers bypass the endpoint wrappers, so their 500s were counter-blind.
  // Listener-only (res.once('finish')); no behavior/response change.
  instrumentApiResponse(req, res);
  if (req.method === 'POST') {
    const stripe = await getServerStripe();
    if (!stripe) return res.status(503).send('Stripe is not configured');

    const buf = await buffer(req);
    const rawPayload = buf.toString('utf8');
    const sig = req.headers['stripe-signature'];
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    let event: Stripe.Event;

    try {
      if (!sig || !webhookSecret) throw new Error('Missing signature or webhook secret');
      event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
    } catch (error: any) {
      log({
        type: 'error',
        stage: 'signature-verification',
        message: `Signature verification failed: ${error.message}`,
        error: error.message,
      });
      return res.status(400).send('Webhook Error');
    }

    // Only a verified payload is recorded. Fire and forget, never throws.
    trackWebhookEvent('stripe', rawPayload).catch(() => null);

    if (relevantEvents.has(event.type)) {
      try {
        switch (event.type) {
          case 'invoice.paid': {
            const invoice = event.data.object as Stripe.Invoice;
            await manageInvoicePaid(invoice);
            // A gifted month only counts once an invoice has actually used it.
            const { recordGiftMonthConsumed } = await import(
              '~/server/services/membership-gift.service'
            );
            await recordGiftMonthConsumed({ invoice }).catch((err) =>
              log({
                type: 'error',
                stage: 'gift-month-consumed',
                message: 'failed to record a consumed gift month',
                invoiceId: invoice.id,
                error: err instanceof Error ? err.message : String(err),
              })
            );
            break;
          }
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

            const user = await dbWrite.user.findFirst({
              where: { customerId },
              select: { id: true },
            });
            if (user) {
              const { armNextGiftMonth, honorGiftResidualsForUser } = await import(
                '~/server/services/membership-gift.service'
              );
              // Ended with gifted months still owed: hand over the remainder as a free
              // membership rather than letting it disappear with the subscription it happened
              // to be riding on. Otherwise the plan may have changed, and an owed month is
              // armed against the plan as it now stands.
              const ended = event.type === 'customer.subscription.deleted';
              const settleGifts = ended
                ? honorGiftResidualsForUser({ userId: user.id, endedSubscription: subscription })
                : armNextGiftMonth({ userId: user.id });
              await settleGifts.catch((err) =>
                log({
                  type: 'error',
                  stage: ended ? 'gift-residual' : 'gift-arm',
                  message: ended
                    ? 'failed to honor gifted months after cancellation'
                    : 'failed to arm a gifted month after a subscription change',
                  userId: user.id,
                  error: err instanceof Error ? err.message : String(err),
                })
              );
            }
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
              if (checkoutSession.metadata?.type === 'membershipGift') {
                const { handleMembershipGiftCheckoutEvent } = await import(
                  '~/server/services/membership-gift.service'
                );
                // Throws propagate to the outer catch → 400 → Stripe retries.
                await handleMembershipGiftCheckoutEvent({
                  type: event.type,
                  session: checkoutSession,
                });
                break;
              }

              // First, check if this payment is for Civitai AIR

              if (
                env.AIR_PAYMENT_LINK_ID &&
                checkoutSession.payment_link === env.AIR_PAYMENT_LINK_ID
              ) {
                // For AIR stuff...
                const email =
                  checkoutSession.customer_details?.email || checkoutSession.customer_email;
                const name = checkoutSession.customer_details?.name ?? 'Stripe Customer';

                if (isDev) {
                  log({ type: 'info', stage: 'air-dev-skip', eventId: event.id });
                  break;
                }
                if (!email) {
                  log({ type: 'warning', stage: 'air-no-email', eventId: event.id });
                  break;
                }

                // Stripe delivers at least once; AIR hears about each checkout once.
                const notifiedKey =
                  `${REDIS_SYS_KEYS.WEBHOOKS.STRIPE_AIR_NOTIFIED}:${checkoutSession.id}` as const;
                const claimed = await sysRedis.set(notifiedKey, '1', {
                  NX: true,
                  EX: AIR_NOTIFIED_TTL_SECONDS,
                });
                if (!claimed) {
                  log({ type: 'info', stage: 'air-already-notified', eventId: event.id });
                  break;
                }
                try {
                  await notifyAir({ email, name });
                } catch (err) {
                  try {
                    await sysRedis.del(notifiedKey);
                  } catch (releaseErr) {
                    // The claim outlives Stripe's retries, so AIR is never told about this checkout.
                    log({
                      type: 'error',
                      stage: 'air-claim-release-failed',
                      eventId: event.id,
                      checkoutSessionId: checkoutSession.id,
                      error: (releaseErr as Error).message,
                    });
                  }
                  throw err;
                }
                break;
              }

              await manageCheckoutPayment(checkoutSession.id, checkoutSession.customer as string);
            }
            break;
          case 'checkout.session.async_payment_succeeded':
          case 'checkout.session.async_payment_failed': {
            const session = event.data.object as Stripe.Checkout.Session;
            if (session.metadata?.type === 'membershipGift') {
              const { handleMembershipGiftCheckoutEvent } = await import(
                '~/server/services/membership-gift.service'
              );
              await handleMembershipGiftCheckoutEvent({ type: event.type, session });
            }
            break;
          }
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
          case 'charge.dispute.created': {
            // A dispute can still be won, so nothing is revoked until it closes as lost.
            const dispute = event.data.object as Stripe.Dispute;
            log({
              type: 'warning',
              stage: 'dispute-created',
              eventId: event.id,
              paymentIntentId: idOf(dispute.payment_intent),
              amount: dispute.amount,
              reason: dispute.reason,
            });
            break;
          }
          case 'charge.refunded':
          case 'charge.dispute.closed': {
            const object = event.data.object as Stripe.Charge | Stripe.Dispute;
            if (
              event.type === 'charge.dispute.closed' &&
              (object as Stripe.Dispute).status !== 'lost'
            ) {
              log({
                type: 'info',
                stage: 'dispute-closed-not-lost',
                eventId: event.id,
                status: (object as Stripe.Dispute).status,
              });
              break;
            }
            const isLostDispute = event.type === 'charge.dispute.closed';
            const paymentIntentId = idOf(object.payment_intent);
            if (!paymentIntentId) {
              log({
                type: 'warning',
                stage: 'refund-no-payment-intent',
                eventType: event.type,
                eventId: event.id,
                objectId: isLostDispute ? undefined : object.id,
              });
              if (isLostDispute) logDisputeBan({ eventId: event.id, outcome: 'no-user' });
              break;
            }
            // Stripe sends charge.refunded for every partial refund. Only the one that leaves the
            // charge fully refunded revokes; a partial refund is for support to handle.
            if (event.type === 'charge.refunded' && !(object as Stripe.Charge).refunded) {
              const partial = object as Stripe.Charge;
              log({
                type: 'warning',
                stage: 'partial-refund',
                eventId: event.id,
                paymentIntentId,
                amount: partial.amount,
                amountRefunded: partial.amount_refunded,
              });
              break;
            }
            const reason = event.type === 'charge.refunded' ? 'refund' : 'chargeback';

            // Every step is idempotent, so all of them run, and any failure fails the event:
            // Stripe then redelivers it and the steps that already succeeded do nothing.
            let invoiceId: string | undefined;
            let customerId: string | undefined;
            let paymentIntentLoaded = false;
            const failedStages: string[] = [];
            const attempt = async (stage: string, run: () => Promise<unknown>) => {
              try {
                await run();
              } catch (err) {
                failedStages.push(stage);
                log({
                  type: 'error',
                  stage,
                  eventType: event.type,
                  eventId: event.id,
                  paymentIntentId,
                  invoiceId,
                  error: (err as Error)?.message,
                });
              }
            };

            await attempt('refund-payment-intent-lookup', async () => {
              const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
              invoiceId = idOf(pi.invoice);
              customerId = idOf(pi.customer);
              paymentIntentLoaded = true;
            });
            await attempt('membership-gift-revoke', async () => {
              const { revokeMembershipGift } = await import(
                '~/server/services/membership-gift.service'
              );
              await revokeMembershipGift({ paymentIntentId, reason });
            });
            // Buzz purchases are keyed on the PaymentIntent, membership payments on its invoice.
            for (const sourceEventId of [paymentIntentId, invoiceId].filter(Boolean) as string[]) {
              await attempt('referral-revoke', () =>
                revokeForChargeback({ sourceEventId, reason: event.type })
              );
              await attempt('block-attribution-void', () =>
                voidAttributionsForPayment({
                  paymentProvider: 'stripe',
                  paymentTransactionId: sourceEventId,
                  reason,
                })
              );
              await attempt('block-subscription-attribution-void', () =>
                voidSubscriptionAttributionsForInvoice({
                  paymentProvider: 'stripe',
                  invoiceId: sourceEventId,
                  reason,
                })
              );
            }
            // After the revokes, so a failed ban never stops them.
            if (isLostDispute) {
              if (!event.livemode && !isDev) {
                logDisputeBan({ eventId: event.id, outcome: 'skipped-test-mode' });
              } else if (paymentIntentLoaded) {
                await attempt('payer-ban', () =>
                  banPayerForLostDispute({ customerId, disputeId: object.id, eventId: event.id })
                );
              } else {
                logDisputeBan({ eventId: event.id, outcome: 'failed' });
              }
            }
            if (failedStages.length) {
              throw new Error(`Refund/dispute steps failed: ${failedStages.join(', ')}`);
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
          objectId: event.type.startsWith('charge.dispute.') ? undefined : object.id,
          metadata: object.metadata,
          message: `Event handler threw: ${error.message}`,
          error: error.message,
          stack: error.stack,
        });
        return res.status(400).send({
          error: 'Webhook handler failed',
        });
      }
    }

    res.json({ received: true });
  } else {
    res.setHeader('Allow', 'POST');
    res.status(405).end('Method Not Allowed');
  }
}
