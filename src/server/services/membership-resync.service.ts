import { TRPCError } from '@trpc/server';
import type { Stripe } from 'stripe';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { ownershipProblems } from '~/server/services/membership-extend.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { upsertSubscription } from '~/server/services/stripe.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { getServerStripe } from '~/server/utils/get-server-stripe';
import { BUZZ_MEMBERSHIP_SUBSCRIPTION_TYPE } from '~/shared/utils/buzz-membership';
import { PaymentProvider } from '~/shared/utils/prisma/enums';

/**
 * A moderator re-reads a member's Stripe subscription into CustomerSubscription, for when a webhook
 * was missed. Writes nothing to Stripe: it reads, then runs the webhook's own `upsertSubscription`.
 *
 * That upsert ends a live Buzz-bought membership when the Stripe one is active or trialing, as the
 * webhook would. The preview names it and the write is refused without `confirmEndBuzzMembership`.
 */

export const MEMBERSHIP_RESYNC_ACTIVITY = 'resyncMembership';
const LIVE_STATUSES = ['active', 'trialing', 'past_due'];
// upsertSubscription ends a live Buzz membership only for these.
const SUPERSEDING_STATUSES = ['active', 'trialing'];

const iso = (epoch: number | null | undefined) =>
  epoch == null ? null : new Date(epoch * 1000).toISOString();

const log = (data: MixedObject) =>
  logToAxiom({ name: 'mod-membership-resync', ...data }, 'webhooks').catch(() => null);

type RowView = {
  id: string;
  status: string;
  priceId: string;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  currentPeriodEnd: string | null;
};

const rowSelect = {
  id: true,
  status: true,
  priceId: true,
  cancelAtPeriodEnd: true,
  cancelAt: true,
  currentPeriodEnd: true,
  product: { select: { provider: true } },
} as const;

function rowView(row: {
  id: string;
  status: string;
  priceId: string;
  cancelAtPeriodEnd: boolean | null;
  cancelAt: Date | null;
  currentPeriodEnd: Date | null;
}): RowView {
  return {
    id: row.id,
    status: row.status,
    priceId: row.priceId,
    cancelAtPeriodEnd: !!row.cancelAtPeriodEnd,
    cancelAt: row.cancelAt?.toISOString() ?? null,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
  };
}

function stripeView(sub: Stripe.Subscription): RowView {
  return {
    id: sub.id,
    status: sub.status,
    priceId: sub.items.data[0]?.price.id ?? '',
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    cancelAt: iso(sub.cancel_at),
    currentPeriodEnd: iso(sub.current_period_end),
  };
}

/** The fields that differ, our row's value first. Every field when there is no row. */
export function diffRow(row: RowView | null, stripe: RowView) {
  return (Object.keys(stripe) as (keyof RowView)[])
    .filter((k) => !row || row[k] !== stripe[k])
    .map((field) => ({ field, ours: row?.[field] ?? null, stripe: stripe[field] }));
}

type BuzzMembership = { id: string; status: string; currentPeriodEnd: string | null };

async function load(stripe: Stripe, userId: number) {
  const [row, user, buzz] = await Promise.all([
    dbWrite.customerSubscription.findUnique({
      where: { userId_buzzType: { userId, buzzType: 'green' } },
      select: rowSelect,
    }),
    dbWrite.user.findUnique({ where: { id: userId }, select: { customerId: true } }),
    dbWrite.customerSubscription.findFirst({
      // Mirrors liveBuzzMembershipWhere in subscriptions.service, which the upsert ends.
      where: {
        userId,
        buzzType: BUZZ_MEMBERSHIP_SUBSCRIPTION_TYPE,
        status: { notIn: ['canceled', 'incomplete_expired'] },
      },
      select: { id: true, status: true, currentPeriodEnd: true },
    }),
  ]);
  const problems: string[] = [];
  const customerId = user?.customerId ?? null;
  if (row && row.product.provider !== PaymentProvider.Stripe)
    problems.push(`the membership is billed by ${row.product.provider}, not Stripe`);
  if (!customerId) problems.push('the user has no Stripe customer');
  if (problems.length) return { problems, row, sub: null, customerId, buzz: null };

  const notFound = (e: { statusCode?: number }) => {
    if (e?.statusCode === 404) return null;
    throw e;
  };
  let sub: Stripe.Subscription | null = null;
  if (row) {
    sub = await stripe.subscriptions.retrieve(row.id).catch(notFound);
    if (!sub) problems.push(`Stripe has no subscription ${row.id}`);
  } else {
    // No row: the webhook that makes it was missed. Only an unambiguous single live one is synced.
    const list = await stripe.subscriptions.list({
      customer: customerId as string,
      status: 'all',
      limit: 10,
    });
    const live = list.data.filter((s) => LIVE_STATUSES.includes(s.status));
    if (live.length === 1) sub = live[0];
    else
      problems.push(
        live.length
          ? `the customer has ${live.length} live subscriptions (${live
              .map((s) => s.id)
              .join(', ')}); sync by hand`
          : 'the customer has no live Stripe subscription'
      );
  }
  if (sub) {
    const customer = await stripe.customers.retrieve(customerId as string).catch(notFound);
    problems.push(
      ...ownershipProblems({
        userId,
        row: { id: row?.id ?? sub.id, userCustomerId: customerId },
        sub,
        customer,
      })
    );
  }
  const endsBuzz =
    sub && buzz && SUPERSEDING_STATUSES.includes(sub.status)
      ? {
          id: buzz.id,
          status: buzz.status,
          currentPeriodEnd: buzz.currentPeriodEnd?.toISOString() ?? null,
        }
      : null;
  return { problems, row, sub, customerId, buzz: endsBuzz as BuzzMembership | null };
}

async function requireStripe() {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe is not available');
  return stripe;
}

function refuseOwn(userId: number, actorId: number) {
  if (userId === actorId)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You cannot re-sync your own membership' });
}

/** Read-only: our row, Stripe's copy, what differs, and the Buzz membership the sync would end. */
export async function previewMembershipResync({
  userId,
  actorId,
}: {
  userId: number;
  actorId: number;
}) {
  refuseOwn(userId, actorId);
  const stripe = await requireStripe();
  const { problems, row, sub, buzz } = await load(stripe, userId);
  return {
    userId,
    ours: row ? rowView(row) : null,
    stripe: sub ? stripeView(sub) : null,
    changes: sub ? diffRow(row ? rowView(row) : null, stripeView(sub)) : [],
    endsBuzzMembership: buzz,
    problems,
  };
}

export async function resyncMembership({
  userId,
  reason,
  confirmEndBuzzMembership,
  actorId,
}: {
  userId: number;
  reason: string;
  confirmEndBuzzMembership: boolean;
  actorId: number;
}) {
  refuseOwn(userId, actorId);
  const stripe = await requireStripe();
  const { problems, row, sub, customerId, buzz } = await load(stripe, userId);
  // Decided on this read, not the preview's: a Buzz membership that appeared since still needs the confirm.
  if (buzz && !confirmEndBuzzMembership)
    problems.push(
      `this ends the member's Buzz-bought membership ${buzz.id}; confirm that to re-sync`
    );
  if (problems.length || !sub || !customerId) {
    await log({ type: 'refused', actorId, userId, reason, problems });
    throw throwBadRequestError(`Not re-synced: ${problems.join('; ')}`);
  }

  const before = row ? rowView(row) : null;
  const changes = diffRow(before, stripeView(sub));
  // Not a webhook event type, so the upsert neither waits out a webhook race nor deletes the row.
  await upsertSubscription(sub, customerId, new Date(), 'moderator.resync');
  const afterRow = await dbWrite.customerSubscription.findUnique({
    where: { userId_buzzType: { userId, buzzType: 'green' } },
    select: rowSelect,
  });
  const after = afterRow ? rowView(afterRow) : null;

  await trackModActivity(actorId, {
    entityType: 'user',
    entityId: userId,
    activity: MEMBERSHIP_RESYNC_ACTIVITY,
  }).catch((e) => log({ type: 'audit-failed', actorId, userId, error: (e as Error).message }));
  await log({
    type: 'resynced',
    actorId,
    userId,
    subscriptionId: sub.id,
    reason,
    before,
    after,
    changes,
    endedBuzzMembership: buzz?.id ?? null,
  });
  return {
    ok: true,
    userId,
    subscriptionId: sub.id,
    before,
    after,
    changes,
    endedBuzzMembership: buzz,
  };
}
