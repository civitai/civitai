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
