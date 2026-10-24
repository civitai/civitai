import { dbWrite } from '~/server/db/client';
import { PRIOR_BLOCKED_FOR_KEY, PRIOR_INGESTION_KEY } from '~/server/utils/image-removal-mode';

/**
 * 🔴 Strips the grace-block breadcrumbs off rows a MODERATION path is blocking right now.
 *
 * Its own module, not `account-deletion-images.ts` where the readers live, only because that file
 * imports `image.service` and `image.service` is one of the callers here — a leaf module keeps a
 * cycle out of an 8k-line module that builds caches at import time.
 *
 * `unblockAccountDeletionImages` (in `account-deletion-images.ts`) restores an image purely on the
 * presence of
 * `PRIOR_INGESTION_KEY`, and its own docstring promises that it will not put back content a
 * moderator hid. That promise only holds if the breadcrumb is gone by the time the moderator's
 * block lands — and the ordering that breaks it is ordinary: a user self-deletes with the 7-day
 * grace option (every image marked), a report lands on day 3, a moderator blocks the image, the
 * user then restores the account. Without this strip the restore reads a breadcrumb that is still
 * there and un-blocks the moderated image, back to whatever `ingestion` it held before the
 * deletion, with the moderator's `blockedFor` overwritten by the recorded one.
 *
 * Called by the block SITES rather than folded into the reader, because the reader is not the only
 * consumer: `countPendingAccountDeletionImageRestores` and the unreadable-breadcrumb audit in
 * `unblockAccountDeletionImages` read the same key, and a moderated row should be invisible to all
 * three.
 *
 * Takes ids OR a userId, matching the two shapes the block sites have. Not both — a call with
 * neither, or a call with an empty id list, is a no-op rather than a table-wide UPDATE.
 * `"metadata" - key` leaves a NULL metadata NULL, so this never materialises `{}` on a row that
 * had nothing.
 */
export async function clearAccountDeletionImageMarkers(
  target: { ids: number[]; userId?: undefined } | { userId: number; ids?: undefined }
) {
  // Two statements rather than one with an interpolated predicate: the scope of a destructive
  // UPDATE stays literal in the source, so neither shape can be widened by a value.
  //
  // `("metadata" -> key) IS NOT NULL` and not `->>`: for a JSON null the arrow returns the JSON
  // null (not SQL NULL) while the double-arrow returns SQL NULL, so `->>` would walk past a
  // breadcrumb spelled `null` and leave it in place. Same divergence that made the two readers of
  // this key disagree; here the wider reading is the correct one — strip whatever is there.
  if (target.ids !== undefined) {
    if (!target.ids.length) return 0;
    return dbWrite.$executeRaw`
      UPDATE "Image"
      SET "metadata" = "metadata" - ${PRIOR_INGESTION_KEY}::text - ${PRIOR_BLOCKED_FOR_KEY}::text
      WHERE id = ANY(${target.ids})
        AND ("metadata" -> ${PRIOR_INGESTION_KEY}::text) IS NOT NULL
    `;
  }
  return dbWrite.$executeRaw`
    UPDATE "Image"
    SET "metadata" = "metadata" - ${PRIOR_INGESTION_KEY}::text - ${PRIOR_BLOCKED_FOR_KEY}::text
    WHERE "userId" = ${target.userId}
      AND ("metadata" -> ${PRIOR_INGESTION_KEY}::text) IS NOT NULL
  `;
}
