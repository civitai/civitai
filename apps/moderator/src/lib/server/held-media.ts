import { sql } from '@civitai/db/kysely';
import { FLAG_KEPT_THROUGH_BLOCK } from '$lib/image-review';
import { dbRead } from './db';
import { flagClearHoldLegs, holdMarkerState } from './csam-flag-clear';
import { recordModActivity } from './mod-activity';
import { logToAxiom } from './axiom';

/** The owner `deleteUser` hands kept content to; the main app's `PLACEHOLDER_OWNER_ID`. */
const PLACEHOLDER_OWNER_ID = -1;

/** The page whose grant opens held media. */
export const HELD_MEDIA_PAGE = '/images/csam';

export type HeldMedia = { url: string; type: string; mimeType: string | null };

/**
 * The image's storage key and type, only while it is in the CSAM review queue or its owner is held
 * by a CSAM report or an evidence hold. `null` otherwise, so the route answers an ordinary image
 * exactly as it answers a missing one.
 *
 * The owner legs are `csam-flag-clear`'s, minus two: `ban` is not a CSAM hold, and `evidenceHold`
 * read without its view holds every user, which here would open every image. The placeholder owner
 * of deleted accounts' kept content is never an owner hold: a report naming it would open all of it.
 */
export async function getHeldMedia(imageId: number): Promise<HeldMedia | null> {
  const marker = await holdMarkerState(dbRead);
  const legs = flagClearHoldLegs(sql<number>`i."userId"`, marker);
  const ownerHeld = [
    legs.csamReport,
    legs.csamReportSecondary,
    legs.reportedImage,
    ...(marker === 'view' ? [legs.evidenceHold] : []),
  ];
  const row = await dbRead
    .selectFrom('Image as i')
    .select(['i.url', 'i.type', 'i.mimeType'])
    .where('i.id', '=', imageId)
    .where(
      sql<boolean>`(i."needsReview" = ${FLAG_KEPT_THROUGH_BLOCK}
        OR (i."userId" <> ${PLACEHOLDER_OWNER_ID} AND (${sql.join(ownerHeld, sql` OR `)})))`
    )
    .executeTakeFirst();
  return row ?? null;
}

/** One row per grid page, not per image: the count is the record, and `entityId` carries it. */
export function recordHeldGridView(moderatorId: number, count: number) {
  if (!count) return;
  void recordModActivity({
    userId: moderatorId,
    entityType: 'heldMediaGrid',
    entityId: count,
    activity: 'heldMedia:grid',
  });
  void logToAxiom({ name: 'held-media-grid', type: 'info', moderatorId, count }).catch(() => {});
}

export function recordHeldFullView(moderatorId: number, imageId: number) {
  void recordModActivity({
    userId: moderatorId,
    entityType: 'image',
    entityId: imageId,
    activity: 'heldMedia:view',
  });
  void logToAxiom({ name: 'held-media-view', type: 'info', moderatorId, imageId }).catch(() => {});
}
