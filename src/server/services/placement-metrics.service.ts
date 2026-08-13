import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { updateEntityMetricDetached } from '~/server/utils/metric-helpers';
import type { PlacementSurface } from '~/shared/utils/placement';

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
 * Shared rather than one copy per surface, because the two would drift and the
 * number would then mean something different depending on which surface you
 * asked — the one property a single counter cannot afford to lose.
 *
 * **Accepted placements only** (Justin, 2026-08-12). A decline counts nothing
 * whatever it pays: most leave a non-refundable fee with the owner, some waive
 * it entirely, and neither moves this number. That is the one place the counter
 * is not "Buzz the creator received", and it is deliberate — counting declines
 * would grow it fastest for a creator who refuses everything. What it means
 * instead is *what people paid to be on this image*, which is also what makes
 * it legible next to the content it labels.
 *
 * **Never reversed.** Every path that takes a live placement down — owner
 * removal past its lock, a moderator takedown, a cosmetic takedown — moves no
 * money back, so there is nothing to take off the counter; and a counter that
 * fell would read as the creator losing Buzz they still hold.
 *
 * The same event the tip button emits (`Image`/`Buzz`), so this arrives through
 * the metric pipeline the feed, the detail page and the search index already
 * read, rather than as a second number each of them has to learn to add.
 *
 * Detached from any request context on purpose: approval happens from a review
 * queue, from an auto-approving space and from a bulk action, and the counter
 * has to move the same way in all three.
 *
 * **Nothing here may throw.** It runs after the settle has already claimed the
 * transition and paid the owner, so a throw would report a live, paid placement
 * as failed — and in a bulk path would put its id in `failed`, inviting the
 * owner to action it again. `updateEntityMetric` catches its own emission, but
 * the module load, the tracker construction and the flag read sit outside that,
 * so the whole call is wrapped rather than trusting where that boundary happens
 * to fall today.
 *
 * This is still the best-effort half: it runs after a committed settle, outside
 * any transaction. What changed is that a failure is now recoverable rather than
 * permanent — the emit only writes `metricCountedAt` once it has happened, and
 * {@link sweepUncountedPlacements} counts whatever is still missing it.
 */
export async function recordPlacementTip({
  surface,
  placementId,
  imageId,
  amount,
  placerId,
}: {
  /** For the log only — the counter does not distinguish them. */
  surface: PlacementSurface;
  /**
   * The row to mark once the Buzz has been counted. Without it the emit is
   * unrepeatable *and* unrecoverable: nothing downstream carries a placement id,
   * so a lost emit would stay indistinguishable from one that never happened.
   */
  placementId: number;
  imageId: number;
  amount: number;
  /**
   * Who paid, attributed the way a tip attributes its tipper.
   *
   * Not cosmetic: `userId` is part of the key the metric pipeline dedupes on
   * — `(entityType, entityId, metricType, userId, createdAt)`, with no
   * `metricValue` in it — so two placements landing on the same image, under
   * the same attribution, in the same second would replace one another and the
   * second payment would vanish from the counter. A request-less `Tracker`
   * attributes everything to 0, which is exactly the collision this avoids; a
   * bulk approval loop is the shape that would hit it.
   */
  placerId: number;
}) {
  try {
    const counted =
      amount <= 0 ||
      (await updateEntityMetricDetached({
        entityType: 'Image',
        entityId: imageId,
        metricType: 'Buzz',
        amount,
        userId: placerId,
        awaitDelivery: true,
      }));

    if (counted) await markPlacementsCounted([placementId]);
  } catch (error) {
    await logToAxiom({
      name: 'placement-metrics',
      type: 'error',
      message: 'could not count an approved placement toward the image buzz counter',
      surface,
      placementId,
      imageId,
      amount,
      error: (error as Error).message,
    }).catch(() => null);
  }
}

/**
 * Marked after the emit, never before.
 *
 * The two orders trade one failure for the other and they are not equal: marking
 * first means a failed emit is recorded as counted and the Buzz is gone for
 * good, which is the bug this whole path exists to end. Marking after leaves a
 * window — emit lands, pod dies, the sweep counts it again — whose cost is one
 * placement counted twice on a counter that is a display total. Recoverable
 * over-count beats unrecoverable loss.
 *
 * `updateMany` with the NULL guard rather than `update`, so a row the sweep and
 * a live approval both reached does not have its original stamp overwritten.
 */
async function markPlacementsCounted(placementIds: number[]) {
  if (!placementIds.length) return 0;

  const { count } = await dbWrite.placement.updateMany({
    where: { id: { in: placementIds }, metricCountedAt: null },
    data: { metricCountedAt: new Date() },
  });

  return count;
}

/**
 * How long a settled placement is left to the live emit before the sweep takes
 * it. Only to keep the two off the same row at the same moment: the live emit
 * runs milliseconds after the settle commits, so anything still unmarked this
 * much later is genuinely lost rather than in flight.
 */
const LIVE_EMIT_GRACE_MS = 5 * 60 * 1000;

/**
 * The durable half: count every placement that reached `approved` and never made
 * it onto the counter.
 *
 * Why a sweep over Postgres rather than CDC on `Placement` (the other option on
 * the ticket): the property that makes this correct is `metricCountedAt` on the
 * row, written in the same place the money is, and it needs no publication
 * membership, no `REPLICA IDENTITY FULL`, and no handler that has to tell a
 * `pending → approved` transition from the four paths that write `removed`.
 * Getting that wrong makes a counter that decrements, which is the one thing it
 * must never do.
 *
 * **Emits one event per (image, placer), not per placement.** The pipeline's key
 * has no `metricValue` in it and its `createdAt` is second-precision, so two
 * events for the same image and placer inside one second collapse into one and
 * the second payment disappears. A bulk approval is exactly that shape. Summing
 * the group first makes the collision unreachable instead of unlikely.
 *
 * **`removed` is swept too.** Those placements were approved first — the money
 * moved — and the counter counts the approval and never reverses. Skipping them
 * would mean a placement removed before the next tick was never counted at all,
 * while an identical one removed an hour later was; the counter would then say
 * something different depending on cron timing.
 *
 * Never throws for one bad group: a single image whose emit fails must not stop
 * the rest of the backlog. Its rows stay unmarked and come back next tick.
 */
export async function sweepUncountedPlacements({ limit = 100 }: { limit?: number } = {}) {
  const pending = await dbWrite.placement.findMany({
    where: {
      status: { in: ['approved', 'removed'] },
      metricCountedAt: null,
      // The counter is an `Image` metric. A surface that places on something
      // else needs its own counter and its own decision about what it means, so
      // this counts what it understands rather than guessing.
      targetType: 'image',
      resolvedAt: { not: null, lt: new Date(Date.now() - LIVE_EMIT_GRACE_MS) },
    },
    select: { id: true, targetId: true, placerId: true, amount: true, surface: true },
    orderBy: { resolvedAt: 'asc' },
    take: limit,
  });

  if (!pending.length) return { considered: 0, counted: 0, amount: 0 };

  const groups = new Map<
    string,
    { imageId: number; placerId: number; amount: number; ids: number[]; surface: string }
  >();

  for (const row of pending) {
    const key = `${row.targetId}:${row.placerId}`;
    const group = groups.get(key) ?? {
      imageId: row.targetId,
      placerId: row.placerId,
      amount: 0,
      ids: [],
      surface: row.surface,
    };
    group.amount += row.amount;
    group.ids.push(row.id);
    groups.set(key, group);
  }

  let counted = 0;
  let amount = 0;

  for (const group of groups.values()) {
    try {
      // A zero-amount group is marked without an emit rather than skipped: left
      // unmarked it would be re-selected on every tick and eat the batch ahead
      // of rows that do need counting.
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

      // `false` here is the metric flag being off, not a failure. The group
      // stays unmarked and is counted on a later tick, which is the whole point
      // of the queue — marking it now would lose the flag's whole window.
      if (!delivered) continue;

      counted += await markPlacementsCounted(group.ids);
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
        error: (error as Error).message,
      }).catch(() => null);
    }
  }

  return { considered: pending.length, counted, amount };
}
