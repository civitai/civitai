import { sql } from '@civitai/db/kysely';
import { env } from '$env/dynamic/private';
import { RETRACTED_SERVED_ACTIVITY } from '@civitai/shared/retracted-media';
import {
  createScannerVerdictCache,
  retractedImageWhereSql,
  retractedSuspectSql,
  retractedTier,
  type RetractedTier,
} from '@civitai/shared/retracted-media-tier';
import { blockedForPatterns } from './blocked-for-patterns';
import { dbWrite } from './db';
import { insertModActivity } from './mod-activity';
import { readScannerVerdict } from './review-batch';

/** No scanner verdict for the image: the route tells the moderator it needs CSAM-queue access. */
export const NEEDS_CSAM_QUEUE = 'needs-csam-queue';

export const scannerVerdicts = createScannerVerdictCache(readScannerVerdict);

export type RetractedMedia = {
  url: string;
  type: string;
  mimeType: string | null;
  tier: RetractedTier;
};

/**
 * The image's storage key and type while this moderator may see it on `/api/retracted-media`;
 * `null` otherwise, so an image they may not see is answered exactly as a missing one. A `suspect`
 * image needs `csamReview`. The same rules as the main app's `/api/mod/retracted-media`, read on the
 * primary for the same reason: a flag or hold the replica has not seen would serve as `plain`.
 */
export async function getRetractedMedia(
  imageId: number,
  { csamReview }: { csamReview: boolean }
): Promise<RetractedMedia | typeof NEEDS_CSAM_QUEUE | null> {
  const row = await dbWrite
    .selectFrom('Image as i')
    .select(['i.url', 'i.type', 'i.mimeType', 'i.blockedFor', 'i.ingestion'])
    .select(sql<boolean>`${sql.raw(retractedSuspectSql('i'))}`.as('suspect'))
    .where('i.id', '=', imageId)
    .where(
      sql<boolean>`${sql.raw(retractedImageWhereSql('i', { cdnLeg: retractedMediaCdnLeg() }))}`
    )
    .executeTakeFirst();
  if (!row) return null;
  const tier = retractedTier(row, blockedForPatterns());
  if (!csamReview) {
    if (tier === 'suspect') return null;
    // Refused when the scanner marks it, has no verdict for it, or cannot be read.
    // A scanned image can be rescanned, so its verdict is read fresh rather than from the cache.
    const verdict =
      row.ingestion === 'Scanned'
        ? await readScannerVerdict(imageId)
        : await scannerVerdicts.read(imageId);
    if (verdict === 'none') return NEEDS_CSAM_QUEUE;
    if (verdict !== 'clear') return null;
  }
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

/** `/api/retracted-media` answers 404 unless this is exactly 'true'. */
export const retractedMediaEnabled = () => env.RETRACTED_MEDIA_ENABLED === 'true';

/** Whether a scanned image whose url the image CDN retracted is eligible too. */
export const retractedMediaCdnLeg = () => env.RETRACTED_MEDIA_CDN_LEG === 'true';
