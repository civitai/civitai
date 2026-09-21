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

/**
 * The backfill's customer list was snapshotted at 2026-09-18 22:47:33 UTC; this floor sits a
 * margin earlier because that timestamp is when the file finished WRITING, not when its SELECT
 * ran, and an account deleted in between belongs to neither side.
 *
 * 🔴 `User.deletedAt` is `timestamp` WITHOUT time zone and stores UTC. Postgres DROPS the offset
 * when casting a literal that carries one, silently meaning a different instant, so this is a JS
 * Date sent through Prisma (which serialises UTC) and never a hand-written offset literal.
 *
 * Accounts deleted BEFORE it belong to the one-time backfill's own `customerId` purge, which is
 * bounded by membership of that list and is not this job's work.
 */
export const GDPR_STRIPE_SCRUB_FLOOR = new Date('2026-09-18T22:40:00Z');

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
    const candidates = (await dbWrite.user.findMany({
      where: {
        deletedAt: { gte: GDPR_STRIPE_SCRUB_FLOOR },
        customerId: { startsWith: 'cus_' },
      },
      select: { id: true, customerId: true, meta: true },
      orderBy: { deletedAt: 'asc' },
      take: BATCH_SIZE * 4,
    })) as Candidate[];

    const due = candidates
      .filter((user) => !!user.customerId && CUSTOMER_ID_SHAPE.test(user.customerId))
      .filter((user) => isDue((user.meta as UserMeta | null)?.gdprStripeScrub, now))
      .slice(0, BATCH_SIZE);

    const summary = { considered: candidates.length, processed: 0, scrubbed: 0, blocked: 0, failed: 0 };

    for (const user of due) {
      jobContext.checkIfCanceled();
      const customerId = user.customerId as string;
      summary.processed++;

      const outcome = await scrubStripeAccount({ userId: user.id, customerId }).catch((error) => ({
        complete: false,
        errors: [{ step: 'scrub', message: (error as Error)?.message ?? 'unknown' }],
        blocked: [],
      }));
      summary.blocked += outcome.blocked.length;

      if (!outcome.complete) {
        summary.failed++;
        await recordAttempt(user, outcome.errors[0]?.message, now);
        continue;
      }

      // Guarded so a restore between the read and this write keeps its pointer, and so a second
      // run cannot null a pointer it did not scrub.
      const { count } = await dbWrite.user.updateMany({
        where: { id: user.id, deletedAt: { not: null }, customerId },
        data: { customerId: null, meta: clearScrubState(user.meta) },
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

async function recordAttempt(user: Candidate, lastError: string | undefined, now: Date) {
  const previous = (user.meta as UserMeta | null)?.gdprStripeScrub;
  const attempts = (previous?.attempts ?? 0) + 1;

  await dbWrite.user.update({
    where: { id: user.id },
    data: {
      meta: {
        ...((user.meta ?? {}) as Prisma.JsonObject),
        gdprStripeScrub: { attempts, lastAttemptAt: now.toISOString(), lastError },
      } as Prisma.JsonObject,
    },
  });

  if (attempts >= ALERT_AFTER_ATTEMPTS) {
    await logToAxiom({
      name: 'gdpr-stripe-scrub-stuck',
      type: 'error',
      userId: user.id,
      attempts,
      message: lastError,
    }).catch(() => null);
  }
}
