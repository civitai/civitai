import { Prisma } from '@prisma/client';
import { retractedImageSql } from '@civitai/shared/retracted-media';
import { dbRead } from '~/server/db/client';

export type RetractedMedia = { url: string; type: string; mimeType: string | null };

/** The image's storage key and type while `retractedImageSql` allows it; `null` otherwise, so an
 *  ineligible image is answered exactly as a missing one. */
export async function getRetractedMedia(
  imageId: number,
  db = dbRead
): Promise<RetractedMedia | null> {
  const [row] = await db.$queryRaw<RetractedMedia[]>`
    SELECT i.url, i.type::text AS type, i."mimeType"
    FROM "Image" i
    WHERE i.id = ${imageId} AND ${Prisma.raw(retractedImageSql('i'))}
  `;
  return row ?? null;
}
