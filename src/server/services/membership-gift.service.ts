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
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
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
// Tags the cancellation of a residual subscription we end ourselves, so its deletion webhook
// does not hand the months back.
const GIFT_REVOKED_CANCELLATION = 'membership-gift-revoked';

// A gift fulfilled before gifts had to be accepted was applied in full when it was paid. It is
// still 'Fulfilled' until the migration's second part runs, and it has no months left to give.
const isAwaitingAcceptance = (gift: { status: MembershipGiftStatus; monthsRemaining: number }) =>
  gift.status === MembershipGiftStatus.Fulfilled && gift.monthsRemaining > 0;

// A gifted month is priced against one month of billing. On any other interval the next invoice
// is not a month, so the gift is applied as its cash value instead of as free time.
const isBilledMonthly = (subscription: { price: { interval: string | null } }) =>
  subscription.price.interval === 'month';

// Stripe caps a discount at the invoice total and drops the rest, so a renewal is only ever
// handed the whole months it can absorb; the others stay on the gift for the renewal after.
const monthsCoveredByRenewal = ({
  renewalAmount,
  monthlyValue,
  monthsRemaining,
}: {
  renewalAmount: number;
  monthlyValue: number;
  monthsRemaining: number;
}) => Math.min(monthsRemaining, Math.max(1, Math.floor(renewalAmount / monthlyValue)));

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
  // The message is emailed to the recipient, another user.
  await throwOnBlockedUserContent(message, { surface: 'membership-gift' });

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
      // A bank debit can be reversed as unauthorized weeks after it succeeds, long after the
      // recipient has the membership.
      payment_method_types: ['card'],
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

type GiftCheckoutEventType =
  | 'checkout.session.completed'
  | 'checkout.session.async_payment_succeeded'
  | 'checkout.session.async_payment_failed';

/**
 * A gift checkout's payment moved. Checkout completes 'unpaid' for a delayed payment method
 * (a bank debit), whose money arrives days later or never, so the gift is only fulfilled once
 * the payment has actually succeeded.
 */
export async function handleMembershipGiftCheckoutEvent({
  type,
  session,
}: {
  type: GiftCheckoutEventType;
  session: Stripe.Checkout.Session;
}) {
  const giftId = session.metadata?.giftId;
  if (!giftId) throw new Error('membershipGift checkout session missing giftId');

  if (type === 'checkout.session.async_payment_failed') {
    const revoked = await revokeMembershipGift({ giftId, reason: 'payment_failed' });
    if (!revoked) throw throwNotFoundError(`MembershipGift not found: ${giftId}`);
    return revoked;
  }

  const paid =
    type === 'checkout.session.async_payment_succeeded' || session.payment_status === 'paid';
  if (!paid) {
    // Gift checkout offers no promotion codes, so a gift that needed no payment is unexpected.
    if (session.payment_status === 'no_payment_required')
      await log({
        type: 'warning',
        stage: 'checkout',
        giftId,
        message: 'gift checkout completed without a payment; not fulfilled',
      });
    return { fulfilled: false as const, paymentStatus: session.payment_status };
  }

  return fulfillMembershipGift({
    giftId,
    paymentIntentId:
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id,
  });
}

/**
 * Records the gifter's payment and puts the gift in the recipient's queue. Must be safe to
 * re-run (Stripe retries on non-2xx), so anything past Pending bails early. A Failed gift's
 * payment can never clear, so it is never fulfilled.
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

  if (gift.status !== MembershipGiftStatus.Pending) return { alreadyProcessed: true as const };

  // Stripe can deliver the same success concurrently, and both deliveries read Pending above.
  const { count } = await dbWrite.membershipGift.updateMany({
    where: { id: gift.id, status: MembershipGiftStatus.Pending },
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
  if (count === 0) return { alreadyProcessed: true as const };

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
  | { kind: 'renewal-discount'; tier: string; months: number; amount: number; currency: string }
  | { kind: 'free-subscription'; tier: string; months: number };

/**
 * What accepting this gift will do, decided from the holder's membership right now.
 *
 *   gift tier >  yours  → we move you up and the months are free (never a partial discount:
 *                         a $50 gift against a $10 bill would burn $40 a month)
 *   gift tier == yours  → the months are free
 *   gift tier <  yours  → the gift's monthly value comes off your bill; we never offer to
 *                         move you down
 *   not billed monthly  → the gift's whole value comes off your renewals, whatever the tiers
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
    },
  });
  if (!gift || gift.holderId !== userId) throw throwNotFoundError('Gift not found');
  if (gift.monthsRemaining <= 0) throw throwBadRequestError('This gift has already been used');

  const months = gift.monthsRemaining;
  const subscription = await getGreenSubscription(userId);
  const live = subscription && !TERMINAL_STATUSES.includes(subscription.status);
  if (!live) return { kind: 'free-subscription', tier: gift.tier, months };

  if (!isBilledMonthly(subscription)) {
    const { pricesByCurrency, unitAmount, currency } = await getTierMonthlyPrice(gift.tier);
    const subCurrency = subscription.price.currency ?? currency;
    return {
      kind: 'renewal-discount',
      tier: gift.tier,
      months,
      amount: (pricesByCurrency[subCurrency] ?? unitAmount) * months,
      currency: subCurrency,
    };
  }

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
  if (!isAwaitingAcceptance(gift))
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
  // Only for monthly billing: swapping a yearly price for a monthly one restarts their billing.
  if (live && isBilledMonthly(subscription)) {
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
    data: { status: MembershipGiftStatus.Active, acceptedAt: new Date() },
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
 *
 * A subscription that is not billed monthly is the exception: its next invoice takes the cash
 * value of as many whole months as it can absorb, in one coupon.
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
  // A held upgrade changes the plan when it is paid, so a month armed now would be priced for the
  // wrong plan. The webhook that applies or drops the change, or the sweep, arms it afterwards.
  if (stripeSub.pending_update) return { armed: false as const, reason: 'plan-change-pending' };

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
  const billedMonthly = isBilledMonthly(subscription);
  let months = 1;
  if (!billedMonthly) {
    const { pricesByCurrency } = await getTierMonthlyPrice(gift.tier);
    const monthlyValue = pricesByCurrency[stripeSub.currency];
    if (monthlyValue)
      months = monthsCoveredByRenewal({
        renewalAmount: stripeSub.items.data[0]?.price.unit_amount ?? 0,
        monthlyValue,
        monthsRemaining: gift.monthsRemaining,
      });
  }
  const firstMonth = gift.monthsConsumed + 1;
  const coupon = await getOrCreateMonthCoupon({
    stripe,
    couponId: billedMonthly
      ? monthCouponId(gift.id, firstMonth)
      : `${monthCouponId(gift.id, firstMonth)}_x${months}`,
    gift,
    months,
    asCashValue: !billedMonthly || tierRank(holderTier) > tierRank(gift.tier),
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
    month: firstMonth,
    months,
  });
  return { armed: true as const, giftId: gift.id, couponId: coupon.id };
}

async function getOrCreateMonthCoupon({
  stripe,
  couponId,
  gift,
  months,
  asCashValue,
  subCurrency,
}: {
  stripe: Stripe;
  couponId: string;
  gift: { id: string; tier: string };
  months: number;
  asCashValue: boolean;
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
    name: months === 1 ? `Gifted ${gift.tier} month` : `Gifted ${gift.tier} months (${months})`,
    metadata: { giftId: gift.id, months: String(months) },
  };

  if (!asCashValue) return stripe.coupons.create({ ...base, percent_off: 100 });

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
    amount_off: amountOff * months,
    currency: subCurrency,
    // Invisible when read back on our API version, but Stripe stores and applies it — so a
    // holder who switches billing currency mid-gift still gets the right amount.
    currency_options: Object.fromEntries(
      Object.entries(pricesByCurrency)
        .filter(([c]) => c !== subCurrency)
        .map(([c, amount]) => [c, { amount_off: amount * months }])
    ),
  });
}

/**
 * Detach the armed month from the holder's gift ahead of a plan change, without counting it as
 * used. It was priced for the plan they are leaving, and a plan change can raise an invoice
 * straight away.
 *
 * Touches only our row and the coupon object: the caller clears the discount in the same Stripe
 * call that changes the plan, so there is no moment where it is gone and the plan is unchanged.
 * The month is armed again, for the new plan, once the subscription webhook lands.
 */
export async function releaseArmedGiftMonth({ userId }: { userId: number }) {
  const gift = await dbWrite.membershipGift.findFirst({
    where: {
      holderId: userId,
      status: MembershipGiftStatus.Active,
      armedCouponId: { not: null },
    },
    select: { id: true, armedCouponId: true },
  });
  if (!gift?.armedCouponId) return null;

  await dbWrite.membershipGift.update({
    where: { id: gift.id },
    data: { armedCouponId: null, armedAt: null },
  });
  // Deleting a coupon leaves it on subscriptions already carrying it; this frees its id so the
  // same month can be armed again with different terms.
  const stripe = await getServerStripe();
  await stripe?.coupons.del(gift.armedCouponId).catch(() => null);

  await log({
    type: 'info',
    stage: 'release',
    giftId: gift.id,
    userId,
    couponId: gift.armedCouponId,
  });
  return { giftId: gift.id, couponId: gift.armedCouponId };
}

/** The plan change failed, so the discount is still on the subscription: point the gift back at it. */
export async function restoreArmedGiftMonth({
  giftId,
  couponId,
}: {
  giftId: string;
  couponId: string;
}) {
  await dbWrite.membershipGift.update({
    where: { id: giftId },
    data: { armedCouponId: couponId, armedAt: new Date() },
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

  const monthsUsed = Math.min(
    gift.monthsRemaining,
    Number(invoice.discount?.coupon?.metadata?.months) || 1
  );
  const monthsRemaining = gift.monthsRemaining - monthsUsed;
  await dbWrite.membershipGift.update({
    where: { id: gift.id },
    data: {
      monthsRemaining,
      monthsConsumed: gift.monthsConsumed + monthsUsed,
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
 * The gift is completed here, but the months stay recoverable: if the subscription ends before
 * they run out, `restoreUndeliveredResidualMonths` puts the rest back on the gift.
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
  // Keyed on the first month it covers: a retry re-uses it, and a gift restored after an early
  // cancel needs a fresh one, because the first is single-use and sized for the old remainder.
  const couponId = `gift_${gift.id}_residual_m${gift.monthsConsumed + 1}`;
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

  const subscription = await stripe.subscriptions.create(
    {
      customer: customerId,
      items: [{ price: priceId }],
      coupon: coupon.id,
      cancel_at: dayjs().add(gift.monthsRemaining, 'month').unix(),
      // Every invoice inside the window is $0, so no payment method is needed; if Stripe ever
      // computed a non-zero amount the sub parks as `incomplete` instead of charging.
      payment_behavior: 'default_incomplete',
      metadata: {
        membershipGiftId: gift.id,
        membershipGift: 'true',
        residualMonths: String(gift.monthsRemaining),
      },
    },
    // A mint that failed after this call is retried with the same coupon id; without the key
    // the retry would open a second free subscription.
    { idempotencyKey: couponId }
  );

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
 * A residual subscription ended before the months it was minted for ran out — the holder
 * cancelled it, and Stripe moved its end to the current period end. Put the months it never
 * delivered back on the gift, which the residual mint had already completed.
 *
 * Every billing period that started counts as delivered — its invoice already granted the
 * month's Buzz — so each early end uses up at least one month and repeated cancels run the
 * gift down instead of renewing it forever.
 */
export async function restoreUndeliveredResidualMonths({
  subscription,
}: {
  subscription: Stripe.Subscription;
}) {
  const giftId = subscription.metadata?.membershipGiftId;
  if (!giftId) return { restored: 0 };
  if (subscription.cancellation_details?.comment === GIFT_REVOKED_CANCELLATION)
    return { restored: 0 };

  // Residual subscriptions minted before `residualMonths` was recorded carry it on the coupon.
  const mintedMonths =
    Number(subscription.metadata.residualMonths) ||
    subscription.discount?.coupon?.duration_in_months ||
    0;
  const endedAt = subscription.ended_at ?? subscription.canceled_at;
  if (!mintedMonths || !endedAt) return { restored: 0 };

  // A day of slack keeps a period that ended on its boundary from counting the next one as
  // started.
  const monthsElapsed = dayjs
    .unix(endedAt)
    .subtract(1, 'day')
    .diff(dayjs.unix(subscription.start_date), 'month', true);
  const delivered = Math.max(1, Math.ceil(monthsElapsed));
  const owed = mintedMonths - delivered;
  if (owed <= 0) return { restored: 0 };

  const gift = await dbWrite.membershipGift.findUnique({
    where: { id: giftId },
    select: {
      id: true,
      holderId: true,
      monthsConsumed: true,
      stripeCouponId: true,
      holder: { select: { bannedAt: true, deletedAt: true } },
    },
  });
  if (!gift) return { restored: 0 };
  // Banning or deleting an account cancels its subscription; that must not mint a new one.
  if (gift.holder.bannedAt || gift.holder.deletedAt) return { restored: 0 };

  // Guarded on the subscription it was completed by, so a redelivered deletion — or one for an
  // older residual of a gift that has since been minted again — changes nothing.
  const { count } = await dbWrite.membershipGift.updateMany({
    where: {
      id: gift.id,
      status: MembershipGiftStatus.Completed,
      stripeSubscriptionId: subscription.id,
    },
    data: {
      status: MembershipGiftStatus.Active,
      monthsRemaining: owed,
      monthsConsumed: Math.max(0, gift.monthsConsumed - owed),
    },
  });
  if (!count) return { restored: 0 };

  if (gift.stripeCouponId) {
    const stripe = await getServerStripe();
    await stripe?.coupons.del(gift.stripeCouponId).catch(() => null);
  }

  await log({
    type: 'warning',
    stage: 'residual-restore',
    giftId: gift.id,
    userId: gift.holderId,
    stripeSubscriptionId: subscription.id,
    mintedMonths,
    delivered,
    restored: owed,
  });
  return { restored: owed, giftId: gift.id };
}

/**
 * A holder's subscription ended with gifted months still owed. Called from the subscription
 * webhook — hands them the remainder as a free membership rather than letting it evaporate.
 * When the subscription that ended was itself a residual one, its undelivered months are
 * restored first, so they are owed again.
 */
export async function honorGiftResidualsForUser({
  userId,
  endedSubscription,
}: {
  userId: number;
  endedSubscription?: Stripe.Subscription;
}) {
  const stripe = await getServerStripe();
  if (!stripe) return { minted: 0 };

  if (endedSubscription)
    await restoreUndeliveredResidualMonths({ subscription: endedSubscription });

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

const revokedStatus = {
  refund: MembershipGiftStatus.Refunded,
  chargeback: MembershipGiftStatus.Revoked,
  payment_failed: MembershipGiftStatus.Failed,
} as const;

/**
 * Undo a gift after a refund, chargeback or failed payment on the gifter's payment.
 * Best-effort by design: Buzz already granted for elapsed months is not clawed back.
 * Returns false when no gift matches.
 */
export async function revokeMembershipGift({
  reason,
  ...by
}: { reason: keyof typeof revokedStatus } & ({ paymentIntentId: string } | { giftId: string })) {
  const gift = await dbWrite.membershipGift.findUnique({
    where: 'giftId' in by ? { id: by.giftId } : { stripePaymentIntentId: by.paymentIntentId },
  });
  if (!gift) return false;

  const newStatus = revokedStatus[reason];

  if (Object.values(revokedStatus).some((status) => status === gift.status)) return true;

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
        await stripe.subscriptions.del(subscription.id, {
          cancellation_details: { comment: GIFT_REVOKED_CANCELLATION },
        });
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

  await log({
    type: 'warning',
    stage: 'revoke',
    giftId: gift.id,
    reason,
    paymentIntentId: gift.stripePaymentIntentId,
  });

  return true;
}

const REVOKED_STATUSES: MembershipGiftStatus[] = Object.values(revokedStatus);
// A PaymentIntent in one of these holds no money and can still be cancelled.
const UNFUNDED_PI_STATUSES: Stripe.PaymentIntent.Status[] = [
  'requires_payment_method',
  'requires_action',
  'requires_confirmation',
];

async function getGiftPaymentIntent(
  stripe: Stripe,
  gift: { stripePaymentIntentId: string | null; stripeCheckoutSessionId: string | null }
) {
  let paymentIntentId = gift.stripePaymentIntentId;
  if (!paymentIntentId && gift.stripeCheckoutSessionId) {
    const session = await stripe.checkout.sessions.retrieve(gift.stripeCheckoutSessionId);
    paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id ?? null;
  }
  if (!paymentIntentId) return null;
  return stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
}

/** Why money may already be on its way for an unfulfilled payment, or null when none is. */
async function findFundsInFlight(stripe: Stripe, pi: Stripe.PaymentIntent) {
  if (pi.amount_received > 0) return 'partially-funded';
  const remaining = pi.next_action?.display_bank_transfer_instructions?.amount_remaining;
  if (remaining != null && remaining !== pi.amount) return 'partially-funded';
  // A bank transfer lands in the customer's cash balance first and is applied to the payment from
  // there, so money sitting in it may be this gift's, waiting to be reconciled.
  if (pi.payment_method_types.includes('customer_balance') && pi.customer) {
    const customerId = typeof pi.customer === 'string' ? pi.customer : pi.customer.id;
    const cash = await stripe.customers.retrieveCashBalance(customerId);
    if ((cash.available?.[pi.currency] ?? 0) > 0) return 'unapplied-cash-balance';
  }
  return null;
}

export type GiftRevocationEffect =
  | { kind: 'residual-subscription-ends'; subscriptionId: string; cancelAt: number | null }
  | {
      kind: 'discount-removed';
      subscriptionId: string;
      renewsAt: number;
      fullPriceAmount: number | null;
      currency: string;
      hasPaymentMethod: boolean;
    }
  | { kind: 'queued-months-removed'; monthsRemaining: number }
  | { kind: 'unaccepted-offer-withdrawn'; monthsRemaining: number }
  | { kind: 'nothing-live' };

/** What revoking this gift takes away from its holder, read from live Stripe. */
async function describeRevocationEffect(
  stripe: Stripe,
  gift: {
    id: string;
    holderId: number;
    status: MembershipGiftStatus;
    monthsRemaining: number;
    armedCouponId: string | null;
    stripeSubscriptionId: string | null;
  }
): Promise<GiftRevocationEffect> {
  if (gift.stripeSubscriptionId) {
    const sub = await stripe.subscriptions.retrieve(gift.stripeSubscriptionId).catch(() => null);
    if (
      sub &&
      !TERMINAL_STATUSES.includes(sub.status) &&
      sub.metadata?.membershipGiftId === gift.id
    )
      return {
        kind: 'residual-subscription-ends',
        subscriptionId: sub.id,
        cancelAt: sub.cancel_at,
      };
  }

  if (gift.armedCouponId) {
    const holderSub = await getGreenSubscription(gift.holderId);
    const live =
      holderSub && !TERMINAL_STATUSES.includes(holderSub.status)
        ? await stripe.subscriptions
            .retrieve(holderSub.id, { expand: ['customer'] })
            .catch(() => null)
        : null;
    if (live && live.discount?.coupon?.id === gift.armedCouponId) {
      const customer = live.customer as Stripe.Customer;
      const item = live.items.data[0];
      return {
        kind: 'discount-removed',
        subscriptionId: live.id,
        renewsAt: live.current_period_end,
        fullPriceAmount:
          item?.price.unit_amount != null ? item.price.unit_amount * (item.quantity ?? 1) : null,
        currency: live.currency,
        hasPaymentMethod:
          !!live.default_payment_method ||
          !!customer.invoice_settings?.default_payment_method ||
          !!customer.default_source,
      };
    }
  }

  if (gift.monthsRemaining > 0)
    return isAwaitingAcceptance(gift)
      ? { kind: 'unaccepted-offer-withdrawn', monthsRemaining: gift.monthsRemaining }
      : { kind: 'queued-months-removed', monthsRemaining: gift.monthsRemaining };

  return { kind: 'nothing-live' };
}

export type UnpaidGiftRevocation =
  | { outcome: 'not-found' }
  | { outcome: 'already-revoked'; status: MembershipGiftStatus }
  | {
      outcome: 'skipped';
      reason:
        | 'never-fulfilled'
        | 'no-payment-intent'
        | 'payment-mismatch'
        | 'payment-succeeded'
        | 'payment-processing'
        | 'payment-not-cancellable';
      paymentStatus?: string;
    }
  | {
      outcome: 'stopped';
      reason: 'partially-funded' | 'unapplied-cash-balance';
      paymentIntentId: string;
    }
  | {
      outcome: 'stopped';
      reason: 'holder-will-be-billed';
      paymentIntentId: string;
      effect: GiftRevocationEffect;
    }
  | {
      outcome: 'would-revoke' | 'revoked';
      paymentIntentId: string;
      paymentStatus: string;
      selfGift: boolean;
      effect: GiftRevocationEffect;
      notified: boolean;
    };

/**
 * Revoke a gift that was granted before its payment cleared, and cancel that payment so it can no
 * longer clear. Everything is decided from the gift row and live Stripe at call time, so a gifter
 * who has paid since is skipped, and money that has started to arrive stops the revoke for a
 * person to look at.
 *
 * Dry run unless `execute`. Re-running is a no-op for a gift already revoked.
 */
export async function revokeUnpaidMembershipGift({
  giftId,
  execute = false,
  notify = false,
}: {
  giftId: string;
  execute?: boolean;
  notify?: boolean;
}): Promise<UnpaidGiftRevocation> {
  const gift = await dbWrite.membershipGift.findUnique({ where: { id: giftId } });
  if (!gift) return { outcome: 'not-found' };
  if (REVOKED_STATUSES.includes(gift.status))
    return { outcome: 'already-revoked', status: gift.status };
  // Nothing was granted, so there is nothing to take back.
  if (gift.status === MembershipGiftStatus.Pending)
    return { outcome: 'skipped', reason: 'never-fulfilled' };

  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');

  const pi = await getGiftPaymentIntent(stripe, gift);
  if (!pi) return { outcome: 'skipped', reason: 'no-payment-intent' };
  if (pi.metadata?.giftId !== gift.id)
    return { outcome: 'skipped', reason: 'payment-mismatch', paymentStatus: pi.status };
  if (pi.status === 'succeeded')
    return { outcome: 'skipped', reason: 'payment-succeeded', paymentStatus: pi.status };
  if (pi.status === 'processing')
    return { outcome: 'skipped', reason: 'payment-processing', paymentStatus: pi.status };
  if (pi.status !== 'canceled' && !UNFUNDED_PI_STATUSES.includes(pi.status))
    return { outcome: 'skipped', reason: 'payment-not-cancellable', paymentStatus: pi.status };

  if (pi.status !== 'canceled') {
    const inFlight = await findFundsInFlight(stripe, pi);
    if (inFlight) return { outcome: 'stopped', reason: inFlight, paymentIntentId: pi.id };
  }

  const effect = await describeRevocationEffect(stripe, gift);
  // Removing a gifted month from a subscription the holder pays for bills their next renewal at full
  // price, which no notification here tells them about; that needs a person to decide.
  if (effect.kind === 'discount-removed')
    return { outcome: 'stopped', reason: 'holder-will-be-billed', paymentIntentId: pi.id, effect };
  const selfGift = gift.gifterId === gift.holderId;
  const plan = { paymentIntentId: pi.id, paymentStatus: pi.status, selfGift, effect };
  if (!execute) return { outcome: 'would-revoke', ...plan, notified: false };

  // Cancel first: once cancelled, a late transfer can no longer complete this payment, and Stripe
  // refuses to cancel one that has started to clear, which stops the revoke here.
  if (pi.status !== 'canceled')
    await stripe.paymentIntents.cancel(pi.id, { cancellation_reason: 'abandoned' });

  await revokeMembershipGift({ giftId: gift.id, reason: 'payment_failed' });

  const notified = notify && effect.kind !== 'nothing-live';
  if (notified)
    await createNotification({
      type: 'membership-gift-canceled',
      userId: gift.holderId,
      category: NotificationCategory.System,
      key: `membership-gift-canceled:${gift.id}`,
      details: {
        giftId: gift.id,
        tier: gift.tier,
        months: gift.months,
        selfGift,
      },
    });

  await log({
    type: 'warning',
    stage: 'revoke-unpaid',
    giftId: gift.id,
    paymentIntentId: pi.id,
    effect: effect.kind,
    notified,
  });

  return { outcome: 'revoked', ...plan, notified };
}

export type UnfulfilledGiftRefund =
  | { outcome: 'not-found' }
  | { outcome: 'already-refunded' }
  | {
      outcome: 'skipped';
      reason:
        | 'not-pending'
        | 'no-payment-intent'
        | 'payment-mismatch'
        | 'payment-not-succeeded'
        | 'nothing-refundable';
      status?: string;
    }
  | {
      outcome: 'would-refund' | 'refunded';
      paymentIntentId: string;
      chargeId: string;
      amount: number;
      currency: string;
      refundId?: string;
    };

/**
 * Refund a gift whose payment cleared but which was never fulfilled. The refund goes back to the
 * payment it came from, for whatever of that charge is still unrefunded; the `charge.refunded`
 * webhook then marks the gift Refunded.
 *
 * Dry run unless `execute`. Re-running is a no-op once the charge is fully refunded.
 */
export async function refundUnfulfilledMembershipGift({
  giftId,
  execute = false,
}: {
  giftId: string;
  execute?: boolean;
}): Promise<UnfulfilledGiftRefund> {
  const gift = await dbWrite.membershipGift.findUnique({ where: { id: giftId } });
  if (!gift) return { outcome: 'not-found' };
  if (gift.status === MembershipGiftStatus.Refunded) return { outcome: 'already-refunded' };
  if (gift.status !== MembershipGiftStatus.Pending)
    return { outcome: 'skipped', reason: 'not-pending', status: gift.status };

  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');

  const pi = await getGiftPaymentIntent(stripe, gift);
  if (!pi) return { outcome: 'skipped', reason: 'no-payment-intent' };
  if (pi.metadata?.giftId !== gift.id)
    return { outcome: 'skipped', reason: 'payment-mismatch', status: pi.status };
  if (pi.status !== 'succeeded')
    return { outcome: 'skipped', reason: 'payment-not-succeeded', status: pi.status };

  const charge = pi.latest_charge as Stripe.Charge | null;
  const amount = charge ? charge.amount_captured - charge.amount_refunded : 0;
  if (!charge || amount <= 0) return { outcome: 'skipped', reason: 'nothing-refundable' };

  const plan = { paymentIntentId: pi.id, chargeId: charge.id, amount, currency: charge.currency };
  if (!execute) return { outcome: 'would-refund', ...plan };

  // The refund webhook finds the gift by its payment, so the row has to name it first.
  if (gift.stripePaymentIntentId !== pi.id)
    await dbWrite.membershipGift.update({
      where: { id: gift.id },
      data: { stripePaymentIntentId: pi.id },
    });

  const refund = await stripe.refunds.create(
    { charge: charge.id, amount, metadata: { giftId: gift.id } },
    { idempotencyKey: `membership-gift-refund:${gift.id}:${charge.id}:${amount}` }
  );

  await log({
    type: 'warning',
    stage: 'refund-unfulfilled',
    giftId: gift.id,
    paymentIntentId: pi.id,
    refundId: refund.id,
    amount,
  });

  return { outcome: 'refunded', ...plan, refundId: refund.id };
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

/** Whether the user holds a gift they can still accept or are part-way through using. */
export async function holdsOpenMembershipGift({ userId }: { userId: number }) {
  // dbWrite: the recipient follows the notification seconds after the webhook writes the row
  const gift = await dbWrite.membershipGift.findFirst({
    where: {
      holderId: userId,
      status: { in: [MembershipGiftStatus.Fulfilled, MembershipGiftStatus.Active] },
      monthsRemaining: { gt: 0 },
    },
    select: { id: true },
  });
  return !!gift;
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
      pending: isAwaitingAcceptance(g),
      gifter: g.anonymous ? null : g.gifter,
    })),
  };
}
