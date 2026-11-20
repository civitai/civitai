import { Prisma } from '@prisma/client';
import { RETRACTED_MEDIA_READ_TIMEOUT_MS } from '@civitai/shared/retracted-media';
import {
  createScannerVerdictCache,
  csamRestrictedSql,
  retractedImageWhereSql,
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
};

/**
 * The image's storage key and type while this moderator may see it here; `null` otherwise, so an
 * image they may not see is answered exactly as a missing one. CSAM-restricted media
 * (`csamRestrictedSql`, a `blockedFor` signal, or the scanner's CSAM label) needs `csamReview`; a
 * minor signal alone does not. Read on the primary: a flag or hold the replica has not seen yet would
 * otherwise be missed. A read past its timeout, or a scanner that cannot be read, refuses.
 */
export async function getRetractedMedia(
  imageId: number,
  { csamReview, cdnLeg = false }: { csamReview: boolean; cdnLeg?: boolean },
  db = dbWrite
): Promise<RetractedMedia | null> {
  const [row] = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${RETRACTED_MEDIA_READ_TIMEOUT_MS}`);
    return tx.$queryRaw<
      (RetractedMedia & { blockedFor: string | null; ingestion: string; restricted: boolean })[]
    >`
      SELECT i.url, i.type::text AS type, i."mimeType", i."blockedFor", i.ingestion,
        ${Prisma.raw(csamReview ? 'false' : csamRestrictedSql('i'))} AS restricted
      FROM "Image" i
      WHERE i.id = ${imageId} AND ${Prisma.raw(retractedImageWhereSql('i', { cdnLeg }))}
    `;
  });
  if (!row) return null;
  if (!csamReview) {
    if (row.restricted || blockedForSignal(row.blockedFor, blockedForPatterns())) return null;
    // A scanned image can be rescanned, so its verdict is read fresh rather than from the cache.
    const verdict =
      row.ingestion === 'Scanned'
        ? await readScannerCsamVerdict(imageId)
        : await scannerVerdicts.read(imageId);
    if (verdict !== 'clear' && verdict !== 'none') return null;
  }
  return { url: row.url, type: row.type, mimeType: row.mimeType };
}
