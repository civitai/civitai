import { sql } from '@civitai/db/kysely';
import { RETRACTED_SERVED_ACTIVITY } from '@civitai/shared/retracted-media';
import {
  retractedImageWhereSql,
  retractedSuspectSql,
  retractedTier,
  type RetractedTier,
} from '@civitai/shared/retracted-media-tier';
import { blockedForPatterns } from './blocked-for-patterns';
import { dbRead } from './db';
import { insertModActivity } from './mod-activity';

export type RetractedMedia = {
  url: string;
  type: string;
  mimeType: string | null;
  tier: RetractedTier;
};

/**
 * The image's storage key and type while this moderator may see it on `/api/retracted-media`;
 * `null` otherwise, so an image they may not see is answered exactly as a missing one. A `suspect`
 * image needs `csamReview`. The same rules as the main app's `/api/mod/retracted-media`.
 */
export async function getRetractedMedia(
  imageId: number,
  { csamReview }: { csamReview: boolean }
): Promise<RetractedMedia | null> {
  const row = await dbRead
    .selectFrom('Image as i')
    .select(['i.url', 'i.type', 'i.mimeType', 'i.blockedFor'])
    .select(sql<boolean>`${sql.raw(retractedSuspectSql('i'))}`.as('suspect'))
    .where('i.id', '=', imageId)
    .where(sql<boolean>`${sql.raw(retractedImageWhereSql('i'))}`)
    .executeTakeFirst();
  if (!row) return null;
  const tier = retractedTier(row, blockedForPatterns());
  if (tier === 'suspect' && !csamReview) return null;
  return { url: row.url, type: row.type, mimeType: row.mimeType, tier };
}

/** Every response carrying bytes, ranges included. Throws when the row is not written, so the bytes
 *  are not sent without it. */
export function recordRetractedView(moderatorId: number, imageId: number) {
  return insertModActivity({
    userId: moderatorId,
    entityType: 'image',
    entityId: imageId,
    activity: RETRACTED_SERVED_ACTIVITY,
  });
}
