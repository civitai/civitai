import { sql } from '@civitai/db/kysely';
import { heldImageSql, SERVED_ACTIVITY } from '@civitai/shared/held-media';
import { dbRead } from './db';
import { recordModActivity } from './mod-activity';
import { logToAxiom } from './axiom';

/** The page whose grant opens held media. */
export const HELD_MEDIA_PAGE = '/images/csam';

export type HeldMedia = { url: string; type: string; mimeType: string | null };

/** The image's storage key and type while `heldImageSql` holds it; `null` otherwise, so the route
 *  answers an ordinary image exactly as it answers a missing one. */
export async function getHeldMedia(imageId: number): Promise<HeldMedia | null> {
  const row = await dbRead
    .selectFrom('Image as i')
    .select(['i.url', 'i.type', 'i.mimeType'])
    .where('i.id', '=', imageId)
    .where(sql<boolean>`${sql.raw(heldImageSql('i'))}`)
    .executeTakeFirst();
  return row ?? null;
}

/** The grid's summary row, once per page view; the images themselves are audited as they are
 *  served. ModActivity has no details column, so `entityId` carries the count. */
export function recordHeldGridView(moderatorId: number, count: number) {
  void recordModActivity({
    userId: moderatorId,
    entityType: 'heldMediaGrid',
    entityId: count,
    activity: 'heldMedia:grid',
  });
  void logToAxiom({ name: 'held-media-grid', type: 'info', moderatorId, count }).catch(() => null);
}

/** One image opened from byte 0, in the grid or the full view. */
export function recordHeldView(moderatorId: number, imageId: number) {
  void recordModActivity({
    userId: moderatorId,
    entityType: 'image',
    entityId: imageId,
    activity: SERVED_ACTIVITY,
  });
}

/** Every response carrying held bytes, mid-file ranges included. */
export function recordHeldServe(record: Record<string, unknown>) {
  void logToAxiom(record).catch(() => null);
}
