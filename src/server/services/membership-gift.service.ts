import type { Stripe } from 'stripe';
import dayjs from '~/shared/utils/dayjs';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { membershipGiftReceivedEmail } from '~/server/email/templates/membershipGiftReceived.email';
import { membershipGiftSentEmail } from '~/server/email/templates/membershipGiftSent.email';
import { logToAxiom } from '~/server/logging/client';
import type {
  CreateMembershipGiftCheckoutInput,
  GiftableTier,
} from '~/server/schema/membership-gift.schema';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { refreshSession } from '~/server/auth/session-invalidation';
import { createNotification } from '~/server/services/notification.service';
import { getPlans } from '~/server/services/subscriptions.service';
import { createCustomer } from '~/server/services/stripe.service';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { getServerStripe } from '~/server/utils/get-server-stripe';
import { invalidateSubscriptionCaches } from '~/server/utils/subscription.utils';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { MembershipGiftStatus, PaymentProvider } from '~/shared/utils/prisma/enums';

const baseUrl = getBaseUrl('green'); // Stripe lives in civitai green

const log = (data: MixedObject) =>
  logToAxiom({ name: 'membership-gift', ...data }, 'webhooks').catch(() => null);

// Stripe subscription statuses that mean the row is dead and a fresh gift sub can be created.
const TERMINAL_STATUSES = ['canceled', 'incomplete_expired'];
// Statuses a gift coupon can safely be applied to.
const EXTENDABLE_STATUSES = ['active', 'trialing'];

export type RecipientGiftability =
  | { status: 'no-subscription' }
  | { status: 'active'; tier: GiftableTier; renewsAt: Date; cancelsAtPeriodEnd: boolean }
  | { status: 'blocked'; reason: 'annual-interval' | 'billing-issue' | 'unsupported-provider' };

async function getGreenSubscription(userId: number) {
  // dbWrite: fulfillment runs off webhooks where replication lag matters
  return dbWrite.customerSubscription.findUnique({
    where: { userId_buzzType: { userId, buzzType: 'green' } },
    select: {
      id: true,
      status: true,
      cancelAtPeriodEnd: true,
      cancelAt: true,
      currentPeriodEnd: true,
      product: { select: { id: true, provider: true, metadata: true } },
      price: { select: { id: true, interval: true } },
    },
  });
}

export async function getRecipientGiftability({
  recipientUserId,
}: {
  recipientUserId: number;
}): Promise<RecipientGiftability> {
  const subscription = await getGreenSubscription(recipientUserId);
  if (!subscription || TERMINAL_STATUSES.includes(subscription.status)) {
    return { status: 'no-subscription' };
  }

  if (subscription.product.provider !== PaymentProvider.Stripe) {
    return { status: 'blocked', reason: 'unsupported-provider' };
  }

  if (!EXTENDABLE_STATUSES.includes(subscription.status)) {
    return { status: 'blocked', reason: 'billing-issue' };
  }

  if (subscription.price.interval !== 'month') {
    return { status: 'blocked', reason: 'annual-interval' };
  }

  const productMeta = subscription.product.metadata as SubscriptionProductMetadata;
  return {
    status: 'active',
    tier: productMeta.tier as GiftableTier,
    renewsAt: subscription.currentPeriodEnd,
    cancelsAtPeriodEnd: subscription.cancelAtPeriodEnd || !!subscription.cancelAt,
  };
}

async function getTierMonthlyPrice(tier: GiftableTier) {
  const plans = await getPlans({ paymentProvider: PaymentProvider.Stripe, interval: 'month' });
  const plan = plans.find((p) => p.metadata.tier === tier);
  if (!plan?.price?.unitAmount) {
    throw throwNotFoundError(`No active monthly Stripe price found for tier: ${tier}`);
  }
  return {
    productId: plan.id,
    priceId: plan.price.id,
    unitAmount: plan.price.unitAmount,
    currency: plan.price.currency,
    productMeta: plan.metadata,
  };
}

export async function createMembershipGiftCheckout({
  gifterId,
  gifterEmail,
  recipientUserId,
  tier,
  months,
  message,
  anonymous,
}: CreateMembershipGiftCheckoutInput & { gifterId: number; gifterEmail: string }) {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');

  const recipient = await dbWrite.user.findUnique({
    where: { id: recipientUserId },
    select: { id: true, username: true, bannedAt: true, deletedAt: true },
  });
  if (!recipient || recipient.deletedAt) throw throwNotFoundError('Recipient not found');
  if (recipient.bannedAt) throw throwBadRequestError('This user cannot receive gifts');

  const giftability = await getRecipientGiftability({ recipientUserId });
  if (giftability.status === 'blocked') {
    const reasons: Record<typeof giftability.reason, string> = {
      'annual-interval':
        'This user is on an annual membership, which cannot receive gifted months yet',
      'billing-issue': "This user's membership has a billing issue and cannot receive gifts",
      'unsupported-provider': "This user's membership cannot receive gifted months",
    };
    throw throwBadRequestError(reasons[giftability.reason]);
  }
  if (giftability.status === 'active' && giftability.tier !== tier) {
    throw throwBadRequestError(
      `This user already has a ${giftability.tier} membership — gifted months must match their current tier`
    );
  }

  const { productId, unitAmount, currency } = await getTierMonthlyPrice(tier);

  const gift = await dbWrite.membershipGift.create({
    data: {
      gifterId,
      recipientId: recipientUserId,
      tier,
      months,
      amountCents: unitAmount * months,
      message,
      anonymous,
    },
    select: { id: true },
  });

  const customerId = await createCustomer({ id: gifterId, email: gifterEmail });
  const metadata = { type: 'membershipGift', giftId: gift.id };

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'payment',
      line_items: [
        {
          price_data: { currency, unit_amount: unitAmount, product: productId },
          quantity: months,
        },
      ],
      success_url: `${baseUrl}/payment/success?cid=${customerId.slice(-8)}&gift=true`,
      cancel_url: `${baseUrl}/pricing?canceled=true`,
      metadata,
      payment_intent_data: { metadata },
    });
  } catch (error) {
    // No session — the row can never be fulfilled, so don't leave a dangling Pending gift
    await dbWrite.membershipGift.delete({ where: { id: gift.id } }).catch(() => null);
    throw error;
  }

  await dbWrite.membershipGift.update({
    where: { id: gift.id },
    data: { stripeCheckoutSessionId: session.id },
  });

  return { giftId: gift.id, sessionId: session.id, url: session.url };
}

async function getOrCreateGiftCoupon({
  stripe,
  giftId,
  existingCouponId,
  tier,
  months,
}: {
  stripe: Stripe;
  giftId: string;
  existingCouponId: string | null;
  tier: string;
  months: number;
}) {
  if (existingCouponId) {
    return stripe.coupons.retrieve(existingCouponId);
  }
  return stripe.coupons.create({
    percent_off: 100,
    duration: 'repeating',
    duration_in_months: months,
    max_redemptions: 1,
    name: `Gifted ${tier} membership (${months}mo)`,
    metadata: { giftId },
  });
}

/**
 * Applies a paid gift to the recipient. Called from the Stripe webhook on
 * checkout.session.completed — must be safe to re-run (Stripe retries on non-2xx):
 * Fulfilled/Refunded/Revoked rows bail early, and both the coupon and the created
 * subscription are re-used from the row when a prior attempt got partway through.
 */
export async function fulfillMembershipGift({
  giftId,
  paymentIntentId,
}: {
  giftId: string;
  paymentIntentId?: string;
}) {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');

  const gift = await dbWrite.membershipGift.findUnique({
    where: { id: giftId },
    include: {
      gifter: { select: { id: true, username: true, email: true } },
      recipient: { select: { id: true, username: true, email: true } },
    },
  });
  if (!gift) throw throwNotFoundError(`MembershipGift not found: ${giftId}`);

  // Failed rows stay retryable: a webhook redelivery is a legitimate recovery path
  if (gift.status !== MembershipGiftStatus.Pending && gift.status !== MembershipGiftStatus.Failed) {
    return { alreadyProcessed: true as const };
  }

  if (paymentIntentId && gift.stripePaymentIntentId !== paymentIntentId) {
    await dbWrite.membershipGift.update({
      where: { id: gift.id },
      data: { stripePaymentIntentId: paymentIntentId },
    });
  }

  const markFailed = async (reason: string) => {
    await dbWrite.membershipGift.update({
      where: { id: gift.id },
      data: { status: MembershipGiftStatus.Failed },
    });
    await log({
      type: 'error',
      stage: 'fulfillment',
      giftId: gift.id,
      gifterId: gift.gifterId,
      recipientId: gift.recipientId,
      message: `Gift fulfillment needs support attention: ${reason}`,
    });
    return { fulfilled: false as const, reason };
  };

  const subscription = await getGreenSubscription(gift.recipientId);
  const hasLiveRow = !!subscription && !TERMINAL_STATUSES.includes(subscription.status);

  let stripeSubscriptionId: string;
  let applied: 'extended' | 'created';

  if (hasLiveRow) {
    if (subscription.product.provider !== PaymentProvider.Stripe) {
      return markFailed('recipient has a non-Stripe green subscription');
    }

    // The DB row can lag Stripe — the subscription itself is the source of truth here
    const stripeSub = await stripe.subscriptions.retrieve(subscription.id);
    if (TERMINAL_STATUSES.includes(stripeSub.status)) {
      const result = await createGiftSubscription({ stripe, gift });
      if (!result.ok) return markFailed(result.reason);
      stripeSubscriptionId = result.subscriptionId;
      applied = 'created';
    } else {
      if (!EXTENDABLE_STATUSES.includes(stripeSub.status)) {
        return markFailed(`recipient subscription is in status "${stripeSub.status}"`);
      }
      if (stripeSub.items.data[0]?.price.recurring?.interval !== 'month') {
        return markFailed('recipient subscription is not billed monthly');
      }

      const coupon = await getOrCreateGiftCoupon({
        stripe,
        giftId: gift.id,
        existingCouponId: gift.stripeCouponId,
        tier: gift.tier,
        months: gift.months,
      });
      await dbWrite.membershipGift.update({
        where: { id: gift.id },
        data: { stripeCouponId: coupon.id },
      });

      // API 2022-11-15 has a single discount slot — applying our coupon replaces any
      // existing one. 100%-off wins for the user during the gift, but log the
      // replacement so support can restore a long-lived discount if one existed.
      if (stripeSub.discount) {
        await log({
          type: 'warning',
          stage: 'fulfillment',
          giftId: gift.id,
          message: `replacing existing discount (coupon ${stripeSub.discount.coupon?.id}) on subscription ${stripeSub.id}`,
        });
      }

      const updateParams: Stripe.SubscriptionUpdateParams = { coupon: coupon.id };
      // Recipient had canceled (or scheduled a cancel): defer the cancellation past the
      // gifted months instead of un-canceling — the free months happen, then the sub
      // still ends. Billing never resumes without an explicit reinstate.
      const scheduledEnd = stripeSub.cancel_at
        ? stripeSub.cancel_at
        : stripeSub.cancel_at_period_end
        ? stripeSub.current_period_end
        : null;
      if (scheduledEnd) {
        updateParams.cancel_at = dayjs.unix(scheduledEnd).add(gift.months, 'month').unix();
        // cancel_at and cancel_at_period_end are mutually exclusive — leaving the
        // flag set would still end the sub at period end, eating the gifted months.
        updateParams.cancel_at_period_end = false;
      }

      await stripe.subscriptions.update(stripeSub.id, updateParams);
      stripeSubscriptionId = stripeSub.id;
      applied = 'extended';
    }
  } else {
    const result = await createGiftSubscription({ stripe, gift });
    if (!result.ok) return markFailed(result.reason);
    stripeSubscriptionId = result.subscriptionId;
    applied = 'created';
  }

  await dbWrite.membershipGift.update({
    where: { id: gift.id },
    data: {
      status: MembershipGiftStatus.Fulfilled,
      fulfilledAt: new Date(),
      stripeSubscriptionId,
    },
  });

  // Webhooks for the subscription change will also bust these, but don't rely on ordering
  await invalidateSubscriptionCaches(gift.recipientId);
  await refreshSession(gift.recipientId);

  await createNotification({
    type: 'membership-gift-received',
    userId: gift.recipientId,
    category: NotificationCategory.System,
    key: `membership-gift-received:${gift.id}`,
    details: {
      giftId: gift.id,
      tier: gift.tier,
      months: gift.months,
      message: gift.message,
      from: gift.anonymous ? null : gift.gifter.username,
    },
  });
  await createNotification({
    type: 'membership-gift-sent',
    userId: gift.gifterId,
    category: NotificationCategory.System,
    key: `membership-gift-sent:${gift.id}`,
    details: {
      giftId: gift.id,
      tier: gift.tier,
      months: gift.months,
      to: gift.recipient.username,
    },
  });

  // Mail is best-effort: the gift is already applied, and throwing here would make the
  // Stripe webhook retry a fulfillment that's done.
  const sendGiftEmail = (label: string, send: () => Promise<void>) =>
    send().catch((error) =>
      log({
        type: 'error',
        stage: 'fulfillment-email',
        giftId: gift.id,
        message: `Failed to send ${label} email: ${String(error)}`,
      })
    );

  const recipientEmail = gift.recipient.email;
  if (recipientEmail) {
    await sendGiftEmail('membership-gift-received', () =>
      membershipGiftReceivedEmail.send({
        to: recipientEmail,
        username: gift.recipient.username ?? 'there',
        tier: gift.tier,
        months: gift.months,
        from: gift.anonymous ? null : gift.gifter.username,
        message: gift.message,
      })
    );
  }

  const gifterEmail = gift.gifter.email;
  if (gifterEmail) {
    await sendGiftEmail('membership-gift-sent', () =>
      membershipGiftSentEmail.send({
        to: gifterEmail,
        username: gift.gifter.username ?? 'there',
        tier: gift.tier,
        months: gift.months,
        recipient: gift.recipient.username,
        anonymous: gift.anonymous,
      })
    );
  }

  await log({
    type: 'info',
    stage: 'fulfillment',
    giftId: gift.id,
    applied,
    stripeSubscriptionId,
  });

  return { fulfilled: true as const, applied, stripeSubscriptionId };
}

async function createGiftSubscription({
  stripe,
  gift,
}: {
  stripe: Stripe;
  gift: {
    id: string;
    tier: string;
    months: number;
    recipientId: number;
    stripeCouponId: string | null;
    stripeSubscriptionId: string | null;
    recipient: { email: string | null };
  };
}): Promise<{ ok: true; subscriptionId: string } | { ok: false; reason: string }> {
  // Re-entrancy: a prior attempt may have created the subscription before the row update
  if (gift.stripeSubscriptionId) {
    const existing = await stripe.subscriptions.retrieve(gift.stripeSubscriptionId);
    if (existing.metadata?.membershipGiftId === gift.id) {
      return { ok: true, subscriptionId: existing.id };
    }
  }

  if (!gift.recipient.email) {
    return { ok: false, reason: 'recipient has no email — cannot create a Stripe customer' };
  }

  const { priceId } = await getTierMonthlyPrice(gift.tier as GiftableTier);
  const customerId = await createCustomer({ id: gift.recipientId, email: gift.recipient.email });

  const coupon = await getOrCreateGiftCoupon({
    stripe,
    giftId: gift.id,
    existingCouponId: gift.stripeCouponId,
    tier: gift.tier,
    months: gift.months,
  });
  await dbWrite.membershipGift.update({
    where: { id: gift.id },
    data: { stripeCouponId: coupon.id },
  });

  // Every invoice inside the gift window is $0 (100%-off coupon), so no payment method
  // is needed; cancel_at guarantees the recipient is never billed. default_incomplete
  // is a guard: if Stripe ever computed a non-zero amount due, the sub parks as
  // `incomplete` instead of erroring or charging.
  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    coupon: coupon.id,
    cancel_at: dayjs().add(gift.months, 'month').unix(),
    payment_behavior: 'default_incomplete',
    metadata: { membershipGiftId: gift.id, membershipGift: 'true' },
  });

  if (!EXTENDABLE_STATUSES.includes(subscription.status)) {
    await log({
      type: 'error',
      stage: 'fulfillment',
      giftId: gift.id,
      message: `gift subscription ${subscription.id} created in unexpected status "${subscription.status}"`,
    });
  }

  return { ok: true, subscriptionId: subscription.id };
}

/**
 * Undo a gift after a refund or chargeback on the gifter's payment.
 * Best-effort by design: Buzz already granted for elapsed months is not clawed back.
 * Returns false when the payment intent doesn't belong to a gift.
 */
export async function revokeMembershipGift({
  paymentIntentId,
  reason,
}: {
  paymentIntentId: string;
  reason: 'refund' | 'chargeback';
}) {
  const gift = await dbWrite.membershipGift.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: {
      id: true,
      status: true,
      recipientId: true,
      stripeCouponId: true,
      stripeSubscriptionId: true,
    },
  });
  if (!gift) return false;

  const newStatus =
    reason === 'refund' ? MembershipGiftStatus.Refunded : MembershipGiftStatus.Revoked;

  if (
    gift.status === MembershipGiftStatus.Refunded ||
    gift.status === MembershipGiftStatus.Revoked
  ) {
    return true;
  }

  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');

  if (gift.status === MembershipGiftStatus.Fulfilled && gift.stripeSubscriptionId) {
    const subscription = await stripe.subscriptions
      .retrieve(gift.stripeSubscriptionId)
      .catch(() => null);

    if (subscription && !TERMINAL_STATUSES.includes(subscription.status)) {
      if (subscription.metadata?.membershipGiftId === gift.id) {
        // Gift-created subscription — the whole thing exists only because of this payment
        await stripe.subscriptions.del(subscription.id);
      } else if (gift.stripeCouponId && subscription.discount?.coupon?.id === gift.stripeCouponId) {
        // Existing subscription that got our coupon — strip the remaining free months
        await stripe.subscriptions.deleteDiscount(subscription.id);
        // Fulfillment may have deferred the recipient's own cancellation past the
        // gifted months (cancel_at pushed out). With the gift revoked that deferral
        // would resume BILLING a user who had canceled — collapse it back to
        // period-end so they keep what they paid for and are never charged again.
        if (subscription.cancel_at) {
          await stripe.subscriptions.update(subscription.id, {
            cancel_at: '',
            cancel_at_period_end: true,
          });
        }
      }
    }
  }

  if (gift.stripeCouponId) {
    await stripe.coupons.del(gift.stripeCouponId).catch(() => null);
  }

  await dbWrite.membershipGift.update({
    where: { id: gift.id },
    data: { status: newStatus },
  });

  await invalidateSubscriptionCaches(gift.recipientId);
  await refreshSession(gift.recipientId);

  await log({
    type: 'warning',
    stage: 'revoke',
    giftId: gift.id,
    reason,
    paymentIntentId,
  });

  return true;
}

/**
 * "Keep my membership": clears a scheduled cancellation (gift subs use cancel_at,
 * regular cancels use cancel_at_period_end) so billing resumes after the free months.
 * Requires a usable payment method — without one, returns a billing-portal URL so the
 * user can add a card, then retry.
 */
export async function keepGiftMembership({ userId }: { userId: number }) {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');

  const subscription = await getGreenSubscription(userId);
  if (!subscription || TERMINAL_STATUSES.includes(subscription.status)) {
    throw throwNotFoundError('No active membership found');
  }
  if (subscription.product.provider !== PaymentProvider.Stripe) {
    throw throwBadRequestError('This membership is not managed by Stripe');
  }

  const stripeSub = await stripe.subscriptions.retrieve(subscription.id, {
    expand: ['customer'],
  });
  if (TERMINAL_STATUSES.includes(stripeSub.status)) {
    throw throwNotFoundError('No active membership found');
  }
  if (!stripeSub.cancel_at && !stripeSub.cancel_at_period_end) {
    return { kept: true as const };
  }

  const customer = stripeSub.customer as Stripe.Customer;
  // default_source is a legacy Source/Card — Stripe bills it as the customer
  // default but rejects it as a subscription default_payment_method, so it only
  // counts as "has a way to pay", never gets set on the sub.
  let subscriptionPaymentMethod: string | null = null;
  let hasBillingMethod =
    !!customer.invoice_settings?.default_payment_method || !!customer.default_source;
  if (!hasBillingMethod) {
    const methods = await stripe.paymentMethods.list({ customer: customer.id, type: 'card' });
    subscriptionPaymentMethod = methods.data[0]?.id ?? null;
    hasBillingMethod = !!subscriptionPaymentMethod;
  }
  if (!hasBillingMethod) {
    const portal = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: `${baseUrl}/user/membership?flow=keep-membership`,
      flow_data: { type: 'payment_method_update' },
    });
    return { kept: false as const, portalUrl: portal.url };
  }

  await stripe.subscriptions.update(stripeSub.id, {
    cancel_at: '',
    cancel_at_period_end: false,
    ...(subscriptionPaymentMethod ? { default_payment_method: subscriptionPaymentMethod } : {}),
  });

  await invalidateSubscriptionCaches(userId);
  await refreshSession(userId);

  await log({ type: 'info', stage: 'keep', userId, stripeSubscriptionId: stripeSub.id });

  return { kept: true as const };
}

export async function getMyMembershipGifts({ userId }: { userId: number }) {
  const [sent, received] = await Promise.all([
    dbWrite.membershipGift.findMany({
      where: { gifterId: userId, status: { not: MembershipGiftStatus.Pending } },
      select: {
        id: true,
        tier: true,
        months: true,
        status: true,
        createdAt: true,
        fulfilledAt: true,
        recipient: { select: { id: true, username: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    dbWrite.membershipGift.findMany({
      where: { recipientId: userId, status: MembershipGiftStatus.Fulfilled },
      select: {
        id: true,
        tier: true,
        months: true,
        message: true,
        anonymous: true,
        fulfilledAt: true,
        gifter: { select: { id: true, username: true } },
      },
      orderBy: { fulfilledAt: 'desc' },
    }),
  ]);

  return {
    sent,
    received: received.map((g) => ({
      ...g,
      gifter: g.anonymous ? null : g.gifter,
    })),
  };
}
