import { Prisma } from '@prisma/client';
import { heldImageKnownSql } from '@civitai/shared/held-media';
import { RETRACTED_MEDIA_READ_TIMEOUT_MS } from '@civitai/shared/retracted-media';
import {
  createScannerVerdictCache,
  retractedAccessColumnsSql,
  moderatorMediaWhereSql,
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
  /** Held media (`heldImageSql`), so its serve is recorded as a held view. */
  held: boolean;
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
  { csamReview, cdnLeg = false }: { csamReview: boolean; cdnLeg?: boolean },
  db = dbWrite
): Promise<RetractedMedia | null> {
  const access = retractedAccessColumnsSql('i', { csamReview });
  const [row] = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${RETRACTED_MEDIA_READ_TIMEOUT_MS}`);
    return tx.$queryRaw<
      (RetractedMedia & {
        blockedFor: string | null;
        ingestion: string;
        restricted: boolean;
        siblings: UrlSibling[];
      })[]
    >`
      SELECT i.url, i.type::text AS type, i."mimeType", i."blockedFor", i.ingestion,
        ${Prisma.raw(access.restricted)} AS restricted,
        ${Prisma.raw(access.siblings)} AS siblings, ${Prisma.raw(heldImageKnownSql('i'))} AS held
      FROM "Image" i
      WHERE i.id = ${imageId}
        AND ${Prisma.raw(moderatorMediaWhereSql('i', { cdnLeg, csamReview, heldLeg: false }))}
    `;
  });
  if (!row) return null;
  if (!csamReview) {
    const viewable = await retractedViewable(row, {
      patterns: blockedForPatterns(),
      // A scanned image can be rescanned, so its verdict is read fresh rather than from the cache.
      readVerdict: () =>
        row.ingestion === 'Scanned'
          ? readScannerCsamVerdict(imageId)
          : scannerVerdicts.read(imageId),
      readVerdicts: readScannerCsamVerdicts,
    });
    if (!viewable) return null;
  }
  return { url: row.url, type: row.type, mimeType: row.mimeType, held: row.held };
}
