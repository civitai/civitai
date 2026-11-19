import { Prisma } from '@prisma/client';
import {
  createScannerVerdictCache,
  csamRestrictedSql,
  retractedImageWhereSql,
  retractedSuspectSql,
  retractedTier,
  type RetractedTier,
} from '@civitai/shared/retracted-media-tier';
import { blockedForSignal } from '@civitai/shared/review-batch';
import { dbWrite } from '~/server/db/client';
import { blockedForPatterns } from '~/server/services/blocked-for-patterns';
import { readScannerCsamVerdict } from '~/server/services/review-batch/review-batch.service';

export const scannerVerdicts = createScannerVerdictCache(readScannerCsamVerdict);

export type RetractedMedia = {
  url: string;
  type: string;
  mimeType: string | null;
  tier: RetractedTier;
};

/**
 * The image's storage key and type while this moderator may see it here; `null` otherwise, so an
 * image they may not see is answered exactly as a missing one. CSAM-restricted media
 * (`csamRestrictedSql`, a `blockedFor` signal, or the scanner's CSAM label) needs `csamReview`; a
 * minor signal alone does not. Read on the primary: a flag or hold the replica has not seen yet would
 * otherwise be missed. A scanner that cannot be read refuses.
 */
export async function getRetractedMedia(
  imageId: number,
  { csamReview }: { csamReview: boolean },
  db = dbWrite
): Promise<RetractedMedia | null> {
  const [row] = await db.$queryRaw<
    (Omit<RetractedMedia, 'tier'> & {
      blockedFor: string | null;
      suspect: boolean;
      restricted: boolean;
    })[]
  >`
    SELECT i.url, i.type::text AS type, i."mimeType", i."blockedFor",
      ${Prisma.raw(retractedSuspectSql('i'))} AS suspect,
      ${Prisma.raw(csamReview ? 'false' : csamRestrictedSql('i'))} AS restricted
    FROM "Image" i
    WHERE i.id = ${imageId} AND ${Prisma.raw(retractedImageWhereSql('i'))}
  `;
  if (!row) return null;
  const patterns = blockedForPatterns();
  const tier = retractedTier(row, patterns);
  if (!csamReview) {
    if (row.restricted || blockedForSignal(row.blockedFor, patterns)) return null;
    const verdict = await scannerVerdicts.read(imageId);
    if (verdict !== 'clear' && verdict !== 'none') return null;
  }
  return { url: row.url, type: row.type, mimeType: row.mimeType, tier };
}
