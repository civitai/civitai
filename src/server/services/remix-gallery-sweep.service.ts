import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { settlePlacement } from '~/server/services/placement-escrow.service';

/**
 * Pending submissions whose image has been hard-deleted since it was sent.
 *
 * `Image` rows are deleted outright rather than soft-deleted, and
 * `Placement.data.imageId` is a plain JSON value with no foreign key, so nothing
 * in the database notices. The gallery read joins `Image` and simply stops
 * returning the entry, and the owner's queue drops it — which is right for
 * display and wrong for money: the submitter's Buzz stays in escrow until the
 * 48-hour expiry, waiting on a decision nobody can make, because the owner
 * cannot see what they are being asked to judge.
 *
 * This releases those early, on the same terms as expiry: refunded in full, no
 * decline fee. The owner gave no attention and there is nothing left to give it
 * to.
 *
 * Kept out of `placement-escrow.service.ts` on purpose. The escrow layer is
 * surface-agnostic by rule, and "look inside `data` for an image id" is a
 * remix-gallery fact — the foundation does not read inside that column.
 */
export async function sweepDeletedRemixGallerySubmissions({
  limit = 100,
}: { limit?: number } = {}) {
  const orphaned = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT pl.id
    FROM "Placement" pl
    WHERE pl.surface = 'remixGallery'
      AND pl."targetType" = 'image'
      AND pl.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM "Image" i WHERE i.id = (pl.data ->> 'imageId')::int
      )
    ORDER BY pl.id
    LIMIT ${limit}
  `;

  let released = 0;
  for (const { id } of orphaned) {
    try {
      // Claims with `WHERE status = 'pending'`, so a race against the ordinary
      // expiry sweep moves no money twice — the loser reports `settled: false`.
      const result = await settlePlacement({ placementId: id, action: 'expire' });
      if (result.settled) released++;
    } catch (error) {
      logToAxiom({
        name: 'remix-gallery',
        type: 'error',
        message: 'releasing a submission whose image was deleted failed',
        placementId: id,
        error: (error as Error).message,
      }).catch(() => null);
    }
  }

  return { considered: orphaned.length, released };
}
