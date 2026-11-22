import { sql } from '@civitai/db/kysely';
import { BLOCKED_IMAGE_DELETE_QUEUE } from '@civitai/shared/account-deletion-grace';
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
 * Re-queues an image that stays blocked with the clock starting now, as a fresh block would: a lift
 * kept blocked while its owner is deleted must not inherit the original block's time. One statement, so
 * a failure cannot leave the image with no queue row. Twin: src/server/services/image.service.ts.
 */
export async function restartBlockedImageDeleteClock(imageId: number) {
  await dbWrite
    .insertInto('JobQueue')
    .values({ ...BLOCKED_IMAGE_DELETE_QUEUE, entityId: imageId })
    .onConflict((oc) =>
      oc.columns(['entityType', 'entityId', 'type']).doUpdateSet({ createdAt: sql`now()` })
    )
    .execute();
}
