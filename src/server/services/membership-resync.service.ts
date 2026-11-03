import { TRPCError } from '@trpc/server';
import type { Stripe } from 'stripe';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { ownershipProblems } from '~/server/services/membership-extend.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { env } from '~/env/server';
import { toDateTime, upsertSubscription } from '~/server/services/stripe.service';
import { stripeKeyMode } from '~/server/utils/stripe-key-mode';
import { syncFreshdeskMembership } from '~/server/services/subscriptions.service';
import { getServerStripe } from '~/server/utils/get-server-stripe';
import { BUZZ_MEMBERSHIP_SUBSCRIPTION_TYPE } from '~/shared/utils/buzz-membership';
import { randomUUID } from 'crypto';
import { delIfValue } from '~/server/redis/atomic';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { throwBadRequestError, throwConflictError } from '~/server/utils/errorHandling';
import { PaymentProvider } from '~/shared/utils/prisma/enums';

/**
 * A moderator re-reads a member's Stripe subscription into CustomerSubscription, for when a webhook
 * was missed. Writes nothing to Stripe: it reads, then runs the webhook's own `upsertSubscription`.
 *
 * That upsert ends a live Buzz-bought membership when the Stripe one is active or trialing, as the
 * webhook would. The preview names it, and the write is refused unless `confirmEndBuzzMembership`
 * matches the preview's confirm.
 *
 * Not the webhook's gift settlement, which writes to Stripe: an ended subscription is refused (its
 * deleted event hands over owed gifted months; resend that event from Stripe instead), and an owed
 * gift month on a live one is armed by the next subscription event.
 */

export const MEMBERSHIP_RESYNC_ACTIVITY = 'resyncMembership';
const LIVE_STATUSES = ['active', 'trialing', 'past_due'];
const ENDED_STATUSES = ['canceled', 'incomplete_expired'];
// upsertSubscription ends a live Buzz membership only for these.
const SUPERSEDING_STATUSES = ['active', 'trialing'];

const iso = (epoch: number | null | undefined) =>
  epoch == null ? null : new Date(epoch * 1000).toISOString();
// The upsert stores Stripe times through toDateTime, which is offset from the epoch (30 min, plus the
// process timezone's 1970 offset less its current one). A stored time that toDateTime gives for
// Stripe's shows Stripe's, so a matching row compares equal. Any other is shown with the offset
// undone, which is ambiguous around a spring-forward hour: toDateTime stores two seconds as one.
const storedIso = (d: Date | null, stripeEpoch?: number | null) => {
  if (d == null) return null;
  if (stripeEpoch != null && toDateTime(stripeEpoch).getTime() === d.getTime())
    return iso(stripeEpoch);
  let secs = Math.round(d.getTime() / 1000) - 1800;
  for (let i = 0; i < 3; i++) secs += Math.round((d.getTime() - toDateTime(secs).getTime()) / 1000);
  return iso(secs);
};

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

function rowView(
  row: {
    id: string;
    status: string;
    priceId: string;
    cancelAtPeriodEnd: boolean | null;
    cancelAt: Date | null;
    currentPeriodEnd: Date | null;
  },
  sub: Stripe.Subscription | null
): RowView {
  return {
    id: row.id,
    status: row.status,
    priceId: row.priceId,
    cancelAtPeriodEnd: !!row.cancelAtPeriodEnd,
    cancelAt: storedIso(row.cancelAt, sub?.cancel_at),
    currentPeriodEnd: storedIso(row.currentPeriodEnd, sub?.current_period_end),
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

// Mirrors liveBuzzMembershipWhere in subscriptions.service, which the upsert ends.
const liveBuzzMembership = (userId: number) =>
  dbWrite.customerSubscription.findFirst({
    where: {
      userId,
      buzzType: BUZZ_MEMBERSHIP_SUBSCRIPTION_TYPE,
      status: { notIn: ['canceled', 'incomplete_expired'] },
    },
    select: { id: true, status: true, currentPeriodEnd: true },
  });

type BuzzMembership = {
  id: string;
  status: string;
  currentPeriodEnd: string | null;
  /** Sent back as `confirmEndBuzzMembership`. A repeat Buzz purchase keeps the row id, so the token
   *  carries the period too: a month bought after the preview no longer matches. */
  confirm: string;
};
const buzzView = (b: { id: string; status: string; currentPeriodEnd: Date | null }) => {
  const currentPeriodEnd = b.currentPeriodEnd?.toISOString() ?? null;
  return {
    id: b.id,
    status: b.status,
    currentPeriodEnd,
    confirm: `${b.id}|${b.status}|${currentPeriodEnd}`,
  };
};

async function load(stripe: Stripe, userId: number) {
  const [row, user, buzz] = await Promise.all([
    dbWrite.customerSubscription.findUnique({
      where: { userId_buzzType: { userId, buzzType: 'green' } },
      select: rowSelect,
    }),
    dbWrite.user.findUnique({
      where: { id: userId },
      select: { customerId: true, isModerator: true },
    }),
    liveBuzzMembership(userId),
  ]);
  const problems: string[] = [];
  const customerId = user?.customerId ?? null;
  if (row && row.product.provider !== PaymentProvider.Stripe)
    problems.push(`the membership is billed by ${row.product.provider}, not Stripe`);
  if (!customerId) problems.push('the user has no Stripe customer');
  if (user?.isModerator) problems.push('the member is a moderator; change it out of band');
  if (stripeKeyMode(env.STRIPE_SECRET_KEY) !== 'live') problems.push('the Stripe key is not live');
  if (problems.length) return { problems, row, sub: null, customerId, buzz: null };

  const notFound = (e: { statusCode?: number }) => {
    if (e?.statusCode === 404) return null;
    throw e;
  };
  let sub: Stripe.Subscription | null = null;
  const listLive = async () => {
    const list = await stripe.subscriptions.list({
      customer: customerId as string,
      status: 'all',
      limit: 10,
    });
    return list.data.filter((s) => LIVE_STATUSES.includes(s.status));
  };
  if (row) {
    sub = await stripe.subscriptions.retrieve(row.id).catch(notFound);
    if (!sub) problems.push(`Stripe has no subscription ${row.id}`);
    else if (!LIVE_STATUSES.includes(sub.status)) {
      // The row's subscription is over, but another may have replaced it (both webhooks missed):
      // syncing the old one would mark a paying member as lapsed.
      const others = (await listLive()).filter((s) => s.id !== sub?.id);
      if (others.length)
        problems.push(
          `${row.id} is ${sub.status} but the customer has live ${others
            .map((s) => s.id)
            .join(', ')}; sync by hand`
        );
    }
    if (sub && ENDED_STATUSES.includes(sub.status))
      problems.push(
        `the subscription has ended (${sub.status}); resend its customer.subscription.deleted event from Stripe, which also settles gifted months (Stripe keeps events 30 days; older, ask an engineer)`
      );
  } else {
    // No row: the webhook that makes it was missed. Only an unambiguous single live one is synced.
    const live = await listLive();
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
  if (sub && !sub.livemode) problems.push('the subscription is not a live-mode subscription');
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
  const endsBuzz = sub && buzz && SUPERSEDING_STATUSES.includes(sub.status) ? buzzView(buzz) : null;
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
    ours: row ? rowView(row, sub) : null,
    stripe: sub ? stripeView(sub) : null,
    changes: sub ? diffRow(row ? rowView(row, sub) : null, stripeView(sub)) : [],
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
  /** The preview's `endsBuzzMembership.confirm`, when it named one. */
  confirmEndBuzzMembership?: string;
  actorId: number;
}) {
  refuseOwn(userId, actorId);
  const stripe = await requireStripe();
  // Shares extend's and cancel's lock: a re-sync that read Stripe before their write would store
  // that old copy over the webhook's newer row.
  const lockKey = `${REDIS_SYS_KEYS.MEMBERSHIP_EXTEND.LOCK}:${userId}` as const;
  const owner = randomUUID();
  if ((await sysRedis.set(lockKey, owner, { NX: true, EX: 600 })) === null)
    throw throwConflictError('Another membership change for this member is in progress');
  try {
    return await resyncLocked({ stripe, userId, reason, confirmEndBuzzMembership, actorId });
  } finally {
    await delIfValue(sysRedis, lockKey, owner).catch(() => undefined);
  }
}

async function resyncLocked({
  stripe,
  userId,
  reason,
  confirmEndBuzzMembership,
  actorId,
}: {
  stripe: Stripe;
  userId: number;
  reason: string;
  /** The preview's `endsBuzzMembership.confirm`, when it named one. */
  confirmEndBuzzMembership?: string;
  actorId: number;
}) {
  const { problems, row, sub, customerId, buzz } = await load(stripe, userId);
  // Decided on this read, not the preview's: a Buzz membership that appeared since still needs the confirm.
  if (buzz && confirmEndBuzzMembership !== buzz.confirm)
    problems.push(
      `this ends the member's Buzz-bought membership ${buzz.id} (to ${buzz.currentPeriodEnd}); confirm it from a fresh preview to re-sync`
    );
  if (problems.length || !sub || !customerId) {
    await log({ type: 'refused', actorId, userId, reason, problems });
    throw throwBadRequestError(`Not re-synced: ${problems.join('; ')}`);
  }

  const before = row ? rowView(row, sub) : null;
  const changes = diffRow(before, stripeView(sub));
  const audit = () =>
    trackModActivity(actorId, {
      entityType: 'user',
      entityId: userId,
      activity: MEMBERSHIP_RESYNC_ACTIVITY,
    }).catch((e) => log({ type: 'audit-failed', actorId, userId, error: (e as Error).message }));
  // The upsert ends whatever Buzz membership is live when it runs: refuse if that is no longer the
  // one this decision (and the moderator's confirm) was about.
  const buzzNow = SUPERSEDING_STATUSES.includes(sub.status)
    ? await liveBuzzMembership(userId)
    : null;
  if ((buzzNow ? buzzView(buzzNow).confirm : null) !== (buzz?.confirm ?? null)) {
    await log({ type: 'refused', actorId, userId, reason, problems: ['Buzz membership changed'] });
    throw throwConflictError("The member's Buzz-bought membership changed; preview again");
  }
  // Webhooks and the member's own changes take no lock: refuse to store a copy Stripe has moved past.
  const fresh = await stripe.subscriptions.retrieve(sub.id);
  if (diffRow(stripeView(sub), stripeView(fresh)).length) {
    await log({ type: 'refused', actorId, userId, reason, problems: ['subscription changed'] });
    throw throwConflictError(
      'The subscription changed in Stripe during the re-sync; preview again'
    );
  }
  try {
    // Not a webhook event type, so the upsert neither waits out a webhook race nor deletes the row.
    await upsertSubscription(sub, customerId, new Date(), 'moderator.resync');
  } catch (e) {
    // Its writes are not one transaction: the row may be written and a Buzz membership ended.
    await audit();
    await log({
      type: 'resync-failed',
      actorId,
      userId,
      subscriptionId: sub.id,
      reason,
      before,
      changes,
      error: (e as Error).message,
    });
    throw e;
  }
  await audit();
  await syncFreshdeskMembership({ customerId }).catch((e) =>
    log({ type: 'freshdesk-sync-failed', userId, error: (e as Error).message })
  );
  const afterRow = await dbWrite.customerSubscription.findUnique({
    where: { userId_buzzType: { userId, buzzType: 'green' } },
    select: rowSelect,
  });
  const after = afterRow ? rowView(afterRow, sub) : null;
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
