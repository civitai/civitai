import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { UserMeta } from '~/server/schema/user.schema';
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
    // Over-fetch, then drop the ones still inside their backoff, so a stuck account cannot hold
    // the head of the queue and starve everything behind it.
    // 🔴 Eligibility is STATE, never a cutoff. A deleted account that still points at a Stripe
    // customer has not been scrubbed — that is the whole definition. An earlier draft carried a
    // start date of 2026-09-18 22:40 UTC, meant to keep the job off the accounts the one-time pass
    // had already done; the one-time pass has since run, and that date was measured to STRAND 2
    // accounts it never covered, both still holding an email at Stripe.
    //
    // `lte` is the one date here and it postpones rather than excludes: an account becomes
    // eligible as it ages past the delay, so nothing can be stranded by it.
    const candidates = (await dbWrite.user.findMany({
      where: {
        // Our own cancel's `customer.subscription.deleted` is resolved BY customerId, and
        // `upsertSubscription` throws above every branch when it cannot find the user. Waiting
        // lets that event land while the pointer still resolves, which is why the webhook needed
        // no change. A JS Date, never a literal: `deletedAt` is timestamp WITHOUT time zone and
        // Postgres drops the offset of a literal that carries one.
        deletedAt: { not: null, lte: new Date(now.getTime() - WEBHOOK_SETTLE_MS) },
        customerId: { not: null },
      },
      select: { id: true, customerId: true, meta: true },
      // Least recently touched first. `recordAttempt` writes the row, which bumps `updatedAt`, so
      // an account that cannot finish rotates to the back instead of holding the window and
      // starving every deletion behind it.
      orderBy: { updatedAt: 'asc' },
      take: BATCH_SIZE * 4,
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
      failed: 0,
    };

    for (const user of due) {
      jobContext.checkIfCanceled();
      // While Stripe is degraded every call can burn its full retry budget, and 25 accounts of
      // that outlast the 10-minute cron: runs would then stack, each holding a request open. An
      // account not reached here is simply taken next tick, which is how the queue already works.
      if (Date.now() - now.getTime() > RUN_BUDGET_MS) break;
      const customerId = user.customerId as string;
      summary.processed++;

      const outcome = await scrubStripeAccount({ customerId }).catch((error) => ({
        complete: false,
        errors: [{ step: 'scrub', message: (error as Error)?.message ?? 'unknown' }],
        blocked: [],
      }));
      summary.blocked += outcome.blocked.length;

      if (!outcome.complete) {
        summary.failed++;
        await recordAttempt(user.id, outcome.errors[0], now);
        continue;
      }

      // Guarded so a restore between the read and this write keeps its pointer, and so a second
      // run cannot null a pointer it did not scrub. `meta` is re-read here rather than reused from
      // the selection: a scrub is many seconds of Stripe calls, and this write replaces the whole
      // object, so the stale copy would clobber anything written meanwhile.
      const { count } = await dbWrite.user.updateMany({
        where: { id: user.id, deletedAt: { not: null }, customerId },
        data: { customerId: null, meta: clearScrubState(await currentMeta(user.id)) },
      });
      if (count) summary.scrubbed++;
    }

    return summary;
  }
);

const clearScrubState = (meta: Prisma.JsonValue) => {
  const { gdprStripeScrub: _, ...rest } = (meta ?? {}) as UserMeta;
  return rest as Prisma.JsonObject;
};

const currentMeta = async (userId: number) =>
  ((await dbWrite.user.findUnique({ where: { id: userId }, select: { meta: true } }))?.meta ??
    {}) as Prisma.JsonValue;

async function recordAttempt(
  userId: number,
  failure: { step: string; message: string } | undefined,
  now: Date
) {
  const meta = await currentMeta(userId);
  const attempts = ((meta as UserMeta | null)?.gdprStripeScrub?.attempts ?? 0) + 1;

  await dbWrite.user.update({
    where: { id: userId },
    data: {
      meta: {
        ...((meta ?? {}) as Prisma.JsonObject),
        gdprStripeScrub: {
          attempts,
          lastAttemptAt: now.toISOString(),
          lastError: failure?.message,
        },
      } as Prisma.JsonObject,
    },
  });

  if (attempts >= ALERT_AFTER_ATTEMPTS) {
    await logToAxiom({
      name: 'gdpr-stripe-scrub-stuck',
      type: 'error',
      userId,
      attempts,
      // The step is what tells a reader whether this account needs Stripe support or a code fix.
      step: failure?.step,
      message: failure?.message,
    }).catch(() => null);
  }
}
