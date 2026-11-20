import { sql } from '@civitai/db/kysely';
import { env } from '$env/dynamic/private';
import {
  RETRACTED_MEDIA_READ_TIMEOUT_MS,
  RETRACTED_SERVED_ACTIVITY,
} from '@civitai/shared/retracted-media';
import { blockedForSignal } from '@civitai/shared/review-batch';
import {
  createScannerVerdictCache,
  csamRestrictedSql,
  upgradedRetractionSql,
  retractedImageWhereSql,
  siblingsServable,
  urlSiblingsSql,
  type UrlSibling,
} from '@civitai/shared/retracted-media-tier';
import { blockedForPatterns } from './blocked-for-patterns';
import { dbWrite } from './db';
import { insertModActivity } from './mod-activity';
import { readScannerCsamVerdict, readScannerCsamVerdicts } from './review-batch';

export const scannerVerdicts = createScannerVerdictCache(readScannerCsamVerdict);

export type RetractedMedia = {
  url: string;
  type: string;
  mimeType: string | null;
};

/**
 * The image's storage key and type while this moderator may see it on `/api/retracted-media`;
 * `null` otherwise, so an image they may not see is answered exactly as a missing one. CSAM-restricted
 * media (`csamRestrictedSql`, a `blockedFor` signal, or the scanner's CSAM label) needs `csamReview`;
 * a minor signal alone does not. The same rules as the main app's `/api/mod/retracted-media`, read on the
 * primary for the same reason: a flag or hold the replica has not seen would otherwise be missed.
 */
export async function getRetractedMedia(
  imageId: number,
  { csamReview }: { csamReview: boolean }
): Promise<RetractedMedia | null> {
  const row = await dbWrite.transaction().execute(async (trx) => {
    await sql.raw(`SET LOCAL statement_timeout = ${RETRACTED_MEDIA_READ_TIMEOUT_MS}`).execute(trx);
    return (
      trx
        .selectFrom('Image as i')
        .select(['i.url', 'i.type', 'i.mimeType', 'i.blockedFor', 'i.ingestion'])
        // Read only for a moderator who could be refused on it.
        .select(
          sql<boolean>`${sql.raw(
            csamReview ? 'false' : `(${csamRestrictedSql('i')} OR ${upgradedRetractionSql('i')})`
          )}`.as('restricted')
        )
        .select(
          sql<UrlSibling[]>`${sql.raw(csamReview ? "'[]'::json" : urlSiblingsSql('i'))}`.as(
            'siblings'
          )
        )
        .where('i.id', '=', imageId)
        .where(
          sql<boolean>`${sql.raw(retractedImageWhereSql('i', { cdnLeg: retractedMediaCdnLeg() }))}`
        )
        .executeTakeFirst()
    );
  });
  if (!row) return null;
  const patterns = blockedForPatterns();
  if (!csamReview) {
    if (row.restricted || blockedForSignal(row.blockedFor, patterns)) return null;
    // Refused when the scanner's CSAM label marks it, or the scanner cannot be read. A scanned image
    // can be rescanned, so its verdict is read fresh rather than from the cache.
    const verdict =
      row.ingestion === 'Scanned'
        ? await readScannerCsamVerdict(imageId)
        : await scannerVerdicts.read(imageId);
    if (verdict !== 'clear' && verdict !== 'none') return null;
    const isSignal = (blockedFor: string | null) => blockedForSignal(blockedFor, patterns);
    if (!(await siblingsServable(row.siblings, isSignal, readScannerCsamVerdicts))) return null;
  }
  return { url: row.url, type: row.type, mimeType: row.mimeType };
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
