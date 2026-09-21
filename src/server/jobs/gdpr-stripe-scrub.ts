import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { userUpdateCounter } from '~/server/prom/client';
import { logToAxiom } from '~/server/logging/client';
import type { UserMeta } from '~/server/schema/user.schema';
import type { ScrubOutcome } from '~/server/services/gdpr/stripe-account-scrub';
import { CUSTOMER_ID_SHAPE, scrubStripeAccount } from '~/server/services/gdpr/stripe-account-scrub';
import { createJob } from './job';

/**
 * Brings deleted accounts to the same Stripe state as the one-time backfill of 2026-09-18:
 * customer PII cleared, payment methods cleared or detached, `metadata.userId` gone, and only then
 * our `customerId` pointer dropped.
 *
 * `deleteUser` does none of this inline. Deletion has to complete while Stripe is down, and a
 * retry path that runs only during an outage is a path nobody has seen run — here the outage case
 * and the ordinary case are the same code, exercised on every deletion.
 *
 * THE QUEUE IS THE DATA. A deleted account whose `customerId` is still set has not been scrubbed;
 * that is also the query the backfill's own id list was built from, so it cannot drift from
 * reality. Nothing is enqueued, so no failure can lose a deletion.
 */

/** How long a deletion is left alone so its own Stripe webhook can land first. */
const WEBHOOK_SETTLE_MS = 15 * 60 * 1000;

/** Stops a degraded-Stripe run outlasting the 10-minute cron and stacking on the next one. */
const RUN_BUDGET_MS = 8 * 60 * 1000;

/** Sequential, small, and deliberately not adaptive: the rate limit is shared with live checkout. */
const BATCH_SIZE = 25;
/** Several batches of headroom, so held-back accounts cannot fill the window. */
const WINDOW_SIZE = BATCH_SIZE * 8;
const BASE_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
/** ~2 days of backoff. Past this the account needs a human, so say so once per run. */
const ALERT_AFTER_ATTEMPTS = 8;

type ScrubState = NonNullable<UserMeta['gdprStripeScrub']>;

type Candidate = { id: number; customerId: string | null; meta: Prisma.JsonValue };

export const isDue = (state: ScrubState | undefined, now: Date) => {
  if (!state) return true;
  const last = Date.parse(state.lastAttemptAt);
  if (!Number.isFinite(last)) return true;
  const wait = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, state.attempts - 1), MAX_BACKOFF_MS);
  return now.getTime() - last >= wait;
};

export const gdprStripeScrubJob = createJob(
  'gdpr-stripe-scrub',
  '*/10 * * * *',
  async (jobContext) => {
    const now = new Date();
    // 🔴 Eligibility is STATE, never a cutoff. A deleted account that still points at a Stripe
    // customer has not been scrubbed — that is the whole definition. An earlier draft carried a
    // start date of 2026-09-18 22:40 UTC, meant to keep the job off the accounts the one-time pass
    // had already done; the one-time pass has since run, and that date was measured to STRAND 2
    // accounts it never covered, both still holding an email at Stripe.
    //
    // `lte` is the one date here and it postpones rather than excludes: an account becomes
    // eligible as it ages past the delay, so nothing can be stranded by it.
    // Read from the replica: the guarded update below makes a stale read harmless (at worst an
    // account is attempted a tick early or late), and without the partial index this query reads
    // every deleted row — 1.3M today — which has no business running on the primary.
    const candidates = (await dbRead.user.findMany({
      where: {
        // Our own cancel's `customer.subscription.deleted` is resolved BY customerId, and
        // `upsertSubscription` throws above every branch when it cannot find the user. Waiting
        // lets that event land while the pointer still resolves, which is why the webhook needed
        // no change. A JS Date, never a literal: `deletedAt` is timestamp WITHOUT time zone and
        // Postgres drops the offset of a literal that carries one.
        deletedAt: { not: null, lte: new Date(now.getTime() - WEBHOOK_SETTLE_MS) },
        // Prisma cannot express `^cus_[A-Za-z0-9]+$`, so this only excludes the empty-string row;
        // a `cus_..._MERGED` value still starts with `cus_` and is caught by the service's own
        // check before any Stripe call. Those few rows do keep their window slots — the window is
        // 8 batches wide for that reason, and the full-window alert is what would say otherwise.
        customerId: { startsWith: 'cus_' },
      },
      select: { id: true, customerId: true, meta: true },
      orderBy: { deletedAt: 'asc' },
      // The window is deliberately several batches wide. An account that cannot finish keeps its
      // pointer and stays in this window, but its backoff drops it before the batch is formed, so
      // it costs a window slot rather than a run. `User` carries no updated-at column to rotate
      // on; the alert at ALERT_AFTER_ATTEMPTS is what says the head of the queue needs a person.
      take: WINDOW_SIZE,
    })) as Candidate[];

    // Two prod rows hold a value that is not a Stripe id (a `_MERGED` suffix, and an empty
    // string). The suffix must never be stripped — the base id resolves to a customer whose owner
    // could not be established — so they are counted and left alone rather than retried forever.
    const usable = candidates.filter(
      (user) => !!user.customerId && CUSTOMER_ID_SHAPE.test(user.customerId)
    );
    const due = usable
      .filter((user) => isDue((user.meta as UserMeta | null)?.gdprStripeScrub, now))
      .slice(0, BATCH_SIZE);

    const summary = {
      considered: candidates.length,
      malformed: candidates.length - usable.length,
      processed: 0,
      scrubbed: 0,
      blocked: 0,
      pending: 0,
      failed: 0,
    };

    for (const user of due) {
      jobContext.checkIfCanceled();
      // While Stripe is degraded every call can burn its full retry budget, and 25 accounts of
      // that outlast the 10-minute cron: runs would then stack, each holding a request open. An
      // account not reached here is simply taken next tick, which is how the queue already works.
      if (Date.now() - now.getTime() > RUN_BUDGET_MS) break;
      const customerId = user.customerId as string;

      // The selection came off a replica, and nothing below has an inverse: cancels, detaches and
      // metadata strips cannot be undone by the guard on the final write. Re-read the two fields
      // that decide eligibility from the PRIMARY first, so a restore that has not replicated yet
      // cannot be scrubbed. One findUnique against an account that is about to cost dozens of
      // Stripe round-trips.
      const live = await dbWrite.user.findUnique({
        where: { id: user.id },
        select: { deletedAt: true, customerId: true, meta: true },
      });
      if (!live?.deletedAt || live.customerId !== customerId) continue;

      summary.processed++;

      const outcome = await scrubStripeAccount({ customerId }).catch(
        (error): ScrubOutcome => ({
          complete: false,
          customerGone: false,
          pending: false,
          cleared: { paymentMethods: 0, charges: 0, paymentIntents: 0 },
          blocked: [],
          canceledSubscriptions: [],
          errors: [{ step: 'scrub', message: (error as Error)?.message ?? 'unknown' }],
        })
      );
      summary.blocked += outcome.blocked.length;

      if (!outcome.complete) {
        // Pending is not failure: the account is waiting on a payment of its own, not on us. It
        // still takes the backoff, so it is not re-attempted every ten minutes for a day.
        if (outcome.errors.length) summary.failed++;
        else summary.pending++;
        await recordAttempt(user.id, live.meta, outcome.errors[0], now);
        continue;
      }

      // A subscription cancelled THIS run emits customer.subscription.deleted asynchronously, and
      // that event is resolved BY customerId. Dropping the pointer seconds later would 400 it, and
      // Stripe retries a 4xx endpoint for days. Leave it to the next run, which is far enough
      // behind for the event to have landed.
      if (outcome.canceledSubscriptions.length) {
        summary.pending++;
        await recordAttempt(user.id, live.meta, undefined, now);
        continue;
      }

      // Guarded so a restore between the read and this write keeps its pointer, and so a second
      // run cannot null a pointer it did not scrub. `meta` is re-read here rather than reused from
      // the selection: a scrub is many seconds of Stripe calls, and this write replaces the whole
      // object, so the stale copy would clobber anything written meanwhile.
      // One statement, and `meta - key` rather than a read-modify-write: `User.meta` is shared
      // with moderation paths (ban details, mute reason, contest state) that know nothing about
      // this job, and writing the whole object back drops whichever of theirs landed in between.
      const count = await dbWrite.$executeRaw`
        UPDATE "User"
        SET "customerId" = NULL, "meta" = COALESCE("meta", '{}'::jsonb) - 'gdprStripeScrub'
        WHERE id = ${user.id} AND "deletedAt" IS NOT NULL AND "customerId" = ${customerId}
      `;
      if (count) {
        userUpdateCounter?.inc({ location: 'jobs:gdpr-stripe-scrub:pointer' });
        summary.scrubbed++;
      }
    }

    // Held-back and malformed rows keep their pointer, so they keep their place in an
    // ordered-by-deletedAt window. A full window means newer deletions may not be visible at all,
    // and it is the only thing that tells a blocked queue from an empty one.
    // Only on a full window. `malformed` is a permanent two-row condition, so alerting on it would
    // emit the same warning every ten minutes until someone hand-fixes those rows, which is how a
    // channel gets muted — taking this error with it. The count stays in the returned summary.
    if (candidates.length >= WINDOW_SIZE)
      await logToAxiom({ name: 'gdpr-stripe-scrub-queue', type: 'error', ...summary }).catch(
        () => null
      );

    return summary;
  },
  // 🔴 The lock is the ONLY thing stopping two runs of this job overlapping, and it must outlast
  // the work. At the default 5 minutes it expires 3 minutes before RUN_BUDGET_MS, releasing
  // mid-run so the next tick starts a second pass over the same accounts — re-issuing the same
  // Stripe calls against a rate limit shared with live checkout. `checkIfCanceled` does not
  // substitute: the release never touches the job context.
  { lockExpiration: 30 * 60 }
);

async function recordAttempt(
  userId: number,
  currentMeta: Prisma.JsonValue,
  failure: { step: string; message: string } | undefined,
  now: Date
) {
  // From the PRIMARY's copy, not the replica selection's: a lagging read would recompute the
  // count from a stale value and reset the backoff it is supposed to grow.
  const attempts = ((currentMeta as UserMeta | null)?.gdprStripeScrub?.attempts ?? 0) + 1;
  const state: ScrubState = { attempts, lastAttemptAt: now.toISOString() };
  if (failure) state.lastError = failure.message;

  // jsonb_set, for the same reason as the pointer write above: this key is ours, the rest of
  // `meta` belongs to paths that are writing it concurrently.
  await dbWrite.$executeRaw`
    UPDATE "User"
    SET "meta" = jsonb_set(COALESCE("meta", '{}'::jsonb), '{gdprStripeScrub}', ${JSON.stringify(
      state
    )}::jsonb)
    WHERE id = ${userId} AND "deletedAt" IS NOT NULL
  `;
  userUpdateCounter?.inc({ location: 'jobs:gdpr-stripe-scrub:attempt' });

  // Only a real failure is worth a person's time. An account merely waiting out its own payment
  // would otherwise alert with no step and no message to act on.
  // A restore between the selection and here strips this key again; the guard above is what stops
  // us writing it back onto a live account.
  if (attempts >= ALERT_AFTER_ATTEMPTS) {
    await logToAxiom({
      name: 'gdpr-stripe-scrub-stuck',
      type: 'error',
      userId,
      attempts,
      // The step is what tells a reader whether this account needs Stripe support or a code fix.
      // Absent it, the account is not failing — it is waiting on a payment of its own — and that
      // is worth saying rather than staying silent, because a permanently pending account holds
      // its place in the window and nothing else reports it.
      step: failure?.step ?? 'pending',
      message: failure?.message,
    }).catch(() => null);
  }
}
