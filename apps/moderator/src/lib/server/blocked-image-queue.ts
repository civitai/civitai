import { sql } from '@civitai/db/kysely';
import { dbWrite } from './db';

/**
 * Mirrors the main app's `dropBlockedImageDeleteQueue`: a surviving row keeps the first block's time,
 * so a later re-block would inherit it, and an un-block's activity would read as a takedown of the
 * next block. Call it from anything that clears an image's block.
 */
export async function dropBlockedImageDeleteQueue(imageId: number) {
  await dbWrite
    .deleteFrom('JobQueue')
    .where('type', '=', 'BlockedImageDelete')
    .where('entityType', '=', 'Image')
    .where('entityId', '=', imageId)
    .execute();
}

/**
 * Re-queues an image that stays blocked with the clock starting now, as a fresh block would: an
 * approval kept blocked while its owner is deleted must not inherit the original block's time.
 */
export async function restartBlockedImageDeleteClock(imageId: number) {
  // One statement, so a failure cannot leave the image with no queue row and never purged.
  await dbWrite
    .insertInto('JobQueue')
    .values({ type: 'BlockedImageDelete', entityType: 'Image', entityId: imageId })
    .onConflict((oc) =>
      oc.columns(['entityType', 'entityId', 'type']).doUpdateSet({ createdAt: sql`now()` })
    )
    .execute();
}
