import { Prisma } from '@prisma/client';
import { RETRACTED_MEDIA_READ_TIMEOUT_MS } from '@civitai/shared/retracted-media';
import {
  createScannerVerdictCache,
  retractedAccessColumnsSql,
  retractedImageWhereSql,
  retractedViewable,
  type UrlSibling,
} from '@civitai/shared/retracted-media-tier';
import { dbWrite } from '~/server/db/client';
import { blockedForPatterns } from '~/server/services/blocked-for-patterns';
import {
  readScannerCsamVerdict,
  readScannerCsamVerdicts,
} from '~/server/services/review-batch/review-batch.service';

export const scannerVerdicts = createScannerVerdictCache(readScannerCsamVerdict);

export type RetractedMedia = {
  url: string;
  type: string;
  mimeType: string | null;
};

/**
 * The image's storage key and type while this moderator may see it here; `null` otherwise, so an
 * image they may not see is answered exactly as a missing one. A moderator without `csamReview` is
 * refused what `retractedViewable` refuses. Read on the primary: a flag or hold the replica has not
 * seen yet would otherwise be missed. A read past its timeout, or a scanner that cannot be read,
 * refuses.
 */
export async function getRetractedMedia(
  imageId: number,
  { csamReview }: { csamReview: boolean },
  db = dbWrite
): Promise<RetractedMedia | null> {
  const access = retractedAccessColumnsSql('i', { csamReview });
  const [row] = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${RETRACTED_MEDIA_READ_TIMEOUT_MS}`);
    return tx.$queryRaw<
      (RetractedMedia & {
        blockedFor: string | null;
        restricted: boolean;
        siblings: UrlSibling[];
      })[]
    >`
      SELECT i.url, i.type::text AS type, i."mimeType", i."blockedFor",
        ${Prisma.raw(access.restricted)} AS restricted,
        ${Prisma.raw(access.siblings)} AS siblings
      FROM "Image" i
      WHERE i.id = ${imageId} AND ${Prisma.raw(retractedImageWhereSql('i'))}
    `;
  });
  if (!row) return null;
  if (!csamReview) {
    const viewable = await retractedViewable(row, {
      patterns: blockedForPatterns(),
      readVerdict: () => scannerVerdicts.read(imageId),
      readVerdicts: readScannerCsamVerdicts,
    });
    if (!viewable) return null;
  }
  return { url: row.url, type: row.type, mimeType: row.mimeType };
}
