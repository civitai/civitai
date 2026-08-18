import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { updateEntityMetricDetached } from '~/server/utils/metric-helpers';

/**
 * A paid placement counts toward the Buzz counter on the content it sits on.
 *
 * Agreed by Justin, Ellie and Luis in the 2026-08-12 review for stickers — a
 * placement reads as a pseudo-tip, and the counter people already look at should
 * say so — and widened by Justin the same day to every surface. A sticker and a
 * remix entry are the same act from the counter's point of view: someone paid to
 * be on this image. The whole `amount` counts, not the owner's share of it;
 * Justin's own example was two 200⚡ stickers taking a counter from 13 to 413.
 *
 * **Accepted placements only** (Justin, 2026-08-12). A decline counts nothing
 * whatever it pays: most leave a non-refundable fee with the owner, some waive
 * it entirely, and neither moves this number. That is the one place the counter
 * is not "Buzz the creator received", and it is deliberate — counting declines
 * would grow it fastest for a creator who refuses everything. What it means
 * instead is *what people paid to be on this image*.
 *
 * **Never reversed.** Every path that takes a *live* placement down — owner
 * removal past its lock, a moderator takedown, a cosmetic takedown — moves no
 * money back, so there is nothing to take off the counter, and a counter that
 * fell would read as the creator losing Buzz they still hold.
 *
 * The same event the tip button emits (`Image`/`Buzz`), so this arrives through
 * the metric pipeline the feed, the detail page and the search index already
 * read, rather than as a second number each of them has to learn to add.
 *
 * **This sweep is the only emitter.** The per-approval emit that shipped in
 * #3849 is gone, and that is the point rather than a simplification:
 *
 * - It could not report failure. `Tracker.send` dispatches with `void`, so an
 *   awaited emit returned before the POST was attempted; stamping after it
 *   recorded a dropped event as counted, which is worse than the loss it
 *   replaced. Making it wait instead put an untimed network call inside a money
 *   mutation — and `actOnStickerPlacements` loops up to 50 of them in one
 *   request, so a tracker returning fast 500s turns a bulk approve into a
 *   minute of sleeping and a gateway timeout, on placements that were all
 *   settled and paid.
 * - It emitted one event per placement, and the pipeline's dedupe key has no
 *   `metricValue` and second-precision `createdAt`. Two placements by one placer
 *   on one image approved inside the same second collapsed into one, which a
 *   bulk approve produces routinely. Grouping is only possible here.
 *
 * The cost, stated: the counter moves on the next tick rather than instantly.
 * That is the trade the ticket names for this option and recommends taking.
 */

/**
 * Marked after the emit, never before.
 *
 * The two orders trade one failure for the other and they are not equal: marking
 * first means a failed emit is recorded as counted and the Buzz is gone for
 * good, which is the bug this path exists to end. Marking after leaves a window
 * — the tracker accepts the row, the pod dies, the next run counts it again —
 * whose cost is one group counted twice on a number that is a display total.
 * Recoverable over-count beats unrecoverable loss.
 *
 * `updateMany` with the NULL guard rather than `update`, so a row two runs both
 * reached does not have its original stamp overwritten.
 */
async function markPlacementsCounted(placementIds: number[], lease: Date) {
  if (!placementIds.length) return 0;

  const { count } = await dbWrite.placement.updateMany({
    // Fenced on the lease. A run slower than `CLAIM_RETRY_MS` has had its own
    // claim expire and another run may hold these rows now; writing without the
    // token would let the loser confirm work the winner is still doing.
    where: { id: { in: placementIds }, metricCountedAt: null, metricClaimedAt: lease },
    data: { metricCountedAt: new Date() },
  });

  return count;
}

/**
 * How long a claim stands before another run may take the row back.
 *
 * The recovery window for a process that claimed rows and died before it could
 * confirm them. **Not load-bearing for correctness** — a run slower than this
 * loses its lease, and every write it makes afterwards is fenced on the exact
 * claim timestamp it was handed, so the row belongs to whoever holds the lease
 * now. Picking a number that "should" be long enough is what this replaced: the
 * worst case is bounded by a timeout times a retry count times a page size, and
 * that product was already larger than any duration worth waiting for.
 */
const CLAIM_RETRY_MS = 15 * 60 * 1000;

/**
 * How many times a row may be claimed before the sweep leaves it alone.
 *
 * A payload the tracker rejects fails identically on every retry, and the claim
 * is ordered oldest-first, so without a ceiling one poisoned row sits at the
 * head of the queue forever and starves the whole backlog behind it. Past the
 * ceiling the row is reported and skipped rather than retried.
 */
const MAX_CLAIM_ATTEMPTS = 10;

/**
 * The worst a single group's emit can cost: every attempt timing out, plus the
 * backoff between them. Subtracted from the lease before starting one, so a
 * group cannot begin work it has no time left to finish.
 */
const MAX_GROUP_EMIT_MS = 3 * 5_000 + 750;

/**
 * The durable path: count every placement that reached `approved` and never made
 * it onto the counter.
 *
 * Why a sweep over Postgres rather than CDC on `Placement` (the other option on
 * the ticket): the property that makes this correct is a column on the row, and
 * it needs no publication membership, no `REPLICA IDENTITY FULL`, and no handler
 * that has to tell a `pending → approved` transition from the four paths that
 * write `removed`. Getting that wrong makes a counter that decrements, which is
 * the one thing it must never do.
 *
 * **The claim is a lease, and every write afterwards carries its token.** That
 * is the whole design. Two sweeps can run at once — the job lock fails open when Redis is
 * unavailable, and `?noCheck=1` bypasses it — and with a single column both runs
 * read the same unstamped rows and both emit before either stamps. The counter
 * never reverses, so that over-count is permanent. `FOR UPDATE SKIP LOCKED` plus
 * the claim predicate makes two runs take disjoint sets instead. A run that dies
 * between claiming and confirming leaves rows claimed, and they are retried once
 * the claim goes stale, so a crash costs a delay rather than the Buzz.
 *
 * **Emits one summed event per (image, placer), not per placement**, because the
 * pipeline's key has no `metricValue` in it and its `createdAt` is
 * second-precision, so two events for the same image and placer inside one
 * second collapse and the second payment disappears.
 *
 * `alreadyEmitted` carries that guarantee *across* calls within one run: the
 * grouping is per page and the job drains up to ten pages back to back, so a
 * group split by a page boundary would emit twice within the same second. Such a
 * group has its claim RELEASED rather than merely skipped — left claimed it
 * would sit out the whole stale window, three ticks away, for a collision the
 * next tick a minute later cannot have.
 *
 * Never throws for one bad group: a single image whose emit fails must not stop
 * the rest of the backlog. Its rows keep their claim and come back when it goes
 * stale.
 */
export async function sweepUncountedPlacements({
  limit = 100,
  alreadyEmitted,
}: { limit?: number; alreadyEmitted?: Set<string> } = {}) {
  const idle = {
    considered: 0,
    counted: 0,
    amount: 0,
    deferred: 0,
    undelivered: 0,
    skipped: false,
  };

  // Default-off, and it must stay off until the migration's backfill has been
  // re-run against the deployed code. Everything approved between the ALTER and
  // that re-run was counted by the old code without being stamped, so a sweep
  // running first re-emits all of it — with a fresh `createdAt`, so it sums
  // rather than collapsing, and the counter never comes back down.
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.PLACEMENT_METRIC_SWEEP)))
    return { ...idle, skipped: true };

  // Hoisted ahead of the claim, because both are process-global rather than
  // per-group. Discovering them after claiming burned an attempt and held the
  // claim for the full stale window on every row it touched — ten cycles of that
  // is two and a half hours, and an incident kill-switch left on for an
  // afternoon would have taken the entire queue past its ceiling and made it
  // permanently invisible. Nothing is claimed unless an emit could land.
  if (!env.CLICKHOUSE_TRACKER_URL || (await isFlipt('disable-app-entity-metrics')))
    return { ...idle, skipped: true };

  const staleBefore = new Date(Date.now() - CLAIM_RETRY_MS);

  /**
   * `removed` is countable because those placements were approved first — the
   * money moved — and the counter counts the approval and never reverses.
   *
   * **But `removed` alone is not that set.** All three `removeBy*` settle
   * actions are also driven straight from `pending`: a moderator suspending an
   * abusive placer runs `removePlacementsByUser` over their pending rows, whose
   * escrow is *forfeited* — no owner is paid and nothing was ever live.
   * Counting those would make moderating abuse inflate the counter on the images
   * it targeted, and it breaks the "accepted placements only" rule above.
   * `takenDownAt` is the discriminator: only a takedown of an already-settled
   * placement sets it.
   */
  const claimed = await dbWrite.$queryRaw<
    {
      id: number;
      targetId: number;
      placerId: number;
      amount: number;
      metricClaimedAt: Date;
      metricAttempts: number;
    }[]
  >`
    WITH candidate AS (
      SELECT id
      FROM "Placement"
      WHERE "metricCountedAt" IS NULL
        AND "targetType" = 'image'
        AND "resolvedAt" IS NOT NULL
        AND (status = 'approved' OR (status = 'removed' AND "takenDownAt" IS NOT NULL))
        AND ("metricClaimedAt" IS NULL OR "metricClaimedAt" < ${staleBefore})
        AND "metricAttempts" < ${MAX_CLAIM_ATTEMPTS}
      ORDER BY "resolvedAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "Placement" p
    SET "metricClaimedAt" = now(), "metricAttempts" = p."metricAttempts" + 1
    FROM candidate c
    WHERE p.id = c.id
    RETURNING p.id, p."targetId", p."placerId", p.amount, p."metricClaimedAt", p."metricAttempts"
  `;

  if (!claimed.length) return idle;

  // One statement, so `now()` is the transaction timestamp and every row in the
  // page carries the same value. That is the lease token every write below is
  // fenced on.
  const lease = claimed[0].metricClaimedAt;

  const groups = new Map<
    string,
    {
      key: string;
      imageId: number;
      placerId: number;
      amount: number;
      ids: number[];
      attempts: number;
    }
  >();

  for (const row of claimed) {
    const key = `${row.targetId}:${row.placerId}`;
    const group = groups.get(key) ?? {
      key,
      imageId: row.targetId,
      placerId: row.placerId,
      amount: 0,
      ids: [],
      attempts: 0,
    };
    group.amount += row.amount;
    group.ids.push(row.id);
    group.attempts = Math.max(group.attempts, row.metricAttempts);
    groups.set(key, group);
  }

  let counted = 0;
  let amount = 0;
  const deferredIds: number[] = [];
  // Counted apart from a collision defer: one is the design working, the other
  // is the sweep unable to emit at all, and the job's alarm turns on the
  // difference.
  let undelivered = 0;

  for (const group of groups.values()) {
    if (alreadyEmitted?.has(group.key)) {
      deferredIds.push(...group.ids);
      continue;
    }

    // The fence stops a run that lost its lease from *writing*, but the emit is
    // the irreversible half and no database guard reaches it. A run slow enough
    // to outlive its own claim would emit for rows its successor has already
    // emitted for — two events, different seconds, additive metric, permanent.
    //
    // The margin is what makes this airtight rather than merely bounded. Checked
    // against the bare lease, a group starting at one second to expiry and
    // hitting the worst case finishes past it: emitted, then unable to confirm,
    // then re-claimed and emitted again. Refuse to start what cannot finish.
    // The rest of the page keeps its stale claim, which is the recovery path
    // that already exists.
    if (Date.now() - lease.getTime() > CLAIM_RETRY_MS - MAX_GROUP_EMIT_MS) break;

    try {
      // A zero-amount group is confirmed without an emit rather than skipped:
      // left unconfirmed it would be re-claimed every time its claim went stale
      // and eat the batch ahead of rows that do need counting.
      const delivered =
        group.amount <= 0 ||
        (await updateEntityMetricDetached({
          entityType: 'Image',
          entityId: group.imageId,
          metricType: 'Buzz',
          amount: group.amount,
          userId: group.placerId,
          awaitDelivery: true,
        }));

      // Not a failure, so it is handed back rather than left holding a claim:
      // the checks above make this all but unreachable, but a caller that
      // reports "not delivered" for a reason this function does not know about
      // must not cost the row an attempt it never spent.
      if (!delivered) {
        deferredIds.push(...group.ids);
        undelivered += group.ids.length;
        continue;
      }

      alreadyEmitted?.add(group.key);
      counted += await markPlacementsCounted(group.ids, lease);
      amount += group.amount;
    } catch (error) {
      await logToAxiom({
        name: 'placement-metrics',
        type: 'error',
        message: 'could not reconcile a placement group onto the image buzz counter',
        imageId: group.imageId,
        placerId: group.placerId,
        placementIds: group.ids,
        amount: group.amount,
        attempts: group.attempts,
        // Named so a poisoned row is visible before it is abandoned rather than
        // after: past the ceiling the claim stops selecting it entirely, and the
        // only remaining symptom is a counter that is quietly short.
        abandonedAfterThis: group.attempts >= MAX_CLAIM_ATTEMPTS,
        error: (error as Error).message,
      }).catch(() => null);
    }
  }

  // Handed straight back, so the next tick sees them. Their only problem was
  // arriving in the same second as a group that has already gone out.
  if (deferredIds.length)
    await dbWrite.placement.updateMany({
      // Fenced for the same reason the confirmation is: releasing a claim we no
      // longer hold would hand rows another run is actively emitting for to a
      // third one.
      where: { id: { in: deferredIds }, metricCountedAt: null, metricClaimedAt: lease },
      // The attempt is given back with the claim. A deferred row was never
      // tried — nothing was emitted for it — and letting deferrals burn the
      // ceiling would abandon a group whose only fault is being large enough to
      // span pages ten times.
      data: { metricClaimedAt: null, metricAttempts: { decrement: 1 } },
    });

  return {
    considered: claimed.length,
    counted,
    amount,
    deferred: deferredIds.length - undelivered,
    undelivered,
    skipped: false,
  };
}

/**
 * How many placements the sweep has given up on.
 *
 * The ceiling turns a starving queue into a bounded loss, and this is what makes
 * the loss visible: past it the claim stops selecting these rows entirely, so
 * without a count the counter is quietly short by an unknown amount forever.
 */
export async function countAbandonedPlacements() {
  return dbWrite.placement.count({
    where: { metricCountedAt: null, metricAttempts: { gte: MAX_CLAIM_ATTEMPTS } },
  });
}
