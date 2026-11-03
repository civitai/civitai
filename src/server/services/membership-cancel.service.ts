import { TRPCError } from '@trpc/server';
import { randomUUID } from 'crypto';
import type { Stripe } from 'stripe';
import { env } from '~/env/server';
import { refreshSession } from '~/server/auth/session-invalidation';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { delIfValue } from '~/server/redis/atomic';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import {
  cancelModeOf,
  iso,
  notFoundAsNull,
  ownershipProblems,
  requireStripe,
  snapshot,
  type ExtensionSnapshot,
} from '~/server/services/membership-extend.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { cancelSubscription, MODERATION_CANCEL_MARK } from '~/server/services/stripe.service';
import { throwBadRequestError, throwConflictError } from '~/server/utils/errorHandling';
import { stripeKeyMode } from '~/server/utils/stripe-key-mode';
import { invalidateSubscriptionCaches } from '~/server/utils/subscription.utils';
import { PaymentProvider } from '~/shared/utils/prisma/enums';

/**
 * A moderator sets or undoes cancel-at-period-end on a member's Stripe subscription, on the member's
 * request. One field is sent; nothing is charged, refunded or prorated. Undoing arms the next renewal
 * charge, which is why it has its own grant (`user.membership.cancel`).
 *
 * Already in the asked-for state: nothing is written and the answer is `changed: false`.
 * Every refusal happens before the write. Once Stripe has taken the update, or may have, a ModActivity
 * row and an Axiom record are written; a Stripe rejection logs to Axiom only.
 */

export const MEMBERSHIP_CANCEL_ACTIVITY = {
  set: 'setMembershipCancel',
  undo: 'undoMembershipCancel',
} as const;
const LOCK_SECONDS = 600;
const CHANGEABLE_STATUSES = ['active', 'trialing'];

const log = (data: MixedObject) =>
  logToAxiom({ name: 'mod-membership-cancel', ...data }, 'webhooks').catch(() => null);

export type CancelGuardInput = {
  userId: number;
  cancelAtPeriodEnd: boolean;
  row: {
    id: string;
    provider: string;
    userCustomerId: string | null;
    userIsModerator: boolean;
    userBannedOrMuted: boolean;
  } | null;
  sub: Stripe.Subscription | null;
  customer: Stripe.Customer | Stripe.DeletedCustomer | null;
};

/** Every guard, with no I/O. `changed: false` with no problems: already in that state. */
export function checkCancelChange({
  userId,
  cancelAtPeriodEnd,
  row,
  sub,
  customer,
}: CancelGuardInput): { problems: string[]; changed?: boolean } {
  const problems: string[] = [];
  if (!row) return { problems: ['no green membership subscription for this user'] };
  if (row.provider !== PaymentProvider.Stripe)
    return { problems: [`the membership is billed by ${row.provider}, not Stripe`] };
  if (row.userIsModerator) problems.push('the member is a moderator; change it out of band');
  if (!sub) return { problems: [...problems, 'Stripe has no such subscription'] };

  problems.push(...ownershipProblems({ userId, row, sub, customer }));
  if (!CHANGEABLE_STATUSES.includes(sub.status))
    problems.push(`status is ${sub.status}, not active or trialing`);
  // A schedule owns the phases, cancel included.
  if (sub.schedule) problems.push('the subscription is on a schedule');
  // A custom cancel_at is a gift's end date: clearing it would renew the gift into paid billing.
  const mode = cancelModeOf(sub);
  if (!mode) problems.push(`a custom cancel date (${iso(sub.cancel_at)}) is set`);
  if (problems.length) return { problems };

  const target = cancelAtPeriodEnd ? 'cancelling' : 'renewing';
  if (mode === target) return { problems, changed: false };

  if (!cancelAtPeriodEnd) {
    // The ban / mute flow's cancel: reinstateSubscription resumes it when the restriction lifts.
    if (
      sub.canceled_at != null &&
      sub.metadata?.[MODERATION_CANCEL_MARK] === String(sub.canceled_at)
    )
      problems.push('the cancel was made by a ban or mute; lifting that restores it');
    if (row.userBannedOrMuted) problems.push('the member is banned or muted');
    // A gift is kept through the member's own "Keep my membership", which also makes sure a card
    // is on file; this path would not.
    if (sub.metadata?.membershipGiftId) problems.push('the subscription is a membership gift');
  }
  return { problems, changed: problems.length ? undefined : true };
}

/** What must hold after the write: the asked-for state, and no new invoice (no money moved). */
export function verifyCancelChange({
  before,
  after,
  cancelAtPeriodEnd,
}: {
  before: Stripe.Subscription;
  after: Stripe.Subscription | null;
  cancelAtPeriodEnd: boolean;
}) {
  if (!after) return ['the re-read found no subscription'];
  const problems: string[] = [];
  if (after.cancel_at_period_end !== cancelAtPeriodEnd)
    problems.push(`cancel_at_period_end is ${after.cancel_at_period_end}`);
  if (!cancelAtPeriodEnd && after.cancel_at != null)
    problems.push(`cancel_at is ${iso(after.cancel_at)}, expected none`);
  const invoiceId = (s: Stripe.Subscription) => snapshot(s).latestInvoiceId;
  if (invoiceId(after) !== invoiceId(before))
    problems.push(`the change made invoice ${invoiceId(after)}`);
  return problems;
}

type Loaded = Pick<CancelGuardInput, 'row' | 'sub' | 'customer'>;

async function load(stripe: Stripe, userId: number): Promise<Loaded> {
  const [cs, user] = await Promise.all([
    dbWrite.customerSubscription.findUnique({
      where: { userId_buzzType: { userId, buzzType: 'green' } },
      select: { id: true, product: { select: { provider: true } } },
    }),
    dbWrite.user.findUnique({
      where: { id: userId },
      select: { customerId: true, isModerator: true, bannedAt: true, muted: true },
    }),
  ]);
  const row = cs
    ? {
        id: cs.id,
        provider: cs.product.provider,
        userCustomerId: user?.customerId ?? null,
        userIsModerator: !!user?.isModerator,
        userBannedOrMuted: !!user?.bannedAt || !!user?.muted,
      }
    : null;
  if (!row || row.provider !== PaymentProvider.Stripe) return { row, sub: null, customer: null };
  const sub = await stripe.subscriptions.retrieve(row.id).catch(notFoundAsNull);
  const customer =
    sub && typeof sub.customer === 'string'
      ? await stripe.customers.retrieve(sub.customer).catch(notFoundAsNull)
      : null;
  return { row, sub, customer };
}

function refuseOwn(userId: number, actorId: number) {
  if (userId === actorId)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You cannot change your own membership' });
}

/** Read-only: what the change would do, and every guard's verdict. */
export async function previewMembershipCancel({
  userId,
  cancelAtPeriodEnd,
  actorId,
}: {
  userId: number;
  cancelAtPeriodEnd: boolean;
  actorId: number;
}) {
  refuseOwn(userId, actorId);
  const stripe = await requireStripe();
  const loaded = await load(stripe, userId);
  const checked = checkCancelChange({ userId, cancelAtPeriodEnd, ...loaded });
  // The write's live-money checks, so a preview never promises what the write refuses.
  if (stripeKeyMode(env.STRIPE_SECRET_KEY) !== 'live')
    checked.problems.push('the Stripe key is not live');
  if (loaded.sub && !loaded.sub.livemode)
    checked.problems.push('the subscription is not a live-mode subscription');
  if (checked.problems.length) checked.changed = undefined;
  return {
    userId,
    cancelAtPeriodEnd,
    subscription: loaded.sub ? snapshot(loaded.sub) : null,
    problems: checked.problems,
    changed: checked.changed ?? null,
  };
}

/**
 * A ban or mute landing after the re-check found the subscription still cancelling, so its cancel
 * did nothing and the undo left a restricted member renewing. Put back the ban flow's own cancel,
 * marked, so lifting the restriction resumes it.
 */
async function recancelIfRestricted(stripe: Stripe, result: MembershipCancelResult) {
  let failed: string | null = null;
  try {
    const user = await dbWrite.user.findUnique({
      where: { id: result.userId },
      select: { bannedAt: true, muted: true },
    });
    if (!user?.bannedAt && !user?.muted) return [];
    await cancelSubscription({ subscriptionId: result.subscriptionId, atPeriodEnd: true });
  } catch (e) {
    failed = e instanceof Error ? e.message : String(e);
  }
  // Report what Stripe now holds: the ban flow may have re-cancelled already, or half-done it.
  const now = await stripe.subscriptions.retrieve(result.subscriptionId).catch(() => null);
  if (now) result.after = snapshot(now);
  const state = !now
    ? 'its state is unknown'
    : now.cancel_at_period_end
    ? 'it is cancelling again'
    : 'it is still renewing';
  return [
    failed
      ? `the ban or mute re-check after the undo failed (${failed}); ${state}`
      : `the member was banned or muted during the undo; ${state}`,
  ];
}

export type MembershipCancelResult = {
  ok: boolean;
  userId: number;
  subscriptionId: string;
  cancelAtPeriodEnd: boolean;
  /** false: it was already so and nothing was written. */
  changed: boolean;
  before: ExtensionSnapshot;
  after: ExtensionSnapshot | null;
  problems: string[];
  /** true: Stripe took the update. false: it refused it. null: unknown, or nothing to write. */
  written: boolean | null;
};

export async function setMembershipCancel({
  userId,
  cancelAtPeriodEnd,
  reason,
  actorId,
}: {
  userId: number;
  cancelAtPeriodEnd: boolean;
  reason: string;
  actorId: number;
}): Promise<MembershipCancelResult> {
  refuseOwn(userId, actorId);
  if (stripeKeyMode(env.STRIPE_SECRET_KEY) !== 'live')
    throw throwBadRequestError('Membership changes run against live Stripe only');
  const stripe = await requireStripe();

  // Extend's lock: extend re-sends cancel_at_period_end as it read it, so a toggle between its read
  // and write would be undone.
  const lockKey = `${REDIS_SYS_KEYS.MEMBERSHIP_EXTEND.LOCK}:${userId}` as const;
  const owner = randomUUID();
  if ((await sysRedis.set(lockKey, owner, { NX: true, EX: LOCK_SECONDS })) === null)
    throw throwConflictError('Another membership change for this member is in progress');
  try {
    return await setLocked({ stripe, userId, cancelAtPeriodEnd, reason, actorId });
  } finally {
    await delIfValue(sysRedis, lockKey, owner).catch(() => undefined);
  }
}

async function setLocked({
  stripe,
  userId,
  cancelAtPeriodEnd,
  reason,
  actorId,
}: {
  stripe: Stripe;
  userId: number;
  cancelAtPeriodEnd: boolean;
  reason: string;
  actorId: number;
}): Promise<MembershipCancelResult> {
  const loaded = await load(stripe, userId);
  const { sub } = loaded;
  const checked = checkCancelChange({ userId, cancelAtPeriodEnd, ...loaded });
  if (sub && !sub.livemode)
    checked.problems.push('the subscription is not a live-mode subscription');
  if (checked.problems.length || !sub) {
    await log({
      type: 'refused',
      actorId,
      userId,
      cancelAtPeriodEnd,
      reason,
      problems: checked.problems,
    });
    throw throwBadRequestError(`Not changed: ${checked.problems.join('; ')}`);
  }

  const result: MembershipCancelResult = {
    ok: true,
    userId,
    subscriptionId: sub.id,
    cancelAtPeriodEnd,
    changed: checked.changed === true,
    before: snapshot(sub),
    after: snapshot(sub),
    problems: [],
    written: null,
  };
  if (!result.changed) {
    await log({
      type: 'unchanged',
      actorId,
      userId,
      subscriptionId: sub.id,
      cancelAtPeriodEnd,
      reason,
    });
    return result;
  }

  // A ban or mute since the read finds the sub already cancelling and leaves no mark, so undoing now
  // would leave a banned member renewing.
  if (!cancelAtPeriodEnd) {
    const now = await dbWrite.user.findUnique({
      where: { id: userId },
      select: { bannedAt: true, muted: true },
    });
    if (now?.bannedAt || now?.muted) {
      await log({
        type: 'refused',
        actorId,
        userId,
        cancelAtPeriodEnd,
        reason,
        problems: ['banned or muted since the read'],
      });
      throw throwBadRequestError('Not changed: the member is banned or muted');
    }
  }

  result.after = null;
  let response: Stripe.Subscription | null = null;
  let rejected = false;
  try {
    // No moderator id in metadata: it is copied to CustomerSubscription.metadata, which the member reads.
    response = await stripe.subscriptions.update(sub.id, {
      cancel_at_period_end: cancelAtPeriodEnd,
    });
    try {
      const after = await stripe.subscriptions.retrieve(sub.id);
      result.after = snapshot(after);
      result.problems.push(...verifyCancelChange({ before: sub, after, cancelAtPeriodEnd }));
    } finally {
      // Even when the re-read failed: a restricted member must not be left renewing.
      if (!cancelAtPeriodEnd) result.problems.push(...(await recancelIfRestricted(stripe, result)));
    }
  } catch (e) {
    const type = (e as { type?: string }).type;
    rejected = !response && (type === 'StripeInvalidRequestError' || type === 'StripeCardError');
    result.problems.push(
      `stopped after ${response ? 'the update' : 'no confirmed write'}: ${(e as Error).message}`
    );
  } finally {
    result.ok = result.problems.length === 0;
    result.written = response ? true : rejected ? false : null;
    if (!rejected)
      await trackModActivity(actorId, {
        entityType: 'user',
        entityId: userId,
        activity: MEMBERSHIP_CANCEL_ACTIVITY[cancelAtPeriodEnd ? 'set' : 'undo'],
      }).catch((e) => log({ type: 'audit-failed', actorId, userId, error: (e as Error).message }));
    await log({
      type: result.ok ? 'changed' : rejected ? 'rejected-by-stripe' : 'changed-with-problems',
      actorId,
      userId,
      subscriptionId: sub.id,
      cancelAtPeriodEnd,
      reason,
      before: result.before,
      response: response ? snapshot(response) : null,
      after: result.after,
      problems: result.problems,
    });
  }

  await invalidateSubscriptionCaches(userId).catch(() => undefined);
  await refreshSession(userId, { caller: 'subscription' }).catch(() => undefined);
  return result;
}
