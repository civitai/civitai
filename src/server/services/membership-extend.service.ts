import { TRPCError } from '@trpc/server';
import { randomUUID } from 'crypto';
import type { Stripe } from 'stripe';
import { env } from '~/env/server';
import { refreshSession } from '~/server/auth/session-invalidation';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { delIfValue } from '~/server/redis/atomic';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { MEMBERSHIP_EXTEND_MAX_DAYS } from '~/server/schema/membership-extend.schema';
import { trackModActivity } from '~/server/services/moderator.service';
import { throwBadRequestError, throwConflictError } from '~/server/utils/errorHandling';
import { getServerStripe } from '~/server/utils/get-server-stripe';
import { stripeKeyMode } from '~/server/utils/stripe-key-mode';
import { invalidateSubscriptionCaches } from '~/server/utils/subscription.utils';
import { PaymentProvider } from '~/shared/utils/prisma/enums';

/**
 * A moderator gives a Stripe member N free days: `trial_end = current_period_end + N days`, no
 * proration, so nothing is charged now and the next invoice (or the cancel) moves to the new end. The
 * subscription keeps its cancel state: a renewing member renews at the new end, a cancelling one
 * cancels there.
 *
 * A $0 `subscription_update` invoice is expected; manageInvoicePaid grants no bonus Buzz or
 * referral reward on it (civitai/civitai#6717).
 *
 * Every refusal happens before the first write. From the first write on, a ModActivity row and an
 * Axiom record are always written, and post-check failures come back as `ok: false` (never undone
 * automatically: undoing is another write a person decides on). The audit holds ids, dates, statuses
 * and the reason only: no card, payment method or amount.
 */

export { MEMBERSHIP_EXTEND_MAX_DAYS };
/** One extension per member in this window, counted from ModActivity. */
export const MEMBERSHIP_EXTEND_COOLDOWN_DAYS = 25;
export const MEMBERSHIP_EXTEND_ACTIVITY = 'extendMembership';
const DAY_SECONDS = 86_400;
// Longer than every Stripe call the locked section can make (up to four, 80 s client timeout each).
const LOCK_SECONDS = 600;
const EXTENDABLE_STATUSES = ['active', 'trialing'];

const iso = (epoch: number | null | undefined) =>
  epoch == null ? null : new Date(epoch * 1000).toISOString();

const log = (data: MixedObject) =>
  logToAxiom({ name: 'mod-membership-extend', ...data }, 'webhooks').catch(() => null);

type CancelMode = 'renewing' | 'cancelling';

export type ExtensionSnapshot = {
  id: string;
  status: string;
  currentPeriodEnd: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  latestInvoiceId: string | null;
};

/** What the audit and the response show of a subscription: ids, dates and states only. */
export function snapshot(sub: Stripe.Subscription): ExtensionSnapshot {
  const inv = sub.latest_invoice;
  return {
    id: sub.id,
    status: sub.status,
    currentPeriodEnd: iso(sub.current_period_end),
    trialEnd: iso(sub.trial_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    cancelAt: iso(sub.cancel_at),
    latestInvoiceId: inv == null ? null : typeof inv === 'string' ? inv : inv.id,
  };
}

export function computeTrialEnd(currentPeriodEnd: number, days: number) {
  if (!Number.isInteger(days) || days < 1 || days > MEMBERSHIP_EXTEND_MAX_DAYS)
    throw new Error(`days must be a whole number from 1 to ${MEMBERSHIP_EXTEND_MAX_DAYS}`);
  return currentPeriodEnd + days * DAY_SECONDS;
}

/** The two clean cancel states. Anything else (a custom cancel_at) is a person's call. */
export function cancelModeOf(
  sub: Pick<Stripe.Subscription, 'cancel_at_period_end' | 'cancel_at' | 'current_period_end'>
): CancelMode | null {
  if (!sub.cancel_at_period_end && sub.cancel_at == null) return 'renewing';
  if (
    sub.cancel_at_period_end &&
    (sub.cancel_at == null || sub.cancel_at === sub.current_period_end)
  )
    return 'cancelling';
  return null;
}

export type ExtensionGuardInput = {
  userId: number;
  days: number;
  now: number;
  row: {
    id: string;
    provider: string;
    userCustomerId: string | null;
    userIsModerator?: boolean;
  } | null;
  sub: Stripe.Subscription | null;
  customer: Stripe.Customer | Stripe.DeletedCustomer | null;
  recentExtensions: number;
  /** Pending invoice items on the customer: the trial's $0 invoice would pick them up and charge them. */
  pendingInvoiceItems?: number;
};

/**
 * Every guard, with no I/O. Returns the problems (any one refuses) and, when there are none, the
 * target trial_end and the cancel mode to keep.
 */
export function checkExtension({
  userId,
  days,
  now,
  row,
  sub,
  customer,
  recentExtensions,
  pendingInvoiceItems = 0,
}: ExtensionGuardInput) {
  const problems: string[] = [];
  if (!Number.isInteger(days) || days < 1 || days > MEMBERSHIP_EXTEND_MAX_DAYS)
    problems.push(`days must be a whole number from 1 to ${MEMBERSHIP_EXTEND_MAX_DAYS}`);
  if (recentExtensions > 0)
    problems.push(
      `this member was already extended in the last ${MEMBERSHIP_EXTEND_COOLDOWN_DAYS} days`
    );
  if (!row) problems.push('no green membership subscription for this user');
  else if (row.provider !== PaymentProvider.Stripe)
    problems.push(`the membership is billed by ${row.provider}, not Stripe`);
  // Moderators cannot give each other free days (nor themselves: refused before this).
  if (row?.userIsModerator)
    problems.push('the member is a moderator; extend a moderator out of band');
  if (!row || row.provider !== PaymentProvider.Stripe) return { problems };
  if (!sub) return { problems: [...problems, 'Stripe has no such subscription'] };

  if (sub.id !== row.id) problems.push(`Stripe returned ${sub.id}, not ${row.id}`);
  if (!EXTENDABLE_STATUSES.includes(sub.status))
    problems.push(`status is ${sub.status}, not active or trialing`);
  // The app maps a subscription to a user by User.customerId (upsertSubscription).
  if (!row.userCustomerId || row.userCustomerId !== sub.customer)
    problems.push("the subscription's customer is not this user's Stripe customer");
  // createCustomer stamps metadata.userId on every customer it makes.
  if (!customer) problems.push('the Stripe customer was not found');
  else if ('deleted' in customer && customer.deleted)
    problems.push('the Stripe customer is deleted');
  else if (
    (customer as Stripe.Customer).metadata?.userId != null &&
    String((customer as Stripe.Customer).metadata.userId) !== String(userId)
  )
    problems.push("the Stripe customer's metadata.userId is another user");
  if (sub.metadata?.userId != null && String(sub.metadata.userId) !== String(userId))
    problems.push("the subscription's metadata.userId is another user");
  // A schedule owns the phases and can undo trial_end.
  if (sub.schedule) problems.push('the subscription is on a schedule');
  // Never stack on a live trial: ours, a gift's or a promotion's.
  if (sub.trial_end != null && sub.trial_end > now)
    problems.push(`already in a trial until ${iso(sub.trial_end)}`);
  // An armed gift month (or any coupon) rides on the next invoice; v1 does not move it.
  // Monthly only: a trial on an annual plan stops its monthly Buzz and cosmetics until the trial ends
  // (deliver-annual-sub-buzz pays status 'active' only) and bills a new year at its end.
  const items = sub.items?.data ?? [];
  if (items.length !== 1 || items[0].price?.recurring?.interval !== 'month')
    problems.push('only a single monthly plan can be extended');
  if (pendingInvoiceItems > 0)
    problems.push('the customer has pending invoice items, which the trial invoice would charge');
  if (sub.discount) problems.push('the subscription carries a discount (an armed gift month?)');
  const mode = cancelModeOf(sub);
  if (!mode) problems.push(`a custom cancel date (${iso(sub.cancel_at)}) is set`);
  if (!Number.isInteger(sub.current_period_end)) problems.push('no current_period_end');
  if (problems.length) return { problems };
  return {
    problems,
    trialEnd: computeTrialEnd(sub.current_period_end, days),
    mode: mode as CancelMode,
  };
}

/** The one update. cancel_at_period_end is sent as it was, so the cancel state is stated, not assumed. */
export function updateParams({
  trialEnd,
  mode,
  stamp,
}: {
  trialEnd: number;
  mode: CancelMode;
  stamp: string;
}): Stripe.SubscriptionUpdateParams {
  return {
    trial_end: trialEnd,
    proration_behavior: 'none',
    cancel_at_period_end: mode === 'cancelling',
    metadata: { modExtension: stamp },
  };
}

/**
 * What must hold after the update: in a trial to exactly the target, the cancel state kept, and no
 * money moved (a new latest_invoice with anything due or paid).
 */
export function verifyExtension({
  before,
  after,
  trialEnd,
  mode,
}: {
  before: Stripe.Subscription;
  after: Stripe.Subscription | null;
  trialEnd: number;
  mode: CancelMode;
}) {
  const problems: string[] = [];
  if (!after) return { problems: ['the re-read found no subscription'], newInvoiceId: null };
  if (after.status !== 'trialing') problems.push(`status is ${after.status}, expected trialing`);
  if (after.trial_end !== trialEnd)
    problems.push(`trial_end is ${iso(after.trial_end)}, expected ${iso(trialEnd)}`);
  if (after.current_period_end !== trialEnd)
    problems.push(
      `current_period_end is ${iso(after.current_period_end)}, expected ${iso(trialEnd)}`
    );
  if (mode === 'cancelling') {
    if (after.cancel_at_period_end !== true)
      problems.push('cancel_at_period_end was lost; it should still cancel');
    // A cancel_at left at the old end would take the days back.
    if (after.cancel_at != null && after.cancel_at !== trialEnd)
      problems.push(`cancel_at is ${iso(after.cancel_at)}, expected ${iso(trialEnd)}`);
  } else {
    if (after.cancel_at_period_end !== false) problems.push('cancel_at_period_end turned on');
    if (after.cancel_at != null)
      problems.push(`cancel_at is ${iso(after.cancel_at)}, expected none`);
  }
  const id = (inv: Stripe.Subscription['latest_invoice']) =>
    inv == null ? null : typeof inv === 'string' ? inv : inv.id;
  const newInvoiceId =
    id(after.latest_invoice) !== id(before.latest_invoice) ? id(after.latest_invoice) : null;
  if (newInvoiceId) {
    const inv = after.latest_invoice;
    if (typeof inv === 'string' || inv == null)
      problems.push(`new invoice ${newInvoiceId} was not expanded, so it is unchecked`);
    else if (inv.amount_due !== 0 || inv.amount_paid !== 0)
      problems.push(`the update made invoice ${newInvoiceId} with money due or paid`);
  }
  return { problems, newInvoiceId };
}

type Loaded = {
  row: ExtensionGuardInput['row'];
  sub: Stripe.Subscription | null;
  customer: ExtensionGuardInput['customer'];
  recentExtensions: number;
  pendingInvoiceItems: number;
};

async function load(stripe: Stripe, userId: number, now: number): Promise<Loaded> {
  const [cs, user, recentExtensions] = await Promise.all([
    dbWrite.customerSubscription.findUnique({
      where: { userId_buzzType: { userId, buzzType: 'green' } },
      select: { id: true, product: { select: { provider: true } } },
    }),
    dbWrite.user.findUnique({
      where: { id: userId },
      select: { customerId: true, isModerator: true },
    }),
    dbWrite.modActivity.count({
      where: {
        entityType: 'user',
        entityId: userId,
        activity: MEMBERSHIP_EXTEND_ACTIVITY,
        createdAt: { gte: new Date((now - MEMBERSHIP_EXTEND_COOLDOWN_DAYS * DAY_SECONDS) * 1000) },
      },
    }),
  ]);
  const row = cs
    ? {
        id: cs.id,
        provider: cs.product.provider,
        userCustomerId: user?.customerId ?? null,
        userIsModerator: !!user?.isModerator,
      }
    : null;
  if (!row || row.provider !== PaymentProvider.Stripe)
    return { row, sub: null, customer: null, recentExtensions, pendingInvoiceItems: 0 };
  const sub = await stripe.subscriptions
    .retrieve(row.id, { expand: ['latest_invoice'] })
    .catch((e: { statusCode?: number }) => {
      if (e?.statusCode === 404) return null;
      throw e;
    });
  const customer =
    sub && typeof sub.customer === 'string'
      ? await stripe.customers.retrieve(sub.customer).catch((e: { statusCode?: number }) => {
          if (e?.statusCode === 404) return null;
          throw e;
        })
      : null;
  const pending =
    sub && typeof sub.customer === 'string'
      ? await stripe.invoiceItems.list({ customer: sub.customer, pending: true, limit: 1 })
      : null;
  return { row, sub, customer, recentExtensions, pendingInvoiceItems: pending?.data.length ?? 0 };
}

async function requireStripe() {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');
  return stripe;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Read-only: what an extension would do, and every guard's verdict. */
export async function previewMembershipExtension({
  userId,
  days,
  actorId,
}: {
  userId: number;
  days: number;
  actorId: number;
}) {
  if (userId === actorId)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You cannot extend your own membership' });
  const stripe = await requireStripe();
  const now = nowSeconds();
  const loaded = await load(stripe, userId, now);
  const result = checkExtension({ userId, days, now, ...loaded });
  return {
    userId,
    days,
    subscription: loaded.sub ? snapshot(loaded.sub) : null,
    problems: result.problems,
    keyMode: stripeKeyMode(env.STRIPE_SECRET_KEY),
    // Pass back to extendMembership: a different live value refuses (no double extension).
    expectedCurrentPeriodEnd: loaded.sub?.current_period_end ?? null,
    trialEnd: result.trialEnd ?? null,
    trialEndIso: iso(result.trialEnd),
    mode: result.mode ?? null,
  };
}

export type ExtendMembershipResult = {
  ok: boolean;
  userId: number;
  subscriptionId: string;
  days: number;
  trialEnd: string | null;
  mode: CancelMode;
  before: ExtensionSnapshot;
  after: ExtensionSnapshot | null;
  cancelRestored: boolean;
  newInvoiceId: string | null;
  problems: string[];
};

export async function extendMembership({
  userId,
  days,
  reason,
  expectedCurrentPeriodEnd,
  actorId,
}: {
  userId: number;
  days: number;
  reason: string;
  expectedCurrentPeriodEnd: number;
  actorId: number;
}): Promise<ExtendMembershipResult> {
  if (userId === actorId)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You cannot extend your own membership' });
  // Live money only: a sandbox key writes nowhere real, and a test-mode run must not leave an audit
  // row that counts toward a real member's cooldown.
  if (stripeKeyMode(env.STRIPE_SECRET_KEY) !== 'live')
    throw throwBadRequestError('Membership extensions run against live Stripe only');
  const stripe = await requireStripe();

  const lockKey = `${REDIS_SYS_KEYS.MEMBERSHIP_EXTEND.LOCK}:${userId}` as const;
  const owner = randomUUID();
  if ((await sysRedis.set(lockKey, owner, { NX: true, EX: LOCK_SECONDS })) === null)
    throw throwConflictError('Another extension for this member is in progress');
  try {
    return await extendLocked({ stripe, userId, days, reason, expectedCurrentPeriodEnd, actorId });
  } finally {
    await delIfValue(sysRedis, lockKey, owner).catch(() => undefined);
  }
}

async function extendLocked({
  stripe,
  userId,
  days,
  reason,
  expectedCurrentPeriodEnd,
  actorId,
}: {
  stripe: Stripe;
  userId: number;
  days: number;
  reason: string;
  expectedCurrentPeriodEnd: number;
  actorId: number;
}): Promise<ExtendMembershipResult> {
  const now = nowSeconds();
  const loaded = await load(stripe, userId, now);
  const { sub } = loaded;
  const checked = checkExtension({ userId, days, now, ...loaded });
  if (sub && !sub.livemode)
    checked.problems.push('the subscription is not a live-mode subscription');
  if (checked.problems.length || !sub || checked.trialEnd == null || !checked.mode) {
    await log({ type: 'refused', actorId, userId, days, reason, problems: checked.problems });
    throw throwBadRequestError(`Not extended: ${checked.problems.join('; ')}`);
  }
  // Compare-and-swap on what the moderator previewed: a double submit, or a second moderator, sees a
  // moved current_period_end (Stripe moves it to trial_end) and is refused.
  if (sub.current_period_end !== expectedCurrentPeriodEnd) {
    await log({
      type: 'refused',
      actorId,
      userId,
      days,
      reason,
      problems: ['current_period_end changed since the preview'],
    });
    throw throwConflictError(
      `The membership changed since the preview (period end ${iso(
        sub.current_period_end
      )}); preview again`
    );
  }

  const { trialEnd, mode } = checked;
  // No moderator id: Stripe metadata is copied to CustomerSubscription.metadata, which the member can
  // read (getUserSubscription). ModActivity and Axiom hold the actor.
  // Deterministic (no clock): a retry of the same extension sends the same params under the same
  // idempotency key, so Stripe replays its stored result instead of refusing a changed request.
  const stamp = `${days}d:to:${iso(trialEnd)}`;
  const result: ExtendMembershipResult = {
    ok: false,
    userId,
    subscriptionId: sub.id,
    days,
    trialEnd: iso(trialEnd),
    mode,
    before: snapshot(sub),
    after: null,
    cancelRestored: false,
    newInvoiceId: null,
    problems: [],
  };
  let response: Stripe.Subscription | null = null;
  // Stripe refused the first update outright (a 4xx invalid-request or card error): nothing was
  // written, so it must not start the member's cooldown.
  let rejected = false;
  try {
    response = await stripe.subscriptions.update(sub.id, updateParams({ trialEnd, mode, stamp }), {
      idempotencyKey: `mod-extend:${sub.id}:${trialEnd}`,
    });
    // Cancelling: if Stripe did not keep cancel_at_period_end, put it back from the response itself,
    // before any further read can fail. Left alone, the trial would end in a charge.
    if (mode === 'cancelling' && response.cancel_at_period_end !== true) {
      result.cancelRestored = true;
      await stripe.subscriptions.update(
        sub.id,
        { cancel_at_period_end: true },
        { idempotencyKey: `mod-extend:${sub.id}:${trialEnd}:cancel` }
      );
    }
    let after = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice'] });
    if (mode === 'cancelling' && !result.cancelRestored && after.cancel_at_period_end !== true) {
      result.cancelRestored = true;
      await stripe.subscriptions.update(
        sub.id,
        { cancel_at_period_end: true },
        { idempotencyKey: `mod-extend:${sub.id}:${trialEnd}:cancel` }
      );
      after = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice'] });
    }
    result.after = snapshot(after);
    const verified = verifyExtension({ before: sub, after, trialEnd, mode });
    result.problems.push(...verified.problems);
    result.newInvoiceId = verified.newInvoiceId;
  } catch (e) {
    const type = (e as { type?: string }).type;
    rejected = !response && (type === 'StripeInvalidRequestError' || type === 'StripeCardError');
    result.problems.push(
      `stopped after ${response ? 'the update' : 'no confirmed write'}: ${(e as Error).message}`
    );
  } finally {
    result.ok = result.problems.length === 0;
    // From the first write attempt on: the activity counts toward the cooldown even when the write's
    // outcome is unknown. Only a definite Stripe rejection of the first update is left out.
    if (!rejected)
      await trackModActivity(actorId, {
        entityType: 'user',
        entityId: userId,
        activity: MEMBERSHIP_EXTEND_ACTIVITY,
      }).catch((e) => log({ type: 'audit-failed', actorId, userId, error: (e as Error).message }));
    await log({
      type: result.ok ? 'extended' : rejected ? 'rejected-by-stripe' : 'extended-with-problems',
      actorId,
      userId,
      subscriptionId: sub.id,
      days,
      reason,
      mode,
      trialEnd: result.trialEnd,
      before: result.before,
      response: response ? snapshot(response) : null,
      after: result.after,
      cancelRestored: result.cancelRestored,
      newInvoiceId: result.newInvoiceId,
      problems: result.problems,
    });
  }

  await invalidateSubscriptionCaches(userId).catch(() => undefined);
  await refreshSession(userId, { caller: 'subscription' }).catch(() => undefined);
  return result;
}
