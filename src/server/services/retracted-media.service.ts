import { Prisma } from '@prisma/client';
import {
  createScannerVerdictCache,
  retractedImageWhereSql,
  retractedSuspectSql,
  retractedTier,
  type RetractedTier,
} from '@civitai/shared/retracted-media-tier';
import { dbWrite } from '~/server/db/client';
import { blockedForPatterns } from '~/server/services/blocked-for-patterns';
import { readScannerVerdict } from '~/server/services/review-batch/review-batch.service';

export const NEEDS_CSAM_QUEUE = 'needs-csam-queue';

export const scannerVerdicts = createScannerVerdictCache(readScannerVerdict);

export type RetractedMedia = {
  url: string;
  type: string;
  mimeType: string | null;
  tier: RetractedTier;
};

/**
 * The image's storage key and type while this moderator may see it here; `null` otherwise, so an
 * image they may not see is answered exactly as a missing one. A `suspect` image needs `csamReview`.
 * Read on the primary: a flag or hold the replica has not seen yet would otherwise serve as `plain`.
 * For a moderator without `csamReview`, a `plain` image is also checked against the scanner's labels,
 * and is refused when they mark it, have none for it, or cannot be read. No labels at all is answered
 * `NEEDS_CSAM_QUEUE`, which the route explains: a moderator can do something about it.
 */
export async function getRetractedMedia(
  imageId: number,
  { csamReview }: { csamReview: boolean },
  db = dbWrite
): Promise<RetractedMedia | typeof NEEDS_CSAM_QUEUE | null> {
  const [row] = await db.$queryRaw<
    (Omit<RetractedMedia, 'tier'> & { blockedFor: string | null; suspect: boolean })[]
  >`
    SELECT i.url, i.type::text AS type, i."mimeType", i."blockedFor",
      ${Prisma.raw(retractedSuspectSql('i'))} AS suspect
    FROM "Image" i
    WHERE i.id = ${imageId} AND ${Prisma.raw(retractedImageWhereSql('i'))}
  `;
  if (!row) return null;
  const tier = retractedTier(row, blockedForPatterns());
  if (!csamReview) {
    if (tier === 'suspect') return null;
    const verdict = await scannerVerdicts.read(imageId);
    if (verdict === 'none') return NEEDS_CSAM_QUEUE;
    if (verdict !== 'clear') return null;
  }
  return { url: row.url, type: row.type, mimeType: row.mimeType, tier };
}
