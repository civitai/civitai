import { Prisma } from '@prisma/client';
import { heldImageSql } from '@civitai/shared/held-media';
import { dbRead } from '~/server/db/client';

export type HeldMedia = { url: string; type: string; mimeType: string | null };

/** The image's storage key and type while `heldImageSql` holds it; `null` otherwise, so an ordinary
 *  image is answered exactly as a missing one. */
export async function getHeldMedia(imageId: number, db = dbRead): Promise<HeldMedia | null> {
  const [row] = await db.$queryRaw<HeldMedia[]>`
    SELECT i.url, i.type::text AS type, i."mimeType"
    FROM "Image" i
    WHERE i.id = ${imageId} AND ${Prisma.raw(heldImageSql('i'))}
  `;
  return row ?? null;
}
