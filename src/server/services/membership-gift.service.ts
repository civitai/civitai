import type { Stripe } from 'stripe';
import dayjs from '~/shared/utils/dayjs';
import { NotificationCategory } from '~/server/common/enums';
import { constants } from '~/server/common/constants';
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
const tierRank = (tier: string) => constants.memberships.tierOrder.indexOf(tier as never);

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
      price: { select: { id: true, interval: true, currency: true } },
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

async function getTierMonthlyPrice(tier: string) {
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
    // Every currency we sell this tier in. A gift is always bought in the default currency,
    // but the holder may be billed in another one, and an amount_off coupon only applies to
    // an invoice in a currency it carries an amount for.
    pricesByCurrency: Object.fromEntries(
      plan.prices.filter((p) => p.unitAmount).map((p) => [p.currency, p.unitAmount as number])
    ) as Record<string, number>,
  };
}

async function getTierPriceIdForCurrency(tier: string, currency: string) {
  const plans = await getPlans({ paymentProvider: PaymentProvider.Stripe, interval: 'month' });
  const plan = plans.find((p) => p.metadata.tier === tier);
  const price = plan?.prices.find((p) => p.currency === currency) ?? plan?.price;
  if (!price) throw throwNotFoundError(`No active monthly Stripe price for tier ${tier}`);
  return price.id;
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

  // No tier-match check. A gift is N months of a tier; what it buys the recipient is decided
  // when they accept it, against whatever membership they hold then.
  const giftability = await getRecipientGiftability({ recipientUserId });
  if (giftability.status === 'blocked' && giftability.reason === 'unsupported-provider') {
    throw throwBadRequestError("This user's membership cannot receive gifted months");
  }

  const { productId, unitAmount, currency } = await getTierMonthlyPrice(tier);

  const gift = await dbWrite.membershipGift.create({
    data: {
      gifterId,
      recipientId: recipientUserId,
      holderId: recipientUserId,
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

/**
 * Records the gifter's payment and puts the gift in the recipient's queue. Called from the
 * Stripe webhook on checkout.session.completed — must be safe to re-run (Stripe retries on
 * non-2xx), so anything past Pending/Failed bails early.
 *
 * Deliberately applies NOTHING. Acceptance is the recipient's action.
 */
export async function fulfillMembershipGift({
  giftId,
  paymentIntentId,
}: {
  giftId: string;
  paymentIntentId?: string;
}) {
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

  await dbWrite.membershipGift.update({
    where: { id: gift.id },
    data: {
      status: MembershipGiftStatus.Fulfilled,
      fulfilledAt: new Date(),
      monthsRemaining: gift.months,
      monthsConsumed: 0,
      ...(paymentIntentId && gift.stripePaymentIntentId !== paymentIntentId
        ? { stripePaymentIntentId: paymentIntentId }
        : {}),
    },
  });

  await createNotification({
    type: 'membership-gift-received',
    userId: gift.holderId,
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

  // Mail is best-effort: the gift is already recorded, and throwing here would make the
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

  await log({ type: 'info', stage: 'fulfillment', giftId: gift.id, queuedFor: gift.holderId });

  return { fulfilled: true as const, queued: true as const };
}

export type GiftOffer =
  | { kind: 'free-months'; tier: string; months: number }
  | { kind: 'switch-and-free-months'; tier: string; months: number; fromTier: string }
  | {
      kind: 'value-discount';
      tier: string;
      months: number;
      amountPerMonth: number;
      currency: string;
    }
  | { kind: 'free-subscription'; tier: string; months: number };

/**
 * What accepting this gift will do, decided from the holder's membership right now.
 *
 *   gift tier >  yours  → we move you up and the months are free (never a partial discount:
 *                         a $50 gift against a $10 bill would burn $40 a month)
 *   gift tier == yours  → the months are free
 *   gift tier <  yours  → the gift's monthly value comes off your bill; we never offer to
 *                         move you down
 *   no membership       → a free subscription at the gift's tier
 */
export async function getGiftOffer({
  giftId,
  userId,
}: {
  giftId: string;
  userId: number;
}): Promise<GiftOffer> {
  const gift = await dbWrite.membershipGift.findUnique({
    where: { id: giftId },
    select: {
      id: true,
      holderId: true,
      tier: true,
      status: true,
      monthsRemaining: true,
      months: true,
    },
  });
  if (!gift || gift.holderId !== userId) throw throwNotFoundError('Gift not found');

  const months = gift.monthsRemaining || gift.months;
  const subscription = await getGreenSubscription(userId);
  const live = subscription && !TERMINAL_STATUSES.includes(subscription.status);
  if (!live) return { kind: 'free-subscription', tier: gift.tier, months };

  const holderTier = (subscription.product.metadata as SubscriptionProductMetadata).tier ?? 'free';
  if (tierRank(holderTier) > tierRank(gift.tier)) {
    const { pricesByCurrency, unitAmount, currency } = await getTierMonthlyPrice(gift.tier);
    const subCurrency = subscription.price.currency ?? currency;
    return {
      kind: 'value-discount',
      tier: gift.tier,
      months,
      amountPerMonth: pricesByCurrency[subCurrency] ?? unitAmount,
      currency: subCurrency,
    };
  }
  if (tierRank(holderTier) < tierRank(gift.tier)) {
    return { kind: 'switch-and-free-months', tier: gift.tier, months, fromTier: holderTier };
  }
  return { kind: 'free-months', tier: gift.tier, months };
}

/**
 * Accept a gift. Starts consuming it — the first month is armed immediately, the rest as
 * each one is used up. Nothing about how the remaining months apply is decided here.
 */
export async function acceptMembershipGift({ giftId, userId }: { giftId: string; userId: number }) {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');

  const gift = await dbWrite.membershipGift.findUnique({ where: { id: giftId } });
  if (!gift || gift.holderId !== userId) throw throwNotFoundError('Gift not found');
  if (gift.status === MembershipGiftStatus.Active) return { accepted: true as const };
  if (gift.status !== MembershipGiftStatus.Fulfilled)
    throw throwBadRequestError('This gift is not available to accept');
  if (gift.expiresAt && gift.expiresAt < new Date())
    throw throwBadRequestError('This gift has expired');

  const subscription = await getGreenSubscription(userId);
  const live = subscription && !TERMINAL_STATUSES.includes(subscription.status);
  if (live && subscription.product.provider !== PaymentProvider.Stripe)
    throw throwBadRequestError('This membership is not managed by Stripe');

  // Moving the holder UP to the gifted tier is the one thing acceptance itself does, and it
  // happens once rather than per month. proration_behavior 'none' means Stripe raises no
  // invoice for the change — the accept click is what consents to the new recurring price.
  if (live) {
    const holderTier =
      (subscription.product.metadata as SubscriptionProductMetadata).tier ?? 'free';
    if (tierRank(holderTier) < tierRank(gift.tier)) {
      const stripeSub = await stripe.subscriptions.retrieve(subscription.id);
      if (!TERMINAL_STATUSES.includes(stripeSub.status)) {
        const priceId = await getTierPriceIdForCurrency(gift.tier, stripeSub.currency);
        await stripe.subscriptions.update(stripeSub.id, {
          items: [{ id: stripeSub.items.data[0].id, price: priceId }],
          proration_behavior: 'none',
        });
      }
    }
  }

  await dbWrite.membershipGift.update({
    where: { id: gift.id },
    data: {
      status: MembershipGiftStatus.Active,
      acceptedAt: new Date(),
      monthsRemaining: gift.monthsRemaining || gift.months,
    },
  });

  await armNextGiftMonth({ userId });
  await invalidateSubscriptionCaches(userId);
  await refreshSession(userId, { caller: 'membership' });

  await log({ type: 'info', stage: 'accept', giftId: gift.id, userId });
  return { accepted: true as const };
}

const monthCouponId = (giftId: string, monthIndex: number) => `gift_${giftId}_m${monthIndex}`;

/**
 * Put ONE month of the holder's next open gift onto their subscription.
 *
 * At most one gifted month is ever live in Stripe. Everything else — how many months are
 * left, which gift is next — lives on our rows, which is what makes a cancellation
 * mid-gift recoverable instead of destroying the unused months.
 */
export async function armNextGiftMonth({ userId }: { userId: number }) {
  const stripe = await getServerStripe();
  if (!stripe) return { armed: false as const, reason: 'stripe-unavailable' };

  const gifts = await dbWrite.membershipGift.findMany({
    where: {
      holderId: userId,
      status: MembershipGiftStatus.Active,
      monthsRemaining: { gt: 0 },
    },
    orderBy: [{ acceptedAt: 'asc' }, { createdAt: 'asc' }],
  });
  if (!gifts.length) return { armed: false as const, reason: 'nothing-to-arm' };

  // A gift already holding the discount slot means this month is armed; don't stack.
  if (gifts.some((g) => !!g.armedCouponId))
    return { armed: false as const, reason: 'already-armed' };

  const gift = gifts[0];
  const subscription = await getGreenSubscription(userId);
  const live = subscription && !TERMINAL_STATUSES.includes(subscription.status);
  if (!live) return mintResidualSubscription({ stripe, giftId: gift.id });

  if (subscription.product.provider !== PaymentProvider.Stripe)
    return { armed: false as const, reason: 'unsupported-provider' };

  const stripeSub = await stripe.subscriptions.retrieve(subscription.id);
  if (TERMINAL_STATUSES.includes(stripeSub.status))
    return mintResidualSubscription({ stripe, giftId: gift.id });
  if (!EXTENDABLE_STATUSES.includes(stripeSub.status))
    return { armed: false as const, reason: `subscription-status-${stripeSub.status}` };

  // Applying a coupon REPLACES whatever discount is there, with no error and no warning
  // from Stripe. Refuse rather than destroy someone's existing discount.
  if (stripeSub.discount) {
    await log({
      type: 'warning',
      stage: 'arm',
      giftId: gift.id,
      userId,
      message: `subscription ${stripeSub.id} already carries discount ${stripeSub.discount.coupon?.id}; not arming`,
    });
    return { armed: false as const, reason: 'slot-occupied' };
  }

  const holderTier = (subscription.product.metadata as SubscriptionProductMetadata).tier ?? 'free';
  const couponId = monthCouponId(gift.id, gift.monthsConsumed + 1);
  const coupon = await getOrCreateMonthCoupon({
    stripe,
    couponId,
    gift,
    holderTier,
    subCurrency: stripeSub.currency,
  });

  await stripe.subscriptions.update(stripeSub.id, { coupon: coupon.id });
  await dbWrite.membershipGift.update({
    where: { id: gift.id },
    data: { armedCouponId: coupon.id, armedAt: new Date() },
  });

  await log({
    type: 'info',
    stage: 'arm',
    giftId: gift.id,
    userId,
    couponId: coupon.id,
    month: gift.monthsConsumed + 1,
  });
  return { armed: true as const, giftId: gift.id, couponId: coupon.id };
}

async function getOrCreateMonthCoupon({
  stripe,
  couponId,
  gift,
  holderTier,
  subCurrency,
}: {
  stripe: Stripe;
  couponId: string;
  gift: { id: string; tier: string };
  holderTier: string;
  subCurrency: string;
}) {
  // The id is derived from (gift, month), so a retry re-uses the coupon instead of minting
  // a second one for the same month.
  const existing = await stripe.coupons.retrieve(couponId).catch(() => null);
  if (existing) return existing;

  const base = {
    id: couponId,
    duration: 'once' as const,
    max_redemptions: 1,
    name: `Gifted ${gift.tier} month`,
    metadata: { giftId: gift.id },
  };

  if (tierRank(holderTier) <= tierRank(gift.tier)) {
    return stripe.coupons.create({ ...base, percent_off: 100 });
  }

  const { pricesByCurrency } = await getTierMonthlyPrice(gift.tier);
  const amountOff = pricesByCurrency[subCurrency];
  if (!amountOff) {
    // An amount_off in the wrong currency does not apply — Stripe accepts the coupon and
    // then silently discounts nothing. Refuse instead.
    throw throwBadRequestError(
      `No ${gift.tier} price in ${subCurrency} to value this gifted month against`
    );
  }
  return stripe.coupons.create({
    ...base,
    amount_off: amountOff,
    currency: subCurrency,
    // Invisible when read back on our API version, but Stripe stores and applies it — so a
    // holder who switches billing currency mid-gift still gets the right amount.
    currency_options: Object.fromEntries(
      Object.entries(pricesByCurrency)
        .filter(([c]) => c !== subCurrency)
        .map(([c, amount]) => [c, { amount_off: amount }])
    ),
  });
}

/**
 * A gifted month was actually billed. Called from the Stripe webhook on invoice.paid.
 *
 * Consumption is counted here rather than when the month is armed: an armed month on a
 * subscription that gets cancelled before its next invoice is never used, and decrementing
 * at arm time would silently eat it.
 */
export async function recordGiftMonthConsumed({ invoice }: { invoice: Stripe.Invoice }) {
  const couponId = invoice.discount?.coupon?.id;
  if (!couponId) return { consumed: false as const };

  const gift = await dbWrite.membershipGift.findFirst({
    where: { armedCouponId: couponId, status: MembershipGiftStatus.Active },
  });
  if (!gift) return { consumed: false as const };

  const monthsRemaining = Math.max(0, gift.monthsRemaining - 1);
  await dbWrite.membershipGift.update({
    where: { id: gift.id },
    data: {
      monthsRemaining,
      monthsConsumed: gift.monthsConsumed + 1,
      // Clearing this is what makes a webhook redelivery a no-op.
      armedCouponId: null,
      armedAt: null,
      ...(monthsRemaining === 0 ? { status: MembershipGiftStatus.Completed } : {}),
    },
  });

  await log({
    type: 'info',
    stage: 'consume',
    giftId: gift.id,
    userId: gift.holderId,
    invoiceId: invoice.id,
    monthsRemaining,
  });

  // Arm the next month straight away — the next one of THIS gift, or the first of whichever
  // gift is next in the queue. The slot is free either way, which is why two gifts never
  // contend for it.
  await armNextGiftMonth({ userId: gift.holderId });

  return { consumed: true as const, giftId: gift.id, monthsRemaining };
}

/**
 * The holder has no live subscription, so the months they are still owed become a free one
 * at the gift's tier that ends when they run out.
 *
 * This delivers the gift in full and completes it. There is nothing left to meter: the
 * subscription is free for exactly the months owed and then cancels itself.
 */
async function mintResidualSubscription({ stripe, giftId }: { stripe: Stripe; giftId: string }) {
  const gift = await dbWrite.membershipGift.findUnique({
    where: { id: giftId },
    include: { holder: { select: { id: true, email: true } } },
  });
  if (!gift || gift.monthsRemaining <= 0)
    return { armed: false as const, reason: 'nothing-to-mint' };
  if (!gift.holder.email)
    return {
      armed: false as const,
      reason: 'holder has no email — cannot create a Stripe customer',
    };

  const { priceId, currency } = await getTierMonthlyPrice(gift.tier);
  const customerId = await createCustomer({ id: gift.holderId, email: gift.holder.email });
  const couponId = `gift_${gift.id}_residual`;
  const coupon =
    (await stripe.coupons.retrieve(couponId).catch(() => null)) ??
    (await stripe.coupons.create({
      id: couponId,
      percent_off: 100,
      duration: 'repeating',
      duration_in_months: gift.monthsRemaining,
      max_redemptions: 1,
      name: `Gifted ${gift.tier} membership (${gift.monthsRemaining}mo)`,
      metadata: { giftId: gift.id },
    }));

  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    coupon: coupon.id,
    cancel_at: dayjs().add(gift.monthsRemaining, 'month').unix(),
    // Every invoice inside the window is $0, so no payment method is needed; if Stripe ever
    // computed a non-zero amount the sub parks as `incomplete` instead of charging.
    payment_behavior: 'default_incomplete',
    metadata: { membershipGiftId: gift.id, membershipGift: 'true' },
  });

  await dbWrite.membershipGift.update({
    where: { id: gift.id },
    data: {
      status: MembershipGiftStatus.Completed,
      monthsConsumed: gift.monthsConsumed + gift.monthsRemaining,
      monthsRemaining: 0,
      armedCouponId: null,
      armedAt: null,
      stripeCouponId: coupon.id,
      stripeSubscriptionId: subscription.id,
    },
  });

  await invalidateSubscriptionCaches(gift.holderId);
  await refreshSession(gift.holderId, { caller: 'membership' });

  await log({
    type: 'info',
    stage: 'residual',
    giftId: gift.id,
    userId: gift.holderId,
    months: gift.monthsRemaining,
    stripeSubscriptionId: subscription.id,
    currency,
  });

  return { armed: true as const, residual: true as const, subscriptionId: subscription.id };
}

/**
 * A holder's subscription ended with gifted months still owed. Called from the subscription
 * webhook — hands them the remainder as a free membership rather than letting it evaporate.
 */
export async function honorGiftResidualsForUser({ userId }: { userId: number }) {
  const stripe = await getServerStripe();
  if (!stripe) return { minted: 0 };

  const gifts = await dbWrite.membershipGift.findMany({
    where: { holderId: userId, status: MembershipGiftStatus.Active, monthsRemaining: { gt: 0 } },
    orderBy: [{ acceptedAt: 'asc' }],
    select: { id: true },
  });
  if (!gifts.length) return { minted: 0 };

  // Only the first: it creates a live subscription, and the rest arm against that one.
  await mintResidualSubscription({ stripe, giftId: gifts[0].id });
  return { minted: 1 };
}

/**
 * Backstop for the event-driven arming. If `invoice.paid` was missed or an arm failed, a
 * holder can sit with months owed and nothing on their subscription — which bills them full
 * price for a month we owe them.
 */
export async function sweepGiftArming({ limit = 200 }: { limit?: number } = {}) {
  const pending = await dbWrite.membershipGift.findMany({
    where: {
      status: MembershipGiftStatus.Active,
      monthsRemaining: { gt: 0 },
      armedCouponId: null,
    },
    select: { holderId: true },
    distinct: ['holderId'],
    take: limit,
  });

  let armed = 0;
  for (const { holderId } of pending) {
    const result = await armNextGiftMonth({ userId: holderId }).catch((error) => {
      log({
        type: 'error',
        stage: 'sweep',
        userId: holderId,
        message: `arming failed: ${String(error)}`,
      });
      return null;
    });
    if (result?.armed) armed++;
  }

  await log({ type: 'info', stage: 'sweep', candidates: pending.length, armed });
  return { candidates: pending.length, armed };
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

  // A gift that was never accepted has touched nothing in Stripe — the row is the whole state.
  if (gift.armedCouponId || gift.stripeSubscriptionId) {
    const subscription = gift.stripeSubscriptionId
      ? await stripe.subscriptions.retrieve(gift.stripeSubscriptionId).catch(() => null)
      : null;

    if (subscription && !TERMINAL_STATUSES.includes(subscription.status)) {
      if (subscription.metadata?.membershipGiftId === gift.id) {
        // Residual subscription — it exists only because of this payment
        await stripe.subscriptions.del(subscription.id);
      }
    }

    if (gift.armedCouponId) {
      const holderSub = await getGreenSubscription(gift.holderId);
      if (holderSub && !TERMINAL_STATUSES.includes(holderSub.status)) {
        const live = await stripe.subscriptions.retrieve(holderSub.id).catch(() => null);
        if (live?.discount?.coupon?.id === gift.armedCouponId) {
          await stripe.subscriptions.deleteDiscount(live.id);
        }
      }
      await stripe.coupons.del(gift.armedCouponId).catch(() => null);
    }

    if (gift.stripeCouponId) await stripe.coupons.del(gift.stripeCouponId).catch(() => null);
  }

  await dbWrite.membershipGift.update({
    where: { id: gift.id },
    data: {
      status: newStatus,
      monthsRemaining: 0,
      armedCouponId: null,
      armedAt: null,
    },
  });

  await invalidateSubscriptionCaches(gift.holderId);
  await refreshSession(gift.holderId, { caller: 'membership' });

  await log({ type: 'warning', stage: 'revoke', giftId: gift.id, reason, paymentIntentId });

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
  await refreshSession(userId, { caller: 'membership' });

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
      where: {
        holderId: userId,
        status: {
          in: [
            MembershipGiftStatus.Fulfilled,
            MembershipGiftStatus.Active,
            MembershipGiftStatus.Completed,
          ],
        },
      },
      select: {
        id: true,
        tier: true,
        months: true,
        message: true,
        anonymous: true,
        status: true,
        monthsRemaining: true,
        monthsConsumed: true,
        acceptedAt: true,
        expiresAt: true,
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
      pending: g.status === MembershipGiftStatus.Fulfilled,
      gifter: g.anonymous ? null : g.gifter,
    })),
  };
}
