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
 * **Accepted placements only** (Justin, 2026-08-12). A declined placement pays
 * the owner a non-refundable fee and still counts nothing, which is deliberate
 * and is the one place this number is not "Buzz the creator received": counting
 * declines would grow the counter fastest for a creator who refuses everything.
 * What it means instead is *what people paid to be on this image*, which is also
 * what makes it legible next to the content it labels.
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
 * **The consequence, stated rather than left implied: this counter is
 * best-effort and permanently lossy.** The emission is a separate step after a
 * committed settle, outside any transaction, and nothing reconciles it. A
 * failure loses that placement's Buzz from the number for good, and a pod
 * killed between the two loses it without even the log line above. There is no
 * backfill, and a lost emit is indistinguishable from a placement that was
 * never approved.
 *
 * That is the right trade — a counter must not be able to fail a payment — but
 * it means the number is a display total and not a ledger. Anything that has to
 * be *right* about money reads `PlacementTransaction`, which is the record that
 * is written in the same transaction as the status.
 */
export async function recordPlacementTip({
  surface,
  imageId,
  amount,
}: {
  /** For the log only — the counter does not distinguish them. */
  surface: PlacementSurface;
  imageId: number;
  amount: number;
}) {
  if (amount <= 0) return;

  try {
    await updateEntityMetricDetached({
      entityType: 'Image',
      entityId: imageId,
      metricType: 'Buzz',
      amount,
    });
  } catch (error) {
    await logToAxiom({
      name: 'placement-metrics',
      type: 'error',
      message: 'could not count an approved placement toward the image buzz counter',
      surface,
      imageId,
      amount,
      error: (error as Error).message,
    }).catch(() => null);
  }
}
